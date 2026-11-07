# KFUPM Schedule Planner

Scrape KFUPM's section offerings → plan a conflict-free week in the browser → get a Telegram ping when a full section opens → (optionally) let a script do the registration for you.

## Download

Get the latest version from **[Releases](../../releases/latest)**:

| Computer | File | How to open |
|---|---|---|
| **Mac** (Apple Silicon: M1/M2/M3/M4) | `KFUPM-Planner-macOS.zip` | Unzip, drag **KFUPM Planner** to Applications, open it. If macOS says it can't check the app: **System Settings → Privacy & Security → Open Anyway** (once). |
| **Windows** 10/11 | `KFUPM-Planner-Windows-Setup.exe` | Run it (installs just for you, no admin). If you see *"Windows protected your PC"*: **More info → Run anyway**. |
| **Windows** (no install) | `KFUPM-Planner-Windows-portable.zip` | Unzip anywhere and run `KFUPM Planner.exe`. |

The warnings appear only because the app isn't paid-signed by Apple/Microsoft. Only download it from this repo's Releases page, and you can check the file against `SHA256SUMS.txt` in the same release.

### Is it safe?

* **Your KFUPM password never leaves your computer.** It's stored in the macOS Keychain / Windows Credential Manager and used only to sign in to KFUPM's own login page (`login.kfupm.edu.sa`, `sts.kfupm.edu.sa`) from your machine. There's no server, account or analytics behind this app.
* The app only talks to KFUPM (and to Telegram if *you* turn on Telegram alerts with your own bot).
* Its local server listens on `127.0.0.1` only and needs a per-launch token, so websites can't talk to it.
* Nothing is registered or dropped until you confirm. A current section is only dropped when you swap it for another section of the same course.
* The source code is all here — anything in the app is built from this repo.
* Never send your password, `.env` file or diagnostics zip to anyone you don't trust. (The diagnostics zip doesn't contain your password, but it does contain your schedule.)

This is an unofficial student tool, not affiliated with KFUPM. Use it at your own risk and within KFUPM's rules.

```
app.py            THE APP  KFUPM Planner.app: planner + register + radar in one native window
scraper.py        Part 1  Banner 9 class-search scraper (multi-term)  → data/*.json (+ courses.json)
frontend/         Part 2  React + Vite + Tailwind UI (dark, monochrome)
register.py       Part 3  Playwright auto-registration (add / drop from your plan)
radar.py          Part 4  standalone Telegram seat-radar bot (no KFUPM login needed)
radar_service.py          the in-app seat radar
secrets_store.py          keeps your login in the macOS Keychain
kfupm_auth.py             shared SSO login (CAS → ADFS)
paths.py                  where files live (project folder, or Application Support in the app)
packaging/  build_mac.sh  build the Mac app
```

## The Mac app

**Build it** (once, or after you change code):

```bash
./build_mac.sh
```

That produces **`release/KFUPM Planner.app`** — a normal double-clickable Mac app (~160 MB; Python, the UI, a course-data snapshot and the browser-automation driver are all inside). Drag it into `/Applications` if you like. It needs Google Chrome installed for signing in to Banner.

**What's inside**

