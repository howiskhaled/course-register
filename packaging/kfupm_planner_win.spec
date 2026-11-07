# PyInstaller spec for Windows: release/KFUPM Planner/KFUPM Planner.exe (one-folder build).
# Built by .github/workflows/windows.yml on a Windows runner; the installer wraps this folder.
# -*- mode: python ; coding: utf-8 -*-
import glob
import os

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))

# Bundle ONLY what the app needs. Never add .env, plan.json, logs or debug output.
DIST = os.path.join(ROOT, "frontend", "dist")
datas = []
for folder, _dirs, files in os.walk(DIST):
    rel = os.path.relpath(folder, DIST)
    if rel == "data" or rel.startswith("data" + os.sep):
        continue
    for f in files:
        if rel == "." and f == "courses.json":
            continue
        datas.append((os.path.join(folder, f), os.path.normpath(os.path.join("frontend_dist", rel))))
SEED = glob.glob(os.path.join(ROOT, "data", "*.json")) or glob.glob(os.path.join(ROOT, "packaging", "seed_data", "*.json"))
datas += [(f, "seed_data") for f in SEED]

a = Analysis(
    [os.path.join(ROOT, "app.py")],
    pathex=[ROOT],
    datas=datas,
    hiddenimports=[
        "scraper",
        "register",
        "kfupm_auth",
        "radar",
        "radar_service",
        "autopilot",
        "secrets_store",
        "paths",
        "ocr",
        "webview",
        "keyring.backends.Windows",
        "win32ctypes.core",
        "win32ctypes.pywin32.win32cred",
    ],
    excludes=["tkinter", "test", "unittest", "pydoc"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="KFUPM Planner",
    console=False,
    debug=False,
    strip=False,
    upx=False,
    icon=os.path.join(ROOT, "build", "icon.ico"),
)

coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="KFUPM Planner")
