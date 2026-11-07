#!/usr/bin/env python3
"""Auto-registration helper for KFUPM Banner 9 (Playwright).

    python register.py --dry-run          # walk through everything, stop before final submit
    python register.py                    # really register (asks you to type YES first)
    python register.py --headed --dry-run # watch the browser while it runs

Reads  plan.json   -> either ["25052", "25053"]  or  {"term": "202620", "crns": [...]}
                      (the web app's "Download plan.json" button writes the second form)
Reads  .env        -> KFUPM_ID, KFUPM_PASSWORD
Writes registration_log.txt (appended) and, on any failure, debug/ screenshots + HTML.

Flow (standard Banner 9 "Register for Classes"):
  SSO login -> /ssb/term/termSelection?mode=registration -> pick term -> "Enter CRNs" tab
  -> type each CRN + "Add to Summary" -> (dry-run stops here) -> "Submit" -> read per-CRN status.

NOTE: the page selectors below are Banner 9's stock ids (#txt_crn1, #addCRNbutton, #saveButton ...)
with text-based fallbacks. They were not exercised against a logged-in KFUPM session while this
was written (that needs a real account), so use --dry-run --headed first and check the screenshots
in debug/ if a step can't find its element.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import Page, TimeoutError as PWTimeout

from kfupm_auth import LoginError, logged_in_page

ROOT = Path(__file__).resolve().parent
DEFAULT_BASE = "https://banner9-registration.kfupm.edu.sa/StudentRegistrationSsb"
import paths  # noqa: E402

LOG_PATH = paths.LOG_FILE
DEBUG_DIR = paths.DEBUG_DIR
STEP_TIMEOUT = 20_000


# ---------------------------------------------------------------- logging
class Log:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def __call__(self, msg: str) -> None:
        line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
        print(line)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")


# ---------------------------------------------------------------- plan
def _clean_crns(items, path: Path, what: str) -> list[str]:
    out: list[str] = []
    for c in items:
        c = str(c).strip()
        if not re.fullmatch(r"\d{4,6}", c):
            raise SystemExit(f"Invalid CRN {c!r} in {what} of {path} (expected 4-6 digits)")
        if c not in out:
            out.append(c)
    return out


def load_plan(path: Path) -> tuple[str | None, list[str], list[str]]:
    """Returns (term, wanted_crns, current_crns).

    plan.json may be a bare list  ["25052", ...]  or
      {"term": "202620", "crns": [wanted...], "current": [what you're registered in now...]}
    """
    if not path.exists():
        raise SystemExit(f"{path} not found. Export it from the web app (Download plan.json) or create it by hand.")
    data = json.loads(path.read_text(encoding="utf-8"))
    term, current = None, []
    if isinstance(data, dict):
        term = str(data["term"]) if data.get("term") else None
        current = _clean_crns(data.get("current", []), path, "'current'")
        data = data.get("crns", [])
    crns = _clean_crns(data, path, "'crns'")
    if not crns:
        raise SystemExit(f"{path} contains no CRNs")
    return term, crns, current


def diff_plan(wanted: list[str], current: list[str]) -> tuple[list[str], list[str], list[str]]:
    """(to_add, to_drop, keep). With no `current` list nothing is ever dropped."""
    have = set(current)
    to_add = [c for c in wanted if c not in have]
    keep = [c for c in wanted if c in have]
    to_drop = [c for c in current if c not in set(wanted)]
    return to_add, to_drop, keep


# ---------------------------------------------------------------- page helpers
class RegistrationClosed(RuntimeError):
    """Login + term selection worked, but Banner says this student can't register yet."""


def snapshot(page: Page, name: str) -> None:
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%H%M%S")
    try:
        (DEBUG_DIR / f"{stamp}-{name}.html").write_text(page.content(), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        print(f"  (could not save HTML snapshot: {exc})", file=sys.stderr)
    try:
        page.screenshot(path=str(DEBUG_DIR / f"{stamp}-{name}.png"), timeout=10_000)
    except Exception as exc:  # noqa: BLE001
        print(f"  (could not save screenshot: {exc})", file=sys.stderr)
    print(f"  debug snapshot saved: {DEBUG_DIR}/{stamp}-{name}.*")


def first_visible(page: Page, *selectors: str, timeout: int = STEP_TIMEOUT):
    """Return a locator for the first selector that becomes visible."""
    deadline = timeout
    per = max(1500, timeout // max(len(selectors), 1))
    last = None
    for sel in selectors:
        loc = page.locator(sel).first
        try:
            loc.wait_for(state="visible", timeout=min(per, deadline))
            return loc
        except PWTimeout as exc:
            last = exc
    raise PWTimeout(f"none of {selectors} became visible") from last


def banner_errors(page: Page) -> list[str]:
    """Error notifications only (Banner's notification centre), e.g. time-ticket or hold messages."""
    out: list[str] = []
    for sel in (".error-container .notification-message", ".notification-center-message-error .notification-message"):
        try:
            for t in page.locator(sel).all_inner_texts():
                t = " ".join(t.split())
                if t and t not in out:
                    out.append(t)
        except Exception:  # noqa: BLE001
            pass
    return out


def banner_messages(page: Page) -> list[str]:
    """Collect Banner's notification-center / inline error texts currently on the page."""
    texts: list[str] = []
    for sel in (
        ".notification-flyout-item",
        ".notification-item",
        "#notification-center .message",
        ".error-message",
        ".alert-error",
        "[role=alert]",
    ):
        try:
            for t in page.locator(sel).all_inner_texts():
                t = " ".join(t.split())
                t = t[:-3].rstrip() if t.endswith(" Ok") else t  # drop the notification's "Ok" button text
                if t and t.lower() != "ok" and t not in texts:
                    texts.append(t)
        except Exception:  # noqa: BLE001
            pass
    return texts


def select_term(page: Page, base: str, term: str | None, log: Log) -> str:
    page.goto(f"{base}/ssb/term/termSelection?mode=registration", wait_until="domcontentloaded")
    # Resolve a human description for the term code through the public term list.
    desc = None
    if term:
        try:
            terms = page.request.get(f"{base}/ssb/classSearch/getTerms", params={"offset": 1, "max": 100}).json()
            desc = next((t["description"] for t in terms if t["code"] == term), None)
        except Exception:  # noqa: BLE001
            pass
    box = first_visible(page, "#s2id_txt_term a.select2-choice", "#s2id_txt_term", "#txt_term")
    box.click()
    # The list is loaded over AJAX and first shows "Searching..." - wait for real options.
    # Each real option looks like <div id="202620">Second Semester 2026-27</div>.
    real = page.locator(".select2-results li.select2-result-selectable")
    labels: list[str] = []
    for _ in range(40):  # up to ~20 s
        labels = [t.strip() for t in real.all_inner_texts() if t.strip() and "searching" not in t.lower() and "loading" not in t.lower()]
        if labels:
            break
        page.wait_for_timeout(500)
    log(f"Terms open for registration: {labels}")
    if not labels:
        raise RuntimeError("Banner offers no term for registration (registration may not be open for you yet).")
    if term:
        needle = (desc or term).lower()
        pick = next((l for l in labels if needle in l.lower() or term in l), None)
        if pick is None:
            raise RuntimeError(f"Term {term} ({desc}) is not open for registration. Open: {labels}")
    else:
        # no term given: prefer a regular semester over a Summer session
        pick = next((l for l in labels if "summer" not in l.lower()), labels[0])
    target = real.filter(has_text=pick).first
    target.scroll_into_view_if_needed()
    target.click()
    # make sure the dropdown (and its click-mask) is gone before pressing Continue
    page.locator("#select2-drop-mask").first.wait_for(state="hidden", timeout=5000) if page.locator("#select2-drop-mask").count() else None
    log(f"Selected term: {pick}")
    go = first_visible(page, "#term-go", "button:has-text('Continue')")
    # Banner answers this POST with {"regAllowed": bool, "studentEligFailures": [...], "fwdURL": ...}
    with page.expect_response(
        lambda r: "/term/search" in r.url and r.request.method == "POST", timeout=30_000
    ) as resp_info:
        go.click()
    try:
        verdict = resp_info.value.json()
    except Exception:  # noqa: BLE001
        verdict = {}
    if verdict.get("regAllowed") is False:
        reasons = verdict.get("studentEligFailures") or ["(Banner gave no reason)"]
        raise RegistrationClosed(f"Registration is not open for you in '{pick}': {'; '.join(map(str, reasons))}")
    # KFUPM reports time tickets / holds as an error notification and simply stays on "Select a Term"
    # (seen: "Time tickets prevent registration at this time."), so watch the page too.
    for _ in range(16):  # up to ~8 s
        if "classRegistration" in page.url:
            break
        errors = banner_errors(page)
        if errors:
            raise RegistrationClosed(f"Registration is not open for you in '{pick}': {'; '.join(errors)}")
        page.wait_for_timeout(500)
    page.wait_for_load_state("domcontentloaded")
    return pick


def open_enter_crns(page: Page) -> None:
    first_visible(
        page,
        "#enterCRNs-tab",
        "a[data-hint*='CRN' i]",
        "a:has-text('Enter CRNs')",
        "button:has-text('Enter CRNs')",
        timeout=40_000,
    ).click()
    first_visible(page, "#txt_crn1", "input[id^='txt_crn']")


def add_crn(page: Page, crn: str) -> None:
    box = first_visible(page, "#txt_crn1", "input[id^='txt_crn']")
    box.fill(crn)
    first_visible(page, "#addCRNbutton", "button:has-text('Add to Summary')").click()
    page.wait_for_timeout(900)  # Banner validates asynchronously


def _summary_row(page: Page, crn: str):
    """The summary row whose CRN column is exactly `crn` (falls back to any row mentioning it)."""
    exact = page.locator(f"#summaryBody tr:has(td[data-property='courseReferenceNumber']:text-is('{crn}'))").first
    try:
        exact.wait_for(state="visible", timeout=STEP_TIMEOUT)
        return exact
    except PWTimeout:
        row = page.locator("#summaryBody tr, table[id*='summary' i] tbody tr").filter(has_text=crn).first
        row.wait_for(state="visible", timeout=5_000)
        return row


def _chosen_action(page: Page, crn: str) -> str | None:
    """Text of the option currently selected in the row's Action dropdown (e.g. 'None', 'WEB DROP')."""
    return page.evaluate(
        "crn => { const s = document.getElementById(`action-${crn}-ddl`);"
        " return s && s.selectedIndex >= 0 ? s.options[s.selectedIndex].text : null; }",
        crn,
    )


def mark_drop(page: Page, crn: str) -> None:
    """Set the summary row of an already-registered CRN to KFUPM's 'WEB DROP' action.

    Real KFUPM markup: a select2 dropdown #s2id_action-<CRN>-ddl over <select id="action-<CRN>-ddl">
    with options None / WEB DROP. Nothing is saved until Submit.
    """
    row = _summary_row(page, crn)
    try:
        trigger = page.locator(f"#s2id_action-{crn}-ddl a.select2-choice")
        (trigger if trigger.count() else row.locator("a.select2-choice").first).click()
        option = page.locator(".select2-drop-active .select2-results li, .select2-results li").filter(has_text=re.compile(r"\bdrop\b", re.I)).first
        option.wait_for(state="visible", timeout=STEP_TIMEOUT)
        option.click()
        page.wait_for_timeout(500)
    except Exception:  # noqa: BLE001 - fall through to the direct method below
        pass
    if "drop" not in (_chosen_action(page, crn) or "").lower():
        # set Banner's own <select> and fire the change event its scripts listen for
        page.evaluate(
            "crn => { const s = document.getElementById(`action-${crn}-ddl`); if (!s) return;"
            " const o = [...s.options].find(o => /drop/i.test(o.text)); if (!o) return; s.value = o.value;"
            " if (window.jQuery) window.jQuery(s).trigger('change'); else s.dispatchEvent(new Event('change', {bubbles: true})); }",
            crn,
        )
        page.wait_for_timeout(400)
    chosen = _chosen_action(page, crn)
    if chosen is not None and "drop" not in chosen.lower():
        raise RuntimeError(f"could not set CRN {crn} to WEB DROP (still '{chosen}')")


def read_summary(page: Page) -> dict[str, str]:
    """{crn: 'STATUS | row text'} read from Banner's own summary columns (CRN + Status cells)."""
    rows: dict[str, str] = {}
    try:
        data = page.evaluate(
            """() => [...document.querySelectorAll('#summaryBody tr')].map(tr => {
                 const cell = p => ((tr.querySelector(`td[data-property="${p}"]`) || {}).innerText || '').trim();
                 return {crn: cell('courseReferenceNumber'), status: cell('status'), text: tr.innerText.replace(/\\s+/g, ' ').trim()};
               })"""
        )
        for r in data:
            if re.fullmatch(r"\d{4,6}", r["crn"]):
                rows[r["crn"]] = f'{r["status"] or "?"} | {r["text"]}'
    except Exception:  # noqa: BLE001
        pass
    if rows:
        return rows
    for sel in ("#summaryBody tr", "table[id*='summary' i] tbody tr"):  # fallback: older layouts
        try:
            for t in page.locator(sel).all_inner_texts():
                t = " ".join(t.split())
                m = re.search(r"\b(\d{5})\b", t)
                if m:
                    rows[m.group(1)] = f"? | {t}"
            if rows:
                break
        except Exception:  # noqa: BLE001
            pass
    return rows


ERROR_WORDS = ("error", "closed", "conflict", "full", "restriction", "prerequisite", "fail", "not allowed", "not available", "time ticket", "hold", "maximum", "corequisite", "link")


def classify(row: str | None, crn: str, messages: list[str]) -> tuple[bool, str]:
    """Did adding `crn` work? Uses Banner's Status column first, then its notifications."""
    related = [m for m in messages if crn in m]
    dup = next((m for m in related if "duplicate" in m.lower() and "registration" in m.lower()), None)
    if dup:
        return True, f"already registered ({dup})"
    if row is None:
        return False, related[0] if related else "CRN did not appear in the summary (invalid or rejected)"
    status = row.split(" | ", 1)[0].lower()
    reason = related[0] if related else row.split(" | ", 1)[0]
    if "error" in status or "deleted" in status:
        return False, reason
    if related and any(w in related[0].lower() for w in ERROR_WORDS):
        return False, related[0]
    if "registered" in status and "not" not in status:
        return True, row.split(" | ", 1)[0]
    if "pending" in status or status == "?":
        low = row.lower()
        if any(w in low for w in ERROR_WORDS) and "registered" not in low:
            return False, reason
        return True, row.split(" | ", 1)[0]
    return True, row.split(" | ", 1)[0]


# ---------------------------------------------------------------- main
# ---------------------------------------------------------------- serve mode (auto-register)
RETRYABLE = ("closed", "full", "no seats", "capacity", "wait list", "waitlist", "not open", "not available")


def retryable(msg: str) -> bool:
    """A failure worth retrying when the seat opens again (vs. prerequisites / restrictions / holds)."""
    low = (msg or "").lower()
    return any(w in low for w in RETRYABLE)


def _ready_page(page: Page, base: str) -> None:
    try:
        if "classRegistration" in page.url and page.locator("#txt_crn1, input[id^='txt_crn']").first.is_visible():
            return
    except Exception:  # noqa: BLE001
        pass
    page.goto(f"{base}/ssb/classRegistration/classRegistration", wait_until="domcontentloaded")
    open_enter_crns(page)


def tick_conditional_add_drop(page: Page, log: Log) -> bool:
    """Tick Banner's "Conditional Add and Drop" (KFUPM: <input id="conditionalAddDrop"> in the footer, drawn
    as a custom box so the input itself can be invisible). It makes Banner undo a drop if the add fails."""
    box = page.locator("#conditionalAddDrop, input[name*='conditional' i]").first
    if box.count() == 0:
        log("  conditional add/drop: not offered - the app will verify and re-add if needed")
        return False
    if not box.is_checked():
        for attempt in (
            lambda: box.check(timeout=3000),
            lambda: page.locator("label[for='conditionalAddDrop']").first.click(timeout=3000),
            lambda: box.check(force=True, timeout=3000),
            lambda: page.evaluate("() => { const b = document.getElementById('conditionalAddDrop'); if (b && !b.checked) b.click(); }"),
        ):
            try:
                attempt()
            except Exception:  # noqa: BLE001
                pass
            if box.is_checked():
                break
    ok = box.is_checked()
    log("  conditional add/drop: ON (Banner will undo the drop if the add fails)" if ok else "  conditional add/drop: could NOT be ticked - the app will verify and re-add if needed")
    return ok


def _submit_and_read(page: Page, log: Log) -> tuple[dict[str, str], list[str]]:
    first_visible(page, "#saveButton", "button:has-text('Submit')").click()
    page.wait_for_timeout(3500)
    summary, messages = read_summary(page), banner_messages(page)
    for m in messages:
        log(f"  banner: {m}")
    return summary, messages


def _still_registered(row: str | None) -> bool:
    """After a submit: is this (previously registered) CRN still registered?"""
    if row is None:
        return False  # gone from the summary = dropped
    status = row.split(" | ", 1)[0].lower()
    return "registered" in status and "drop" not in status and "delete" not in status


def _register_once(page: Page, base: str, add: list[str], drop: list[str], dry: bool, log: Log) -> dict:
    _ready_page(page, base)
    results: dict[str, tuple[bool, str]] = {}
    for crn in add:
        try:
            add_crn(page, crn)
        except Exception as exc:  # noqa: BLE001
            results[crn] = (False, f"could not add: {exc}")
    for crn in drop:
        try:
            mark_drop(page, crn)
        except Exception as exc:  # noqa: BLE001
            results["-" + crn] = (False, f"could not mark for drop: {exc}")
    summary, messages = read_summary(page), banner_messages(page)
    for m in messages:
        log(f"  banner: {m}")
    for crn in add:
        results.setdefault(crn, classify(summary.get(crn), crn, messages))

    submitted = False
    restored: list[str] = []
    lost: list[str] = []
    if dry:
        if drop:
            tick_conditional_add_drop(page, log)
        snapshot(page, "auto-rehearsal")
        log("REHEARSAL: staged everything, did NOT submit.")
    elif drop and any(not ok for ok, _ in results.values()):
        log("Not submitting: a staged add failed and drops were involved.")
    else:
        if drop:
            tick_conditional_add_drop(page, log)
        summary, messages = _submit_and_read(page, log)
        submitted = True
        for crn in add:
            if results[crn][0]:
                results[crn] = classify(summary.get(crn), crn, messages)
        snapshot(page, "auto-after-submit")

        # Safety net for swaps: the add failed but Banner still dropped the old section -> put it back now.
        if drop and any(not results[c][0] for c in add):
            gone = [c for c in drop if not _still_registered(summary.get(c))]
            if gone:
                log(f"  ! add failed but {gone} was dropped - re-adding it immediately")
                _ready_page(page, base)
                for c in gone:
                    try:
                        add_crn(page, c)
                    except Exception as exc:  # noqa: BLE001
                        log(f"  ! could not stage re-add of {c}: {exc}")
                summary2, messages2 = _submit_and_read(page, log)
                snapshot(page, "auto-restore")
                for c in gone:
                    ok, msg = classify(summary2.get(c), c, messages2)
                    (restored if ok else lost).append(c)
                    log(f"  {'restored' if ok else 'COULD NOT RESTORE'} {c}: {msg}")

    # fresh page for the next command (also discards anything left unsubmitted)
    page.goto(f"{base}/ssb/classRegistration/classRegistration", wait_until="domcontentloaded")
    open_enter_crns(page)
    return {
        "submitted": submitted,
        "restored": restored,
        "lost": lost,
        "results": {
            k: {"ok": ok, "msg": msg, "retry": (not ok) and retryable(msg), "rehearsal": dry}
            for k, (ok, msg) in results.items()
        },
    }


def serve(base: str, term: str, user: str, pw: str, headless: bool, log: Log) -> int:
    """Stay signed in and register on command. Used by the app's Auto-register.

    stdin  (one JSON per line): {"id": "..", "cmd": "register", "add": [crn..], "drop": [crn..], "dry": bool}
                                {"cmd": "quit"}
    stdout: lines starting with "@@" are JSON events for the app; everything else is the human log.
            {"event": "status", "state": "signing_in|waiting_window|ready|error", "detail": ".."}
            {"event": "result", "id": "..", "submitted": bool, "results": {crn: {ok, msg, retry, rehearsal}}}
    """
    import queue
    import threading

    from kfupm_auth import login as sso_login

    def emit(event: str, **kw) -> None:
        print("@@" + json.dumps({"event": event, **kw}), flush=True)

    q: "queue.Queue[dict]" = queue.Queue()

    def reader() -> None:
        for line in sys.stdin:
            line = line.strip()
            if line:
                try:
                    q.put(json.loads(line))
                except ValueError:
                    pass
        q.put({"cmd": "quit"})  # app went away

    threading.Thread(target=reader, daemon=True).start()
    emit("status", state="signing_in")
    page: Page | None = None
    try:
        with logged_in_page(base, user, pw, headless=headless) as (page, _ctx):
            log("Signed in. Waiting for your registration window…")

            def open_registration() -> None:
                while True:
                    try:
                        select_term(page, base, term, log)
                        open_enter_crns(page)
                        return
                    except RegistrationClosed as exc:
                        emit("status", state="waiting_window", detail=str(exc))
                        try:
                            cmd = q.get(timeout=20)  # re-check every 20 s so the window is caught quickly
                        except queue.Empty:
                            continue
                        if cmd.get("cmd") == "quit":
                            raise SystemExit(0) from None
                        if cmd.get("cmd") == "register":
                            emit("result", id=cmd.get("id"), submitted=False, results={c: {"ok": False, "msg": "registration is not open yet", "retry": True} for c in cmd.get("add", [])})

            open_registration()
            emit("status", state="ready")
            log("Ready: signed in and on the Enter CRNs page.")
            last_alive = time.time()
            while True:
                try:
                    cmd = q.get(timeout=20)
                except queue.Empty:
                    if time.time() - last_alive > 240:  # keep the Banner session warm
                        last_alive = time.time()
                        try:
                            r = page.request.get(f"{base}/ssb/keepAlive/data")
                            expired = r.status != 200 or "login" in r.url
                        except Exception:  # noqa: BLE001
                            expired = True
                        if expired:
                            log("Session expired - signing in again.")
                            emit("status", state="signing_in")
                            sso_login(page, base, user, pw, interactive=not headless)
                            open_registration()
                            emit("status", state="ready")
                    continue
                if cmd.get("cmd") == "quit":
                    break
                if cmd.get("cmd") == "register":
                    add = [str(c) for c in cmd.get("add", []) if re.fullmatch(r"\d{4,6}", str(c))]
                    drop = [str(c) for c in cmd.get("drop", []) if re.fullmatch(r"\d{4,6}", str(c))]
                    log(f"{'REHEARSE' if cmd.get('dry') else 'REGISTER'}: add {add or '-'} drop {drop or '-'}")
                    try:
                        res = _register_once(page, base, add, drop, bool(cmd.get("dry")), log)
                    except Exception as exc:  # noqa: BLE001
                        snapshot(page, "auto-error")
                        res = {"submitted": False, "results": {c: {"ok": False, "msg": f"{type(exc).__name__}: {exc}", "retry": True} for c in add}}
                        try:
                            _ready_page(page, base)
                        except Exception:  # noqa: BLE001
                            pass
                    for crn, r in res["results"].items():
                        log(f"  {'OK  ' if r['ok'] else 'FAIL'} {crn}: {r['msg']}")
                    emit("result", id=cmd.get("id"), **res)
                    last_alive = time.time()
    except SystemExit:
        return 0
    except LoginError as exc:
        emit("status", state="error", detail=f"Sign-in failed: {exc}")
        return 3
    except Exception as exc:  # noqa: BLE001
        if page is not None:
            snapshot(page, "auto-fatal")
        emit("status", state="error", detail=f"{type(exc).__name__}: {exc}")
        return 4
    return 0


def main() -> int:
    load_dotenv(ROOT / ".env")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plan", default=str(ROOT / "plan.json"))
    ap.add_argument("--term", help="override the term code from plan.json (e.g. 202620)")
    ap.add_argument("--serve", action="store_true", help="stay signed in and register on command (used by the app's Auto-register; needs --term)")
    ap.add_argument("--check", action="store_true", help="read-only smoke test: log in, open the Enter CRNs page, screenshot, quit (no CRNs typed)")
    ap.add_argument("--dry-run", action="store_true", help="do every step except the final Submit")
    ap.add_argument("--headed", action="store_true", help="show the browser (also needed for 2-factor prompts)")
    ap.add_argument("--allow-drop", action="store_true", help="also DROP registered CRNs that are in plan.json 'current' but not in 'crns' (off by default)")
    ap.add_argument("--yes", action="store_true", help="skip the 'type YES' confirmation for a real run")
    ap.add_argument("--base", default=os.getenv("BANNER_BASE", DEFAULT_BASE))
    ap.add_argument("--log", default=str(LOG_PATH))
    args = ap.parse_args()

    log = Log(Path(args.log))
    user, pw = os.getenv("KFUPM_ID"), os.getenv("KFUPM_PASSWORD")
    if not user or not pw:
        print("KFUPM_ID / KFUPM_PASSWORD are not set - copy .env.example to .env and fill it in.", file=sys.stderr)
        return 2

    if args.serve:
        if not args.term:
            print("--serve needs --term", file=sys.stderr)
            return 2
        headless = not (args.headed or os.getenv("HEADLESS", "true").lower() == "false")
        return serve(args.base, args.term, user, pw, headless, log)

    if args.check:
        log(f"=== CHECK (read-only) | user {user} | term {args.term or '(first available)'}")
        page = None
        try:
            with logged_in_page(args.base, user, pw, headless=not (args.headed or os.getenv("HEADLESS", "true").lower() == "false")) as (page, _ctx):
                log("Logged in.")
                try:
                    select_term(page, args.base, args.term, log)
                    open_enter_crns(page)
                except Exception:
                    snapshot(page, "check-fatal")  # must happen while the browser is still open
                    raise
                snapshot(page, "check-enter-crns")
                log("CHECK OK: reached the Enter CRNs page. Nothing was added, dropped or submitted. Screenshot in debug/.")
            return 0
        except RegistrationClosed as exc:
            log(f"CHECK PARTIAL: login + term selection work, but {exc}")
            log("That is expected before your registration window opens - run --check again once it does.")
            return 0
        except LoginError as exc:
            log(f"LOGIN FAILED: {exc}")
            return 3
        except Exception as exc:  # noqa: BLE001
            log(f"CHECK FAILED: {type(exc).__name__}: {exc}")
            if page is not None:
                snapshot(page, "check-fatal")
            return 4

    plan_term, wanted, current = load_plan(Path(args.plan))
    term = args.term or plan_term
    to_add, to_drop, keep = diff_plan(wanted, current)
    drops = to_drop if args.allow_drop else []
    mode = "DRY RUN" if args.dry_run else "LIVE"
    log(f"=== {mode} | user {user} | term {term or '(first available)'}")
    log(f"  add : {', '.join(to_add) or '-'}")
    log(f"  keep: {', '.join(keep) or '-'}")
    if to_drop and not args.allow_drop:
        log(f"  drop: {', '.join(to_drop)}  <- NOT dropped (add --allow-drop to include these)")
    else:
        log(f"  drop: {', '.join(drops) or '-'}")
    if not to_add and not drops:
        log("Nothing to do: every wanted CRN is already registered and no drops were requested.")
        return 0

    if not args.dry_run and not args.yes:
        prompt = f"This will REGISTER {len(to_add)} section(s)" + (f" and DROP {len(drops)} ({', '.join(drops)})" if drops else "") + " for real. Type YES to continue: "
        if input(prompt).strip() != "YES":
            log("Aborted by user before login.")
            return 130

    headless = not (args.headed or os.getenv("HEADLESS", "true").lower() == "false")
    results: dict[str, tuple[bool, str]] = {}  # key: "+CRN" for adds, "-CRN" for drops
    page: Page | None = None
    try:
        with logged_in_page(args.base, user, pw, headless=headless) as (page, _ctx):
            log("Logged in.")
            try:
                select_term(page, args.base, term, log)
                open_enter_crns(page)
            except Exception:
                snapshot(page, "setup-fatal")  # browser is still open here
                raise

            for crn in to_add:
                try:
                    add_crn(page, crn)
                    log(f"  added CRN {crn} to summary")
                except Exception as exc:  # noqa: BLE001
                    results[f"+{crn}"] = (False, f"could not add: {exc}")
                    log(f"  ! CRN {crn}: could not add ({exc})")
                    snapshot(page, f"add-{crn}")

            for crn in drops:
                try:
                    mark_drop(page, crn)
                    log(f"  marked CRN {crn} to be dropped")
                except Exception as exc:  # noqa: BLE001
                    results[f"-{crn}"] = (False, f"could not mark drop: {exc}")
                    log(f"  ! CRN {crn}: could not mark for drop ({exc})")
                    snapshot(page, f"drop-{crn}")

            summary = read_summary(page)
            messages = banner_messages(page)
            for m in messages:
                log(f"  banner: {m}")
            for crn in to_add:
                if f"+{crn}" not in results:
                    results[f"+{crn}"] = classify(summary.get(crn), crn, messages)
            for crn in drops:
                if f"-{crn}" not in results:
                    results[f"-{crn}"] = (True, summary.get(crn, "marked for drop"))

            if args.dry_run:
                snapshot(page, "dry-run-summary")
                log("DRY RUN: stopping before final Submit. Nothing was registered or dropped. (Screenshot saved in debug/)")
                results = {k: (ok, f"[dry-run] {msg}") for k, (ok, msg) in results.items()}
            else:
                # if anything we needed failed to even stage, don't submit a half-built change
                staged_failures = [k for k, (ok, _m) in results.items() if not ok]
                if staged_failures and drops:
                    log(f"ABORTING before Submit: could not stage {', '.join(staged_failures)}; refusing to submit drops alongside failed adds.")
                    snapshot(page, "aborted-before-submit")
                else:
                    first_visible(page, "#saveButton", "button:has-text('Submit')").click()
                    page.wait_for_timeout(3500)
                    summary = read_summary(page)
                    messages = banner_messages(page)
                    for m in messages:
                        log(f"  banner: {m}")
                    for crn in to_add:
                        if results.get(f"+{crn}", (True, ""))[0]:  # only re-judge ones that got as far as submit
                            results[f"+{crn}"] = classify(summary.get(crn), crn, messages)
                    for crn in drops:
                        if results.get(f"-{crn}", (True, ""))[0]:
                            row = summary.get(crn)
                            results[f"-{crn}"] = (True, row or "no longer in schedule") if (row is None or "drop" in row.lower()) else (False, row)
                    snapshot(page, "after-submit")
    except RegistrationClosed as exc:
        log(f"NOT OPEN: {exc}")
        return 5
    except LoginError as exc:
        log(f"LOGIN FAILED: {exc}")
        return 3
    except Exception as exc:  # noqa: BLE001
        log(f"FATAL: {type(exc).__name__}: {exc}")
        if page is not None:
            snapshot(page, "fatal")
        return 4

    log("--- results ---")
    expected = [f"+{c}" for c in to_add] + [f"-{c}" for c in drops]
    for key in expected:
        ok, msg = results.get(key, (False, "not attempted"))
        log(f"{'OK  ' if ok else 'FAIL'} {'ADD ' if key[0] == '+' else 'DROP'} {key[1:]}: {msg}")
    failed = [k for k in expected if not results.get(k, (False,))[0]]
    log(f"=== done: {len(expected) - len(failed)} ok, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
