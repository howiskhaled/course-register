"""Where things live, both when run from source and inside the packaged app.

From source (python app.py):            data/ debug/ in the project folder, settings in ~/.kfupm-planner
Packaged (KFUPM Planner.app / .exe):    everything writable in the user's app-data folder:
    macOS   ~/Library/Application Support/KFUPM Planner/
    Windows %APPDATA%\\KFUPM Planner\\
The bundle itself is read-only; it only carries the built UI and a seed snapshot of course data.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

FROZEN = bool(getattr(sys, "frozen", False))
SRC_ROOT = Path(__file__).resolve().parent
RESOURCES = Path(getattr(sys, "_MEIPASS", SRC_ROOT))
APP_NAME = "KFUPM Planner"


def _user_data_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    if os.name == "nt":
        return Path(os.getenv("APPDATA", str(Path.home()))) / APP_NAME
    return Path(os.getenv("XDG_DATA_HOME", str(Path.home() / ".local" / "share"))) / APP_NAME


APP_HOME = Path(os.getenv("KFUPM_APP_HOME") or (_user_data_dir() if FROZEN else Path.home() / ".kfupm-planner"))
DATA_DIR = Path(os.getenv("KFUPM_DATA_DIR") or (APP_HOME / "data" if FROZEN else SRC_ROOT / "data"))
DEBUG_DIR = Path(os.getenv("KFUPM_DEBUG_DIR") or (APP_HOME / "debug" if FROZEN else SRC_ROOT / "debug"))
COURSES_JSON = Path(os.getenv("KFUPM_COURSES_JSON") or (APP_HOME / "courses.json" if FROZEN else SRC_ROOT / "courses.json"))
LOG_FILE = Path(os.getenv("KFUPM_LOG_FILE") or (APP_HOME / "registration_log.txt" if FROZEN else SRC_ROOT / "registration_log.txt"))
DIST_DIR = RESOURCES / "frontend_dist" if FROZEN else SRC_ROOT / "frontend" / "dist"
SEED_DATA = RESOURCES / "seed_data" if FROZEN else None
WORK_DIR = APP_HOME if FROZEN else SRC_ROOT


def child_cmd(module: str) -> list[str]:
    """Command that runs scraper.py / register.py as a separate process.
    Inside the app there is no python.exe, so the app binary re-runs itself in --run mode."""
    if FROZEN:
        return [sys.executable, "--run", module]
    return [sys.executable, "-u", str(SRC_ROOT / f"{module}.py")]


def child_env() -> dict[str, str]:
    """Make child processes agree on the same folders."""
    return {
        "KFUPM_APP_HOME": str(APP_HOME),
        "KFUPM_DATA_DIR": str(DATA_DIR),
        "KFUPM_DEBUG_DIR": str(DEBUG_DIR),
        "KFUPM_COURSES_JSON": str(COURSES_JSON),
        "KFUPM_LOG_FILE": str(LOG_FILE),
    }
