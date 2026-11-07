"""Shared KFUPM single-sign-on helper (used by scraper.py --login and register.py).

Login chain observed on the portal (unauthenticated GETs only):

    banner9-registration.kfupm.edu.sa/StudentRegistrationSsb/saml/login
      -> 302 login.kfupm.edu.sa/cas/login?TARGET=<banner>/login/cas
      -> 302 sts.kfupm.edu.sa/adfs/ls/?SAMLRequest=...&RelayState=...      (Microsoft ADFS)
         form#loginForm  fields: UserName, Password, AuthMethod=FormsAuthentication
         submit: #submitButton, error text: #errorText
      -> back through CAS to Banner with a JSESSIONID that is now authenticated

ADFS/SAML needs real JavaScript + redirects, so this is done with Playwright rather
than plain requests.  Credentials come from the environment (.env), never from code.
"""
from __future__ import annotations

import os
import re
from contextlib import contextmanager

from playwright.sync_api import Page, sync_playwright

LOGIN_TIMEOUT_MS = 90_000


class LoginError(RuntimeError):
    pass


def _fill_adfs(page: Page, user: str, password: str) -> None:
    # ADFS default markup; fall back to generic selectors if KFUPM customised it.
    u = page.locator("#userNameInput, input[name='UserName']").first
    p = page.locator("#passwordInput, input[name='Password']").first
    u.wait_for(state="visible", timeout=30_000)
    u.fill(user)
    p.fill(password)
    page.locator("#submitButton, input[type=submit], button[type=submit]").first.click()


def login(page: Page, base: str, user: str, password: str, *, interactive: bool = False) -> None:
    """Drive the SSO login on `page`. Raises LoginError on a rejected login.

    interactive=True (headed browser) gives you time to finish an MFA prompt by hand.
    """
    page.goto(f"{base}/saml/login", wait_until="domcontentloaded")
    if re.search(r"/adfs/|login\.kfupm", page.url):
        _fill_adfs(page, user, password)
    # Wait until we are back on Banner.
    deadline_ms = 5 * 60_000 if interactive else LOGIN_TIMEOUT_MS
    try:
        page.wait_for_url(re.compile(r"banner9-registration\.kfupm\.edu\.sa/StudentRegistrationSsb"), timeout=deadline_ms)
    except Exception as exc:  # noqa: BLE001
        err = ""
        try:
            err = page.locator("#errorText").first.inner_text(timeout=1000).strip()
        except Exception:  # noqa: BLE001
            pass
        hint = f" ADFS says: {err!r}." if err else " (If your account uses 2-factor auth, run with HEADLESS=false and approve it.)"
        raise LoginError(f"Login did not complete - still at {page.url}.{hint}") from exc


@contextmanager
def logged_in_page(base: str, user: str, password: str, *, headless: bool = True):
    """Context manager yielding (page, context) after a successful login."""
    with sync_playwright() as pw:
        browser = None
        # Use a browser the computer already has: Chrome, else Microsoft Edge (on every Windows PC),
        # else Playwright's own Chromium if it was installed.
        channels = [os.getenv("BROWSER_CHANNEL")] if os.getenv("BROWSER_CHANNEL") else ["chrome", "msedge"]
        errors = []
        for channel in channels:
            try:
                browser = pw.chromium.launch(headless=headless, channel=channel)
                break
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{channel}: {str(exc).splitlines()[0]}")
        if browser is None:
            try:
                browser = pw.chromium.launch(headless=headless)
            except Exception as exc:  # noqa: BLE001
                raise LoginError("No supported browser found - install Google Chrome or Microsoft Edge. (" + "; ".join(errors) + ")") from exc
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()
        try:
            login(page, base, user, password, interactive=not headless)
            yield page, ctx
        finally:
            browser.close()


def login_and_get_cookies(base: str, user: str, password: str, *, headless: bool = True) -> list[dict]:
    with logged_in_page(base, user, password, headless=headless) as (_page, ctx):
        return [c for c in ctx.cookies() if "kfupm.edu.sa" in c.get("domain", "")]
