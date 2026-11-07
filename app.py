#!/usr/bin/env python3
"""KFUPM Schedule Planner - the one-click desktop app.

    python app.py            open the app (native window if pywebview is installed, else your browser)
    python app.py --browser  always use your browser
    python app.py --no-window  just run the local server and print the address

Everything runs on YOUR computer:
  * the planner / off-day finder UI (same as the website)
  * scraper.py   "Update course data" button
  * register.py  Check / Dry run / Register buttons (your login is kept in the OS keychain)
  * the seat radar: watches sections and alerts you the second a seat opens
No password ever leaves the machine; the server only listens on 127.0.0.1.

Security notes: every /api call needs a per-launch random token that only this app's own page
knows (so other websites can't poke the local server), and Host/Origin headers are checked.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from secrets_store import SecretStore

import paths  # noqa: E402

ROOT = paths.SRC_ROOT
APP_HOME = paths.APP_HOME
DIST = paths.DIST_DIR
DATA = paths.DATA_DIR
VERSION = "1.0.0"
DEFAULT_PORT = 8765


# ------------------------------------------------------------------ persistence
class AppState:
    """Non-secret settings + radar watch list, in APP_HOME/state.json."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self.data: dict = {}
        if path.exists():
            try:
                self.data = json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                self.data = {}

    def save(self) -> None:
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, indent=1), encoding="utf-8")
            tmp.replace(self.path)


# ------------------------------------------------------------------ event bus (SSE)
class EventBus:
    def __init__(self):
        self.cv = threading.Condition()
        self.events: list[dict] = []
        self.next_id = 1

    def emit(self, ev: dict) -> None:
        with self.cv:
            ev = {**ev, "seq": self.next_id}  # NOT "id": job events carry their own id
            self.next_id += 1
            self.events.append(ev)
            del self.events[:-500]
            self.cv.notify_all()

    def latest_id(self) -> int:
        with self.cv:
            return self.next_id - 1

    def wait(self, after: int, timeout: float) -> list[dict]:
        with self.cv:
            if not any(e["seq"] > after for e in self.events):
                self.cv.wait(timeout)
            return [e for e in self.events if e["seq"] > after]


# ------------------------------------------------------------------ jobs (subprocess runs)
class Job:
    def __init__(self, jid: str, kind: str, argv: list[str], env: dict, secret_values: list[str]):
        self.id, self.kind, self.argv = jid, kind, argv
        self.env = env
        self.secrets = [s for s in secret_values if s]
        self.lines: list[str] = []
        self.status = "running"  # running | done | failed | cancelled
        self.rc: int | None = None
        self.started = time.time()
        self.proc: subprocess.Popen | None = None
        self.cancelled = False

    def public(self, with_lines: bool = True) -> dict:
        d = {"id": self.id, "kind": self.kind, "status": self.status, "rc": self.rc, "started": self.started}
        if with_lines:
            d["lines"] = self.lines[-400:]
        return d


class Jobs:
    def __init__(self, bus: EventBus):
        self.bus = bus
        self.lock = threading.Lock()
        self.jobs: dict[str, Job] = {}

    def active(self) -> Job | None:
        with self.lock:
            return next((j for j in self.jobs.values() if j.status == "running"), None)

    def start(self, kind: str, argv: list[str], env_extra: dict, secret_values: list[str], on_done=None) -> Job:
        with self.lock:
            if any(j.status == "running" for j in self.jobs.values()):
                raise RuntimeError("busy")
            jid = secrets.token_hex(4)
            env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", **paths.child_env(), **env_extra}
            job = Job(jid, kind, argv, env, secret_values)
            self.jobs[jid] = job
            for old in list(self.jobs)[:-15]:
                if self.jobs[old].status != "running":
                    del self.jobs[old]
        self.bus.emit({"type": "job", "id": jid, "kind": kind, "status": "running"})
        threading.Thread(target=self._run, args=(job, on_done), daemon=True).start()
        return job

    def _mask(self, job: Job, line: str) -> str:
        for s in job.secrets:
            if len(s) >= 4:
                line = line.replace(s, "***")
        return line

    def _run(self, job: Job, on_done) -> None:
        try:
            job.proc = subprocess.Popen(
                job.argv,
                cwd=str(paths.WORK_DIR),
                env=job.env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=0x08000000 if sys.platform == "win32" else 0,  # CREATE_NO_WINDOW
            )
            assert job.proc.stdout is not None
            for raw in job.proc.stdout:
                line = self._mask(job, raw.rstrip("\n"))
                job.lines.append(line)
                self.bus.emit({"type": "job", "id": job.id, "kind": job.kind, "line": line})
            job.rc = job.proc.wait()
            job.status = "cancelled" if job.cancelled else ("done" if job.rc == 0 else "failed")
        except Exception as exc:  # noqa: BLE001
            job.lines.append(f"[app] could not run: {exc}")
            job.status = "failed"
        self.bus.emit({"type": "job", "id": job.id, "kind": job.kind, "status": job.status, "rc": job.rc})
        if on_done:
            try:
                on_done(job)
            except Exception:  # noqa: BLE001
                pass

    def cancel(self, jid: str) -> bool:
        job = self.jobs.get(jid)
        if job and job.status == "running" and job.proc:
            job.cancelled = True
            job.proc.terminate()
            return True
        return False


