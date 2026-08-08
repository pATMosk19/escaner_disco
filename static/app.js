"use strict";

// --- Geometry constants (SVG is 1000x1000, centred at 500,500) ---
const CX = 500, CY = 500;
const CENTER_R = 180;      // radius of the centre circle (current node)
const RINGS = 4;
const MAX_R = 480;
const RING_W = (MAX_R - CENTER_R) / RINGS;
const MIN_ANGLE = 0.5;     // don't draw sectors narrower than this (degrees)

// --- App state ---
const VIEW_KEY = "escaner_disco.view";
function loadView() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return (v === "treemap" || v === "junk") ? v : "sunburst";
  } catch (e) { return "sunburst"; }  // invalid/blocked storage -> sunburst
}

const state = {
  rootPath: "",   // absolute root of the scan
  current: null,  // current node (centre), pruned subtree from /api/node
  source: "",     // "scan" | "cache" — where the active tree came from
  scannedAt: 0,   // epoch seconds the active tree was scanned
  platform: "",   // "macos" | "windows" | "linux"
  sep: "/",       // path separator for this platform
  view: loadView(), // "sunburst" | "treemap" — remembered across sessions
};

// Path separator per platform. Windows paths from the server use backslashes.
function sepFor(platform) { return platform === "windows" ? "\\" : "/"; }

// Parent of an absolute path, using the active separator. Never climbs above
// the scan root (the caller re-clamps to root anyway).
function parentPath(path) {
  const i = path.lastIndexOf(state.sep);
  return i <= 0 ? path : path.slice(0, i);
}

// Join like the server's os.path.join: no double separator at a drive/root
// that already ends in one (e.g. "C:\\" + "Users" -> "C:\\Users").
function joinPath(base, name) {
  return base.endsWith(state.sep) ? base + name : base + state.sep + name;
}

// --- Size formatting: base 1000, like Finder ---
function human(size) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = size, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return i === 0 ? `${size} B` : `${v.toFixed(1)} ${units[i]}`;
}

// --- Polar helper: angle measured from top (12 o'clock), clockwise ---
function polar(r, deg) {
  const rad = (deg - 90) * Math.PI / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
}

function sectorPath(a0, a1, rInner, rOuter) {
  if (a1 - a0 >= 360) a1 = a0 + 359.999;  // avoid degenerate full-circle arc
  const large = (a1 - a0) > 180 ? 1 : 0;
  const [x0o, y0o] = polar(rOuter, a0);
  const [x1o, y1o] = polar(rOuter, a1);
  const [x1i, y1i] = polar(rInner, a1);
  const [x0i, y0i] = polar(rInner, a0);
  return `M${x0o} ${y0o} A${rOuter} ${rOuter} 0 ${large} 1 ${x1o} ${y1o} `
       + `L${x1i} ${y1i} A${rInner} ${rInner} 0 ${large} 0 ${x0i} ${y0i} Z`;
}

function color(hue, depth) {
  // Inherit hue from first-level ancestor; darken with depth.
  const lum = Math.max(28, 60 - depth * 7);
  return `hsl(${hue}, 55%, ${lum}%)`;
}

// --- Build a flat list of sectors from the current node, up to 4 rings ---
function buildSectors(current) {
  const sectors = [];
  const kids = current.children || [];
  const total = current.size || 1;
  let a = 0;
  kids.forEach((child, i) => {
    const span = 360 * (child.size / total);
    const hue = Math.round(i * 360 / Math.max(1, kids.length));
    layout(child, 1, a, a + span, hue, child.path, sectors);
    a += span;
  });
  return sectors;
}

function layout(node, depth, a0, a1, hue, rootChildPath, sectors) {
  if (depth > RINGS) return;
  if (a1 - a0 < MIN_ANGLE) return;
  sectors.push({ node, ring: depth - 1, a0, a1, hue, depth, rootChildPath });
  const total = node.size || 1;
  let a = a0;
  for (const child of (node.children || [])) {
    const span = (a1 - a0) * (child.size / total);
    layout(child, depth + 1, a, a + span, hue, rootChildPath, sectors);
    a += span;
  }
}

// --- Rendering ---
const NS = "http://www.w3.org/2000/svg";
function makeSvg(id, viewBox) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("id", id);
  s.setAttribute("viewBox", viewBox);
  return s;
}
// Both charts live off-DOM until mounted. Only one is ever in the document at a
// time (see renderChart) so we never keep two live SVG trees around.
const sunburstSvg = makeSvg("sunburst", "0 0 1000 1000");
const treemapSvg = makeSvg("treemap", "0 0 1200 900");
const svg = sunburstSvg;  // sunburst code below refers to `svg`
// Treemap events are delegated on the container (one listener each), not per
// rect — the worst case is ~1600 rects.
treemapSvg.addEventListener("mousemove", onTreemapMove);
treemapSvg.addEventListener("mouseleave", clearHover);
treemapSvg.addEventListener("click", onTreemapClick);

