#!/usr/bin/env python3
"""All operating-system-specific behaviour, in one place.

Every OS quirk the rest of the project needs lives here: default scan root,
UI shortcuts, exclusions, on-disk size measurement, the "reveal in file
manager" command and the cache directory. No other module contains a
`sys.platform`, a `/System/Volumes/...`, an `open -R` or a
`~/Library/Application Support`; if you find yourself writing one elsewhere,
add a function here instead.

stdlib only. `ctypes` is used on Windows for the two things Python's stdlib
does not expose: the list of fixed drives and the compressed (real on-disk)
file size.
"""

import os
import sys

# Measure real on-disk occupancy on Windows via GetCompressedFileSizeW (one
# syscall per file). Set to False to use the logical st_size instead and skip
# that call. See disk_size() and the S6 checkpoint in the README.
WINDOWS_EXACT_SIZE = True

_UNKNOWN_WARNED = False


def platform_id():
    """Return "macos", "windows" or "linux".

    Anything unrecognised is treated as Linux and warned about once on stderr;
    a scanner that aborts on an odd platform is worse than one that guesses
    POSIX and keeps going.
    """
    global _UNKNOWN_WARNED
    p = sys.platform
    if p == "darwin":
        return "macos"
    if p.startswith("win"):
        return "windows"
    if p.startswith("linux"):
        return "linux"
    if not _UNKNOWN_WARNED:
        print(f"platform_support: unknown platform {p!r}, treating as linux",
              file=sys.stderr)
        _UNKNOWN_WARNED = True
    return "linux"


# --- Case normalisation ----------------------------------------------------
# Windows paths compare case-insensitively; POSIX ones do not. Every path
# comparison in the scanner routes through here so the rule lives in one spot.

def norm(path):
    return path.lower() if platform_id() == "windows" else path


# --- Windows drive enumeration (ctypes) ------------------------------------

DRIVE_FIXED = 3


def _fixed_drives():
    """Return fixed-drive roots like ["C:\\", "D:\\"] on Windows, else []."""
    if platform_id() != "windows":
        return []
    import ctypes
    kernel32 = ctypes.windll.kernel32
    bitmask = kernel32.GetLogicalDrives()
    drives = []
    for i in range(26):
        if not bitmask & (1 << i):
            continue
        root = f"{chr(ord('A') + i)}:\\"
        # Skip CD-ROM and, crucially, network drives: a stray network scan is
        # hours of accidental traversal.
        if kernel32.GetDriveTypeW(root) == DRIVE_FIXED:
            drives.append(root)
    return drives


# --- Scan root and UI shortcuts --------------------------------------------

def default_scan_root():
    pid = platform_id()
    if pid == "macos":
        # APFS mounts the real data volume here; scanning "/" double-counts it
        # via firmlinks (see excluded_here).
        return "/System/Volumes/Data"
    if pid == "windows":
        return os.environ.get("SystemDrive", "C:") + "\\"
    return "/"


def quick_roots():
    """Return [{"label", "path"}] shortcuts for the start screen."""
    home = os.path.expanduser("~")
    downloads = os.path.join(home, "Downloads")
    pid = platform_id()
    roots = [{"label": "Home", "path": home},
             {"label": "Downloads", "path": downloads}]
    if pid == "macos":
        roots.append({"label": "Library", "path": os.path.join(home, "Library")})
    elif pid == "windows":
        for drive in _fixed_drives():
            roots.append({"label": drive, "path": drive})
    return roots


# --- Exclusions ------------------------------------------------------------

def default_excludes():
    """Absolute paths never worth walking. Matched exactly (case per OS)."""
    pid = platform_id()
    if pid == "macos":
        return ("/dev", "/Volumes", "/private/var/vm", "/System/Volumes/VM")
    if pid == "windows":
        sysdrive = os.environ.get("SystemDrive", "C:")
        return (sysdrive + "\\Windows\\CSC", sysdrive + "\\$Recycle.Bin")
    # Pseudo-filesystems that either loop or are not real storage. /tmp is NOT
    # excluded (it holds real files); /var/lib/docker/overlay2 is not excluded
    # either but inflates the total via shared layers (documented in README).
    return ("/proc", "/sys", "/dev", "/run")


# Basenames skipped wherever they appear (not just at a fixed absolute path).
# Windows: per-volume system junk and the paging/hibernation files. Empty on
# POSIX (the ".Snapshot" prefix is handled separately below).
_WINDOWS_SKIP_NAMES = frozenset(n.lower() for n in (
    "System Volume Information", "pagefile.sys", "hiberfil.sys",
    "swapfile.sys", "DumpStack.log.tmp",
))


def excluded_here(path, root):
    """OS-specific exclusions that a flat path list can't express.

    Covers: the macOS APFS firmlink double-count, the macOS .Snapshot dirs,
    and the Windows basename blacklist. Everything OS-specific about *what to
    skip* lives here so the scanner stays platform-agnostic.
    """
    pid = platform_id()
    if pid == "macos":
        # /System/Volumes/Data is a firmlink back into "/": walking both
        # double-counts the whole disk.
        if root == "/" and path == "/System/Volumes/Data":
            return True
        for segment in path.split(os.sep):
            if segment.startswith(".Snapshot"):
                return True
        return False
    if pid == "windows":
        return os.path.basename(path.rstrip("\\/")).lower() in _WINDOWS_SKIP_NAMES
    return False


