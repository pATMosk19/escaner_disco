[Español](README.es.md)

# escaner_disco

A local, read-only disk usage analyzer for macOS, Windows and Linux with a
navigable chart — switch between a **sunburst** and a **treemap** view of the
same data. No dependencies.

![Sunburst view](docs/screenshot.png)
*Sunburst view, with the unreadable-paths banner.*

![Treemap view](docs/screenshot-treemap.png)
*Treemap view, nested two levels.*

## Requirements

- macOS, Windows or Linux.
- Python 3 (standard library only; `ctypes`, also stdlib, is used on Windows).
- No `pip`, no `npm`, no CDN. The frontend is vanilla HTML/CSS/JS and the
  sunburst is drawn by hand with SVG `<path>` elements.

## Platform support

The same `python3 server.py` runs on all three systems. Everything OS-specific
lives in a single module, `platform_support.py`.

| Feature | macOS | Windows | Linux |
|---|---|---|---|
| Default scan root | `/System/Volumes/Data` | system drive (`C:\`) | `/` |
| Quick roots | Home, Downloads, `~/Library` | Home, Downloads, one per fixed drive | Home, Downloads |
| Real on-disk size | `st_blocks * 512` | `GetCompressedFileSizeW` (one call per file, see below) | `st_blocks * 512` |
| Reveal in file manager | reveals the file (Finder) | selects the file (Explorer) | opens the **parent directory** (`xdg-open`) |
| Cache directory | `~/Library/Application Support/escaner_disco` | `%LOCALAPPDATA%\escaner_disco` | `$XDG_DATA_HOME` or `~/.local/share/escaner_disco` |

Known limitations:

- **Windows exact size.** Real occupancy uses `GetCompressedFileSizeW`, one
  syscall per file. Set `WINDOWS_EXACT_SIZE = False` in `platform_support.py` to
  fall back to the logical `st_size` and skip the call.
- **Linux reveal.** There is no `-R`-style "reveal" on Linux; `xdg-open` on a
  file would *launch* it in its associated app (which the reveal endpoint
  forbids), so on Linux it opens the containing directory instead.
- **Caches are not portable across systems.** A cache records paths, separators
  and size semantics of one OS; it is tagged with the platform that wrote it and
  ignored on load elsewhere.

## Usage

Start the local server:

```bash
python3 server.py            # serves http://127.0.0.1:8765
```

Open <http://127.0.0.1:8765>, type a path (the default and the quick links are
filled in per OS from `/api/config`) and press **Escanear**. Stop it with
`Ctrl-C` in the terminal where it runs. The port is configurable:
`python3 server.py --port 9000`.

Above the chart, two tabs switch between the **Sunburst** and **Treemap**
views. Switching keeps the current folder, breadcrumb, list and zoom — only the
renderer changes, and the colours carry over (what is blue in one view is blue
in the other). The choice is remembered across sessions.

There is also a CLI mode that prints the top 20 and a summary, or dumps the full
tree as JSON:

```bash
python3 scanner.py /System/Volumes/Data
python3 scanner.py ~/Downloads --json tree.json
```

## Permissions

Without enough privileges the scan does **not** fail, but many system folders
come back as permission errors and the reported total is short. The app makes
this visible with a warning banner under the breadcrumb; expand it to see the
unreadable paths. How to reduce those errors depends on the OS.

### macOS — Full Disk Access

To scan outside your home folder, macOS requires **Full Disk Access** for the
app that launches the server, under:

> System Settings → Privacy & Security → Full Disk Access

**Launch it from Terminal (or iTerm), not from your editor.** On macOS the
privacy permissions (TCC) are inherited from the parent process: the scan can
read exactly what the launching app can read. If you grant Full Disk Access to
Terminal and start `server.py` from there, the server inherits it; start it from
an editor without that permission and you will see many folders locked even
though the code is identical.

### Windows — run as Administrator

Protected system areas require an **elevated** command prompt. Start it with
"Run as administrator", then `python server.py`. Note that the cache lives in
`%LOCALAPPDATA%`, inside your user profile: on NTFS the POSIX `chmod 0600/0700`
the app applies is almost a no-op, and the real protection is that location, not
the file mode.

### Linux — sufficient privileges

To read paths you do not own, run with enough privileges (e.g. `sudo`), at the
cost of running a local HTTP server as root. `/proc`, `/sys`, `/dev` and `/run`
are skipped as pseudo-filesystems. `/var/lib/docker/overlay2` is **not** skipped
and can inflate the total, because container layers share files that get counted
under several overlays.

## Caching

After each successful scan the tree is cached to disk so you don't wait ~35 s on
every startup. The cache lives in the app's **own** directory (per OS — see the
Platform support table), never inside the project, because a cache file is a
full map of the names of your folders. Files are created `0600`, the directory
`0700` (on Windows/NTFS those modes barely apply; the protection there is living
inside `%LOCALAPPDATA%`). Each cache is tagged with the platform that wrote it
and ignored on load on a different OS — a macOS cache does not describe a Windows
disk.

Format is json + gzip, both stdlib. **Never pickle:** unpickling executes code,
and this tool can't take that risk even in a file it wrote itself. There is one
file per scanned path, named by a hash of the path (the path itself is stored
inside), so several caches can coexist. A 1.2M-node scan compresses to ~3 MB.

The cache is **never invalidated automatically.** When the active tree comes
from cache the app shows when it was taken (`Datos del 6 ago, 20:47 ·
Rescanear`) instead of pretending it's fresh — you decide whether to keep it or
rescan. Raising `MAX_CHILDREN` invalidates existing caches: a file built with a
different cap is ignored on load (with a warning), because pruning happens at
scan time.

Three endpoints back this: `GET /api/cache` lists saved scans, `POST
/api/cache/load` loads one into memory, `POST /api/cache/clear` deletes every
cache file. The two POSTs are `Origin`-checked and POST-only like
`/api/reveal`; `clear` takes **no path** (the client says "clear", not "clear
this") and only ever removes `*.json.gz` inside the cache directory, file by
file — never `shutil.rmtree`.

## Design decisions

**All OS-specific code in one module.** Default root, quick roots, exclusions,
on-disk size, reveal command and cache directory all differ per system;
`platform_support.py` is the only file that knows which OS it is running on
(`scanner.py`, `server.py` and `cache.py` contain no `sys.platform`). One place
to read when porting, one place to change, and the rest of the code stays
readable without OS branches scattered through it.

**Real on-disk size, not `st_size`.** We want the space a file actually occupies
— what you get back when you delete it — not its logical length. `st_size`
ignores compression and sparse files and does not account for block-size
rounding on tiny files. On macOS and Linux that is `st_blocks * 512`. On Windows
there is no `st_blocks`, so we call `GetCompressedFileSizeW` (via `ctypes`) to
get the real footprint — the same decision as S1 (measure occupancy, not logical
length), kept consistent across platforms. It costs one syscall per file;
`WINDOWS_EXACT_SIZE = False` trades that accuracy for `st_size` and no extra
call. The trade-off elsewhere: APFS clones share their blocks physically but are
counted once per clone here, so cloned data is overcounted. `du` uses blocks for
the same reason.

**Scan `/System/Volumes/Data`, not `/`.** On APFS the root `/` is read-only and
user data lives on `/System/Volumes/Data`, mounted over `/` through firmlinks.
Scanning `/` would count the same paths twice (once via `/`, once via the
firmlink), so when the root is `/` we exclude `/System/Volumes/Data`. A
consequence is that the reported total is not directly comparable with the
figure System Settings shows.

**Base 1000 (GB), not 1024 (GiB).** Sizes are formatted in base 1000 because
that is what Finder shows in "Get Info". Using GiB would make the numbers
disagree with Finder and look like a bug.

**`MAX_CHILDREN = 40`, pruned while building the tree, not while serving.** A
full disk has millions of nodes; keeping the whole tree in RAM was expensive and
most of it is tiny subtrees nobody ever looks at. Each directory keeps only its
40 largest children and the rest are collapsed into a single synthetic node,
`"Otros (N elementos)"`. The parent's `size` and `n_files` are accumulated over
*all* children **before** pruning, so the scan total never changes. Raising the
constant requires re-scanning, because the discarded subtrees are no longer in
memory.

**Treemap: squarified, two levels deep.** The treemap is an alternative to the
sunburst over the same tree, in tabs rather than side by side — on a 13" laptop
two live charts leave each too small to read. The layout is a *squarified*
treemap (Bruls, Huizing & van Wijk), not slice-and-dice: slice-and-dice with 40
children of very different sizes produces 2px-wide strips that are illegible and
impossible to click, while squarify keeps every tile close to square. It nests
**two** levels — direct children with a header, and their children inside — and
no deeper: seeing the grandchildren is where the treemap beats the sunburst (you
read at a glance that the weight is in `Library/Caches/something` without
drilling), but a third level would be confetti. Thresholds keep it honest: a
level-1 cell under 60×40px is painted solid instead of subdivided, nothing
thinner than 3px on any side is drawn at all, and text is drawn only when it fits
the tile whole — no mid-word ellipsis, the tooltip carries the rest.

**What a locked folder means.** A folder shown with a lock is a directory that
could not be opened (typically a permissions error). It shows a dash, not
`0 B` — `0 B` would mean "it is empty", and the truth is "I could not look
inside". It is not drawn in either chart because its size is 0: in the treemap,
just as in the sunburst, an unreadable folder has zero area and simply doesn't
appear; giving it an artificial minimum size would falsify the chart. The list
and the banner are the channel for that information.

**Never touches your files; manages only its own.** Two promises used to hide
under "read-only". First: the app never modifies *your* files — absolute, no
exceptions. What it does manage, since S5, is **its own cache files**, in its
own directory, that it created; "does not delete anything" and "does not delete
anything of yours" are different promises, and the second is the one we can
keep. `/api/cache/clear` only ever deletes the app's `*.json.gz`, and never
accepts a path from the client. Second: no endpoint has side effects — broken on
purpose by `POST /api/reveal` (reveals the item in the OS file manager without
launching it, the path must be a node the scan produced, `POST`-only with an
`Origin` check) and by the cache endpoints. Every other endpoint is still
read-only.

## Performance

Reference scan of `/System/Volumes/Data` on macOS, a test volume of ~1.2M files
and ~123 GB total, without `sudo`:

| Metric                          | S1     | S2         |
|---------------------------------|--------|------------|
| Peak RSS (`/usr/bin/time -l`)   | 929 MB | **227 MB** |
| Scan time                       | ~36 s  | ~35 s      |
| Total accounted                 | ~123 GB | ~123 GB   |

Memory dropped to roughly a quarter without changing the total or the scan time.
The saving comes from pruning to 40 children at scan time and from storing only
the entry name in each node — not from measuring less disk.

## Project layout

```
escaner_disco/
├── scanner.py          # iterative, read-only disk scanner (stdlib)
├── platform_support.py # all OS-specific behaviour (macOS/Windows/Linux)
├── server.py           # local HTTP server, 127.0.0.1 only
├── cache.py            # on-disk gzip+json cache of scanned trees
├── static/
│   ├── index.html
│   ├── app.js          # sunburst, treemap, list, breadcrumb, error banner, cache UI
│   └── style.css
├── docs/               # original per-session specs (in Spanish)
├── LICENSE
├── README.md           # this file (canonical, English)
└── README.es.md        # Spanish translation
```

## Docs

`docs/` contains the original per-session specifications (`PROMPT-S1.md`
through `PROMPT-S7.md`), written in Spanish. They record how the project was
built session by session.

## License

MIT — see [LICENSE](LICENSE).