const tooltip = document.getElementById("tooltip");

// The chart element currently mounted; hover/highlight code is chart-agnostic.
function chartEl() { return state.view === "treemap" ? treemapSvg : sunburstSvg; }

// Name of the OS file manager, for button labels and confirmations.
function fileManager() {
  if (state.platform === "windows") return "el Explorador";
  if (state.platform === "linux") return "el gestor de archivos";
  return "Finder";
}

function isNavigable(node) {
  // Unreadable dirs have no children to show, so zooming in is pointless.
  return node && node.is_dir && !node.synthetic && !node.unreadable;
}

// The two main panels are held by reference so the junk tab can unmount them
// from the DOM (S7 rule: the inactive view is removed, not display:none) and
// re-mount them on return, preserving the current node and zoom untouched.
const chartPanelEl = document.getElementById("chart-panel");
const listPanelEl = document.getElementById("list-panel");
const junkPanel = document.createElement("div");
junkPanel.id = "junk-panel";

function render() {
  renderBreadcrumb();
  renderTabs();
  if (state.view === "junk") {
    showJunkPanel();
    renderJunk();
  } else {
    showMainPanels();
    renderChart();
    renderList();
  }
}

// Chart+list mounted, junk panel gone.
function showMainPanels() {
  const panels = document.querySelector(".panels");
  if (junkPanel.parentNode) { junkPanel.remove(); junkPanel.textContent = ""; }
  if (!chartPanelEl.parentNode) panels.appendChild(chartPanelEl);
  if (!listPanelEl.parentNode) panels.appendChild(listPanelEl);
}

// Junk panel mounted (full width), chart+list removed from the DOM.
function showJunkPanel() {
  const panels = document.querySelector(".panels");
  if (chartPanelEl.parentNode) chartPanelEl.remove();
  if (listPanelEl.parentNode) listPanelEl.remove();
  if (!junkPanel.parentNode) panels.appendChild(junkPanel);
}

// Mount the active chart, unmount (and empty) the other so no stale SVG tree
// keeps consuming memory or layout time.
function renderChart() {
  const panel = document.getElementById("chart-panel");
  const [show, hide] = state.view === "treemap"
    ? [treemapSvg, sunburstSvg] : [sunburstSvg, treemapSvg];
  if (hide.parentNode) { hide.remove(); hide.textContent = ""; }
  if (!show.parentNode) panel.appendChild(show);
  if (state.view === "treemap") renderTreemap(); else renderSunburst();
}

function renderSunburst() {
  const cur = state.current;
  const total = cur.size || 1;
  svg.textContent = "";

  // Sectors
  for (const s of buildSectors(cur)) {
    const rInner = CENTER_R + s.ring * RING_W;
    const rOuter = rInner + RING_W;
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", sectorPath(s.a0, s.a1, rInner, rOuter));
    p.setAttribute("fill", color(s.hue, s.depth));
    p.dataset.rootChild = s.rootChildPath;
    p._node = s.node;
    p.addEventListener("mousemove", (e) => onHover(e, s, p));
    p.addEventListener("mouseleave", clearHover);
    p.addEventListener("click", () => zoomTo(s.node));
    svg.appendChild(p);
  }

  // Centre circle
  const c = document.createElementNS(NS, "circle");
  c.setAttribute("cx", CX); c.setAttribute("cy", CY);
  c.setAttribute("r", CENTER_R - 4);
  c.setAttribute("fill", "var(--panel)");
  c.style.cursor = state.current.path === state.rootPath ? "default" : "pointer";
  c.addEventListener("click", goUp);
  svg.appendChild(c);

  const name = document.createElementNS(NS, "text");
  name.setAttribute("id", "center-label");
  name.setAttribute("x", CX); name.setAttribute("y", CY - 10);
  name.setAttribute("text-anchor", "middle");
  name.setAttribute("font-size", "34");
  name.setAttribute("font-weight", "600");
  name.textContent = truncate(cur.name, 16);
  svg.appendChild(name);

  const sz = document.createElementNS(NS, "text");
  sz.setAttribute("x", CX); sz.setAttribute("y", CY + 28);
  sz.setAttribute("text-anchor", "middle");
  sz.setAttribute("font-size", "28");
  sz.setAttribute("fill", "var(--muted)");
  sz.textContent = human(total);
  svg.appendChild(sz);
}

// --- Treemap ---
const TM_HEADER = 18;   // px reserved at the top of a level-1 cell for its name
const TM_PAD = 2;       // px inner padding before subdividing into grandchildren
const TM_MIN_SIDE = 3;  // rects thinner than this on any side aren't drawn
const TM_MIN_W = 60, TM_MIN_H = 40;  // below this a level-1 cell isn't subdivided