# ------------------------------------------------------------------ the app object
class App:
    def __init__(self, port: int, home: Path = APP_HOME, store: SecretStore | None = None, radar_factory=None):
        self.port = port
        self.token = secrets.token_urlsafe(24)
        self.state = AppState(home / "state.json")
        self.secrets = store or SecretStore()
        self.bus = EventBus()
        self.jobs = Jobs(self.bus)
        from radar_service import RadarService  # local import keeps `--help` fast

        self.radar = radar_factory(self.state, self.bus.emit) if radar_factory else RadarService(self.state, self.bus.emit)
        self.home = home
        self.apply_telegram()
        from autopilot import AutoPilot

        self.auto = AutoPilot(self)
        if self.radar._d["watches"] and self.radar._d["running"]:
            self.radar.start()

    # settings ----------------------------------------------------------
    @property
    def settings(self) -> dict:
        s = self.state.data.setdefault("settings", {})
        s.setdefault("headed", True)
        s.setdefault("telegramChatId", "")
        return s

    def apply_telegram(self) -> None:
        from radar_service import telegram_sender

        token, chat = self.secrets.get_telegram_token(), self.settings.get("telegramChatId")
        self.radar.telegram_send = telegram_sender(token, chat) if token and chat else None

    def env_credentials(self) -> bool:
        if os.getenv("KFUPM_APP_IGNORE_DOTENV") or paths.FROZEN:
            return False  # the packaged app only ever uses the keychain
        try:
            from dotenv import dotenv_values

            v = dotenv_values(ROOT / ".env")
            return bool(v.get("KFUPM_ID") and v.get("KFUPM_PASSWORD"))
        except Exception:  # noqa: BLE001
            return False

    def status(self) -> dict:
        login = self.secrets.get_login()
        job = self.jobs.active()
        return {
            "app": True,
            "version": VERSION,
            "credentials": {
                "saved": bool(login),
                "id": login[0] if login else None,
                "fromEnvFile": (not login) and self.env_credentials(),
                "keychain": self.secrets.persistent,
            },
            "telegram": {"tokenSaved": bool(self.secrets.get_telegram_token()), "chatId": self.settings.get("telegramChatId", "")},
            "settings": {"headed": self.settings["headed"]},
            "job": job.public(with_lines=False) if job else None,
            "autoArmed": self.auto.armed,
            "dataReady": (DATA / "terms.json").exists(),
            "packaged": paths.FROZEN,
            "platform": sys.platform,
            "keychainBackend": _keyring_backend(),
            "ocr": _ocr_available(),
            "latestEvent": self.bus.latest_id(),
        }

    def write_diagnostics(self) -> Path:
        """Zip of logs + Banner screenshots for troubleshooting. Never includes the password
        (it is never written to any log; secrets are masked in job output)."""
        import platform
        import zipfile

        stamp = time.strftime("%Y%m%d-%H%M%S")
        desktop = Path.home() / "Desktop"
        out = (desktop if desktop.is_dir() else self.home) / f"KFUPM-Planner-diagnostics-{stamp}.zip"
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("about.json", json.dumps({"version": VERSION, "packaged": paths.FROZEN, "platform": platform.platform(), "python": sys.version.split()[0], "created": stamp}, indent=1))
            snap = self.auto.snapshot()
            z.writestr("auto-register.json", json.dumps({k: v for k, v in snap.items() if k != "lines"}, indent=1))
            z.writestr("auto-register-activity.txt", "\n".join(snap["lines"]))
            z.writestr("radar.json", json.dumps(self.radar.snapshot(), indent=1))
            for job in list(self.jobs.jobs.values())[-5:]:
                z.writestr(f"jobs/{job.kind}-{job.id}.txt", "\n".join(job.lines))
            if paths.LOG_FILE.exists():
                z.write(paths.LOG_FILE, "registration_log.txt")
            if paths.DEBUG_DIR.exists():
                shots = sorted((p for p in paths.DEBUG_DIR.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime)[-60:]
                for p in shots:
                    z.write(p, f"debug/{p.name}")
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(out)])  # show it in Finder
        return out

    # jobs --------------------------------------------------------------
    def login_env(self) -> tuple[dict, list[str]]:
        login = self.secrets.get_login()
        if login:
            return {"KFUPM_ID": login[0], "KFUPM_PASSWORD": login[1]}, [login[1]]
        if os.getenv("KFUPM_APP_IGNORE_DOTENV") or paths.FROZEN:
            return {"KFUPM_ID": "", "KFUPM_PASSWORD": ""}, []
        return {}, []  # register.py falls back to the project's .env

    def start_scrape(self, terms: str) -> Job:
        argv = paths.child_cmd("scraper")
        argv += ["--all-open"] if terms == "all-open" else (["--term", terms] if terms else [])
        return self.jobs.start("scrape", argv, {}, [], on_done=lambda j: self.bus.emit({"type": "data", "kind": "updated", "status": j.status}))

    def start_register(self, mode: str, term: str, wanted: list[str], current: list[str], allow_drop: bool, headed: bool) -> Job:
        self.home.mkdir(parents=True, exist_ok=True)
        plan_path = self.home / f"plan-{secrets.token_hex(3)}.json"
        plan_path.write_text(json.dumps({"term": term, "crns": wanted, "current": current}), encoding="utf-8")
        argv = paths.child_cmd("register") + ["--plan", str(plan_path), "--log", str(paths.LOG_FILE)]
        if mode == "check":
            argv += ["--check", "--term", term]
        elif mode == "dry":
            argv += ["--dry-run"]
        else:
            argv += ["--yes"]
        if headed:
            argv += ["--headed"]
        if allow_drop:
            argv += ["--allow-drop"]
        env, secret_values = self.login_env()

        def cleanup(_job):
            try:
                plan_path.unlink()
            except OSError:
                pass

        return self.jobs.start("register-" + mode, argv, env, secret_values, on_done=cleanup)


