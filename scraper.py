#!/usr/bin/env python3
"""KFUPM course scraper (Banner 9 "Student Registration" class search).

How it works (found by inspecting the portal, see README "How it was reverse engineered"):

* KFUPM's registration system is Banner 9 at
  https://banner9-registration.kfupm.edu.sa/StudentRegistrationSsb
* The *class search* part of it is public - no login is needed to read sections.
  The flow is the standard Banner 9 one:
      1. GET  /ssb/classSearch/getTerms          -> list of terms
      2. GET  /ssb/classSearch/classSearch       -> session cookies + synchronizerToken (CSRF)
      3. POST /ssb/term/search?mode=search       -> binds the term to the session
      4. GET  /ssb/searchResults/searchResults   -> paginated JSON (max 500 per page)
* Session cookies (JSESSIONID + the load-balancer KFUPM_Cookie) are kept by requests.Session.
* The CSRF "synchronizerToken" is read from a <meta> tag and sent as a header on POSTs.

Login is therefore OPTIONAL. Pass --login to authenticate through KFUPM's CAS/ADFS
single-sign-on using KFUPM_ID / KFUPM_PASSWORD from .env (uses Playwright, because the
SSO page is JavaScript/SAML based). Logged-in sessions can see a few extra things
(e.g. registration-restricted terms), but the section data itself is the same.

Usage:
    python scraper.py                  # newest open (non "View Only") term
    python scraper.py --list-terms
    python scraper.py --term 202620
    python scraper.py --login          # authenticate first (needs .env + Playwright)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
import paths  # noqa: E402  (where data lives: project folder, or the app-data folder in the packaged app)
DEFAULT_BASE = "https://banner9-registration.kfupm.edu.sa/StudentRegistrationSsb"
PAGE_SIZE = 500  # Banner's hard maximum
# Banner lists days as booleans; KFUPM's week is Sun-Thu. Use the same one-letter
# codes KFUPM students use: U M T W R (+ F S).
DAY_FIELDS = [
    ("sunday", "U"),
    ("monday", "M"),
    ("tuesday", "T"),
    ("wednesday", "W"),
    ("thursday", "R"),
    ("friday", "F"),
    ("saturday", "S"),
]

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36 kfupm-schedule-planner"
)


class BannerClient:
    def __init__(self, base: str = DEFAULT_BASE, delay: float = 0.3):
        self.base = base.rstrip("/")
        self.delay = delay
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "application/json, text/html, */*"})
        self.sync_token: str | None = None

    # -- helpers ---------------------------------------------------------
    def _url(self, path: str) -> str:
        return f"{self.base}{path}"

    def _get(self, path: str, **kw) -> requests.Response:
        for attempt in range(4):
            try:
                r = self.s.get(self._url(path), timeout=60, **kw)
                if r.status_code in (502, 503, 504):
                    raise requests.HTTPError(f"HTTP {r.status_code}")
                r.raise_for_status()
                time.sleep(self.delay)
                return r
            except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as exc:
                if attempt == 3:
                    raise
                wait = 2 ** attempt
                print(f"  ! {exc} - retrying in {wait}s", file=sys.stderr)
                time.sleep(wait)
        raise RuntimeError("unreachable")

    def _refresh_token(self, html: str) -> None:
        """Read Banner's CSRF token (<meta name="synchronizerToken">)."""
        tok = BeautifulSoup(html, "html.parser").find("meta", attrs={"name": "synchronizerToken"})
        if tok and tok.get("content"):
            self.sync_token = tok["content"]
            self.s.headers["X-Synchronizer-Token"] = self.sync_token

    # -- optional authentication -----------------------------------------
    def load_cookies(self, cookies: list[dict]) -> None:
        for c in cookies:
            self.s.cookies.set(c["name"], c["value"], domain=c.get("domain"), path=c.get("path", "/"))

    # -- API -------------------------------------------------------------
    def terms(self) -> list[dict]:
        out, offset = [], 1
        while True:
            r = self._get("/ssb/classSearch/getTerms", params={"offset": offset, "max": 50, "searchTerm": ""})
            batch = r.json()
            if not batch:
                break
            out.extend(batch)
            if len(batch) < 50:
                break
            offset += 1
        return out

    def start_session(self) -> None:
        r = self._get("/ssb/classSearch/classSearch")
        self._refresh_token(r.text)

    def select_term(self, term: str) -> None:
        r = self.s.post(
            self._url("/ssb/term/search"),
            params={"mode": "search"},
            data={"term": term, "studyPath": "", "studyPathText": "", "startDatePicker": "", "endDatePicker": ""},
            timeout=60,
        )
        r.raise_for_status()
        data = r.json()
        if data.get("regAllowed") is False and data.get("studentEligFailures"):
            # Banner uses this for "No Classes Found in this Date Range" etc.
            print(f"  note: {data['studentEligFailures']}", file=sys.stderr)

    def course_sections(self, term: str, subject: str, number: str) -> list[dict]:
        """Raw sections of ONE course (cheap: a single request). Needs start_session()+select_term() first."""
        # Banner remembers the previous search's criteria in the session; without this reset a
        # second query silently returns the FIRST course's rows again.
        self.s.post(self._url("/ssb/classSearch/resetDataForm"), timeout=60).raise_for_status()
        r = self._get(
            "/ssb/searchResults/searchResults",
            params={
                "txt_term": term,
                "txt_subject": subject,
                "txt_courseNumber": number,
                "startDatePicker": "",
                "endDatePicker": "",
                "pageOffset": 0,
                "pageMaxSize": PAGE_SIZE,
                "sortColumn": "subjectDescription",
                "sortDirection": "asc",
            },
        )
        payload = r.json()
        if not payload.get("success"):
            raise RuntimeError(f"Banner returned success=false for {subject} {number}")
        return payload.get("data") or []

    def sections(self, term: str) -> list[dict]:
        self.start_session()
        self.select_term(term)
        out: list[dict] = []
        offset = 0
        total = None
        while total is None or offset < total:
            r = self._get(
                "/ssb/searchResults/searchResults",
                params={
                    "txt_term": term,
                    "startDatePicker": "",
                    "endDatePicker": "",
                    "pageOffset": offset,
                    "pageMaxSize": PAGE_SIZE,
                    "sortColumn": "subjectDescription",
                    "sortDirection": "asc",
                },
            )
            payload = r.json()
            if not payload.get("success"):
                raise RuntimeError(f"Banner returned success=false at offset {offset}: {str(payload)[:300]}")
            total = payload["totalCount"]
            page = payload.get("data") or []
            out.extend(page)
            print(f"  fetched {len(out)}/{total}")
            if not page:
                break
            offset += PAGE_SIZE
        return out


