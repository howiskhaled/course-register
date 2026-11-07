#!/usr/bin/env python3
"""Seat radar - a Telegram bot that tells you when a full section gets a free seat.

It only reads KFUPM's PUBLIC class search (same data as scraper.py), so it needs NO KFUPM
login and never sees anyone's password. One running bot can serve many classmates: each
chat has its own watch list.

Setup (2 minutes):
  1. In Telegram talk to @BotFather -> /newbot -> copy the token.
  2. Put it in .env:  TELEGRAM_BOT_TOKEN=123456:ABC...
  3. python radar.py
  4. In Telegram open your bot and send:   /watch 25052        (a CRN)
                                           /watch 25052 202620 (CRN + term code)
Commands: /watch CRN [term]   /unwatch CRN   /list   /terms   /help

You get a message when a watched section goes from full -> has seats, and again if it
fills up and re-opens later.

Other modes:
  python radar.py --once              one check pass, print what would be sent, exit (no Telegram needed)
  python radar.py --add 25052 --chat 123456789   add a CRN to a chat's list from the command line

Optional .env:  RADAR_INTERVAL=120  (seconds between checks, min 30)
                RADAR_ALLOWED_CHATS=111,222  (only these chat ids may use the bot)
                RADAR_MAX_WATCH=25  (max CRNs per chat)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import requests
from dotenv import load_dotenv

from scraper import BannerClient, DEFAULT_BASE, pick_default_term

ROOT = Path(__file__).resolve().parent
STATE_PATH = ROOT / "radar_state.json"
CATALOG_TTL = 3600  # re-read the full term list (to resolve CRN -> course) at most hourly


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


# ------------------------------------------------------------------ state
def load_state(path: Path = STATE_PATH) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            pass
    return {"chats": {}, "last": {}, "offset": 0}


def save_state(state: dict, path: Path = STATE_PATH) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1), encoding="utf-8")
    tmp.replace(path)


# ------------------------------------------------------------------ Banner side
class Catalog:
    """CRN -> {subject, number, ...} for a term, cached; plus live seat lookups per course."""

    def __init__(self, base: str = DEFAULT_BASE):
        self.base = base
        self._index: dict[str, dict[str, dict]] = {}
        self._loaded: dict[str, float] = {}
        self._terms: list[dict] = []

    def terms(self) -> list[dict]:
        if not self._terms:
            self._terms = BannerClient(self.base).terms()
        return self._terms

    def default_term(self) -> str:
        return pick_default_term(self.terms())["code"]

    def term_label(self, code: str) -> str:
        return next((t["description"] for t in self.terms() if t["code"] == code), code)

    def lookup(self, term: str, crn: str) -> dict | None:
        if term not in self._index or time.time() - self._loaded.get(term, 0) > CATALOG_TTL:
            if crn in self._index.get(term, {}):  # known CRNs don't need a refresh
                return self._index[term][crn]
            log(f"loading full catalog for {term} ...")
            raw = BannerClient(self.base).sections(term)
            self._index[term] = {r["courseReferenceNumber"]: r for r in raw}
            self._loaded[term] = time.time()
        return self._index[term].get(crn)

    def live(self, term: str, courses: set[tuple[str, str]]) -> dict[str, dict]:
        """Fresh raw sections {crn: raw} for each (subject, number)."""
        out: dict[str, dict] = {}
        client = self._session(term)
        failed = 0
        for subject, number in sorted(courses):
            try:
                for r in client.course_sections(term, subject, number):
                    out[r["courseReferenceNumber"]] = r
            except Exception as exc:  # noqa: BLE001
                failed += 1
                log(f"  ! {subject} {number}: {exc}")
        if failed:
            self._sessions.pop(term, None)  # start a fresh Banner session next time
        return out

    def _session(self, term: str) -> BannerClient:
        """One Banner search session per term, reused between checks (2 requests per course per
        check instead of 4) and renewed every 20 minutes, before Banner's 30-minute timeout."""
        if not hasattr(self, "_sessions"):
            self._sessions = {}
        hit = self._sessions.get(term)
        if hit and time.time() - hit[1] < 20 * 60:
            return hit[0]
        client = BannerClient(self.base, delay=0)
        client.start_session()
        client.select_term(term)
        self._sessions[term] = (client, time.time())
        return client