def _keyring_backend() -> str:
    try:
        import keyring

        k = keyring.get_keyring()
        return f"{type(k).__module__}.{type(k).__name__}"
    except Exception as exc:  # noqa: BLE001
        return f"unavailable: {exc}"


def _ocr_available() -> bool:
    try:
        import ocr

        return ocr.available()
    except Exception:  # noqa: BLE001
        return False


# ------------------------------------------------------------------ HTTP
CRN_RE = re.compile(r"^\d{4,6}$")
TERM_RE = re.compile(r"^\d{6}$")


class Handler(BaseHTTPRequestHandler):
    app: App  # set on the class by make_server()
    server_version = "KFUPMPlanner/" + VERSION

    def log_message(self, fmt, *args):  # quiet
        pass

    # --- guards ---------------------------------------------------------
    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        return host in (f"127.0.0.1:{self.app.port}", f"localhost:{self.app.port}")

    def _origin_ok(self) -> bool:
        o = self.headers.get("Origin")
        return o is None or o in (f"http://127.0.0.1:{self.app.port}", f"http://localhost:{self.app.port}")

    def _token_ok(self, query: dict) -> bool:
        t = self.headers.get("X-App-Token") or (query.get("t") or [""])[0]
        return secrets.compare_digest(t, self.app.token)

    # --- helpers --------------------------------------------------------
    def _send(self, code: int, body: bytes, ctype: str = "application/json", extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode("utf-8"))

    def _err(self, code: int, msg: str) -> None:
        self._json({"error": msg}, code)

    def _body(self, limit: int = 1_000_000) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError("body too large")
        raw = self.rfile.read(n) if n else b"{}"
        d = json.loads(raw or b"{}")
        if not isinstance(d, dict):
            raise ValueError("expected a JSON object")
        return d

    # --- dispatch -------------------------------------------------------
    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method: str):
        u = urlparse(self.path)
        query = parse_qs(u.query)
        path = unquote(u.path)
        if not self._host_ok():
            return self._err(403, "bad host")
        if path.startswith("/api/"):
            if method != "GET" and not self._origin_ok():
                return self._err(403, "bad origin")
            if not self._token_ok(query):
                return self._err(401, "missing or wrong app token")
            try:
                return self._api(method, path, query)
            except (ValueError, KeyError, TypeError) as exc:
                return self._err(400, f"bad request: {exc}")
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as exc:  # noqa: BLE001
                return self._err(500, f"{type(exc).__name__}: {exc}")
        if method != "GET":
            return self._err(405, "method not allowed")
        return self._static(path)

    # --- API ------------------------------------------------------------
    def _api(self, method: str, path: str, query: dict):
        a = self.app
        if method == "GET":
            if path == "/api/status":
                return self._json(a.status())
            if path == "/api/auto":
                return self._json(a.auto.snapshot())
            if path == "/api/radar":
                return self._json(a.radar.snapshot())
            if path == "/api/events":
                return self._sse(int((query.get("after") or ["-1"])[0]))
            m = re.fullmatch(r"/api/kv/([\w.-]{1,64})", path)
            if m:
                return self._json({"value": a.state.data.get("kv", {}).get(m.group(1))})
            m = re.fullmatch(r"/api/jobs/(\w+)", path)
            if m:
                job = a.jobs.jobs.get(m.group(1))
                return self._json(job.public()) if job else self._err(404, "no such job")
            return self._err(404, "not found")

        if method == "DELETE":
            if path == "/api/credentials":
                a.secrets.clear_login()
                return self._json({"ok": True})
            if path == "/api/radar/watch":
                term, crn = (query.get("term") or [""])[0], (query.get("crn") or [""])[0]
                return self._json({"ok": a.radar.remove_watch(term, crn)})
            return self._err(404, "not found")

        b = self._body(30_000_000 if path == "/api/ocr" else 1_000_000)
        if path == "/api/ocr":
            # on-device text recognition of a schedule screenshot (macOS Vision); nothing is uploaded
            import base64

            import ocr

            if not ocr.available():
                return self._err(501, "Screenshot import needs macOS")
            try:
                img = base64.b64decode(str(b["image"]).split(",")[-1], validate=False)
                return self._json({"lines": ocr.recognize(img)})
            except (ValueError, RuntimeError) as exc:
                return self._err(400, str(exc))
        if path == "/api/diagnostics":
            return self._json({"path": str(a.write_diagnostics())})
        if path == "/api/credentials":
            uid, pw = str(b["id"]).strip(), str(b["password"])
            if not uid or not pw:
                return self._err(400, "id and password required")
            a.secrets.set_login(uid, pw)
            return self._json({"ok": True, "keychain": a.secrets.persistent})
        m = re.fullmatch(r"/api/kv/([\w.-]{1,64})", path)
        if m:
            raw = json.dumps(b.get("value"))
            if len(raw) > 500_000:
                return self._err(413, "value too large")
            a.state.data.setdefault("kv", {})[m.group(1)] = b.get("value")
            a.state.save()
            return self._json({"ok": True})
        if path == "/api/settings":
            if "headed" in b:
                a.settings["headed"] = bool(b["headed"])
            if "telegramChatId" in b:
                a.settings["telegramChatId"] = str(b["telegramChatId"]).strip()
            if b.get("telegramToken"):
                a.secrets.set_telegram_token(str(b["telegramToken"]).strip())
            if b.get("clearTelegram"):
                a.secrets.clear_telegram_token()
                a.settings["telegramChatId"] = ""
            a.state.save()
            a.apply_telegram()
            return self._json({"ok": True})
        if path == "/api/telegram/test":
            if not a.radar.telegram_send:
                return self._err(400, "Telegram token and chat id are not both set")
            a.radar.telegram_send("✅ KFUPM Planner radar: test message")
            return self._json({"ok": True})
        if path == "/api/telegram/detect":
            from radar import Telegram

            token = a.secrets.get_telegram_token() or str(b.get("token") or "")
            if not token:
                return self._err(400, "save the bot token first")
            ups = Telegram(token).updates(0, timeout=0)
            chats = [str((u.get("message") or {}).get("chat", {}).get("id")) for u in ups if (u.get("message") or {}).get("chat")]
            if not chats:
                return self._err(404, "no messages yet - send any message to your bot in Telegram, then try again")
            return self._json({"chatId": chats[-1]})
        if path == "/api/radar/watch":
            term, crn = str(b["term"]), str(b["crn"])
            if not TERM_RE.match(term) or not CRN_RE.match(crn):
                return self._err(400, "bad term or crn")
            w = a.radar.add_watch(term, crn, str(b["subject"])[:12], str(b["number"])[:12], str(b["label"])[:200], b.get("seats"), b.get("capacity"))
            a.radar.start()
            return self._json(w)
        if path == "/api/radar/interval":
            a.radar.set_interval(int(b["seconds"]))
            return self._json({"ok": True})
        if path in ("/api/radar/pause", "/api/radar/resume", "/api/radar/check", "/api/radar/history/clear"):
            {"/api/radar/pause": a.radar.pause, "/api/radar/resume": a.radar.start, "/api/radar/check": a.radar.check_now, "/api/radar/history/clear": a.radar.clear_history}[path]()
            return self._json({"ok": True})
        if path == "/api/scrape":
            terms = str(b.get("terms") or "")
            if terms != "all-open" and not re.fullmatch(r"\d{6}(,\d{6})*|", terms):
                return self._err(400, "bad terms")
            try:
                return self._json(a.start_scrape(terms).public())
            except RuntimeError:
                return self._err(409, "another job is already running")
        if path == "/api/auto/arm":
            term = str(b["term"])
            if not TERM_RE.match(term):
                return self._err(400, "bad term")
            targets = []
            for t in b.get("targets", [])[:30]:
                crn = str(t.get("crn", ""))
                drops = [str(c) for c in t.get("drops", [])]
                if not CRN_RE.match(crn) or not all(CRN_RE.match(c) for c in drops):
                    return self._err(400, "bad crn")
                targets.append({"crn": crn, "subject": str(t["subject"])[:12], "number": str(t["number"])[:12], "label": str(t["label"])[:200], "drops": drops})
            if not targets:
                return self._err(400, "nothing to register - every section in the plan is already in your current schedule")
            if b.get("confirm") is not True:
                return self._err(400, "auto-register needs confirm: true")
            if not a.secrets.get_login() and not a.env_credentials() and not os.getenv("KFUPM_APP_IGNORE_DOTENV"):
                return self._err(400, "sign in first")
            if a.jobs.active():
                return self._err(409, "another task is running")
            try:
                a.auto.arm(term, targets, bool(b.get("dry")), bool(b.get("allowDrop")), int(b.get("interval", 10)), bool(b.get("headed", a.settings["headed"])))
            except RuntimeError as exc:
                return self._err(409, str(exc))
            return self._json(a.auto.snapshot())
        if path == "/api/auto/stop":
            a.auto.stop("Stopped by you")
            return self._json(a.auto.snapshot())
        if path == "/api/register":
            mode = str(b["mode"])
            if mode not in ("check", "dry", "live"):
                return self._err(400, "bad mode")
            term = str(b["term"])
            wanted = [str(c) for c in b.get("wanted", [])]
            current = [str(c) for c in b.get("current", [])]
            if not TERM_RE.match(term) or not all(CRN_RE.match(c) for c in wanted + current):
                return self._err(400, "bad term or crn")
            if mode != "check" and not wanted:
                return self._err(400, "plan is empty")
            if a.auto.armed:
                return self._err(409, "Auto-register is running - stop it first")
            if mode == "live" and b.get("confirm") is not True:
                return self._err(400, "live registration needs confirm: true")
            if not a.secrets.get_login() and not a.env_credentials() and not os.getenv("KFUPM_APP_IGNORE_DOTENV"):
                return self._err(400, "no KFUPM login saved yet")
            try:
                job = a.start_register(mode, term, wanted, current, bool(b.get("allowDrop")), bool(b.get("headed", a.settings["headed"])))
            except RuntimeError:
                return self._err(409, "another job is already running")
            return self._json(job.public())
        m = re.fullmatch(r"/api/jobs/(\w+)/cancel", path)
        if m:
            return self._json({"ok": a.jobs.cancel(m.group(1))})
        return self._err(404, "not found")

    def _sse(self, after: int):
        bus = self.app.bus
        if after < 0:
            after = bus.latest_id()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(b": hello\n\n")
            self.wfile.flush()
            while True:
                evs = bus.wait(after, 15)
                if not evs:
                    self.wfile.write(b": ping\n\n")
                for ev in evs:
                    self.wfile.write(f"id: {ev['seq']}\ndata: {json.dumps(ev)}\n\n".encode("utf-8"))
                    after = ev["seq"]
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    # --- static files ---------------------------------------------------
    def _static(self, path: str):
        if path.startswith("/data/") and path.endswith(".json"):
            target = (DATA / path[len("/data/"):]).resolve()
            base = DATA.resolve()
        else:
            base = DIST.resolve()
            rel = path.lstrip("/") or "index.html"
            target = (base / rel).resolve()
            if not target.is_file():
                target = base / "index.html"  # SPA fallback
        if base not in target.parents and target != base:
            return self._err(403, "forbidden")
        if not target.is_file():
            if target.name == "index.html":
                return self._send(
                    503,
                    b"<h1>Frontend not built</h1><p>Run <code>cd frontend &amp;&amp; npm install &amp;&amp; npm run build</code>, then restart the app.</p>",
                    "text/html; charset=utf-8",
                )
            return self._err(404, "not found")
        body = target.read_bytes()
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.name == "index.html":
            meta = f'<meta name="app-token" content="{self.app.token}">'.encode()
            body = body.replace(b"<head>", b"<head>" + meta, 1)
            ctype = "text/html; charset=utf-8"
        self._send(200, body, ctype)


