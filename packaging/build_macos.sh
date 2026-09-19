#!/usr/bin/env bash
# Build "dist/Escáner de Disco.app". Needs PyInstaller on PATH (see README.md).
set -euo pipefail
cd "$(dirname "$0")/.."

pyinstaller --noconfirm packaging/escaner_disco.spec

APP="dist/Escáner de Disco.app"
[[ -d "$APP" ]] || { echo "build failed: $APP not found" >&2; exit 1; }

# Ad-hoc signature: free, and avoids some warnings when copying between Macs.
# No --deep: on this toolchain it crashes codesign (bus error); PyInstaller has
# already signed the inner binaries, so signing the bundle itself is enough.
codesign --force -s - "$APP"
echo "Built: $APP"
