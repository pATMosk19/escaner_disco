# Packaging (macOS)

Builds a double-clickable `.app` with PyInstaller. PyInstaller is a **build-time**
dependency only: nothing in `scanner.py`, `server.py`, `cache.py` or
`platform_support.py` imports it, and `python3 server.py` still needs no
installs.

## Build

```zsh
# Once, OUTSIDE the repo:
python3 -m venv ~/.venvs/escaner-disco-build
source ~/.venvs/escaner-disco-build/bin/activate
pip install pyinstaller

# From the repo root, with that venv active:
./packaging/build_macos.sh
```

The result is `dist/Escáner de Disco.app` (`--onedir` inside a `.app`, windowed,
ad-hoc signed). `build/` and `dist/` are git-ignored.

## Notes

- Not notarized. On another Mac the first launch needs right-click → Open.
- Full Disk Access must be granted to the `.app` itself (not Terminal); see the
  main README.
- Pending: no app icon yet (`icon=None` in the spec).
