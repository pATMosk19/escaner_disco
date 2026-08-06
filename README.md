[Español](README.es.md)

# escaner_disco

A local, read-only disk usage analyzer for macOS with a navigable sunburst
chart. No dependencies.

<!-- Screenshot to be added by the author; place the file at docs/screenshot.png -->
![screenshot](docs/screenshot.png)

## Requirements

- macOS.
- Python 3 (standard library only).
- No `pip`, no `npm`, no CDN. The frontend is vanilla HTML/CSS/JS and the
  sunburst is drawn by hand with SVG `<path>` elements.

## Usage

Start the local server:

```bash
python3 server.py            # serves http://127.0.0.1:8765
```

Open <http://127.0.0.1:8765>, type a path (default `/System/Volumes/Data`) or
use the quick links (`~`, `~/Downloads`, `~/Library`) and press **Escanear**.
Stop it with `Ctrl-C` in the terminal where it runs. The port is configurable:
`python3 server.py --port 9000`.

There is also a CLI mode that prints the top 20 and a summary, or dumps the full
tree as JSON:

```bash
python3 scanner.py /System/Volumes/Data
python3 scanner.py ~/Downloads --json tree.json
```

## Full Disk Access

To scan outside your home folder, macOS requires **Full Disk Access** for the
app that launches the server, under:

> System Settings → Privacy & Security → Full Disk Access

**Launch it from Terminal (or iTerm), not from your editor.** On macOS the
privacy permissions (TCC) are inherited from the parent process: the scan can
read exactly what the launching app can read. If you grant Full Disk Access to
Terminal and start `server.py` from there, the server inherits it; start it from
an editor without that permission and you will see many folders locked even
though the code is identical.

Without the permission the scan does not fail, but many system folders come back
as permission errors and the reported total is short. The app makes this visible
with a warning banner under the breadcrumb; expand it to see the unreadable
paths.

## Design decisions

**Real on-disk size (`st_blocks * 512`), not `st_size`.** We want the space a
file actually occupies — what you get back when you delete it — not its logical
length. `st_size` ignores APFS compression and sparse files, and does not
account for block-size rounding on tiny files. The trade-off: APFS clones share
their blocks physically but are counted once per clone here, so cloned data is
overcounted. `du` uses blocks for the same reason.

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

**What a locked folder means.** A folder shown with a lock is a directory that
could not be opened (typically a permissions error). It shows a dash, not
`0 B` — `0 B` would mean "it is empty", and the truth is "I could not look
inside". It is not drawn in the sunburst because its size is 0; giving it an
artificial minimum size would falsify the chart. The list and the banner are the
channel for that information.

**Read-only, with one deliberate side effect.** Two ideas used to hide under
"read-only"; from S4 they are separated. First: the app never modifies the file
system. That stays absolute, no exceptions — "Reveal in Finder" honours it,
because `open -R` only opens a Finder window, it changes nothing. Second: no
endpoint has side effects. That one is broken exactly once, on purpose, by
`POST /api/reveal`, which opens Finder at a given path. It is considered safe
because `open -R` executes nothing (plain `open` would launch the file's app;
the `-R` flag only reveals it), the path must be a node the last scan actually
produced (an arbitrary filesystem path is rejected with 404), and the endpoint
is `POST`-only with an `Origin` check, so a stray `<img>` tag or a cross-site
page in another tab cannot trigger it. Every other endpoint is still read-only.

## Performance

Reference scan of `/System/Volumes/Data` on a test volume of ~1.2M files and
~123 GB total, without `sudo`:

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
├── server.py           # local HTTP server, 127.0.0.1 only
├── static/
│   ├── index.html
│   ├── app.js          # sunburst, list, breadcrumb, error banner
│   └── style.css
├── docs/               # original per-session specs (in Spanish)
├── LICENSE
├── README.md           # this file (canonical, English)
└── README.es.md        # Spanish translation
```

## Docs

`docs/` contains the original per-session specifications (`PROMPT-S1.md`,
`PROMPT-S2.md`, `PROMPT-S3.md`), written in Spanish. They record how the project
was built session by session.

## License

MIT — see [LICENSE](LICENSE).