# --------------------------------------------------------------------------
# normalisation
# --------------------------------------------------------------------------
def _hhmm(v: str | None) -> str | None:
    return v if v and len(v) == 4 and v.isdigit() else None


def normalise(raw: dict) -> dict:
    meetings = []
    for mf in raw.get("meetingsFaculty") or []:
        mt = mf.get("meetingTime") or {}
        days = [code for field, code in DAY_FIELDS if mt.get(field)]
        start, end = _hhmm(mt.get("beginTime")), _hhmm(mt.get("endTime"))
        meetings.append(
            {
                "days": days,
                "start": start,
                "end": end,
                "building": mt.get("building"),
                "buildingName": mt.get("buildingDescription"),
                "room": mt.get("room"),
                "type": mt.get("meetingScheduleType"),
                "startDate": mt.get("startDate"),
                "endDate": mt.get("endDate"),
            }
        )
    # instructors: section-level plus per-meeting, de-duplicated, order preserved
    names: list[str] = []
    for f in (raw.get("faculty") or []) + [
        f for mf in raw.get("meetingsFaculty") or [] for f in (mf.get("faculty") or [])
    ]:
        n = (f.get("displayName") or "").strip()
        if n and n not in names:
            names.append(n)
    return {
        "crn": raw.get("courseReferenceNumber"),
        "course": f'{raw.get("subject", "")} {raw.get("courseNumber", "")}'.strip(),
        "subject": raw.get("subject"),
        "subjectName": raw.get("subjectDescription"),
        "number": raw.get("courseNumber"),
        "section": raw.get("sequenceNumber"),
        "title": raw.get("courseTitle"),
        "type": raw.get("scheduleTypeDescription"),
        "credits": raw.get("creditHours"),
        "campus": raw.get("campusDescription"),
        # KFUPM keeps male and female sections separate: campus "Female" + section numbers like F03.
        "gender": "female" if (raw.get("campusDescription") == "Female" or str(raw.get("sequenceNumber", "")).upper().startswith("F")) else "male",
        "instructors": names,
        "meetings": meetings,
        "seats": {
            "capacity": raw.get("maximumEnrollment"),
            "enrolled": raw.get("enrollment"),
            "available": raw.get("seatsAvailable"),
            "waitlistAvailable": raw.get("waitAvailable"),
            "open": raw.get("openSection"),
        },
        "linked": raw.get("linkIdentifier"),
    }