def describe(raw: dict) -> str:
    return f'{raw["subject"]} {raw["courseNumber"]}-{raw["sequenceNumber"]} (CRN {raw["courseReferenceNumber"]}) - {raw.get("courseTitle", "")}'


# ------------------------------------------------------------------ commands
HELP = (
    "Seat radar - I tell you when a full section opens up.\n\n"
    "/watch CRN [term]  start watching a section\n"
    "/unwatch CRN       stop watching it\n"
    "/list              what you're watching\n"
    "/terms             term codes\n\n"
    "Example: /watch 25052"
)


def handle_command(text: str, chat_id: str, state: dict, catalog: Catalog, max_watch: int = 25) -> str | None:
    parts = text.strip().split()
    if not parts or not parts[0].startswith("/"):
        return None
    cmd = parts[0].split("@")[0].lower()
    args = parts[1:]
    chat = state["chats"].setdefault(chat_id, {"watch": []})
    watch: list[dict] = chat["watch"]

    if cmd in ("/start", "/help"):
        return HELP
    if cmd == "/terms":
        return "\n".join(f'{t["code"]}  {t["description"]}' for t in catalog.terms()[:6])
    if cmd == "/list":
        if not watch:
            return "You're not watching anything. Try /watch 25052"
        lines = []
        for w in watch:
            lines.append(f'- {w["label"]} [{w["term"]}]')
        return "Watching:\n" + "\n".join(lines)
    if cmd == "/unwatch":
        if not args:
            return "Usage: /unwatch CRN"
        before = len(watch)
        chat["watch"] = [w for w in watch if w["crn"] != args[0]]
        return "Stopped watching." if len(chat["watch"]) < before else f"You weren't watching {args[0]}."
    if cmd == "/watch":
        if not args or not args[0].isdigit():
            return "Usage: /watch CRN [term]   e.g. /watch 25052"
        crn = args[0]
        term = args[1] if len(args) > 1 else catalog.default_term()
        if any(w["crn"] == crn and w["term"] == term for w in watch):
            return f"Already watching {crn}."
        if len(watch) >= max_watch:
            return f"Watch limit reached ({max_watch}). /unwatch something first."
        raw = catalog.lookup(term, crn)
        if raw is None:
            return f"No section with CRN {crn} in {catalog.term_label(term)} ({term}). Check the CRN/term (/terms)."
        label = describe(raw)
        watch.append({"crn": crn, "term": term, "subject": raw["subject"], "number": raw["courseNumber"], "label": label})
        seats = raw.get("seatsAvailable")
        state["last"][f"{term}:{crn}"] = bool(seats and seats > 0)
        status = f"{seats} seat(s) free right now - go register!" if seats and seats > 0 else "currently FULL"
        return f"Watching {label}\n{status}. I'll message you the moment a seat opens."
    return "Unknown command. /help"


# ------------------------------------------------------------------ seat check
def check_watches(state: dict, catalog: Catalog) -> list[tuple[str, str]]:
    """One pass over every watched section. Returns [(chat_id, message), ...] to send."""
    by_term: dict[str, set[tuple[str, str]]] = {}
    for chat in state["chats"].values():
        for w in chat["watch"]:
            by_term.setdefault(w["term"], set()).add((w["subject"], w["number"]))
    live: dict[tuple[str, str], dict] = {}
    for term, courses in by_term.items():
        for crn, raw in catalog.live(term, courses).items():
            live[(term, crn)] = raw

    msgs: list[tuple[str, str]] = []
    for chat_id, chat in state["chats"].items():
        for w in chat["watch"]:
            raw = live.get((w["term"], w["crn"]))
            if raw is None:
                continue  # transient failure; keep previous state
            seats = raw.get("seatsAvailable") or 0
            now_open = seats > 0
            key = f'{w["term"]}:{w["crn"]}'
            was_open = state["last"].get(key, False)
            if now_open and not was_open:
                msgs.append((chat_id, f'SEAT OPEN: {w["label"]}\n{seats} seat(s) available now. Register fast!\n(/unwatch {w["crn"]} to stop)'))
            state["last"][key] = now_open
    return msgs


