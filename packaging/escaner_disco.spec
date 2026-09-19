# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the macOS .app. Run it through build_macos.sh.
# onedir (never onefile): a stable path is what TCC grants Full Disk Access to.
import os

ROOT = os.path.dirname(SPECPATH)

a = Analysis(
    [os.path.join(ROOT, "app_main.py")],
    pathex=[ROOT],
    datas=[(os.path.join(ROOT, "static"), "static")],
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Escáner de Disco",
    console=False,  # windowed: no terminal window
    upx=False,
)

coll = COLLECT(exe, a.binaries, a.datas, upx=False, name="Escáner de Disco")

app = BUNDLE(
    coll,
    name="Escáner de Disco.app",
    icon=None,  # pending: add an .icns
    bundle_identifier="com.pATMosk19.escanerdisco",
    info_plist={"NSHighResolutionCapable": True},
)