def pick_default_term(terms: list[dict]) -> dict:
    """Newest term that is not 'View Only' (= still open), preferring regular semesters
    over Summer sessions (which are small and sit *after* the semester you usually mean).
    Falls back to the newest term. Override with --term."""
    open_terms = [t for t in terms if "view only" not in t["description"].lower()]
    regular = [t for t in open_terms if "summer" not in t["description"].lower()]
    pool = regular or open_terms or terms
    return max(pool, key=lambda t: t["code"])


def write_json(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def update_terms_index(dirs: list[Path], entries: list[dict], default: str) -> None:
    """Merge `entries` into <dir>/terms.json so scraping one term never drops the others."""
    for d in dirs:
        idx_path = d / "terms.json"
        known: dict[str, dict] = {}
        if idx_path.exists():
            try:
                known = {t["code"]: t for t in json.loads(idx_path.read_text(encoding="utf-8")).get("terms", [])}
            except (ValueError, KeyError):
                known = {}
        for e in entries:
            known[e["code"]] = e
        terms = sorted(known.values(), key=lambda t: t["code"], reverse=True)
        write_json(idx_path, {"default": default, "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "terms": terms})


def main() -> int:
    load_dotenv(ROOT / ".env")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--term", help="Banner term code(s), comma separated, e.g. 202620 or 202620,202630 (default: best current term)")
    ap.add_argument("--all-open", action="store_true", help="scrape every term that is not 'View Only'")
    ap.add_argument("--list-terms", action="store_true", help="print available terms and exit")
    ap.add_argument("--login", action="store_true", help="authenticate via KFUPM SSO first (needs .env + Playwright)")
    ap.add_argument("--base", default=os.getenv("BANNER_BASE", DEFAULT_BASE))
    ap.add_argument("--out", default=str(paths.COURSES_JSON), help="where to write the first/default term (legacy single file)")
    ap.add_argument("--no-frontend-copy", action="store_true", help="don't also write into frontend/public/")
    args = ap.parse_args()

    client = BannerClient(args.base)

    if args.login:
        from kfupm_auth import login_and_get_cookies  # lazy: needs Playwright

        user, pw = os.getenv("KFUPM_ID"), os.getenv("KFUPM_PASSWORD")
        if not user or not pw:
            print("KFUPM_ID / KFUPM_PASSWORD missing in .env", file=sys.stderr)
            return 2
        print("Logging in through KFUPM SSO ...")
        client.load_cookies(login_and_get_cookies(args.base, user, pw))

    terms = client.terms()
    if args.list_terms:
        for t in terms:
            print(f'{t["code"]}  {t["description"]}')
        return 0
    if not terms:
        print("No terms returned - is the portal reachable?", file=sys.stderr)
        return 1

    default_term = pick_default_term(terms)
    if args.term:
        wanted = []
        for code in [c.strip() for c in args.term.split(",") if c.strip()]:
            wanted.append(next((t for t in terms if t["code"] == code), {"code": code, "description": code}))
    elif args.all_open:
        wanted = [t for t in terms if "view only" not in t["description"].lower()]
    else:
        wanted = [default_term]
    # The default term is always the best CURRENT term, no matter which terms this run scrapes
    # (scraping only Summer must not make Summer the default).
    wanted.sort(key=lambda t: (t["code"] != default_term["code"], t["code"]))

    out_dirs = [paths.DATA_DIR]
    fe = ROOT / "frontend" / "public"
    if not args.no_frontend_copy and not paths.FROZEN and fe.is_dir():
        out_dirs.append(fe / "data")

    entries = []
    for term in wanted:
        print(f'Scraping term {term["code"]} - {term["description"]}')
        raw = client.sections(term["code"])
        sections = [normalise(r) for r in raw]
        sections.sort(key=lambda s: (s["course"], s["section"] or ""))
        scraped = datetime.now(timezone.utc).isoformat(timespec="seconds")
        doc = {
            "meta": {
                "term": term["code"],
                "termDescription": term["description"],
                "scrapedAt": scraped,
                "source": client.base,
                "count": len(sections),
            },
            "sections": sections,
        }
        fname = f'courses-{term["code"]}.json'
        for d in out_dirs:
            write_json(d / fname, doc)
        if term["code"] == default_term["code"]:  # legacy single-file output the README documents
            write_json(Path(args.out), doc)
            if len(out_dirs) > 1:
                write_json(fe / "courses.json", doc)
        entries.append(
            {
                "code": term["code"],
                "description": term["description"],
                "file": f"data/{fname}",
                "count": len(sections),
                "scrapedAt": scraped,
                "viewOnly": "view only" in term["description"].lower(),
            }
        )
        print(f"  wrote {len(sections)} sections -> data/{fname}")

    update_terms_index(out_dirs, entries, default_term["code"])
    print(f'Done. Default term: {default_term["code"]} ({default_term["description"]}). Index: data/terms.json')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