def make_server(app: App, port: int) -> ThreadingHTTPServer:
    Handler.app = app
    ThreadingHTTPServer.daemon_threads = True
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def find_port(start: int) -> int:
    import socket

    for p in range(start, start + 20):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise SystemExit("No free port near %d" % start)


def run_subcommand(argv: list[str]) -> int:
    """`<app> --run scraper|register ...` - lets the packaged app run its own scripts (no python inside)."""
    module, rest = argv[0], argv[1:]
    if module not in ("scraper", "register"):
        print(f"unknown subcommand {module}", file=sys.stderr)
        return 2
    # A windowed Windows build starts with sys.stdin/stdout/stderr = None even when the parent gave it
    # pipes; reattach them so the app can read this process's output and send it commands.
    for name, fd, mode in (("stdin", 0, "r"), ("stdout", 1, "w"), ("stderr", 2, "w")):
        if getattr(sys, name) is None:
            try:
                setattr(sys, name, open(fd, mode, buffering=1, encoding="utf-8", errors="replace", closefd=False))
            except OSError:
                pass
    sys.argv = [module + ".py", *rest]
    mod = __import__(module)
    return int(mod.main() or 0)


def ensure_data() -> None:
    """First launch of the packaged app: copy the bundled course-data snapshot into app-data."""
    if (DATA / "terms.json").exists() or not paths.SEED_DATA or not paths.SEED_DATA.exists():
        return
    import shutil

    DATA.mkdir(parents=True, exist_ok=True)
    for f in paths.SEED_DATA.glob("*.json"):
        shutil.copy2(f, DATA / f.name)


