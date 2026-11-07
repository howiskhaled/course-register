"""Auto-register: keep trying until the plan you want is the schedule you have.

How it works
  * Every section of the plan you don't already have becomes a *target*.
  * The radar checks the targets' seats every N seconds (shared Banner session, small requests).
  * A separate registrar process (`register.py --serve`) signs in ONCE and waits on Banner's
    "Enter CRNs" page, keeping the session alive. Signing in is the slow part (~15 s), so doing
    it up front is what makes the moment-a-seat-opens registration fast.
  * When targets show free seats, all of them go to the registrar in one submission.
  * Registered -> done. "Closed/full" again -> keep waiting (max 5 attempts per section).
    Anything else (prerequisite, restriction, hold) -> stop on that section and show why.
  * Optional: drop the sections a target is traded for (any course), in the same submission.
  * Rehearsal: does every step except Submit.
"""
from __future__ import annotations

import json
import os
import sys
import secrets
import subprocess
import threading
import time
from datetime import datetime, timezone

import paths

MAX_ATTEMPTS = 5
SIGN_IN_LEAD = 180  # with "Start at": sign in this many seconds early so it's ready on time
FINAL = ("registered", "rehearsed", "failed")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class AutoPilot:
    def __init__(self, app):
        self.app = app
        self.lock = threading.RLock()
        self.proc: subprocess.Popen | None = None
        self.registrar = "off"  # off | signing_in | waiting_window | ready | error
        self.detail: str | None = None
        self.inflight: dict | None = None
        self.lines: list[str] = []
        self._secrets: list[str] = []
        self._caffeinate: subprocess.Popen | None = None
        self._timer: threading.Timer | None = None
        d = self._d
        if d["armed"]:  # never silently resume after a restart
            d["armed"] = False
            for t in d["targets"]:
                if t["status"] not in FINAL:
                    t["status"] = "waiting"
            app.state.save()

    # ------------------------------------------------------------ state
    @property
    def _d(self) -> dict:
        d = self.app.state.data.setdefault("auto", {})
        d.setdefault("armed", False)
        d.setdefault("term", None)
        d.setdefault("dry", False)
        d.setdefault("allowDrop", False)
        d.setdefault("targets", [])
        d.setdefault("startedAt", None)
        d.setdefault("endedReason", None)
        d.setdefault("startAt", None)
        return d

    def _phone(self, text: str) -> None:
        """Telegram message if the user connected it in Radar (best effort, never blocks the loop)."""
        send = self.app.radar.telegram_send
        if send:
            threading.Thread(target=lambda: _safe(send, text), daemon=True).start()

    def _keep_awake(self, on: bool) -> None:
        """Stop the computer from idle-sleeping while auto-register runs (the display may still sleep)."""
        if sys.platform == "win32":
            self._keep_awake_windows(on)
            return
        if on and sys.platform == "darwin" and not self._caffeinate:
            try:
                self._caffeinate = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
            except OSError:
                self._caffeinate = None
        elif not on and self._caffeinate:
            self._caffeinate.terminate()
            self._caffeinate = None

    def _keep_awake_windows(self, on: bool) -> None:
        # SetThreadExecutionState is per-thread, so hold it on a dedicated thread until told to stop
        if on and not getattr(self, "_awake_stop", None):
            stop = threading.Event()
            self._awake_stop = stop

            def hold() -> None:
                import ctypes

                ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
                k32 = ctypes.windll.kernel32
                k32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
                stop.wait()
                k32.SetThreadExecutionState(ES_CONTINUOUS)

            threading.Thread(target=hold, name="keep-awake", daemon=True).start()
        elif not on and getattr(self, "_awake_stop", None):
            self._awake_stop.set()
            self._awake_stop = None

    def _emit(self, kind: str = "update", **kw) -> None:
        self.app.bus.emit({"type": "auto", "kind": kind, **kw})

    def snapshot(self) -> dict:
        with self.lock:
            d = self._d
            return {
                "armed": d["armed"],
                "term": d["term"],
                "dry": d["dry"],
                "allowDrop": d["allowDrop"],
                "startedAt": d["startedAt"],
                "startAt": d["startAt"],
                "endedReason": d["endedReason"],
                "registrar": self.registrar,
                "detail": self.detail,
                "targets": [dict(t) for t in d["targets"]],
                "lines": self.lines[-300:],
            }

    @property
    def armed(self) -> bool:
        return bool(self._d["armed"])

    # ------------------------------------------------------------ control
    def arm(self, term: str, targets: list[dict], dry: bool, allow_drop: bool, interval: int, headed: bool, start_at: float | None = None) -> None:
        with self.lock:
            if self.armed:
                raise RuntimeError("Auto-register is already running")
            if start_at and start_at <= time.time() + 1:
                start_at = None
            d = self._d
            d.update(armed=True, term=term, dry=dry, allowDrop=allow_drop, startedAt=now_iso(), endedReason=None, startAt=start_at)
            d["targets"] = [
                {
                    "crn": t["crn"],
                    "subject": t["subject"],
                    "number": t["number"],
                    "label": t["label"],
                    "drops": [c for c in t.get("drops", []) if c],
                    "status": "waiting",
                    "msg": "",
                    "attempts": 0,
                    "seats": None,
                    "updatedAt": now_iso(),
                }
                for t in targets
            ]
            self.lines = []
            self.app.state.save()
        self._keep_awake(True)
        if start_at:
            wait = max(0.0, start_at - SIGN_IN_LEAD - time.time())
            self.registrar = "scheduled"
            self.detail = None
            when = datetime.fromtimestamp(start_at).strftime("%a %H:%M")
            self._log(f"[auto] scheduled: signs in a few minutes before {when}, then starts")
            self._timer = threading.Timer(wait, self._go, args=(term, targets, interval, headed, start_at))
            self._timer.daemon = True
            self._timer.start()
            self._phone(f"Auto-register {'rehearsal ' if dry else ''}scheduled for {when} ({len(targets)} section(s)). Keep the app open.")
            self._emit()
            return
        self._go(term, targets, interval, headed, None)

    def _go(self, term: str, targets: list[dict], interval: int, headed: bool, start_at: float | None) -> None:
        with self.lock:
            self._timer = None
            if not self.armed:
                return
        dry = self._d["dry"]
        radar = self.app.radar
        for t in self._d["targets"]:
            radar.add_watch(term, t["crn"], t["subject"], t["number"], t["label"])
        radar.set_interval(interval)
        radar.on_pass = self.on_pass
        radar.start()
        self._start_registrar(term, headed, start_at)
        radar.check_now()
        self._phone(f"Auto-register {'rehearsal ' if dry else ''}started for {len(targets)} section(s). I'll message you when something happens.")
        self._emit()

    def stop(self, reason: str = "Stopped") -> None:
        with self.lock:
            d = self._d
            if not d["armed"] and not self.proc:
                return
            d["armed"] = False
            d["endedReason"] = reason
            for t in d["targets"]:
                if t["status"] in ("open", "registering"):
                    t["status"] = "waiting"
            self.inflight = None
            self.app.state.save()
            proc, self.proc = self.proc, None
            timer, self._timer = self._timer, None
        if timer:
            timer.cancel()
        for t in self._d["targets"]:
            self.app.radar.remove_watch(self._d["term"], t["crn"])
        if proc:
            try:
                proc.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
                proc.stdin.flush()
            except Exception:  # noqa: BLE001
                pass
            threading.Timer(4, lambda: proc.poll() is None and proc.terminate()).start()
        self.registrar = "off"
        self._keep_awake(False)
        self._log(f"[auto] {reason}")
        if reason != "App closed":
            self._phone(f"Auto-register: {reason}")
        self._emit()

    # ------------------------------------------------------------ registrar process
    def _start_registrar(self, term: str, headed: bool, open_at: float | None = None) -> None:
        env, self._secrets = self.app.login_env()
        argv = paths.child_cmd("register") + ["--serve", "--term", term, "--log", str(paths.LOG_FILE)] + (["--headed"] if headed else [])
        if open_at:
            argv += ["--open-at", str(int(open_at))]
        self.registrar = "signing_in"
        self.detail = None
        self.proc = subprocess.Popen(
            argv,
            cwd=str(paths.WORK_DIR),
            env={**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", **paths.child_env(), **env},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=0x08000000 if sys.platform == "win32" else 0,  # CREATE_NO_WINDOW
        )
        threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()

    def _log(self, line: str) -> None:
        for s in self._secrets:
            if s and len(s) >= 4:
                line = line.replace(s, "***")
        self.lines.append(line)
        del self.lines[:-500]
        self._emit("log", line=line)

    def _read(self, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            if line.startswith("@@"):
                try:
                    self._on_event(json.loads(line[2:]))
                except ValueError:
                    self._log(line)
            else:
                self._log(line)
        rc = proc.wait()
        if proc is self.proc and self.armed:  # died while we still wanted it
            self.registrar = "error"
            self.detail = self.detail or f"registrar exited (code {rc})"
            self.stop(f"Stopped: {self.detail}")

    def _on_event(self, ev: dict) -> None:
        if ev.get("event") == "status":
            self.registrar = ev.get("state", "error")
            self.detail = ev.get("detail")
            if self.registrar == "error":
                self.stop(f"Stopped: {self.detail}")
                return
            self._emit()
            if self.registrar == "ready":
                self._dispatch()
        elif ev.get("event") == "result":
            self._on_result(ev)

    # ------------------------------------------------------------ the loop
    def on_pass(self, watches: list[dict]) -> None:
        """Called by the radar after every seat check."""
        if not self.armed:
            return
        by_crn = {(w["term"], w["crn"]): w for w in watches}
        with self.lock:
            d = self._d
            for t in d["targets"]:
                w = by_crn.get((d["term"], t["crn"]))
                if not w or t["status"] in FINAL or t["status"] == "registering":
                    continue
                t["seats"] = w.get("seats")
                t["status"] = "open" if w.get("open") else "waiting"
                t["updatedAt"] = now_iso()
            self.app.state.save()
        self._emit()
        self._dispatch()

    def _dispatch(self) -> None:
        with self.lock:
            d = self._d
            if not d["armed"] or self.registrar != "ready" or self.inflight or not self.proc:
                return
            ready = [t for t in d["targets"] if t["status"] == "open"]
            if not ready:
                return
            # Plain adds go together. A target that drops something goes in a submission of its own, so
            # Conditional Add and Drop ties each drop to exactly the section it was traded for.
            plain = [t for t in ready if not (d["allowDrop"] and t["drops"])]
            batch = plain or ready[:1]
            cmd = {
                "id": secrets.token_hex(4),
                "cmd": "register",
                "add": [t["crn"] for t in batch],
                "drop": sorted({c for t in batch for c in t["drops"]}) if d["allowDrop"] else [],
                "dry": d["dry"],
            }
            for t in batch:
                t["status"] = "registering"
                t["attempts"] += 1
                t["updatedAt"] = now_iso()
            self.inflight = {"id": cmd["id"], "crns": cmd["add"], "drop": cmd["drop"], "at": time.time()}
            self.app.state.save()
            try:
                self.proc.stdin.write(json.dumps(cmd) + "\n")
                self.proc.stdin.flush()
            except Exception as exc:  # noqa: BLE001
                self.inflight = None
                self.stop(f"Stopped: registrar unavailable ({exc})")
                return
        self._log(f"[auto] seats open -> {'rehearsing' if cmd['dry'] else 'registering'} {', '.join(cmd['add'])}")
        self._emit()

    def _on_result(self, ev: dict) -> None:
        registered: list[str] = []
        with self.lock:
            d = self._d
            results = ev.get("results", {})
            sent = self.inflight or {"crns": [], "drop": []}
            failed_now: list[str] = []
            for t in d["targets"]:
                if t["crn"] not in sent["crns"]:
                    continue
                r = results.get(t["crn"], {"ok": False, "msg": "no result from Banner", "retry": True})
                t["updatedAt"] = now_iso()
                t["msg"] = r.get("msg", "")
                if r.get("ok"):
                    t["status"] = "rehearsed" if r.get("rehearsal") else "registered"
                    if t["status"] == "registered":
                        registered.append(t["crn"])
                elif r.get("retry") and t["attempts"] < MAX_ATTEMPTS:
                    t["status"] = "waiting"
                else:
                    t["status"] = "failed"
                    if r.get("retry"):
                        t["msg"] = f"gave up after {t['attempts']} attempts: {t['msg']}"
                    failed_now.append(f'{t["label"].split(" · ")[0]}: {t["msg"]}')
            self.inflight = None
            done = all(t["status"] in FINAL for t in d["targets"])
            self.app.state.save()
            term = d["term"]
            if not (ev.get("submitted") and registered):
                dropped = []
            elif isinstance(ev.get("dropped"), list):
                dropped = [c for c in ev["dropped"] if c in sent["drop"]]
            else:
                dropped = sent["drop"]
        for t in self._d["targets"]:
            if t["status"] in FINAL:
                self.app.radar.remove_watch(term, t["crn"])
        restored, lost = ev.get("restored") or [], ev.get("lost") or []
        if restored:
            self._log(f"[auto] the add failed after the drop went through - re-added {', '.join(restored)} (you still have it)")
        if registered:
            self._emit("registered", term=term, crns=registered, dropped=dropped)
            names = [t["label"].split(" · ")[0] for t in self._d["targets"] if t["crn"] in registered]
            self._phone(f"✅ Registered {', '.join(names)}" + (f" (dropped {', '.join(dropped)})" if dropped else ""))
        for f in failed_now:
            self._phone(f"❌ Couldn't register {f}")
        if lost:
            self._phone(f"⚠️ CRN {', '.join(lost)} was dropped and could NOT be re-added. Register it manually now!")
            self._emit("lost", term=term, crns=lost)
            self.stop(f"Stopped: CRN {', '.join(lost)} was dropped and could not be re-added - register it manually now")
            return
        self._emit()
        if done:
            ok = sum(t["status"] in ("registered", "rehearsed") for t in self._d["targets"])
            self.stop(f"Finished: {ok} of {len(self._d['targets'])} sections done")
        else:
            self._dispatch()


def _safe(fn, *a) -> None:
    try:
        fn(*a)
    except Exception:  # noqa: BLE001
        pass
