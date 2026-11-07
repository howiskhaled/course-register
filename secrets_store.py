"""Where the desktop app keeps secrets (KFUPM login, Telegram token).

Uses the operating system's keychain via `keyring` (macOS Keychain / Windows Credential
Locker / Secret Service). Nothing secret is ever written to a plain file by the app.
If `keyring` isn't available the secrets are kept in memory for this run only.
"""
from __future__ import annotations

import json

SERVICE = "kfupm-schedule-planner"

try:  # pragma: no cover - depends on the machine
    import keyring as _keyring
    from keyring.errors import KeyringError
except Exception:  # noqa: BLE001
    _keyring = None

    class KeyringError(Exception):  # type: ignore[no-redef]
        pass


class SecretStore:
    def __init__(self, backend=None):
        """`backend` needs get_password/set_password/delete_password (tests pass a fake)."""
        self._kr = backend if backend is not None else _keyring
        self._mem: dict[str, str] = {}
        # Read each secret from the keychain once per launch: macOS may show an "allow access"
        # prompt for a newly built app, and the UI asks for status every few seconds.
        self._cache: dict[str, str | None] = {}
        self.persistent = self._kr is not None

    def _get(self, key: str) -> str | None:
        if key in self._cache:
            return self._cache[key]
        value = self._read(key)
        self._cache[key] = value
        return value

    def _read(self, key: str) -> str | None:
        if self._kr is not None:
            try:
                return self._kr.get_password(SERVICE, key)
            except Exception:  # noqa: BLE001 - keychain locked / unavailable
                self.persistent = False
        return self._mem.get(key)

    def _set(self, key: str, value: str) -> None:
        self._cache[key] = value
        if self._kr is not None:
            try:
                self._kr.set_password(SERVICE, key, value)
                return
            except Exception:  # noqa: BLE001
                self.persistent = False
        self._mem[key] = value

    def _del(self, key: str) -> None:
        self._cache[key] = None
        self._mem.pop(key, None)
        if self._kr is not None:
            try:
                self._kr.delete_password(SERVICE, key)
            except Exception:  # noqa: BLE001 - not stored is fine
                pass

    # -- KFUPM login ------------------------------------------------------
    def get_login(self) -> tuple[str, str] | None:
        raw = self._get("kfupm-login")
        if not raw:
            return None
        try:
            d = json.loads(raw)
            return d["id"], d["password"]
        except (ValueError, KeyError):
            return None

    def set_login(self, user_id: str, password: str) -> None:
        self._set("kfupm-login", json.dumps({"id": user_id, "password": password}))

    def clear_login(self) -> None:
        self._del("kfupm-login")

    # -- Telegram ---------------------------------------------------------
    def get_telegram_token(self) -> str | None:
        return self._get("telegram-token")

    def set_telegram_token(self, token: str) -> None:
        self._set("telegram-token", token)

    def clear_telegram_token(self) -> None:
        self._del("telegram-token")