def main() -> int:
    if len(sys.argv) > 2 and sys.argv[1] == "--run":
        return run_subcommand(sys.argv[2:])
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--browser", action="store_true", help="open in your browser even if pywebview is installed")
    ap.add_argument("--no-window", action="store_true", help="don't open anything; just serve")
    args = ap.parse_args()

    APP_HOME.mkdir(parents=True, exist_ok=True)
    ensure_data()
    port = find_port(args.port)
    app = App(port)
    server = make_server(app, port)
    url = f"http://127.0.0.1:{port}/"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"KFUPM Schedule Planner running at {url}   (Ctrl-C to quit)")
    if port != args.port:
        print(f"  note: port {args.port} was busy; browser-saved plans are per-port.")
    if not DIST.exists():
        print("  ! the built UI is missing - run: cd frontend && npm install && npm run build")

    if args.no_window:
        window = None
    elif not args.browser:
        try:
            import webview  # type: ignore

            if sys.platform == "darwin":
                # dark title bar to match the UI, regardless of the system appearance
                try:
                    import AppKit  # type: ignore  (comes with pywebview's pyobjc)

                    AppKit.NSApplication.sharedApplication().setAppearance_(AppKit.NSAppearance.appearanceNamed_(AppKit.NSAppearanceNameDarkAqua))
                except Exception:  # noqa: BLE001
                    pass

            webview.create_window(
                paths.APP_NAME,
                url,
                width=1440,
                height=900,
                min_size=(1100, 700),
                background_color="#0A0A0A",
                text_select=True,
            )
            # private_mode=False + a storage path keep the window's browser storage between launches
            webview.start(private_mode=False, storage_path=str(APP_HOME / "webview"))
            app.auto.stop("App closed")
            app.radar.shutdown()
            return 0
        except ImportError:
            window = None
        except Exception as exc:  # noqa: BLE001
            print(f"  (native window unavailable: {exc}; using the browser)")
            window = None
    if not args.no_window:
        webbrowser.open(url)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("bye")
        app.auto.stop("App closed")
        app.radar.shutdown()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