* **Planner** — search/filter sections (incl. Male/Female), drag onto the Sun–Thu week, conflicts flagged, several plans per term, your current schedule with an add/drop diff, Copy CRNs.
* **Off days** — finds conflict-free combinations of your courses that leave a weekday free.
* **Sign in** (top right) — your KFUPM ID and password are saved in the **macOS Keychain**, never in a file. The account menu has *Verify sign-in* and *Sign out*.
* **Register** — *Test sign-in*, *Dry run* (does everything except the final submit) and *Register* (asks for confirmation, listing exactly what's added/dropped). The log streams live.
* **Auto-register** (top of the Register tab) — keep your current schedule, add the sections you want (even full ones), press *Start*. See below.
* **Radar** — *Watch* any full section; checks every 15 s–5 min and the moment a seat opens: alert, sound, optional macOS notification and Telegram message, and a one-click *Register now*. Runs while the app is open.
* **Refresh data** — re-downloads the offering (live seat counts).

### Auto-register

1. Set your **Current schedule** (Planner sidebar or Register tab → *Set current schedule*). Type a section like `STAT 201-02` or a CRN and pick from the suggestions, paste a whole list (any mix of codes and CRNs, e.g. copied from Banner), or click *Import a screenshot* / drop an image of your schedule — it's read on your Mac with Apple's built-in text recognition, nothing is uploaded. You review what was found, untick anything you're not registered in, and save. Then add the sections you want to your plan — or add them by CRN on the Register tab.
2. Everything in the plan that isn't already in your schedule becomes a target. Each target has an **action button**: *Add only*, or *Add + drop…* where you pick which of your current sections to drop when it gets in — the same course (a swap, suggested automatically) or **any other course** (e.g. drop ISE 291 if COE 292 gets in). Each trade is its own Banner submission with *Conditional Add and Drop* ticked, so nothing is dropped unless its section is added.
3. **Start auto-register** — now, or **at a time** (e.g. 9:00 AM when your registration opens): it waits, signs in 3 minutes early, and checks every 3 s around the start time so the opening is caught within seconds. Keep the app open and the computer awake (Mac lid open). The app signs in to Banner once and waits on the "Enter CRNs" page, keeping the session alive (and re-signing in if Banner logs it out). If your registration window hasn't opened yet, it re-checks every 20 s (Banner shows e.g. "Time tickets prevent registration at this time") and starts by itself when it opens.
4. Every 5–30 s (default 10, with a little randomness) it checks the targets' seats. The moment any show a free seat, all of them are submitted together.
5. Registered → moved into your current schedule, alert + sound. Seat gone again ("closed/full") → it keeps watching (up to 5 attempts per section). Prerequisite / restriction / hold errors → it stops on that section and shows Banner's message. It turns itself off when every target is settled.

*Rehearsal* goes through every step except Submit. Keep the app open and the Mac awake while it runs.

Why not every 1 second? Signing in to Banner takes ~15 s, so speed comes from being **already signed in** when a seat opens — which this does — not from polling faster. Checking every second would also hammer KFUPM's server and is the quickest way to get rate-limited during registration week; 5 s is the floor.

Your data lives in `~/Library/Application Support/KFUPM Planner/` (plans, radar list, course data, logs). The app's local server listens only on `127.0.0.1` and every request needs a per-launch token, so other websites can't talk to it.

> Registration status: sign-in, the "registration not open yet" detection, term selection, the Enter CRNs page and *Add to Summary* were verified live on KFUPM's site; reading the summary, *WEB DROP* and *Conditional Add and Drop* were verified on KFUPM's real pages. The final *Submit* by the app hasn't been exercised on a live registration yet — use *Rehearsal* first.

**Sharing it:** a locally built app opens normally on your own Mac. On other Macs Gatekeeper warns because it isn't notarized — **System Settings → Privacy & Security → Open Anyway**. The build is Apple Silicon (arm64) only. Removing the warning needs an Apple Developer ID ($99/yr) to sign and notarize.

## Windows

Download **`KFUPM-Planner-Windows-Setup.exe`** (or the portable zip) from **[Releases](../../releases/latest)**. Each build also comes out of the *Windows build* workflow (GitHub → Actions → Artifacts).

1. Run `KFUPM-Planner-Setup.exe`. It installs just for you (no admin rights) and adds a Start-menu and desktop shortcut.
2. Windows SmartScreen may say *"Windows protected your PC"* because the app isn't code-signed: click **More info → Run anyway**.
3. Open **KFUPM Planner**, click **Sign in** (top right). Your login is stored in **Windows Credential Manager**.
4. Signing in to Banner uses **Google Chrome if installed, otherwise Microsoft Edge** (built into Windows) — nothing extra to install.

Everything else works the same as on the Mac, except *Import a screenshot* (Mac-only for now — type or paste your sections instead). App data lives in `%APPDATA%\KFUPM Planner\`; uninstall from Settings → Apps.

Every build is launched and tested on a real Windows machine first (server, Credential Manager, course data, helper processes) — see `.github/workflows/windows.yml`.

**From source** (for development): `python app.py` (`--browser` to use your browser, `--no-window` to just serve). The plain website build (`cd frontend && npm run build`) shows only the planner and off-days views.

## Setup

Requires Python 3.11+ and Node 18+. Google Chrome is used for the login automation (otherwise run `playwright install chromium`).

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env               # then edit it (see below)
cd frontend && npm install && cd ..
```

### `.env`

See `.env.example` — every key is documented there. `.env` is in `.gitignore`; never commit or share it.
Your KFUPM password is only needed for Part 3, and only ever used on **your own** computer.

## Part 1 — scrape courses

```bash
python scraper.py                      # best current term (newest non-"View Only", regular semester preferred)
python scraper.py --list-terms
python scraper.py --term 202620,202630 # several terms - the planner gets a term picker
python scraper.py --all-open           # every term that isn't "View Only"
```

No login needed: Banner's public class search is read directly. Output:

* `data/courses-<term>.json` + `data/terms.json` (index), mirrored to `frontend/public/data/`
* `courses.json` — the default term, single-file form

```jsonc
{
  "meta": { "term": "202620", "termDescription": "Second Semester 2026-27", "scrapedAt": "…", "count": 3064 },
  "sections": [{
    "crn": "25052", "course": "ACCT 110", "subject": "ACCT", "subjectName": "Accounting",
    "number": "110", "section": "01", "title": "Introduction to Financial Accounting",
    "type": "Lecture", "credits": 3, "campus": "KFUPM Main", "gender": "male",
    "instructors": ["…"],
    "meetings": [{ "days": ["U","T","R"], "start": "0800", "end": "0850", "building": "24", "room": "178", "type": "LEC" }],
    "seats": { "capacity": 25, "enrolled": 29, "available": -4, "waitlistAvailable": 0, "open": false }
  }]
}
```

Day codes: `U`=Sun `M`=Mon `T`=Tue `W`=Wed `R`=Thu. Times are 24-h `HHMM`. Re-run the scraper whenever you want fresh seat counts.

## Part 2 — planner web app

```bash
cd frontend
npm run dev          # http://localhost:5173
npm run build        # static site in frontend/dist (host anywhere: Vercel, Netlify, GitHub Pages)
```

* **Term picker** in the header; every term keeps its own plans.
* **Multiple plans** per term (Plan A, Plan B, …): new / duplicate / rename / delete.
* **Male / Female section filter** (“Sections for”): KFUPM keeps them separate — female sections have campus `Female` and numbers like `F03`; everything else is male. Pick yours once (it's remembered, and used by the off-day finder too). Every section carries a Male/Female tag, and the plan warns if it mixes both, so a section the university opens to everyone is never hidden when you choose **All**.
* Filter by department, course code/title/CRN, instructor, days, start/end time, type, free seats.
* **Drag** a section onto the calendar (or press **Add to plan**); hover previews it (red = clash).
* Sun–Thu calendar; conflicts in **red**, overlapping blocks side by side. Fri/Sat meetings get a notice.
* **Current schedule**: paste the CRNs you're registered in now. They show **hatched** on the calendar and the sidebar lists exactly what the script will **add / drop / keep** to reach your plan.
* **Off-day finder** (header tab): add all the courses you need → it finds conflict-free section combinations that leave a weekday completely free (Sun…Thu tabs), sorted by compactness, with a mini week preview. “Use as new plan” loads one into the planner.
* **Export plan** copies CRNs (one per line / comma-separated / JSON). **Download plan.json** feeds Part 3 (includes `current` when you set it).
* Everything is remembered in your browser (`localStorage`). Works on phones via a bottom tab bar.

> Off-day finder note: Banner's public data doesn't say which lab pairs with which lecture, so any lecture is combined with any lab. Double-check pairing rules when you register.

## Part 3 — auto-registration

```bash
# 0. (once) read-only smoke test: logs in, selects the term, opens "Enter CRNs", screenshots, quits.
#    Types no CRNs, needs no plan.json, never touches Submit.
python register.py --check --headed --term 202620

# 1. download plan.json from the planner (or write it by hand)
#    {"term": "202620", "crns": ["25052","23853"], "current": ["25052","11111"]}
#    crns    = the schedule you WANT      current = what you're registered in NOW (optional)

# 2. rehearse: stages everything in Banner's summary and stops BEFORE Submit
python register.py --dry-run --headed

# 3. for real (prints what it will add/drop; you must type YES; --yes skips that)
python register.py
```

* With `current` set it works out **add** (wanted − current), **keep**, and **drop** (current − wanted).
* **Drops are OFF by default** — the script only prints them. Add `--allow-drop` to include them. Adds and drops are staged together and submitted once; if a staged add fails and drops are involved it aborts before Submit.
* Every run appends to `registration_log.txt` (per-CRN `OK`/`FAIL` + Banner's message). Failures save a screenshot + HTML into `debug/`.
* If registration isn't open for you yet it says so (e.g. `NOT OPEN: Registration is not open for you in …`) and exits with code 5; `--check` reports `CHECK PARTIAL` (login and term selection worked).
* Exit code is 0 only if everything succeeded. Flags: `--plan`, `--term`, `--check`, `--dry-run`, `--allow-drop`, `--headed`, `--yes`, `--log`.
* 2-factor: run with `--headed` and approve the prompt; the script waits up to 5 minutes.

> **Honesty note:** the login chain (CAS → ADFS), term selection, the Enter CRNs page and adding CRNs were verified live; summary reading, drop marking and Conditional Add and Drop were verified on KFUPM's real pages. The final Submit hasn't been exercised by the script on a live registration yet. Run `--dry-run --headed` first and check `debug/` if a step can't find its element.

## Part 4 — Telegram seat radar

Tells you when a **full** section gets a free seat (and again if it fills and re-opens). It only reads the public class search, so it needs **no KFUPM login**.

```bash
# 1. Telegram → @BotFather → /newbot → copy the token into .env as TELEGRAM_BOT_TOKEN
# 2. start it (leave it running; a Raspberry Pi / VPS / always-on laptop works)
python radar.py
# 3. in Telegram, message your bot:
#      /watch 25052          watch a CRN  (optionally: /watch 25052 202620)
#      /unwatch 25052   /list   /terms   /help
```

* One bot can serve many classmates — each chat has its own list (`radar_state.json`). Set `RADAR_ALLOWED_CHATS` to keep it private.
* `python radar.py --once` does one check pass without Telegram; `--add CRN --chat ID` adds a watch from the shell.
* It checks every `RADAR_INTERVAL` seconds (default 120, min 30), one small request per watched *course* — please keep it gentle.
* Alerts are informational: a seat can be gone by the time you tap register. Pair it with Part 3 if you want speed.

## Sharing this with other students

* **Give them the app**: send them the **[Releases](../../releases/latest)** link (Mac zip, Windows installer, Windows portable zip). To make a new Mac build: `./build_mac.sh`, then `ditto -c -k --keepParent "release/KFUPM Planner.app" KFUPM-Planner-macOS.zip`. Windows builds come from GitHub Actions.
* **Website option (undecided)**: `frontend/dist` is static — host it anywhere and refresh `data/` with the scraper. It will show only the planner/off-day finder.
* **The standalone Telegram bot (`radar.py`)** is safe to host once for a group (public data only).
* **Registration is deliberately local-only**: each student's login stays in their own keychain. Never build a hosted service that collects other students' KFUPM passwords.

## How it was reverse engineered (Part 0)

**free-courses.dev** is a React SPA (Vite bundle `/assets/index-*.js`) in front of its own Express API at `https://api.free-courses.dev`:

| Endpoint | Purpose |
|---|---|
| `GET /courses/getTerms`, `/courses/getTermsInfo`, `/courses/getDepartments` | term + department lists |
| `GET /courses?term=…&course=…` | sections for a course; `GET /courses/crn?term=…&crn=…` single CRN |
| `POST /auth/login`, `/auth/register`, `/auth/guest/login`, `GET /auth/refresh` | cookie-based session (every data call returns 401 “No token provided” without it) |
| `GET/POST /user/getSchedule`, `/user/updateSchedule`, `/user/shareSchedule` | saved plans |
| `/ntfy/*`, `/stream/checkout` | paid seat-alert notifications (10 SAR) |

The browser never talks to KFUPM: the API serves already-normalised, flat rows (`crn, course, sequenceNumber, title, instructors, building, room, start_time, end_time, day, …`). What its backend does against KFUPM isn't visible from the client.

**KFUPM itself** exposes the same data publicly through Banner 9 at
`https://banner9-registration.kfupm.edu.sa/StudentRegistrationSsb`:

1. `GET /ssb/classSearch/getTerms` → terms
2. `GET /ssb/classSearch/classSearch` → session cookies (`JSESSIONID`, `KFUPM_Cookie`) + CSRF `synchronizerToken`
3. `POST /ssb/term/search?mode=search` → binds the term to the session
4. `GET /ssb/searchResults/searchResults?txt_term=…&pageOffset=…&pageMaxSize=500` → sections (JSON)
5. Per-course: add `txt_subject` / `txt_courseNumber`, and call `POST /ssb/classSearch/resetDataForm` between searches — Banner keeps the previous search in the session and otherwise silently returns the *previous* course's rows.

Only registration requires login: Banner → `login.kfupm.edu.sa/cas` → ADFS (`sts.kfupm.edu.sa`, form fields `UserName` / `Password`). The registration term step answers with `{"regAllowed": …, "studentEligFailures": […]}`, which `register.py` uses to detect “not open yet”. `edugate.kfupm.edu.sa` didn't resolve from the machine this was built on, so nothing here depends on it.

## Notes & limits

* Be polite: the scraper pauses between pages and retries with backoff; run it when you need fresh data, not in a tight loop.
* `seatsAvailable` can be negative (over-enrolled sections) — shown as 0 seats.
* Use at your own risk; auto-registering is subject to KFUPM's terms of use.
