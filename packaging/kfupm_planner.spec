# PyInstaller spec for "KFUPM Planner.app" (macOS). Build with ./build_mac.sh
# Windows later: the same Analysis works; drop BUNDLE and use an .ico.
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
        continue  # course data lives in app-data (seeded below), not in the UI folder
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
    # run as subcommands of the app binary (`--run scraper` / `--run register`)
    hiddenimports=[
        "scraper",
        "register",
        "kfupm_auth",
        "radar",
        "radar_service",
        "autopilot",
        "ocr",
        "Vision",
        "Quartz",
        "secrets_store",
        "paths",
        "webview",
        "webview.platforms.cocoa",
        "keyring.backends.macOS",
        "AppKit",
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
    argv_emulation=False,
    target_arch=None,
)

coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="KFUPM Planner")

app = BUNDLE(
    coll,
    name="KFUPM Planner.app",
    icon=os.path.join(ROOT, "build", "icon.icns"),
    bundle_identifier="local.kfupm-planner",
    version="1.0.0",
    info_plist={
        "CFBundleDisplayName": "KFUPM Planner",
        "CFBundleShortVersionString": "1.0.0",
        "CFBundleVersion": "1",
        "LSMinimumSystemVersion": "11.0",
        "NSHighResolutionCapable": True,
        "NSRequiresAquaSystemAppearance": False,
        "LSApplicationCategoryType": "public.app-category.education",
        # the UI is served from 127.0.0.1 inside the app
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
    },
)