# ------------------------------------------------------------------ Telegram
class Telegram:
    def __init__(self, token: str):
        self.url = f"https://api.telegram.org/bot{token}"
        self.s = requests.Session()

    def updates(self, offset: int, timeout: int = 10) -> list[dict]:
        r = self.s.get(f"{self.url}/getUpdates", params={"offset": offset, "timeout": timeout}, timeout=timeout + 15)
        r.raise_for_status()
        return r.json().get("result", [])

    def send(self, chat_id: str, text: str) -> None:
        r = self.s.post(f"{self.url}/sendMessage", json={"chat_id": chat_id, "text": text}, timeout=20)
        if not r.ok:
            log(f"  ! telegram send failed {r.status_code}: {r.text[:120]}")


def main() -> int:
    load_dotenv(ROOT / ".env")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true", help="single check pass; print instead of sending")
    ap.add_argument("--add", metavar="CRN", help="add a CRN to --chat's watch list and exit")
    ap.add_argument("--chat", help="chat id for --add")
    ap.add_argument("--term", help="term code for --add (default: best current term)")
    ap.add_argument("--state", default=str(STATE_PATH))
    ap.add_argument("--base", default=os.getenv("BANNER_BASE", DEFAULT_BASE))
    args = ap.parse_args()

    state_path = Path(args.state)
    state = load_state(state_path)
    catalog = Catalog(args.base)
    interval = max(30, int(os.getenv("RADAR_INTERVAL", "120")))
    max_watch = int(os.getenv("RADAR_MAX_WATCH", "25"))
    allowed = {c.strip() for c in os.getenv("RADAR_ALLOWED_CHATS", "").split(",") if c.strip()}

    if args.add:
        if not args.chat:
            print("--add needs --chat", file=sys.stderr)
            return 2
        print(handle_command(f"/watch {args.add} {args.term or ''}", args.chat, state, catalog, max_watch))
        save_state(state, state_path)
        return 0

    if args.once:
        for chat_id, msg in check_watches(state, catalog):
            print(f"-> chat {chat_id}:\n{msg}\n")
        save_state(state, state_path)
        return 0

    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        print("TELEGRAM_BOT_TOKEN is not set (see the top of radar.py for the 2-minute setup).", file=sys.stderr)
        return 2
    tg = Telegram(token)
    log(f"Radar running. Checking every {interval}s. Ctrl-C to stop.")
    next_check = 0.0
    while True:
        try:
            for upd in tg.updates(state.get("offset", 0)):
                state["offset"] = upd["update_id"] + 1
                m = upd.get("message") or {}
                text, chat_id = m.get("text", ""), str((m.get("chat") or {}).get("id", ""))
                if not text or not chat_id:
                    continue
                if allowed and chat_id not in allowed:
                    tg.send(chat_id, "Sorry, this bot is private.")
                    continue
                reply = handle_command(text, chat_id, state, catalog, max_watch)
                if reply:
                    tg.send(chat_id, reply)
                save_state(state, state_path)
            if time.time() >= next_check:
                next_check = time.time() + interval
                n = sum(len(c["watch"]) for c in state["chats"].values())
                if n:
                    log(f"checking {n} watched section(s) ...")
                    for chat_id, msg in check_watches(state, catalog):
                        log(f"  notify {chat_id}: {msg.splitlines()[0]}")
                        tg.send(chat_id, msg)
                    save_state(state, state_path)
        except KeyboardInterrupt:
            log("bye")
            return 0
        except (requests.RequestException, RuntimeError) as exc:
            log(f"  ! {type(exc).__name__}: {exc} - retrying in 15s")
            time.sleep(15)


if __name__ == "__main__":
    raise SystemExit(main())
