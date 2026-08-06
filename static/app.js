"use strict";

// --- Geometry constants (SVG is 1000x1000, centred at 500,500) ---
const CX = 500, CY = 500;
const CENTER_R = 180;      // radius of the centre circle (current node)
const RINGS = 4;
const MAX_R = 480;
const RING_W = (MAX_R - CENTER_R) / RINGS;
const MIN_ANGLE = 0.5;     // don't draw sectors narrower than this (degrees)

// --- App state ---
const state = {
  rootPath: "",   // absolute root of the scan
  current: null,  // current node (centre), pruned subtree from /api/node
  source: "",     // "scan" | "cache" — where the active tree came from
  scannedAt: 0,   // epoch seconds the active tree was scanned
};

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
const svg = document.getElementById("sunburst");
const tooltip = document.getElementById("tooltip");

function isNavigable(node) {
  // Unreadable dirs have no children to show, so zooming in is pointless.
  return node && node.is_dir && !node.synthetic && !node.unreadable;
}

function render() {
  renderBreadcrumb();
  renderSunburst();
  renderList();
}

function renderSunburst() {
  const cur = state.current;
  const total = cur.size || 1;
  const NS = "http://www.w3.org/2000/svg";
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
        actionButton(ICON_REVEAL, "Mostrar en Finder", child, () => reveal(child.path, tr)),
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
    if (r.ok && j.ok) flashRow(tr, "Mostrado en Finder");
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

  // Segments from root down to current.
  let rel = cur.startsWith(root) ? cur.slice(root.length) : "";
  const parts = rel.split("/").filter(Boolean);

  const crumbs = [{ name: root === "/" ? "/" : (root.split("/").pop() || root), path: root }];
  let acc = root;
  for (const part of parts) {
    acc = acc === "/" ? "/" + part : acc + "/" + part;
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

// --- Hover sync ---
function onHover(e, s, pathEl) {
  svg.classList.add("dimmed");
  for (const el of svg.querySelectorAll("path")) el.classList.remove("highlight");
  // Highlight all sectors sharing the same first-level ancestor.
  for (const el of svg.querySelectorAll(`path[data-root-child="${cssEscape(s.rootChildPath)}"]`))
    el.classList.add("highlight");
  highlightRow(s.rootChildPath, true);

  const pct = state.current.size ? (s.node.size / state.current.size * 100) : 0;
  tooltip.innerHTML =
    `<div>${escapeHtml(s.node.name)} — ${human(s.node.size)} (${pct.toFixed(1)}%)</div>` +
    `<div class="tt-path">${escapeHtml(s.node.path)}</div>`;
  tooltip.classList.remove("hidden");
  tooltip.style.left = Math.min(e.clientX + 14, window.innerWidth - 350) + "px";
  tooltip.style.top = (e.clientY + 14) + "px";
}

function clearHover() {
  svg.classList.remove("dimmed");
  for (const el of svg.querySelectorAll("path")) el.classList.remove("highlight");
  for (const tr of document.querySelectorAll("#list tr")) tr.classList.remove("highlight");
  tooltip.classList.add("hidden");
}

function highlightRow(path, on) {
  // Highlight matching list row.
  for (const tr of document.querySelectorAll("#list tr")) {
    if (tr.dataset.path === path) tr.classList.toggle("highlight", on);
  }
  // And matching sectors (when hovering the list).
  for (const el of svg.querySelectorAll(`path[data-root-child="${cssEscape(path)}"]`))
    el.classList.toggle("highlight", on);
  if (on) svg.classList.add("dimmed"); else svg.classList.remove("dimmed");
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
  const parent = state.current.path.replace(/\/[^/]+$/, "") || "/";
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
function renderBanner(count) {
  const b = document.getElementById("error-banner");
  b.classList.remove("open");
  if (!count) { b.classList.add("hidden"); b.textContent = ""; return; }
  b.classList.remove("hidden");
  b.innerHTML =
    `<div class="banner-head">⚠️ ${count.toLocaleString()} rutas no legibles — el total puede estar subestimado</div>` +
    `<div class="banner-note">Conceder <b>Acceso total al disco</b> reduce los errores; ejecutar con <code>sudo</code> los reduce más, a costa de correr un servidor HTTP como root.</div>` +
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
for (const b of document.querySelectorAll(".shortcuts button")) {
  b.addEventListener("click", () => {
    document.getElementById("path-input").value = b.dataset.path;
    startScan(b.dataset.path);
  });
}
document.getElementById("rescan-btn").addEventListener("click", () => {
  document.getElementById("results").classList.add("hidden");
  document.getElementById("start").classList.remove("hidden");
  document.getElementById("progress").classList.add("hidden");
  loadSavedScans();  // a fresh scan may have added a cache entry
});

// On load, show any saved scans (nothing is loaded automatically).
loadSavedScans();