// Squarified treemap (Bruls, Huizing & van Wijk). Pure: no DOM, no globals, so
// it can be exercised straight from the console. items: [{size, ...}] sorted by
// size desc; rect: {x, y, w, h}. Returns each item spread with its {x, y, w, h}.
// Zero/negative sizes get no area, so unreadable nodes (size 0) never appear.
function squarify(items, rect) {
  const out = [];
  const total = items.reduce((s, it) => s + (it.size > 0 ? it.size : 0), 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return out;
  const scale = (rect.w * rect.h) / total;
  const free = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  let i = 0;
  const n = items.length;
  while (i < n) {
    if (!(items[i].size > 0)) { i++; continue; }  // sorted desc -> only trailing
    const side = Math.min(free.w, free.h);
    const start = i;
    const areas = [items[i].size * scale];
    i++;
    // Grow the row while the next item doesn't worsen its worst aspect ratio.
    while (i < n && items[i].size > 0) {
      const a = items[i].size * scale;
      if (worstRatio(areas, side) >= worstRatio(areas.concat(a), side)) {
        areas.push(a); i++;
      } else break;
    }
    // Lay the closed row along the shorter side; subtract its band from `free`.
    const sum = areas.reduce((s, a) => s + a, 0);
    if (free.w <= free.h) {
      const bandH = sum / free.w;
      let x = free.x;
      for (let k = 0; k < areas.length; k++) {
        const w = areas[k] / bandH;
        out.push({ ...items[start + k], x, y: free.y, w, h: bandH });
        x += w;
      }
      free.y += bandH; free.h -= bandH;
    } else {
      const bandW = sum / free.h;
      let y = free.y;
      for (let k = 0; k < areas.length; k++) {
        const h = areas[k] / bandW;
        out.push({ ...items[start + k], x: free.x, y, w: bandW, h });
        y += h;
      }
      free.x += bandW; free.w -= bandW;
    }
  }
  return out;
}

// Worst (largest) aspect ratio in a row of `areas` laid along length `side`.
function worstRatio(areas, side) {
  let sum = 0, max = -Infinity, min = Infinity;
  for (const a of areas) { sum += a; if (a > max) max = a; if (a < min) min = a; }
  const s2 = sum * sum, side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

let _lastPaintMs = 0;  // last treemap paint time, for the perf checkpoint

function renderTreemap() {
  const cur = state.current;
  const panel = document.getElementById("chart-panel");
  // viewBox follows the container's real aspect (~4:3) so tiles aren't squashed
  // and 1 unit == 1 px, making the px thresholds above exact.
  const VW = panel.clientWidth || 1200, VH = panel.clientHeight || 900;
  treemapSvg.setAttribute("viewBox", `0 0 ${VW} ${VH}`);
  treemapSvg.textContent = "";

  const kids = cur.children || [];
  // Level-1 hue by index over children (already size-desc from the server), so
  // colours match the sunburst and the list: what was blue stays blue.
  const items = kids.map((child, i) => ({
    node: child, size: child.size,
    hue: Math.round(i * 360 / Math.max(1, kids.length)),
  }));

  const t0 = performance.now();
  const frag = document.createDocumentFragment();
  for (const cell of squarify(items, { x: 0, y: 0, w: VW, h: VH })) drawL1Cell(cell, frag);
  treemapSvg.appendChild(frag);  // mount the whole tree in one go
  _lastPaintMs = performance.now() - t0;
}

function drawL1Cell(cell, frag) {
  if (cell.w < TM_MIN_SIDE || cell.h < TM_MIN_SIDE) return;  // invisible/unclickable
  const node = cell.node, rc = node.path;
  const canNest = cell.w >= TM_MIN_W && cell.h >= TM_MIN_H
    && node.is_dir && !node.synthetic && !node.unreadable
    && (node.children || []).length > 0;

  // Full cell: its own colour (also the backdrop behind grandchild gaps) and the
  // click/hover target for the level-1 directory itself.
  addRect(frag, cell, color(cell.hue, 1), node, rc);

  if (!canNest) {
    // Solid tile: name if it fits whole, else nothing (the tooltip tells).
    addLabel(frag, node.name, cell.x + 4, cell.y + cell.h / 2 + 4, 13,
             "var(--text)", cell.w - 8, cell.h);
    return;
  }

  // Header band (darker) with name + size if it fits, then subdivide the body.
  addRect(frag, { x: cell.x, y: cell.y, w: cell.w, h: TM_HEADER },
          headerColor(cell.hue), node, rc);
  const withSize = `${node.name}  ${human(node.size)}`;
  const head = fitsText(withSize, 12, cell.w - 8) ? withSize : node.name;
  addLabel(frag, head, cell.x + 4, cell.y + 13, 12, "var(--text)", cell.w - 8, TM_HEADER);

  const body = { x: cell.x + TM_PAD, y: cell.y + TM_HEADER,
                 w: cell.w - 2 * TM_PAD, h: cell.h - TM_HEADER - TM_PAD };
  if (body.w < TM_MIN_SIDE || body.h < TM_MIN_SIDE) return;
  const gitems = node.children.map((g) => ({ node: g, size: g.size }));
  for (const gc of squarify(gitems, body)) {
    if (gc.w < TM_MIN_SIDE || gc.h < TM_MIN_SIDE) continue;
    // rootChild stays the level-1 path so hovering a grandchild lights its parent.
    addRect(frag, gc, color(cell.hue, 2), gc.node, rc);
    addLabel(frag, gc.node.name, gc.x + 3, gc.y + gc.h / 2 + 3, 11,
             "var(--muted)", gc.w - 6, gc.h);
  }
}

// A <rect> carrying its node and first-level ancestor path for hover/zoom.
function addRect(frag, cell, fill, node, rootChild) {
  const r = document.createElementNS(NS, "rect");
  r.setAttribute("x", cell.x); r.setAttribute("y", cell.y);
  r.setAttribute("width", cell.w); r.setAttribute("height", cell.h);
  r.setAttribute("fill", fill);
  r.dataset.rootChild = rootChild;
  r._node = node;
  frag.appendChild(r);
}

// Draw text only if it fits the box whole — no ellipsis, no overflow.
function addLabel(frag, text, x, y, fontSize, fill, maxW, maxH) {
  if (!fitsText(text, fontSize, maxW) || fontSize + 2 > maxH) return;
  const t = document.createElementNS(NS, "text");
  t.setAttribute("x", x); t.setAttribute("y", y);
  t.setAttribute("font-size", fontSize);
  t.setAttribute("fill", fill);
  t.textContent = text;
  frag.appendChild(t);
}

// Cheap width estimate — avg glyph ~0.6em. No DOM measuring (text is off-DOM).
function fitsText(text, fontSize, maxW) {
  return text.length * fontSize * 0.6 <= maxW;
}

function headerColor(hue) { return `hsl(${hue}, 55%, 40%)`; }

// --- View tabs (Sunburst | Treemap) ---
function renderTabs() {
  const box = document.getElementById("view-tabs");
  box.textContent = "";
  for (const [v, label] of [["sunburst", "Sunburst"], ["treemap", "Treemap"], ["junk", "Basura"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "view-tab";
    b.textContent = label;
    b.setAttribute("aria-pressed", String(state.view === v));
    b.addEventListener("click", () => setView(v));
    box.appendChild(b);
  }
}

function setView(v) {
  if (v === state.view) return;
  state.view = v;
  try { localStorage.setItem(VIEW_KEY, v); } catch (e) {}
  // Full re-render: it swaps chart/list <-> junk panels and keeps the current
  // node and zoom in state.current untouched, so returning restores them.
  render();
}

// Repaint the treemap on resize (its layout depends on the container's aspect);
// the sunburst scales itself via viewBox. Debounced, then one rAF.
let _resizeT;
window.addEventListener("resize", () => {
  if (state.view !== "treemap" || !state.current) return;
  clearTimeout(_resizeT);
  _resizeT = setTimeout(() => requestAnimationFrame(renderTreemap), 150);
});

function renderList() {
  const cur = state.current;
  const total = cur.size || 1;
  const kids = (cur.children || []).slice().sort((a, b) => b.size - a.size);
  const tbody = document.querySelector("#list tbody");
  tbody.textContent = "";

  kids.forEach((child, i) => {
    const pct = total ? (child.size / total * 100) : 0;
    const hue = Math.round(i * 360 / Math.max(1, kids.length));
    const tr = document.createElement("tr");
    tr.dataset.path = child.path;
    if (child.unreadable) tr.classList.add("unreadable");

    const icon = child.unreadable ? "🔒"
      : (child.is_dir ? "📁" : (child.synthetic ? "…" : "📄"));
    // A dash, not "0 B": we don't know the size, it isn't empty.
    const sizeCell = child.unreadable ? "—" : human(child.size);

    tr.innerHTML =
      `<td class="icon">${icon}</td>` +
      `<td class="name"><span class="swatch" style="background:${color(hue, 1)}"></span>${escapeHtml(child.name)}</td>` +
      `<td class="size">${sizeCell}</td>` +
      `<td class="pct">${pct.toFixed(1)}%</td>` +
      `<td class="bar-cell"><div class="bar" style="width:${Math.max(2, pct)}%;background:${color(hue, 1)}"></div></td>`;

    // Row actions live over the right end of the bar cell (no extra column, so
    // the bar/pct never move). Synthetic "Otros (N)" rows have no real path.
    if (!child.synthetic) {
      const actions = document.createElement("div");
      actions.className = "row-actions";
      actions.append(
        actionButton(ICON_REVEAL, `Mostrar en ${fileManager()}`, child, () => reveal(child.path, tr)),
        actionButton(ICON_COPY, "Copiar ruta", child, () => copyPath(child.path, tr)),
      );
      tr.querySelector(".bar-cell").appendChild(actions);
    }

    tr.addEventListener("mouseenter", () => highlightRow(child.path, true));
    tr.addEventListener("mouseleave", () => highlightRow(child.path, false));
    tr.addEventListener("click", () => zoomTo(child));
    tbody.appendChild(tr);
  });
}

// --- Junk tab (regenerable data) ---
// A whole-scan view: it does not depend on the current node or breadcrumb, so
// it replaces both panels. It NEVER offers to delete: no checkbox, no "free
// space" button. If a design asks for one, the design is wrong (S10 decision 1).
async function renderJunk() {
  junkPanel.textContent = "";
  let data;
  try {
    data = await (await fetch("/api/junk")).json();
  } catch (e) {
    junkPanel.textContent = "No se pudieron cargar los datos.";
    return;
  }
  if (state.view !== "junk") return;  // tab changed while awaiting
  const cats = data.categories || [];
  if (cats.length === 0) {
    // Neutral: not an achievement, not an error. (A pre-v2 cache can't reach
    // the client — it is refused at load — so no "rescan needed" branch here.)
    const p = document.createElement("p");
    p.className = "junk-empty";
    p.textContent = "No se han encontrado carpetas regenerables en este escaneo.";
    junkPanel.appendChild(p);
    return;
  }
  const head = document.createElement("div");
  head.className = "junk-total";
  head.textContent = `${human(data.total_size)} en ${cats.length} ` +
    (cats.length === 1 ? "categoría" : "categorías");
  junkPanel.appendChild(head);
  for (const c of cats) junkPanel.appendChild(buildJunkCategory(c));
}

// Native <details> disclosure — no custom toggle state to track.
function buildJunkCategory(c) {
  const det = document.createElement("details");
  det.className = "junk-cat";
  const sum = document.createElement("summary");
  const dirs = c.n_paths;
  sum.innerHTML =
    `<span class="jc-label">${escapeHtml(c.label)}</span>` +
    `<span class="jc-size">${human(c.total_size)}</span>` +
    `<span class="jc-dirs">${dirs.toLocaleString()} ${dirs === 1 ? "carpeta" : "carpetas"}</span>`;
  det.appendChild(sum);

  const why = document.createElement("div");
  why.className = "jc-why";
  why.textContent = c.why;  // lets the user disagree with a category on its merits
  det.appendChild(why);

  const list = document.createElement("div");
  list.className = "jc-paths";
  for (const p of c.paths) list.appendChild(buildJunkRow(p));
  if (c.truncated) {
    const more = document.createElement("div");
    more.className = "jc-more";
    more.textContent = `… y ${(c.n_paths - c.paths.length).toLocaleString()} más ` +
      `(se muestran las ${c.paths.length} mayores de ${c.n_paths.toLocaleString()})`;
    list.appendChild(more);
  }
  det.appendChild(list);
  return det;
}

function buildJunkRow(p) {
  const row = document.createElement("div");
  row.className = "jc-row";
  // actionButton wants an object with .name/.path; reuse the exact S4 buttons.
  const child = { name: p.path, path: p.path };
  const label = document.createElement("span");
  label.className = "jc-path";
  label.textContent = p.path;
  label.title = p.path;
  const size = document.createElement("span");
  size.className = "jc-rowsize";
  size.textContent = human(p.size);
  const actions = document.createElement("div");
  actions.className = "jc-actions";
  actions.append(
    actionButton(ICON_REVEAL, `Mostrar en ${fileManager()}`, child, () => reveal(p.path, row)),
    actionButton(ICON_COPY, "Copiar ruta", child, () => copyPath(p.path, row)),
  );
  row.append(label, size, actions);
  return row;
}

// --- Row actions (reveal in Finder / copy path) ---
// Monochrome inline SVG, 24x24 viewBox, inherits currentColor. No color emoji:
// a colored glyph breaks the density of a dark table.
const ICON_REVEAL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

function actionButton(svg, label, child, handler) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "row-action";
  b.innerHTML = svg;
  b.title = label;
  b.setAttribute("aria-label", `${label}: ${child.name}`);
  b.addEventListener("click", (e) => {
    e.stopPropagation();  // don't let the row's zoom handler fire
    handler();
  });
  return b;
}

async function reveal(path, tr) {
  try {
    const r = await fetch("/api/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) flashRow(tr, `Mostrado en ${fileManager()}`);
    else flashRow(tr, j.error || `Error ${r.status}`, true);
  } catch (e) {
    flashRow(tr, "Error de red", true);
  }
}

async function copyPath(path, tr) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(path);
      flashRow(tr, "Ruta copiada");
      return;
    }
  } catch (e) {
    // Async Clipboard API can be blocked outside a user gesture; fall back.
  }
  if (legacyCopy(path)) flashRow(tr, "Ruta copiada");
  else flashRow(tr, "No se pudo copiar", true);
}

// execCommand fallback for contexts where the async clipboard API is blocked.
function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

// Brief, ephemeral confirmation next to the row (~1.5 s). No alert().
let _flashTimer;
function flashRow(tr, text, isError = false) {
  let el = document.getElementById("row-flash");
  if (!el) {
    el = document.createElement("div");
    el.id = "row-flash";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.toggle("error", !!isError);
  const rect = tr.getBoundingClientRect();
  el.style.top = (rect.top + rect.height / 2) + "px";
  el.style.left = (rect.right - 12) + "px";
  el.classList.add("show");
  clearTimeout(_flashTimer);
  _flashTimer = setTimeout(() => el.classList.remove("show"), 1500);
}

function renderBreadcrumb() {
  const bc = document.getElementById("breadcrumb");
  bc.textContent = "";
  const root = state.rootPath;
  const cur = state.current.path;

  // Segments from root down to current, split on the platform separator.
  const rel = cur.startsWith(root) ? cur.slice(root.length) : "";
  const parts = rel.split(state.sep).filter(Boolean);

  const rootName = root.split(state.sep).filter(Boolean).pop() || root;
  const crumbs = [{ name: rootName, path: root }];
  let acc = root;
  for (const part of parts) {
    acc = joinPath(acc, part);
    crumbs.push({ name: part, path: acc });
  }

  crumbs.forEach((cr, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sep"; sep.textContent = "›";
      bc.appendChild(sep);
    }
    const s = document.createElement("span");
    s.className = "crumb";
    s.textContent = cr.name;
    s.title = cr.path;
    s.addEventListener("click", () => navigateTo(cr.path));
    bc.appendChild(s);
  });
}

// --- Hover sync (shared by sunburst and treemap) ---
// node: the hovered element's node (may be a descendant); rootChildPath: its
// first-level ancestor, so the list row and the whole block light up together.
function chartHover(e, node, rootChildPath) {
  const chart = chartEl();
  chart.classList.add("dimmed");
  for (const el of chart.querySelectorAll("[data-root-child]")) el.classList.remove("highlight");
  for (const el of chart.querySelectorAll(`[data-root-child="${cssEscape(rootChildPath)}"]`))
    el.classList.add("highlight");
  for (const tr of document.querySelectorAll("#list tr"))
    tr.classList.toggle("highlight", tr.dataset.path === rootChildPath);

  const pct = state.current.size ? (node.size / state.current.size * 100) : 0;
  tooltip.innerHTML =
    `<div>${escapeHtml(node.name)} — ${human(node.size)} (${pct.toFixed(1)}%)</div>` +
    `<div class="tt-path">${escapeHtml(node.path)}</div>`;
  tooltip.classList.remove("hidden");
  tooltip.style.left = Math.min(e.clientX + 14, window.innerWidth - 350) + "px";
  tooltip.style.top = (e.clientY + 14) + "px";
}

// Sunburst path handler.
function onHover(e, s) { chartHover(e, s.node, s.rootChildPath); }

// Treemap delegated handlers: text has pointer-events:none, so the target is a
// <rect> (carrying _node) or the empty background.
function onTreemapMove(e) {
  const r = e.target.closest && e.target.closest("rect");
  if (r && r._node) chartHover(e, r._node, r.dataset.rootChild);
  else clearHover();
}
function onTreemapClick(e) {
  const r = e.target.closest && e.target.closest("rect");
  if (r && r._node) zoomTo(r._node);  // zoomTo ignores files/synthetic/unreadable
}

function clearHover() {
  const chart = chartEl();
  chart.classList.remove("dimmed");
  for (const el of chart.querySelectorAll("[data-root-child]")) el.classList.remove("highlight");
  for (const tr of document.querySelectorAll("#list tr")) tr.classList.remove("highlight");
  tooltip.classList.add("hidden");
}

function highlightRow(path, on) {
  const chart = chartEl();
  // Highlight matching list row.
  for (const tr of document.querySelectorAll("#list tr")) {
    if (tr.dataset.path === path) tr.classList.toggle("highlight", on);
  }
  // And matching chart elements (when hovering the list).
  for (const el of chart.querySelectorAll(`[data-root-child="${cssEscape(path)}"]`))
    el.classList.toggle("highlight", on);
  if (on) chart.classList.add("dimmed"); else chart.classList.remove("dimmed");
}

// --- Navigation ---
async function zoomTo(node) {
  if (!isNavigable(node)) return;  // files and synthetic "Otros" don't zoom
  if (node.truncated || !node.children || node.children.length === 0) {
    const fresh = await fetchNode(node.path);
    if (fresh) { state.current = fresh; render(); }
    return;
  }
  await navigateTo(node.path);
}

async function navigateTo(path) {
  const node = await fetchNode(path);
  if (node) { state.current = node; render(); }
}

function goUp() {
  if (state.current.path === state.rootPath) return;
  const parent = parentPath(state.current.path);
  navigateTo(parent.startsWith(state.rootPath) ? parent : state.rootPath);
}

async function fetchNode(path, depth = 4) {
  const r = await fetch(`/api/node?path=${encodeURIComponent(path)}&depth=${depth}`);
  if (!r.ok) return null;
  return r.json();
}

// --- Scan flow ---
async function startScan(path) {
  const err = document.getElementById("error");
  err.classList.add("hidden");
  const prog = document.getElementById("progress");
  prog.classList.remove("hidden");
  prog.textContent = "Iniciando…";

  const r = await fetch("/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (r.status === 409) { prog.textContent = "Ya hay un escaneo en curso."; return; }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    prog.classList.add("hidden");
    err.textContent = j.error || "No se pudo iniciar el escaneo.";
    err.classList.remove("hidden");
    return;
  }
  pollProgress();
}

async function pollProgress() {
  const prog = document.getElementById("progress");
  const r = await fetch("/api/progress");
  const s = await r.json();

  if (s.state === "scanning") {
    prog.textContent = `${s.files_seen.toLocaleString()} archivos… ${s.current_path}`;
    setTimeout(pollProgress, 500);
    return;
  }
  if (s.state === "error") {
    prog.classList.add("hidden");
    const err = document.getElementById("error");
    err.textContent = "Error: " + s.message;
    err.classList.remove("hidden");
    return;
  }
  if (s.state === "done") {
    await enterResults(s);
  }
}

// Show the active tree (from a fresh scan or a loaded cache) given a progress
// state object. Reused by pollProgress and by cache loading.
async function enterResults(s) {
  state.rootPath = s.root;
  state.source = s.source;
  state.scannedAt = s.scanned_at;
  if (s.platform) { state.platform = s.platform; state.sep = sepFor(s.platform); }
  const node = await fetchNode(s.root);
  if (!node) {
    document.getElementById("progress").textContent = "El árbol no está disponible.";
    return;
  }
  state.current = node;
  document.getElementById("start").classList.add("hidden");
  document.getElementById("results").classList.remove("hidden");
  render();
  renderBanner(s.errors);
  renderFreshness();
}

// --- Freshness indicator (only when the tree comes from cache) ---
function renderFreshness() {
  const el = document.getElementById("freshness");
  if (state.source !== "cache") { el.classList.add("hidden"); el.textContent = ""; return; }
  el.classList.remove("hidden");
  el.innerHTML = `Datos del ${formatDate(state.scannedAt)} · `;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "link-btn";
  btn.textContent = "Rescanear";
  btn.addEventListener("click", () => rescan(state.rootPath));
  el.appendChild(btn);
}

function rescan(path) {
  document.getElementById("results").classList.add("hidden");
  document.getElementById("start").classList.remove("hidden");
  document.getElementById("path-input").value = path;
  startScan(path);
}

// --- Cache: saved scans on the start screen ---
async function loadSavedScans() {
  const section = document.getElementById("saved-scans");
  let data;
  try {
    data = await (await fetch("/api/cache")).json();
  } catch (e) {
    section.classList.add("hidden");
    return;
  }
  const entries = data.entries || [];
  if (entries.length === 0) { section.classList.add("hidden"); return; }
  section.classList.remove("hidden");

  const ul = document.getElementById("saved-list");
  ul.textContent = "";
  for (const e of entries) {
    const li = document.createElement("li");
    const meta = `${human(e.total_size)}, ${(e.n_files || 0).toLocaleString()} archivos`;
    li.innerHTML =
      `<span class="ss-path">${escapeHtml(e.path)}</span>` +
      `<span class="ss-meta">${meta}</span>` +
      `<span class="ss-date">${formatDate(e.scanned_at)}</span>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ss-load";
    btn.textContent = "Cargar";
    btn.addEventListener("click", () => loadCache(e.path));
    li.appendChild(btn);
    ul.appendChild(li);
  }
  renderClearCache(entries.length, data.dir);
}

async function loadCache(path) {
  const err = document.getElementById("error");
  err.classList.add("hidden");
  const r = await fetch("/api/cache/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    err.textContent = j.error || `No se pudo cargar la caché (${r.status}).`;
    err.classList.remove("hidden");
    return;
  }
  const s = await (await fetch("/api/progress")).json();
  await enterResults(s);
}

// --- Cache: clear with in-UI confirmation ---
function renderClearCache(count, dir) {
  const box = document.getElementById("clear-cache");
  box.innerHTML = "";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "link-btn danger";
  btn.textContent = `Borrar escaneos guardados (${count})`;
  btn.addEventListener("click", () => showClearConfirm(count, dir));
  box.appendChild(btn);
}

function showClearConfirm(count, dir) {
  const box = document.getElementById("clear-cache");
  box.innerHTML =
    `<div class="confirm">` +
    `<p>Se borrarán <b>${count}</b> ficheros de caché de la aplicación en ` +
    `<code>${escapeHtml(dir)}</code>. Solo se borran los ficheros de caché de ` +
    `escáner_disco; el árbol que estés viendo <b>no</b> se pierde.</p>` +
    `<div class="confirm-actions"></div>` +
    `</div>`;
  const actions = box.querySelector(".confirm-actions");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "link-btn";
  cancel.textContent = "Cancelar";
  cancel.addEventListener("click", () => loadSavedScans());  // re-render, default
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "link-btn danger";
  confirm.textContent = "Borrar";
  confirm.addEventListener("click", clearCache);
  actions.append(cancel, confirm);
  cancel.focus();
}

async function clearCache() {
  try {
    const r = await fetch("/api/cache/clear", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) showToast(`${j.deleted} escaneo(s) borrado(s).`);
    else showToast(j.error || `Error ${r.status}`, true);
  } catch (e) {
    showToast("Error de red", true);
  }
  document.getElementById("saved-list").textContent = "";
  document.getElementById("saved-scans").classList.add("hidden");
}

// --- Unreadable-paths banner ---
// Per-OS hint on how to reduce unreadable-path errors.
function permissionHint() {
  if (state.platform === "windows") {
    return "Ejecutar como <b>Administrador</b> reduce los errores, a costa de " +
           "correr un servidor HTTP con privilegios elevados.";
  }
  if (state.platform === "linux") {
    return "Ejecutar con permisos suficientes (p. ej. <code>sudo</code>) reduce " +
           "los errores, a costa de correr un servidor HTTP como root.";
  }
  return "Conceder <b>Acceso total al disco</b> reduce los errores; ejecutar " +
         "con <code>sudo</code> los reduce más, a costa de correr un servidor " +
         "HTTP como root.";
}

function renderBanner(count) {
  const b = document.getElementById("error-banner");
  b.classList.remove("open");
  if (!count) { b.classList.add("hidden"); b.textContent = ""; return; }
  b.classList.remove("hidden");
  b.innerHTML =
    `<div class="banner-head">⚠️ ${count.toLocaleString()} rutas no legibles — el total puede estar subestimado</div>` +
    `<div class="banner-note">${permissionHint()}</div>` +
    `<div class="banner-paths hidden"></div>`;
  b.querySelector(".banner-head").addEventListener("click", toggleErrorPaths);
}

async function toggleErrorPaths() {
  const b = document.getElementById("error-banner");
  const box = b.querySelector(".banner-paths");
  if (!box.classList.contains("hidden")) {  // collapse
    box.classList.add("hidden");
    b.classList.remove("open");
    return;
  }
  if (!box.dataset.loaded) {  // fetch only on first expand
    const data = await (await fetch("/api/errors")).json();
    let html = "";
    if (data.truncated) {
      html += `<div class="banner-trunc">Mostrando las primeras ` +
        `${data.paths.length.toLocaleString()} de ${data.total.toLocaleString()}.</div>`;
    }
    html += "<ul>" + data.paths.map((p) => `<li>${escapeHtml(p)}</li>`).join("") + "</ul>";
    box.innerHTML = html;
    box.dataset.loaded = "1";
  }
  box.classList.remove("hidden");
  b.classList.add("open");
}

// --- Small utils ---
function formatDate(epochSeconds) {
  if (!epochSeconds) return "—";
  const d = new Date(epochSeconds * 1000);
  const date = d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time}`;
}

let _toastTimer;
function showToast(text, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.toggle("error", !!isError);
  el.classList.remove("hidden");
  el.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}

// --- Wire up start screen ---
document.getElementById("scan-btn").addEventListener("click", () => {
  startScan(document.getElementById("path-input").value.trim());
});
document.getElementById("path-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("scan-btn").click();
});
document.getElementById("rescan-btn").addEventListener("click", () => {
  document.getElementById("results").classList.add("hidden");
  document.getElementById("start").classList.remove("hidden");
  document.getElementById("progress").classList.add("hidden");
  loadSavedScans();  // a fresh scan may have added a cache entry
});

// Fill the default scan path and the per-OS quick-root shortcuts from the
// server. Also sets the platform up front so the start screen is correct even
// before any scan runs.
async function loadConfig() {
  let cfg;
  try {
    cfg = await (await fetch("/api/config")).json();
  } catch (e) {
    return;  // leave the input empty; the user can still type a path
  }
  state.platform = cfg.platform || "";
  state.sep = sepFor(state.platform);
  const input = document.getElementById("path-input");
  if (!input.value) input.value = cfg.default_root || "";

  const box = document.querySelector(".shortcuts");
  box.textContent = "";
  for (const r of (cfg.quick_roots || [])) {
    const b = document.createElement("button");
    b.textContent = r.label;
    b.title = r.path;
    b.addEventListener("click", () => {
      input.value = r.path;
      startScan(r.path);
    });
    box.appendChild(b);
  }
}

// On load: set up the start screen (default path, shortcuts) and list any
// saved scans (nothing is loaded automatically).
loadConfig();
loadSavedScans();