# --- Cross-volume check ----------------------------------------------------

def same_volume(root_path, root_st, child_path, child_st):
    """True if `child_path` is on the same volume as the scan root.

    The scanner refuses to cross volume boundaries (an external disk mounted
    under the tree would otherwise be counted into the wrong total). The
    reliable signal for "same volume" differs per OS.

    POSIX (macOS, Linux): st_dev is always populated, so compare it directly —
    unchanged behaviour.

    Windows: os.scandir() fills a DirEntry's stat from the directory listing,
    without the extra syscall that a full os.stat() makes to fetch the file
    index. So `child_st.st_dev` is routinely 0 while `root_st` (a real os.stat)
    is not, and comparing the two would drop every subdirectory as "another
    volume" — the silent no-descent bug S8 fixes. Compare the drive letter
    (case-insensitive) instead, and only fall back to st_dev when both values
    are actually populated.

    Known limitation: a volume mounted into a folder (an NTFS junction / mount
    point to another drive) shares the parent's drive letter. If its st_dev
    comes back 0 it is scanned as part of this volume. Rare on home machines,
    and the alternative — a real os.stat() per directory — is not worth its
    cost; documented rather than hidden.
    """
    if platform_id() != "windows":
        return root_st.st_dev == child_st.st_dev

    root_drive = os.path.splitdrive(root_path)[0].lower()
    child_drive = os.path.splitdrive(child_path)[0].lower()
    if root_drive != child_drive:
        return False
    # Use st_dev only when it is real on both sides; scandir leaves it 0.
    if child_st.st_dev != 0 and root_st.st_dev != 0:
        return root_st.st_dev == child_st.st_dev
    return True


# --- On-disk size ----------------------------------------------------------

_INVALID_FILE_SIZE = 0xFFFFFFFF
_NO_ERROR = 0


def disk_size(st, path):
    """Bytes actually occupied on disk for the file at `path`.

    POSIX: st_blocks * 512 (allocated 512-byte blocks), no extra syscall.
    Windows: GetCompressedFileSizeW, so compressed/sparse files report their
    real footprint like they do on macOS/Linux — consistent with the S1
    decision to measure occupancy, not logical length.
    """
    if platform_id() != "windows" or not WINDOWS_EXACT_SIZE:
        return st.st_blocks * 512

    import ctypes
    kernel32 = ctypes.windll.kernel32
    high = ctypes.c_ulong(0)
    low = kernel32.GetCompressedFileSizeW(path, ctypes.byref(high))
    if low == _INVALID_FILE_SIZE:
        # 0xFFFFFFFF is a legitimate low DWORD (a file of exactly 4 GiB - 1),
        # so it is only an error when GetLastError() is not NO_ERROR.
        if ctypes.GetLastError() != _NO_ERROR:
            return st.st_size  # fall back to logical size, never break the scan
    return (high.value << 32) | low


# --- Reveal in file manager ------------------------------------------------

def reveal_command(path):
    """argv to reveal `path` in the OS file manager (never shell=True)."""
    pid = platform_id()
    if pid == "macos":
        return ["open", "-R", path]
    if pid == "windows":
        # explorer.exe exits with code 1 even on success: the caller must treat
        # only a failure-to-launch as an error, not the return code.
        return ["explorer", "/select,", path]
    # Linux has no "-R" reveal. xdg-open on a FILE would OPEN it in its
    # associated app (which S4 forbids), so we open the parent DIRECTORY.
    return ["xdg-open", os.path.dirname(path)]


# --- Cache directory -------------------------------------------------------

def cache_dir():
    pid = platform_id()
    if pid == "windows":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return os.path.join(base, "escaner_disco")
    if pid == "linux":
        base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
        return os.path.join(base, "escaner_disco")
    return os.path.join(os.path.expanduser("~/Library/Application Support"),
                        "escaner_disco")


# --- Long-path support (Windows) -------------------------------------------

def extended_path(path):
    """Prefix `path` with \\\\?\\ on Windows so os.scandir survives paths over
    260 chars. No-op elsewhere. Only applied to the scan root; child paths
    returned to the client are the clean, prefix-free ones.
    """
    if platform_id() != "windows" or path.startswith("\\\\?\\"):
        return path
    return "\\\\?\\" + path


def strip_extended(path):
    """Inverse of extended_path, for display (error paths)."""
    return path[4:] if path.startswith("\\\\?\\") else path


if __name__ == "__main__":
    # Smoke check: the public API returns sane values on this host.
    print("platform_id     :", platform_id())
    print("default_scan_root:", default_scan_root())
    print("quick_roots     :", quick_roots())
    print("default_excludes:", default_excludes())
    print("cache_dir       :", cache_dir())
    print("reveal_command  :", reveal_command(os.path.expanduser("~/x.txt")))
    print("WINDOWS_EXACT_SIZE:", WINDOWS_EXACT_SIZE)
