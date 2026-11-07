"""In-app seat radar: watches sections and raises an event the moment a seat opens.

Used by app.py. Reads only KFUPM's public class search (no login). The standalone Telegram bot
in radar.py keeps working separately; this service can ALSO push to Telegram if configured.
"""
from __future__ import annotations

import random
import threading
import time
from datetime import datetime, timezone
from typing import Callable

from radar import Catalog, Telegram

MIN_INTERVAL = 5  # floor: faster than this risks KFUPM rate-limiting you, and sign-in, not polling, is the slow part
DEFAULT_INTERVAL = 45


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class RadarService:
    def __init__(self, store, emit: Callable[[dict], None], catalog: Catalog | None = None):
        """
        store : object with .data (dict) and .save()  - persistence (see AppState in app.py)
        emit  : callback receiving event dicts (pushed to the UI over SSE)
        """
        self.store = store
        self.emit = emit
        self.catalog = catalog or Catalog()
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last_error: str | None = None
        self.last_pass: str | None = None
        self.checking = False
        self.telegram_send: Callable[[str], None] | None = None  # set by app when configured
        self.on_pass: Callable[[list[dict]], None] | None = None  # auto-register hook: sees every pass

    # ---- config / state -------------------------------------------------
    @property
    def _d(self) -> dict:
        d = self.store.data.setdefault("radar", {})
        d.setdefault("watches", [])
        d.setdefault("interval", DEFAULT_INTERVAL)
        d.setdefault("running", True)
        d.setdefault("history", [])
        return d

    def snapshot(self) -> dict:
        with self._lock:
            d = self._d
            return {
                "running": bool(d["running"]) and self._thread is not None and self._thread.is_alive(),
                "interval": d["interval"],
                "watches": [dict(w) for w in d["watches"]],
                "history": list(d["history"][-30:]),
                "lastPass": self.last_pass,
                "lastError": self.last_error,
                "checking": self.checking,
            }

    def set_interval(self, seconds: int) -> None:
        with self._lock:
            self._d["interval"] = max(MIN_INTERVAL, int(seconds))
            self.store.save()
        self._wake.set()

    # ---- watch list -----------------------------------------------------
    def add_watch(self, term: str, crn: str, subject: str, number: str, label: str, seats=None, capacity=None) -> dict:
        with self._lock:
            for w in self._d["watches"]:
                if w["term"] == term and w["crn"] == crn:
                    return w
            w = {
                "term": term,
                "crn": crn,
                "subject": subject,
                "number": number,
                "label": label,
                "seats": seats,
                "capacity": capacity,
                "open": bool(seats and seats > 0),
                "known": seats is not None,
                "addedAt": now_iso(),
                "checkedAt": None,
            }
            self._d["watches"].append(w)
            self.store.save()
        self._wake.set()  # check right away
        self.emit({"type": "radar", "kind": "update"})
        return w

    def remove_watch(self, term: str, crn: str) -> bool:
        with self._lock:
            before = len(self._d["watches"])
            self._d["watches"] = [w for w in self._d["watches"] if not (w["term"] == term and w["crn"] == crn)]
            changed = len(self._d["watches"]) < before
            if changed:
                self.store.save()
        if changed:
            self.emit({"type": "radar", "kind": "update"})
        return changed

    def clear_history(self) -> None:
        with self._lock:
            self._d["history"] = []
            self.store.save()
        self.emit({"type": "radar", "kind": "update"})

    # ---- lifecycle ------------------------------------------------------
    def start(self) -> None:
        with self._lock:
            self._d["running"] = True
            self.store.save()
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="radar", daemon=True)
            self._thread.start()
        self.emit({"type": "radar", "kind": "update"})

    def pause(self) -> None:
        with self._lock:
            self._d["running"] = False
            self.store.save()
        self._stop.set()
        self._wake.set()
        self.emit({"type": "radar", "kind": "update"})

    def shutdown(self) -> None:
        self._stop.set()
        self._wake.set()

    def check_now(self) -> None:
        self._wake.set()

    # ---- the check loop -------------------------------------------------
    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                if self._d["watches"]:
                    self._check_pass()
            except Exception as exc:  # noqa: BLE001 - never let the thread die
                self.last_error = f"{type(exc).__name__}: {exc}"
                self.emit({"type": "radar", "kind": "update"})
            # +-15% jitter so many students' apps don't hit Banner in lockstep
            self._wake.wait(timeout=self._d["interval"] * random.uniform(0.85, 1.15))
            self._wake.clear()

    def _check_pass(self) -> None:
        with self._lock:
            watches = [dict(w) for w in self._d["watches"]]
        by_term: dict[str, set[tuple[str, str]]] = {}
        for w in watches:
            by_term.setdefault(w["term"], set()).add((w["subject"], w["number"]))
        self.checking = True
        self.emit({"type": "radar", "kind": "update"})
        live: dict[tuple[str, str], dict] = {}
        errors = []
        try:
            for term, courses in by_term.items():
                try:
                    for crn, raw in self.catalog.live(term, courses).items():
                        live[(term, crn)] = raw
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{term}: {exc}")
        finally:
            self.checking = False

        opened: list[dict] = []
        with self._lock:
            for w in self._d["watches"]:
                raw = live.get((w["term"], w["crn"]))
                if raw is None:
                    continue  # transient miss: keep what we knew
                seats = raw.get("seatsAvailable") or 0
                now_open = seats > 0
                was_open = bool(w.get("open"))
                known_before = bool(w.get("known"))
                w.update(
                    seats=seats,
                    capacity=raw.get("maximumEnrollment"),
                    open=now_open,
                    known=True,
                    checkedAt=now_iso(),
                )
                # alert only on a closed -> open transition we actually observed
                if now_open and known_before and not was_open:
                    opened.append(dict(w))
            for w in opened:
                ev = {
                    "time": now_iso(),
                    "crn": w["crn"],
                    "term": w["term"],
                    "label": w["label"],
                    "seats": w["seats"],
                }
                self._d["history"].append(ev)
            self._d["history"] = self._d["history"][-100:]
            self.store.save()
        self.last_pass = now_iso()
        self.last_error = "; ".join(errors) if errors else None

        for w in opened:
            self.emit(
                {
                    "type": "radar",
                    "kind": "open",
                    "crn": w["crn"],
                    "term": w["term"],
                    "label": w["label"],
                    "seats": w["seats"],
                }
            )
            if self.telegram_send:
                try:
                    self.telegram_send(
                        f'SEAT OPEN: {w["label"]}\n{w["seats"]} seat(s) available now. Register fast!'
                    )
                except Exception as exc:  # noqa: BLE001
                    self.last_error = f"telegram: {exc}"
        if self.on_pass:  # auto-register looks at every pass (it acts on "open", not only on transitions)
            try:
                self.on_pass(self.snapshot()["watches"])
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"auto-register: {exc}"
        self.emit({"type": "radar", "kind": "update"})


def telegram_sender(token: str, chat_id: str) -> Callable[[str], None]:
    tg = Telegram(token)

    def send(text: str) -> None:
        r = tg.s.post(f"{tg.url}/sendMessage", json={"chat_id": chat_id, "text": text}, timeout=20)
        r.raise_for_status()

    return send
