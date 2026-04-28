"use strict";

// ============================================================
// Constants
// ============================================================
const STORAGE_KEY = "whiteboard.v3";
const HISTORY_MAX = 60;
const SVG_NS = "http://www.w3.org/2000/svg";
const SNAP_DIST = 28;       // px in canvas-space
const LINE_PAD = 24;        // padding around line bbox

const TEXT_PRESETS = {
  body:    { content: "Click to edit text", w: 240, style: { fontFamily: "Geist, system-ui, sans-serif", fontSize: 18, color: "#0e0f0c", bg: "transparent", bold: false, italic: false, underline: false, align: "left", radius: 12, borderColor: "#a8a8a0", borderWidth: 1 } },
  heading: { content: "Heading",            w: 460, style: { fontFamily: "Geist, system-ui, sans-serif", fontSize: 44, color: "#0e0f0c", bg: "transparent", bold: true,  italic: false, underline: false, align: "left", radius: 12, borderColor: "#a8a8a0", borderWidth: 1 } },
  sticky:  { content: "Sticky note",        w: 220, style: { fontFamily: "Geist, system-ui, sans-serif", fontSize: 17, color: "#2a2c28", bg: "#fdf3c7",     bold: false, italic: false, underline: false, align: "left", radius: 8,  borderColor: "#c9b550", borderWidth: 1 } },
  paper:   { content: "Paper note\n\nDouble-click to edit. Use blank lines to organise paragraphs.", w: 380, style: { fontFamily: "Geist, system-ui, sans-serif", fontSize: 15, color: "#0e0f0c", bg: "#ffffff", bold: false, italic: false, underline: false, align: "left", radius: 14, borderColor: "#c8c8c2", borderWidth: 1 } },
  emoji:   { content: "✨",                  w: 80,  style: { fontFamily: "Geist, system-ui, sans-serif", fontSize: 56, color: "#0e0f0c", bg: "transparent", bold: false, italic: false, underline: false, align: "center", radius: 12, borderColor: "#a8a8a0", borderWidth: 1 } },
};
const PAPER_COLORS = [
  { name: "Yellow", value: "#fdf3c7", edge: "#ecdf99" },
  { name: "Pink",   value: "#fde2dd", edge: "#ecc3bb" },
  { name: "Blue",   value: "#dde8f3", edge: "#b8cee0" },
  { name: "Green",  value: "#dde8de", edge: "#b3c8b6" },
];
const SWATCH_COLORS = [
  "#0e0f0c", "#ffffff", "#fafaf7", "#f3f3ee",
  "#fdf3c7", "#fde2dd", "#dde8f3", "#dde8de",
  "#b54343", "#c87a3a", "#a98538", "#508a6c",
  "#3d6c8a", "#5a4a8a", "#8a4378", "#6b6e68",
];

// ============================================================
// State
// ============================================================
const state = {
  nodes: [],
  selectedIds: new Set(),
  pan: { x: 0, y: 0 },
  zoom: 1,
};
let clipboardNodes = [];

// ============================================================
// DOM
// ============================================================
const board = document.getElementById("board");
const canvas = document.getElementById("canvas");
const zoomReset = document.getElementById("btn-zoom-reset");
const emptyState = document.getElementById("empty-state");
const imageInput = document.getElementById("image-input");
const toolImage = document.getElementById("tool-image");
const ft = document.getElementById("float-toolbar");
const ftCount = document.getElementById("ft-count");
const bgPop = document.getElementById("bg-popover");
const borderPop = document.getElementById("border-popover");
const helpPop = document.getElementById("help-popover");
const ctxMenu = document.getElementById("context-menu");
const settingsPop = document.getElementById("settings-popover");

// ============================================================
// Utils
// ============================================================
const uid = () => Math.random().toString(36).slice(2, 10);
const clone = (o) => JSON.parse(JSON.stringify(o));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveImmediate(); pushHistory(); }, 250);
}
function saveImmediate() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      nodes: state.nodes, pan: state.pan, zoom: state.zoom,
    }));
  } catch (_) {}
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.nodes)) {
      state.nodes = data.nodes;
      state.pan = data.pan || { x: 0, y: 0 };
      state.zoom = data.zoom || 1;
    }
  } catch (_) {}
}

// ============================================================
// History
// ============================================================
const history = { stack: [], idx: -1 };
function snap() {
  return JSON.stringify({ nodes: state.nodes, selectedIds: Array.from(state.selectedIds) });
}
function pushHistory() {
  const cur = snap();
  if (history.stack[history.idx] === cur) return;
  history.stack = history.stack.slice(0, history.idx + 1);
  history.stack.push(cur);
  if (history.stack.length > HISTORY_MAX) history.stack.shift();
  history.idx = history.stack.length - 1;
  refreshUndoRedo();
}
function applyHistory(idx) {
  history.idx = clamp(idx, 0, history.stack.length - 1);
  const data = JSON.parse(history.stack[history.idx]);
  state.nodes = data.nodes;
  state.selectedIds = new Set(data.selectedIds || []);
  render(); saveImmediate();
  refreshUndoRedo();
}
function undo() { if (history.idx > 0) applyHistory(history.idx - 1); }
function redo() { if (history.idx < history.stack.length - 1) applyHistory(history.idx + 1); }
function refreshUndoRedo() {
  document.getElementById("btn-undo").disabled = history.idx <= 0;
  document.getElementById("btn-redo").disabled = history.idx >= history.stack.length - 1;
}

// ============================================================
// Coordinates / geometry
// ============================================================
function screenToCanvas(clientX, clientY) {
  const rect = board.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.pan.x) / state.zoom,
    y: (clientY - rect.top - state.pan.y) / state.zoom,
  };
}
function viewportCenter() {
  const rect = board.getBoundingClientRect();
  return screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
}
function applyTransform() {
  canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  zoomReset.textContent = `${Math.round(state.zoom * 100)}%`;
}
function setEmptyState() {
  emptyState.classList.toggle("hidden", state.nodes.length > 0);
}

// Node bounding box (uses live DOM size for text since width is auto)
function nodeBox(node) {
  const el = canvas.querySelector(`.node[data-id="${node.id}"]`);
  if (node.type === "text" && el) {
    return { x: node.x, y: node.y, w: el.offsetWidth, h: el.offsetHeight };
  }
  return { x: node.x, y: node.y, w: node.w || 100, h: node.h || 40 };
}
function nodeCenter(node) {
  const b = nodeBox(node);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}
// Compute the point on box edge along the line from `from` toward box center
function intersectEdge(from, box) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const dx = cx - from.x, dy = cy - from.y;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const halfW = box.w / 2, halfH = box.h / 2;
  const sx = dx === 0 ? Infinity : halfW / Math.abs(dx);
  const sy = dy === 0 ? Infinity : halfH / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx - dx * s, y: cy - dy * s };
}
function resolveLineEndpoints(line) {
  let p1 = { x: line.x1, y: line.y1 };
  let p2 = { x: line.x2, y: line.y2 };
  const fromN = line.fromId ? state.nodes.find((n) => n.id === line.fromId) : null;
  const toN = line.toId ? state.nodes.find((n) => n.id === line.toId) : null;
  if (fromN) p1 = intersectEdge(p2, nodeBox(fromN));
  if (toN) p2 = intersectEdge(p1, nodeBox(toN));
  // Second pass refines if both connected
  if (fromN && toN) p1 = intersectEdge(p2, nodeBox(fromN));
  return { p1, p2 };
}

// ============================================================
// Render
// ============================================================
function render() {
  const existing = new Map();
  for (const el of canvas.querySelectorAll(".node")) existing.set(el.dataset.id, el);
  for (const node of state.nodes) {
    let el = existing.get(node.id);
    if (!el) { el = createNodeElement(node); canvas.appendChild(el); }
    else existing.delete(node.id);
    updateNodeElement(el, node);
  }
  // After all nodes laid out, lines need a second pass for accurate sizes
  for (const node of state.nodes) {
    if (node.type !== "line") continue;
    const el = canvas.querySelector(`.node[data-id="${node.id}"]`);
    if (el) updateLineElement(el, node);
  }
  for (const el of existing.values()) el.remove();
  setEmptyState();
  syncFloatToolbar();
}
function createNodeElement(node) {
  if (node.type === "line") return createLineElement(node);
  const el = document.createElement("div");
  el.className = `node ${node.type}-node` + (node.variant ? ` ${node.variant}` : "");
  el.dataset.id = node.id;
  el.tabIndex = 0;
  if (node.type === "image") {
    const img = document.createElement("img");
    img.draggable = false; img.alt = "";
    img.addEventListener("error", () => {
      // Image failed (typically AI-emitted URLs that 404). Remove the node and
      // any lines connected to it so the board stays clean. Save the removal.
      const nid = node.id;
      const before = state.nodes.length;
      state.nodes = state.nodes.filter((n) => {
        if (n.id === nid) return false;
        if (n.type === "line" && (n.fromId === nid || n.toId === nid)) return false;
        return true;
      });
      if (state.nodes.length !== before) { render(); save(); }
    });
    img.addEventListener("load",  () => { el.classList.remove("image-broken"); });
    img.src = node.src;
    el.appendChild(img);
  }
  if (node.type === "shape") {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "shape-vis");
    el.appendChild(svg);
  }
  const handle = document.createElement("div");
  handle.className = "handle"; handle.dataset.role = "resize";
  el.appendChild(handle);
  el.addEventListener("mousedown", onNodeMouseDown);
  el.addEventListener("dblclick", onNodeDoubleClick);
  return el;
}
function updateNodeElement(el, node) {
  if (node.type === "line") return updateLineElement(el, node);
  el.style.left = node.x + "px";
  el.style.top = node.y + "px";
  el.style.zIndex = effectiveZ(node);
  el.classList.toggle("selected", state.selectedIds.has(node.id));
  if (node.type === "text") {
    const s = node.style || {};
    const isCompactPaper =
      node.variant === "paper" &&
      !node.expanded &&
      el.getAttribute("contenteditable") !== "true" &&
      typeof node.content === "string" &&
      node.content.trim().length > 0;

    if (isCompactPaper) {
      // Compact "tile" rendering — fixed 240×72, icon + first line + hint.
      el.classList.add("paper-tile");
      el.style.width  = "240px";
      el.style.height = "72px";
      el.style.maxWidth = "";
      el.style.fontFamily = s.fontFamily || "Geist, system-ui, sans-serif";
      el.style.fontSize = "14px";
      el.style.color = s.color || "#0e0f0c";
      el.style.background = s.bg && s.bg !== "transparent" ? s.bg : "#fafaf7";
      el.style.fontWeight = "500";
      el.style.fontStyle = "normal";
      el.style.textDecoration = "none";
      el.style.textAlign = "left";
      el.style.borderRadius = (s.radius ?? 12) + "px";
      applyBorder(el, s);
      let inner = el.querySelector(".paper-tile-inner");
      if (!inner) {
        inner = document.createElement("div");
        inner.className = "paper-tile-inner";
        inner.innerHTML =
          '<div class="paper-tile-icon">📄</div>' +
          '<div class="paper-tile-text"><div class="paper-tile-title"></div>' +
          '<div class="paper-tile-hint">Click to read</div></div>';
        const handle = el.querySelector(".handle");
        if (handle) el.insertBefore(inner, handle); else el.appendChild(inner);
      }
      const firstLine = (node.content.split(/\r?\n/).find((l) => l.trim()) || "").trim();
      const truncated = firstLine.length > 35 ? firstLine.slice(0, 34) + "…" : firstLine;
      inner.querySelector(".paper-tile-title").textContent = truncated || "Paper note";
    } else {
      el.classList.remove("paper-tile");
      const stale = el.querySelector(".paper-tile-inner");
      if (stale) stale.remove();
      el.style.width = "max-content"; el.style.height = "auto";
      el.style.maxWidth = (node.w || 320) + "px";
      el.style.fontFamily = s.fontFamily || "Geist, system-ui, sans-serif";
      el.style.fontSize = (s.fontSize || 18) + "px";
      el.style.color = s.color || "#0e0f0c";
      el.style.background = s.bg && s.bg !== "transparent" ? s.bg : "transparent";
      el.style.fontWeight = s.bold ? "700" : "400";
      el.style.fontStyle = s.italic ? "italic" : "normal";
      el.style.textDecoration = s.underline ? "underline" : "none";
      el.style.textAlign = s.align || "left";
      el.style.borderRadius = (s.radius ?? 12) + "px";
      applyBorder(el, s);
      if (el.getAttribute("contenteditable") !== "true") el.textContent = node.content || "";
    }
  } else if (node.type === "image") {
    const s = node.style || {};
    el.style.width = node.w + "px"; el.style.height = node.h + "px";
    el.style.maxWidth = "";
    el.style.borderRadius = (s.radius ?? 12) + "px";
    applyBorder(el, s);
  } else if (node.type === "shape") {
    el.style.width = node.w + "px"; el.style.height = node.h + "px";
    el.style.maxWidth = "";
    el.style.borderRadius = "";
    el.style.border = "";
    drawShapeSVG(el, node);
  }
}

function applyBorder(el, s) {
  const w = +s.borderWidth || 0;
  if (w > 0) {
    el.style.border = `${w}px solid ${s.borderColor || "#0e0f0c"}`;
  } else {
    el.style.border = "";
  }
}

// ============================================================
// Line nodes
// ============================================================
function createLineElement(node) {
  const div = document.createElement("div");
  div.className = "node line-node";
  div.dataset.id = node.id;

  const svg = document.createElementNS(SVG_NS, "svg");
  // Hit area — path so it can follow curves for connected lines.
  const hit = document.createElementNS(SVG_NS, "path");
  hit.setAttribute("class", "line-hit");
  hit.setAttribute("fill", "none");
  // Visible line — path so it can render straight (free) or cubic Bézier (connected).
  const vis = document.createElementNS(SVG_NS, "path");
  vis.setAttribute("class", "line-vis");
  vis.setAttribute("fill", "none");
  vis.setAttribute("marker-end", `url(#arrow-${node.id})`);
  // Defs for arrow marker
  const defs = document.createElementNS(SVG_NS, "defs");
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", `arrow-${node.id}`);
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "8");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "10");
  marker.setAttribute("markerHeight", "10");
  marker.setAttribute("orient", "auto-start-reverse");
  const arrowPath = document.createElementNS(SVG_NS, "path");
  arrowPath.setAttribute("d", "M0 0 L10 5 L0 10 z");
  arrowPath.setAttribute("class", "arrow-head");
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.appendChild(defs);
  svg.appendChild(hit);
  svg.appendChild(vis);
  div.appendChild(svg);

  // Endpoint handles
  for (const end of ["1", "2"]) {
    const h = document.createElement("div");
    h.className = "line-handle";
    h.dataset.role = "endpoint";
    h.dataset.end = end;
    div.appendChild(h);
  }

  div.addEventListener("mousedown", onNodeMouseDown);
  return div;
}
function updateLineElement(el, node) {
  const { p1, p2 } = resolveLineEndpoints(node);
  const connected = !!(node.fromId && node.toId);
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  // Cubic Bézier control points — XMind-style curves. Offsets clamped so far
  // nodes don't get wild S-curves; they stay smooth and predictable.
  let c1, c2;
  if (connected) {
    if (horizontal) {
      const off = Math.min(90, Math.abs(dx) * 0.5);
      const dir = dx >= 0 ? 1 : -1;
      c1 = { x: p1.x + dir * off, y: p1.y };
      c2 = { x: p2.x - dir * off, y: p2.y };
    } else {
      const off = Math.min(70, Math.abs(dy) * 0.5);
      const dir = dy >= 0 ? 1 : -1;
      c1 = { x: p1.x, y: p1.y + dir * off };
      c2 = { x: p2.x, y: p2.y - dir * off };
    }
  } else {
    c1 = p1; c2 = p2;
  }
  const xs = [p1.x, p2.x, c1.x, c2.x];
  const ys = [p1.y, p2.y, c1.y, c2.y];
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const maxX = Math.max(...xs), maxY = Math.max(...ys);
  const w = (maxX - minX) + LINE_PAD * 2;
  const h = (maxY - minY) + LINE_PAD * 2;

  el.style.left = (minX - LINE_PAD) + "px";
  el.style.top = (minY - LINE_PAD) + "px";
  el.style.width = w + "px";
  el.style.height = h + "px";
  el.style.zIndex = effectiveZ(node);
  el.classList.toggle("selected", state.selectedIds.has(node.id));

  const x1 = p1.x - minX + LINE_PAD;
  const y1 = p1.y - minY + LINE_PAD;
  const x2 = p2.x - minX + LINE_PAD;
  const y2 = p2.y - minY + LINE_PAD;
  const cx1 = c1.x - minX + LINE_PAD;
  const cy1 = c1.y - minY + LINE_PAD;
  const cx2 = c2.x - minX + LINE_PAD;
  const cy2 = c2.y - minY + LINE_PAD;

  const s = node.style || {};
  const stroke = s.stroke || "#0e0f0c";
  const width = s.width || 2;
  const arrow = s.arrow !== false;

  const d = connected
    ? `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`
    : `M ${x1} ${y1} L ${x2} ${y2}`;

  const hit = el.querySelector(".line-hit");
  hit.setAttribute("d", d);

  const vis = el.querySelector(".line-vis");
  vis.setAttribute("d", d);
  vis.setAttribute("stroke", stroke);
  vis.setAttribute("stroke-width", connected ? Math.max(1.8, width) : width);
  if (arrow) vis.setAttribute("marker-end", `url(#arrow-${node.id})`);
  else vis.removeAttribute("marker-end");

  // Legacy: clean up old taper element if it exists from a prior render.
  const staleTaper = el.querySelector(".line-taper");
  if (staleTaper) staleTaper.remove();

  const arrowPath = el.querySelector(".arrow-head");
  if (arrowPath) arrowPath.setAttribute("fill", stroke);

  const h1 = el.querySelector('.line-handle[data-end="1"]');
  const h2 = el.querySelector('.line-handle[data-end="2"]');
  h1.style.left = x1 + "px"; h1.style.top = y1 + "px";
  h2.style.left = x2 + "px"; h2.style.top = y2 + "px";
}

// Keep lines visually in sync with a node's current DOM (during drag/resize/edit)
function refreshLinesConnectedTo(nodeIds) {
  const ids = nodeIds instanceof Set ? nodeIds : new Set(nodeIds);
  for (const ln of state.nodes) {
    if (ln.type !== "line") continue;
    if (ids.has(ln.fromId) || ids.has(ln.toId)) {
      const el = canvas.querySelector(`.node[data-id="${ln.id}"]`);
      if (el) updateLineElement(el, ln);
    }
  }
}

// ============================================================
// Selection
// ============================================================
function selectNode(id, additive = false) {
  if (id == null) {
    state.selectedIds.clear();
  } else if (additive) {
    if (state.selectedIds.has(id)) state.selectedIds.delete(id);
    else state.selectedIds.add(id);
  } else {
    state.selectedIds.clear();
    state.selectedIds.add(id);
  }
  for (const el of canvas.querySelectorAll(".node")) {
    el.classList.toggle("selected", state.selectedIds.has(el.dataset.id));
  }
  syncFloatToolbar();
  closePopover(bgPop);
}
function selectAll() {
  state.selectedIds = new Set(state.nodes.map((n) => n.id));
  for (const el of canvas.querySelectorAll(".node")) el.classList.add("selected");
  syncFloatToolbar();
}
function getSelectedNodes() { return state.nodes.filter((n) => state.selectedIds.has(n.id)); }
function getPrimary() { for (const n of state.nodes) if (state.selectedIds.has(n.id)) return n; return null; }
function selectionType() {
  const sel = getSelectedNodes();
  if (sel.length === 0) return null;
  const types = new Set(sel.map((n) => n.type));
  return types.size === 1 ? sel[0].type : "mixed";
}

// ============================================================
// Tool dock
// ============================================================
for (const tool of document.querySelectorAll(".tool[draggable='true']")) {
  tool.addEventListener("dragstart", (e) => {
    tool.classList.add("dragging");
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("application/x-add", JSON.stringify({
      type: tool.dataset.add, variant: tool.dataset.variant || "body",
    }));
  });
  tool.addEventListener("dragend", () => tool.classList.remove("dragging"));
  tool.addEventListener("click", () => {
    const c = viewportCenter();
    if (tool.dataset.add === "text") addTextNode(tool.dataset.variant, c.x, c.y);
  });
}
board.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("application/x-add") || e.dataTransfer.types.includes("Files")) {
    e.preventDefault();
    board.classList.add("dragging-over");
  }
});
board.addEventListener("dragleave", (e) => { if (e.target === board) board.classList.remove("dragging-over"); });
window.addEventListener("dragend", () => board.classList.remove("dragging-over"));
board.addEventListener("drop", (e) => {
  e.preventDefault();
  board.classList.remove("dragging-over");
  const pos = screenToCanvas(e.clientX, e.clientY);
  const raw = e.dataTransfer.getData("application/x-add");
  if (raw) {
    const { type, variant } = JSON.parse(raw);
    if (type === "text") addTextNode(variant, pos.x, pos.y);
    return;
  }
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    let off = 0;
    for (const file of e.dataTransfer.files) {
      if (file.type.startsWith("image/")) { addImageFromFile(file, pos.x + off, pos.y + off); off += 16; }
    }
  }
});
toolImage.addEventListener("click", () => imageInput.click());
imageInput.addEventListener("change", () => {
  if (!imageInput.files?.length) return;
  const anchor = pendingImagePos || viewportCenter();
  pendingImagePos = null;
  let off = 0;
  for (const file of imageInput.files) { addImageFromFile(file, anchor.x + off, anchor.y + off); off += 16; }
  imageInput.value = "";
});

// ============================================================
// Add nodes
// ============================================================
function nextZ() { return state.nodes.reduce((m, n) => Math.max(m, n.z || 1), 0) + 1; }
// Stickies always render above the rest. Relative order within each tier is
// still controlled by node.z (so bring-to-front / send-to-back keeps working).
const STICKY_Z_BOOST = 1000000;
function effectiveZ(n) {
  const base = n.z || 1;
  return (n.type === "text" && n.variant === "sticky") ? base + STICKY_Z_BOOST : base;
}
function addTextNode(variant, x, y, overrides = {}) {
  const preset = TEXT_PRESETS[variant] || TEXT_PRESETS.body;
  const content = overrides.content != null ? overrides.content : preset.content;
  const node = {
    id: uid(), type: "text",
    variant,
    x: Math.round(x - preset.w / 2), y: Math.round(y - 30),
    w: preset.w, z: nextZ(),
    content, style: { ...preset.style },
  };
  // Manually-created paper notes render expanded; AI imports stay compact.
  if (variant === "paper") node.expanded = true;
  state.nodes.push(node);
  state.selectedIds = new Set([node.id]);
  render(); save();
  return node;
}
function addImageFromFile(file, x, y) {
  const reader = new FileReader();
  reader.onload = () => {
    const src = reader.result;
    const img = new Image();
    img.onload = () => {
      const max = 360;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
      const node = {
        id: uid(), type: "image",
        x: Math.round(x - w / 2), y: Math.round(y - h / 2),
        w, h, z: nextZ(),
        src, style: { radius: 12, borderColor: "#a8a8a0", borderWidth: 1 },
      };
      state.nodes.push(node);
      state.selectedIds = new Set([node.id]);
      render(); save();
    };
    img.src = src;
  };
  reader.readAsDataURL(file);
}

// ============================================================
// Line creation (Ctrl + drag)
// ============================================================
let lineDraft = null;   // { fromId, fromX, fromY, toX, toY, toId }
let draftEl = null;
let lastSnapEl = null;

function startLineDraft(fromId, fromX, fromY) {
  lineDraft = { fromId, fromX, fromY, toX: fromX, toY: fromY, toId: null };
  draftEl = document.createElement("div");
  draftEl.className = "line-draft";
  const svg = document.createElementNS(SVG_NS, "svg");
  const line = document.createElementNS(SVG_NS, "line");
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", "draft-dot");
  dot.setAttribute("r", "5");
  svg.appendChild(line); svg.appendChild(dot);
  draftEl.appendChild(svg);
  canvas.appendChild(draftEl);
  updateLineDraft();
  window.addEventListener("mousemove", onLineDraftMove);
  window.addEventListener("mouseup", onLineDraftEnd);
}
function findSnapTarget(x, y, excludeId) {
  let best = null, bestDist = Infinity;
  for (const n of state.nodes) {
    if (n.type === "line") continue;
    if (n.id === excludeId) continue;
    const b = nodeBox(n);
    const padX = SNAP_DIST, padY = SNAP_DIST;
    if (x < b.x - padX || x > b.x + b.w + padX) continue;
    if (y < b.y - padY || y > b.y + b.h + padY) continue;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const d = Math.hypot(cx - x, cy - y);
    if (d < bestDist) { best = n; bestDist = d; }
  }
  return best;
}
function onLineDraftMove(e) {
  if (!lineDraft) return;
  const p = screenToCanvas(e.clientX, e.clientY);
  lineDraft.toX = p.x; lineDraft.toY = p.y;
  const snap = findSnapTarget(p.x, p.y, lineDraft.fromId);
  const newToId = snap ? snap.id : null;
  if (newToId !== lineDraft.toId) {
    if (lastSnapEl) lastSnapEl.classList.remove("snap-target");
    lastSnapEl = null;
    lineDraft.toId = newToId;
    if (newToId) {
      const target = canvas.querySelector(`.node[data-id="${newToId}"]`);
      if (target) { target.classList.add("snap-target"); lastSnapEl = target; }
    }
  }
  updateLineDraft();
}
function updateLineDraft() {
  if (!draftEl || !lineDraft) return;
  let p1 = { x: lineDraft.fromX, y: lineDraft.fromY };
  let p2 = { x: lineDraft.toX, y: lineDraft.toY };
  if (lineDraft.fromId) {
    const fromN = state.nodes.find((n) => n.id === lineDraft.fromId);
    if (fromN) p1 = intersectEdge(p2, nodeBox(fromN));
  }
  if (lineDraft.toId) {
    const toN = state.nodes.find((n) => n.id === lineDraft.toId);
    if (toN) p2 = intersectEdge(p1, nodeBox(toN));
  }
  const minX = Math.min(p1.x, p2.x), minY = Math.min(p1.y, p2.y);
  const maxX = Math.max(p1.x, p2.x), maxY = Math.max(p1.y, p2.y);
  const w = (maxX - minX) + LINE_PAD * 2;
  const h = (maxY - minY) + LINE_PAD * 2;
  draftEl.style.left = (minX - LINE_PAD) + "px";
  draftEl.style.top = (minY - LINE_PAD) + "px";
  draftEl.style.width = w + "px";
  draftEl.style.height = h + "px";
  const line = draftEl.querySelector("line");
  const x1 = p1.x - minX + LINE_PAD, y1 = p1.y - minY + LINE_PAD;
  const x2 = p2.x - minX + LINE_PAD, y2 = p2.y - minY + LINE_PAD;
  line.setAttribute("x1", x1); line.setAttribute("y1", y1);
  line.setAttribute("x2", x2); line.setAttribute("y2", y2);
  const dot = draftEl.querySelector(".draft-dot");
  dot.setAttribute("cx", x2); dot.setAttribute("cy", y2);
  dot.style.opacity = lineDraft.toId ? "1" : "0.5";
}
function onLineDraftEnd() {
  window.removeEventListener("mousemove", onLineDraftMove);
  window.removeEventListener("mouseup", onLineDraftEnd);
  if (!lineDraft) return;
  const dx = lineDraft.toX - lineDraft.fromX;
  const dy = lineDraft.toY - lineDraft.fromY;
  const longEnough = Math.hypot(dx, dy) >= 8 || lineDraft.toId;
  if (longEnough) {
    const node = {
      id: uid(), type: "line", z: nextZ(),
      fromId: lineDraft.fromId, toId: lineDraft.toId,
      x1: lineDraft.fromX, y1: lineDraft.fromY,
      x2: lineDraft.toX, y2: lineDraft.toY,
      style: { stroke: "#0e0f0c", width: 2, arrow: true },
    };
    state.nodes.push(node);
    state.selectedIds = new Set([node.id]);
    render(); save();
  }
  if (lastSnapEl) lastSnapEl.classList.remove("snap-target");
  lastSnapEl = null;
  if (draftEl) draftEl.remove();
  draftEl = null;
  lineDraft = null;
}

// Show crosshair when ctrl held; show grab when space held
let spaceHeld = false;
window.addEventListener("keydown", (e) => {
  if (e.key === "Control" || e.key === "Meta") board.classList.add("ctrl-held");
  if (e.code === "Space") {
    const tag = (e.target && e.target.tagName) || "";
    const editable = e.target && e.target.isContentEditable;
    if (tag === "INPUT" || tag === "TEXTAREA" || editable) return;
    e.preventDefault();
    if (!spaceHeld) { spaceHeld = true; board.classList.add("space-held"); }
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Control" || e.key === "Meta") board.classList.remove("ctrl-held");
  if (e.code === "Space") { spaceHeld = false; board.classList.remove("space-held"); }
});
window.addEventListener("blur", () => {
  board.classList.remove("ctrl-held");
  spaceHeld = false; board.classList.remove("space-held");
});

// ============================================================
// Node interactions: drag (group), resize, line-endpoint drag
// ============================================================
let drag = null;
function onNodeMouseDown(e) {
  // Space held or middle-click → let the board handle panning, never drag the node
  if (spaceHeld || e.button === 1) return;

  const el = e.currentTarget;
  const id = el.dataset.id;
  const node = state.nodes.find((n) => n.id === id);
  if (!node) return;
  if (el.getAttribute("contenteditable") === "true") return;

  // Ctrl + drag from a node = start a connected line
  if ((e.ctrlKey || e.metaKey) && node.type !== "line") {
    e.preventDefault(); e.stopPropagation();
    selectNode(null);
    const c = nodeCenter(node);
    startLineDraft(node.id, c.x, c.y);
    return;
  }

  e.stopPropagation();
  const isHandle = e.target instanceof HTMLElement && e.target.dataset.role === "resize";
  const endpoint = e.target instanceof HTMLElement && e.target.dataset.role === "endpoint" ? e.target.dataset.end : null;

  // Endpoint drag for line nodes
  if (endpoint) {
    selectNode(id, false);
    drag = {
      mode: "endpoint",
      id, end: endpoint,
      startX: e.clientX, startY: e.clientY,
      orig: clone(node),
    };
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
    return;
  }

  if (e.shiftKey && !isHandle) { selectNode(id, true); return; }
  if (!state.selectedIds.has(id)) selectNode(id, false);

  if (isHandle) node.z = nextZ();
  else { let z = nextZ(); for (const n of getSelectedNodes()) n.z = z++; }

  const origs = isHandle
    ? [{ id, x: node.x, y: node.y, w: node.w, h: node.h || 0 }]
    : getSelectedNodes().map((n) => {
        if (n.type === "line") return { id: n.id, line: true, x1: n.x1, y1: n.y1, x2: n.x2, y2: n.y2 };
        return { id: n.id, x: n.x, y: n.y, w: n.w, h: n.h || 0 };
      });
  drag = { primaryId: id, mode: isHandle ? "resize" : "move", startX: e.clientX, startY: e.clientY, origs };
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", onWindowMouseUp);
}
function onWindowMouseMove(e) {
  if (!drag) return;
  const dx = (e.clientX - drag.startX) / state.zoom;
  const dy = (e.clientY - drag.startY) / state.zoom;

  if (drag.mode === "move") {
    const movedIds = new Set();
    for (const o of drag.origs) {
      const n = state.nodes.find((x) => x.id === o.id);
      if (!n) continue;
      if (o.line) {
        n.x1 = Math.round(o.x1 + dx); n.y1 = Math.round(o.y1 + dy);
        n.x2 = Math.round(o.x2 + dx); n.y2 = Math.round(o.y2 + dy);
        const el = canvas.querySelector(`.node[data-id="${n.id}"]`);
        if (el) updateLineElement(el, n);
      } else {
        n.x = Math.round(o.x + dx); n.y = Math.round(o.y + dy);
        const el = canvas.querySelector(`.node[data-id="${n.id}"]`);
        if (el) { el.style.left = n.x + "px"; el.style.top = n.y + "px"; }
        movedIds.add(n.id);
      }
    }
    if (movedIds.size) refreshLinesConnectedTo(movedIds);
  } else if (drag.mode === "resize") {
    const o = drag.origs[0];
    const n = state.nodes.find((x) => x.id === o.id);
    if (!n) return;
    if (n.type === "text") n.w = Math.max(60, Math.round(o.w + dx));
    else { n.w = Math.max(40, Math.round(o.w + dx)); n.h = Math.max(28, Math.round(o.h + dy)); }
    const el = canvas.querySelector(`.node[data-id="${n.id}"]`);
    if (el) {
      if (n.type === "text") el.style.maxWidth = n.w + "px";
      else { el.style.width = n.w + "px"; el.style.height = n.h + "px"; }
    }
    refreshLinesConnectedTo([n.id]);
  } else if (drag.mode === "endpoint") {
    const n = state.nodes.find((x) => x.id === drag.id);
    if (!n) return;
    const p = screenToCanvas(e.clientX, e.clientY);
    // Snap detection (excludes the OTHER end's connected node)
    const otherEnd = drag.end === "1" ? "2" : "1";
    const otherConn = drag.end === "1" ? n.toId : n.fromId;
    const snap = findSnapTarget(p.x, p.y, otherConn);
    const newId = snap ? snap.id : null;
    if (drag.end === "1") { n.x1 = p.x; n.y1 = p.y; n.fromId = newId; }
    else { n.x2 = p.x; n.y2 = p.y; n.toId = newId; }
    // Snap visual
    if (lastSnapEl) lastSnapEl.classList.remove("snap-target");
    lastSnapEl = null;
    if (newId) {
      const tgt = canvas.querySelector(`.node[data-id="${newId}"]`);
      if (tgt) { tgt.classList.add("snap-target"); lastSnapEl = tgt; }
    }
    const el = canvas.querySelector(`.node[data-id="${n.id}"]`);
    if (el) updateLineElement(el, n);
  }
}
function onWindowMouseUp() {
  if (lastSnapEl) lastSnapEl.classList.remove("snap-target");
  lastSnapEl = null;
  if (drag) save();
  drag = null;
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", onWindowMouseUp);
}

function onNodeDoubleClick(e) {
  const el = e.currentTarget;
  const id = el.dataset.id;
  const node = state.nodes.find((n) => n.id === id);
  if (!node) return;

  // Image nodes open in a fullscreen popup viewer.
  if (node.type === "image" && node.src) {
    e.stopPropagation();
    openImageViewModal(node);
    return;
  }

  if (node.type !== "text") return;
  e.stopPropagation();

  // Compact paper tiles open a read-only popup instead of inline edit.
  if (node.variant === "paper" && !node.expanded &&
      typeof node.content === "string" && node.content.trim().length > 0) {
    openPaperViewModal(node);
    return;
  }

  el.setAttribute("contenteditable", "true");
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el); range.collapse(false);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  const onInput = () => refreshLinesConnectedTo([id]);
  const finish = () => {
    el.removeAttribute("contenteditable");
    node.content = el.textContent;
    el.removeEventListener("blur", finish);
    el.removeEventListener("keydown", onEditKey);
    el.removeEventListener("input", onInput);
    save();
  };
  const onEditKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); el.blur(); } };
  el.addEventListener("blur", finish);
  el.addEventListener("keydown", onEditKey);
  el.addEventListener("input", onInput);
}

// ============================================================
// Empty-board interactions:
//   • Ctrl + drag         → draw a line
//   • Space + drag        → pan the canvas
//   • Middle-click drag   → pan the canvas
//   • Default drag        → rubber-band selection
// ============================================================
let pan = null;
let marquee = null;       // { startScreen, currentScreen, baseSelection, el }
board.addEventListener("mousedown", (e) => {
  // Allow Space-pan / middle-click pan to start even when the press lands on a node
  const isPanGesture = spaceHeld || e.button === 1;
  if (!isPanGesture && e.target !== board && e.target !== canvas && !e.target.closest(".empty-state")) return;
  if (e.button !== 0 && e.button !== 1) return;

  // Ctrl + drag = start line
  if ((e.ctrlKey || e.metaKey) && e.button === 0) {
    e.preventDefault();
    selectNode(null);
    const p = screenToCanvas(e.clientX, e.clientY);
    startLineDraft(null, p.x, p.y);
    return;
  }

  // Pan: Space held OR middle-click
  if (spaceHeld || e.button === 1) {
    e.preventDefault();
    pan = { startX: e.clientX, startY: e.clientY, origX: state.pan.x, origY: state.pan.y };
    board.classList.add("panning");
    board.style.cursor = "grabbing";
    window.addEventListener("mousemove", onPanMove);
    window.addEventListener("mouseup", onPanUp);
    return;
  }

  // Default = rubber-band selection
  e.preventDefault();
  const baseSelection = e.shiftKey ? new Set(state.selectedIds) : new Set();
  if (!e.shiftKey) selectNode(null);
  const el = document.createElement("div");
  el.className = "marquee";
  document.body.appendChild(el);
  marquee = { startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY, baseSelection, el };
  updateMarquee();
  window.addEventListener("mousemove", onMarqueeMove);
  window.addEventListener("mouseup", onMarqueeUp);
});
function onPanMove(e) {
  if (!pan) return;
  state.pan.x = pan.origX + (e.clientX - pan.startX);
  state.pan.y = pan.origY + (e.clientY - pan.startY);
  applyTransform();
}
function onPanUp() {
  pan = null; board.classList.remove("panning"); board.style.cursor = "";
  window.removeEventListener("mousemove", onPanMove);
  window.removeEventListener("mouseup", onPanUp);
  save();
}
function updateMarquee() {
  if (!marquee) return;
  const x = Math.min(marquee.startX, marquee.currentX);
  const y = Math.min(marquee.startY, marquee.currentY);
  const w = Math.abs(marquee.currentX - marquee.startX);
  const h = Math.abs(marquee.currentY - marquee.startY);
  marquee.el.style.left = x + "px";
  marquee.el.style.top = y + "px";
  marquee.el.style.width = w + "px";
  marquee.el.style.height = h + "px";
}
function onMarqueeMove(e) {
  if (!marquee) return;
  marquee.currentX = e.clientX;
  marquee.currentY = e.clientY;
  updateMarquee();
  applyMarqueeSelection();
}
function applyMarqueeSelection() {
  if (!marquee) return;
  const a = screenToCanvas(marquee.startX, marquee.startY);
  const b = screenToCanvas(marquee.currentX, marquee.currentY);
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  const next = new Set(marquee.baseSelection);
  for (const n of state.nodes) {
    let nx, ny, nw, nh;
    if (n.type === "line") {
      const { p1, p2 } = resolveLineEndpoints(n);
      nx = Math.min(p1.x, p2.x); ny = Math.min(p1.y, p2.y);
      nw = Math.abs(p2.x - p1.x); nh = Math.abs(p2.y - p1.y);
    } else {
      const box = nodeBox(n);
      nx = box.x; ny = box.y; nw = box.w; nh = box.h;
    }
    const intersects = nx < maxX && nx + nw > minX && ny < maxY && ny + nh > minY;
    if (intersects) next.add(n.id);
    else if (!marquee.baseSelection.has(n.id)) next.delete(n.id);
  }
  state.selectedIds = next;
  for (const el of canvas.querySelectorAll(".node")) {
    el.classList.toggle("selected", state.selectedIds.has(el.dataset.id));
  }
  syncFloatToolbar();
}
function onMarqueeUp() {
  if (marquee) { marquee.el.remove(); marquee = null; }
  window.removeEventListener("mousemove", onMarqueeMove);
  window.removeEventListener("mouseup", onMarqueeUp);
}
board.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = board.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  if (e.ctrlKey || e.metaKey || !e.shiftKey) {
    const delta = -e.deltaY * 0.0015;
    const newZoom = clamp(state.zoom * (1 + delta), 0.25, 3);
    const ratio = newZoom / state.zoom;
    state.pan.x = mx - (mx - state.pan.x) * ratio;
    state.pan.y = my - (my - state.pan.y) * ratio;
    state.zoom = newZoom;
  } else {
    state.pan.x -= e.deltaX; state.pan.y -= e.deltaY;
  }
  applyTransform(); save();
}, { passive: false });
function zoomBy(factor) {
  const rect = board.getBoundingClientRect();
  const mx = rect.width / 2, my = rect.height / 2;
  const newZoom = clamp(state.zoom * factor, 0.25, 3);
  const ratio = newZoom / state.zoom;
  state.pan.x = mx - (mx - state.pan.x) * ratio;
  state.pan.y = my - (my - state.pan.y) * ratio;
  state.zoom = newZoom;
  applyTransform(); save();
}
document.getElementById("btn-zoom-in").addEventListener("click", () => zoomBy(1.2));
document.getElementById("btn-zoom-out").addEventListener("click", () => zoomBy(1 / 1.2));
zoomReset.addEventListener("click", () => { state.pan = { x: 0, y: 0 }; state.zoom = 1; applyTransform(); save(); });

// ============================================================
// Selection toolbar
// ============================================================
const fEl = {
  font: document.getElementById("ft-font"),
  size: document.getElementById("ft-size"),
  sizeUp: document.getElementById("ft-size-up"),
  sizeDown: document.getElementById("ft-size-down"),
  color: document.getElementById("ft-color"),
  colorSwatch: document.getElementById("ft-color-swatch"),
  bgPop: document.getElementById("ft-bg-pop"),
  bgSwatch: document.getElementById("ft-bg-swatch"),
  bg: document.getElementById("ft-bg"),
  bgClear: document.getElementById("ft-bg-clear"),
  bgCurrent: document.getElementById("ft-bg-current"),
  bgSwatches: document.getElementById("bg-swatches"),
  paperSwatches: document.getElementById("paper-swatches"),
  borderPop: document.getElementById("ft-border-pop"),
  borderSwatch: document.getElementById("ft-border-swatch"),
  borderColor: document.getElementById("ft-border-color"),
  borderCurrent: document.getElementById("ft-border-current"),
  borderClear: document.getElementById("ft-border-clear"),
  borderSwatches: document.getElementById("border-swatches"),
  borderWidth: document.getElementById("ft-border-width"),
  borderWidthVal: document.getElementById("ft-border-width-val"),
  borderRadius: document.getElementById("ft-border-radius"),
  borderRadiusVal: document.getElementById("ft-border-radius-val"),
  stroke: document.getElementById("ft-stroke"),
  strokeSwatch: document.getElementById("ft-stroke-swatch"),
  lineWidth: document.getElementById("ft-line-width"),
  arrow: document.getElementById("ft-arrow"),
  front: document.getElementById("ft-front"),
  back: document.getElementById("ft-back"),
  duplicate: document.getElementById("ft-duplicate"),
  del: document.getElementById("ft-delete"),
};

for (const p of PAPER_COLORS) {
  const sw = document.createElement("div");
  sw.className = "swatch paper";
  sw.style.background = p.value; sw.style.borderColor = p.edge;
  sw.dataset.color = p.value; sw.title = p.name;
  sw.addEventListener("click", () => { setStyle({ bg: p.value }); refreshBgPopover(); });
  fEl.paperSwatches.appendChild(sw);
}
for (const c of SWATCH_COLORS) {
  const sw = document.createElement("div");
  sw.className = "swatch"; sw.style.background = c; sw.dataset.color = c;
  sw.addEventListener("click", () => { setStyle({ bg: c }); refreshBgPopover(); });
  fEl.bgSwatches.appendChild(sw);
}
// Border swatches mirror the general palette
for (const c of SWATCH_COLORS) {
  const sw = document.createElement("div");
  sw.className = "swatch"; sw.style.background = c; sw.dataset.color = c;
  sw.addEventListener("click", () => {
    const cur = +(getPrimary()?.style?.borderWidth || 0);
    setStyle({ borderColor: c, borderWidth: cur > 0 ? cur : 2 });
    refreshBorderPopover();
  });
  fEl.borderSwatches.appendChild(sw);
}

function syncFloatToolbar() {
  const sel = getSelectedNodes();
  if (sel.length === 0) { ft.hidden = true; return; }
  ft.hidden = false;
  if (sel.length > 1) { ftCount.hidden = false; ftCount.textContent = `${sel.length} selected`; }
  else ftCount.hidden = true;

  const type = selectionType();
  ft.querySelectorAll('[data-for]').forEach((g) => {
    const fors = g.dataset.for.split(/\s+/);
    g.style.display = fors.includes(type) ? "" : "none";
  });

  const primary = getPrimary();
  if (!primary) return;

  if (type === "text") {
    const s = primary.style || {};
    if (document.activeElement !== fEl.font) fEl.font.value = s.fontFamily || "Geist, system-ui, sans-serif";
    if (document.activeElement !== fEl.size) fEl.size.value = s.fontSize || 18;
    fEl.color.value = s.color || "#0e0f0c";
    fEl.colorSwatch.style.color = s.color || "#0e0f0c";
    const hasBg = s.bg && s.bg !== "transparent";
    fEl.bgSwatch.classList.toggle("empty", !hasBg);
    fEl.bgSwatch.style.color = hasBg ? s.bg : "transparent";
    if (hasBg) fEl.bg.value = s.bg;
    ft.querySelectorAll('.ft-btn[data-toggle]').forEach((b) => b.classList.toggle("active", !!s[b.dataset.toggle]));
    ft.querySelectorAll('.ft-btn[data-align]').forEach((b) => b.classList.toggle("active", s.align === b.dataset.align));
  } else if (type === "image") {
    // border controls are shared via popover — see syncBorderIndicator
  } else if (type === "line") {
    const s = primary.style || {};
    fEl.stroke.value = s.stroke || "#0e0f0c";
    fEl.strokeSwatch.style.color = s.stroke || "#0e0f0c";
    if (document.activeElement !== fEl.lineWidth) fEl.lineWidth.value = s.width || 2;
    fEl.arrow.classList.toggle("active", s.arrow !== false);
  } else if (type === "shape") {
    const s = primary.style || {};
    const fill = (s.bg && s.bg !== "transparent") ? s.bg : SHAPE_DEFAULT_COLOR;
    if (fEl.shapeFillSwatch) {
      fEl.shapeFillSwatch.classList.remove("empty");
      fEl.shapeFillSwatch.style.color = fill;
    }
    if (fEl.shapeRadius && document.activeElement !== fEl.shapeRadius) {
      fEl.shapeRadius.value = s.radius ?? 14;
    }
  }

  // Border indicator (text + image)
  if (type === "text" || type === "image") {
    const s = primary.style || {};
    const w = +s.borderWidth || 0;
    fEl.borderSwatch.classList.toggle("empty", w === 0);
    fEl.borderSwatch.style.color = w > 0 ? (s.borderColor || "#0e0f0c") : "var(--muted-2)";
  }
}

// ============================================================
// Style mutations
// ============================================================
function setStyle(patch) {
  const type = selectionType();
  const sel = getSelectedNodes();
  let any = false;
  for (const n of sel) {
    if (type === "text"  && n.type !== "text")  continue;
    if (type === "image" && n.type !== "image") continue;
    if (type === "line"  && n.type !== "line")  continue;
    if (type === "shape" && n.type !== "shape") continue;
    n.style = { ...(n.style || {}), ...patch };
    any = true;
  }
  if (any) { render(); save(); }
}
fEl.font.addEventListener("change", () => setStyle({ fontFamily: fEl.font.value }));
fEl.size.addEventListener("input", () => {
  const v = +fEl.size.value;
  if (v >= 8 && v <= 240) setStyle({ fontSize: v });
});
fEl.size.addEventListener("change", () => setStyle({ fontSize: clamp(+fEl.size.value || 18, 8, 240) }));
fEl.sizeUp.addEventListener("click", () => { const n = getPrimary(); if (!n) return; setStyle({ fontSize: clamp((n.style.fontSize || 18) + 2, 8, 240) }); });
fEl.sizeDown.addEventListener("click", () => { const n = getPrimary(); if (!n) return; setStyle({ fontSize: clamp((n.style.fontSize || 18) - 2, 8, 240) }); });
fEl.color.addEventListener("input", () => setStyle({ color: fEl.color.value }));
fEl.bg.addEventListener("input", () => setStyle({ bg: fEl.bg.value }));
fEl.bgClear.addEventListener("click", () => { setStyle({ bg: "transparent" }); refreshBgPopover(); });
fEl.borderColor.addEventListener("input", () => {
  const cur = +(getPrimary()?.style?.borderWidth || 0);
  setStyle({ borderColor: fEl.borderColor.value, borderWidth: cur > 0 ? cur : 2 });
  refreshBorderPopover();
});
fEl.borderClear.addEventListener("click", () => { setStyle({ borderWidth: 0 }); refreshBorderPopover(); });
fEl.borderWidth.addEventListener("input", () => {
  const v = +fEl.borderWidth.value;
  fEl.borderWidthVal.textContent = v + "px";
  setStyle({ borderWidth: v });
});
fEl.borderRadius.addEventListener("input", () => {
  const v = +fEl.borderRadius.value;
  fEl.borderRadiusVal.textContent = v + "px";
  setStyle({ radius: v });
});
fEl.stroke.addEventListener("input", () => setStyle({ stroke: fEl.stroke.value }));
fEl.lineWidth.addEventListener("input", () => setStyle({ width: +fEl.lineWidth.value }));
fEl.arrow.addEventListener("click", () => {
  const n = getPrimary(); if (!n) return;
  setStyle({ arrow: !(n.style?.arrow !== false) });
});

ft.querySelectorAll('.ft-btn[data-toggle]').forEach((b) => {
  b.addEventListener("click", () => {
    const n = getPrimary(); if (!n) return;
    setStyle({ [b.dataset.toggle]: !n.style[b.dataset.toggle] });
  });
});
ft.querySelectorAll('.ft-btn[data-align]').forEach((b) => b.addEventListener("click", () => setStyle({ align: b.dataset.align })));

function bringSelectionToFront() {
  const sel = getSelectedNodes(); if (!sel.length) return;
  let z = nextZ(); for (const n of sel) n.z = z++;
  render(); save();
}
function sendSelectionToBack() {
  const sel = getSelectedNodes(); if (!sel.length) return;
  let minZ = state.nodes.reduce((m, x) => Math.min(m, x.z || 1), Infinity);
  let z = minZ - sel.length; for (const n of sel) n.z = z++;
  render(); save();
}
fEl.front.addEventListener("click", bringSelectionToFront);
fEl.back.addEventListener("click", sendSelectionToBack);
fEl.duplicate.addEventListener("click", duplicateSelected);
fEl.del.addEventListener("click", deleteSelected);

// ============================================================
// Popovers
// ============================================================
fEl.bgPop.addEventListener("click", (e) => {
  e.stopPropagation();
  if (bgPop.hidden) {
    bgPop.hidden = false; refreshBgPopover();
    positionPopoverNear(bgPop, fEl.bgPop);
  } else closePopover(bgPop);
});
fEl.borderPop.addEventListener("click", (e) => {
  e.stopPropagation();
  if (borderPop.hidden) {
    borderPop.hidden = false; refreshBorderPopover();
    positionPopoverNear(borderPop, fEl.borderPop);
  } else closePopover(borderPop);
});
function refreshBorderPopover() {
  const node = getPrimary(); if (!node) return;
  const s = node.style || {};
  const w = +s.borderWidth || 0;
  const c = s.borderColor || "#0e0f0c";
  const r = s.radius ?? 12;
  fEl.borderColor.value = c;
  fEl.borderCurrent.style.background = c;
  fEl.borderWidth.value = w;
  fEl.borderWidthVal.textContent = w + "px";
  fEl.borderRadius.value = r;
  fEl.borderRadiusVal.textContent = r + "px";
  borderPop.querySelectorAll(".swatch").forEach((sw) =>
    sw.classList.toggle("active", c.toLowerCase() === sw.dataset.color.toLowerCase() && w > 0));
}
function refreshBgPopover() {
  const node = getPrimary(); if (!node) return;
  const bg = node.style?.bg;
  const cur = bg && bg !== "transparent" ? bg : "#ffffff";
  fEl.bg.value = cur;
  fEl.bgCurrent.style.background = bg && bg !== "transparent" ? bg : "transparent";
  bgPop.querySelectorAll(".swatch").forEach((sw) => sw.classList.toggle("active", (bg || "").toLowerCase() === sw.dataset.color.toLowerCase()));
}
function positionPopoverNear(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth || 280;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
  pop.style.left = left + "px";
  pop.style.top = (r.bottom + 10) + "px";
}
function closePopover(pop) { pop.hidden = true; }
document.addEventListener("mousedown", (e) => {
  if (!bgPop.hidden && !bgPop.contains(e.target) && !fEl.bgPop.contains(e.target)) closePopover(bgPop);
  if (!borderPop.hidden && !borderPop.contains(e.target) && !fEl.borderPop.contains(e.target)) closePopover(borderPop);
  if (!helpPop.hidden && !helpPop.contains(e.target) && !document.getElementById("btn-help").contains(e.target)) closePopover(helpPop);
});
document.getElementById("btn-help").addEventListener("click", (e) => {
  e.stopPropagation();
  if (helpPop.hidden) {
    helpPop.hidden = false;
    const r = e.currentTarget.getBoundingClientRect();
    const w = helpPop.offsetWidth || 300;
    const h = helpPop.offsetHeight || 280;
    let left = r.right - w;
    let top = r.top - h - 10;
    if (top < 10) top = r.bottom + 10;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    helpPop.style.left = left + "px";
    helpPop.style.top = top + "px";
  } else closePopover(helpPop);
});

// ============================================================
// Duplicate / Copy / Paste / Delete
// ============================================================
function duplicateSelected() {
  const sel = getSelectedNodes(); if (!sel.length) return;
  // Map old -> new ids so connections inside the group transfer
  const idMap = new Map();
  for (const n of sel) idMap.set(n.id, uid());
  const newIds = new Set();
  for (const n of sel) {
    const c = clone(n);
    c.id = idMap.get(n.id);
    if (c.type === "line") {
      // Reconnect to duplicated counterparts when possible
      if (c.fromId && idMap.has(c.fromId)) c.fromId = idMap.get(c.fromId);
      else if (c.fromId && !state.selectedIds.has(c.fromId)) {/* keep external */}
      if (c.toId && idMap.has(c.toId)) c.toId = idMap.get(c.toId);
      c.x1 += 24; c.y1 += 24; c.x2 += 24; c.y2 += 24;
    } else { c.x += 24; c.y += 24; }
    c.z = nextZ();
    state.nodes.push(c);
    newIds.add(c.id);
  }
  state.selectedIds = newIds;
  render(); save();
}
function copySelected() {
  const sel = getSelectedNodes(); if (!sel.length) return;
  clipboardNodes = sel.map(clone);
}
function pasteClipboard() {
  if (!clipboardNodes.length) return;
  const idMap = new Map();
  for (const n of clipboardNodes) idMap.set(n.id, uid());
  const newIds = new Set();
  for (const n of clipboardNodes) {
    const c = clone(n);
    c.id = idMap.get(n.id);
    if (c.type === "line") {
      if (c.fromId && idMap.has(c.fromId)) c.fromId = idMap.get(c.fromId); else c.fromId = null;
      if (c.toId && idMap.has(c.toId)) c.toId = idMap.get(c.toId); else c.toId = null;
      c.x1 += 30; c.y1 += 30; c.x2 += 30; c.y2 += 30;
    } else { c.x += 30; c.y += 30; }
    c.z = nextZ();
    state.nodes.push(c);
    newIds.add(c.id);
  }
  state.selectedIds = newIds;
  render(); save();
}
function deleteSelected() {
  if (!state.selectedIds.size) return;
  const removed = new Set(state.selectedIds);
  state.nodes = state.nodes.filter((n) => !removed.has(n.id));
  // Detach lines from removed nodes
  for (const n of state.nodes) {
    if (n.type === "line") {
      if (removed.has(n.fromId)) n.fromId = null;
      if (removed.has(n.toId)) n.toId = null;
    }
  }
  state.selectedIds.clear();
  render(); save();
}

// ============================================================
// Keyboard
// ============================================================
window.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  const editable = e.target && e.target.isContentEditable;
  const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || editable;

  if ((e.ctrlKey || e.metaKey) && !inField) {
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); return; }
    if (k === "a") { e.preventDefault(); selectAll(); return; }
    if (k === "d") { e.preventDefault(); duplicateSelected(); return; }
    if (k === "c" && state.selectedIds.size) { e.preventDefault(); copySelected(); return; }
    if (k === "b" && state.selectedIds.size) {
      const n = getPrimary(); if (n && n.type === "text") { e.preventDefault(); setStyle({ bold: !n.style.bold }); return; }
    }
    if (k === "i" && state.selectedIds.size) {
      const n = getPrimary(); if (n && n.type === "text") { e.preventDefault(); setStyle({ italic: !n.style.italic }); return; }
    }
    if (k === "u" && state.selectedIds.size) {
      const n = getPrimary(); if (n && n.type === "text") { e.preventDefault(); setStyle({ underline: !n.style.underline }); return; }
    }
  }

  if (inField) return;

  if (e.key === "Delete" || e.key === "Backspace") {
    if (state.selectedIds.size) { e.preventDefault(); deleteSelected(); }
  } else if (e.key === "Escape") {
    selectNode(null); closePopover(bgPop); closePopover(borderPop); closePopover(helpPop);
  } else if (e.key === "0") {
    state.pan = { x: 0, y: 0 }; state.zoom = 1; applyTransform(); save();
  } else if (e.key === "?") {
    document.getElementById("btn-help").click();
  } else if (e.key.startsWith("Arrow")) {
    if (!state.selectedIds.size) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    for (const n of getSelectedNodes()) {
      if (n.type === "line") {
        if (e.key === "ArrowUp") { n.y1 -= step; n.y2 -= step; }
        if (e.key === "ArrowDown") { n.y1 += step; n.y2 += step; }
        if (e.key === "ArrowLeft") { n.x1 -= step; n.x2 -= step; }
        if (e.key === "ArrowRight") { n.x1 += step; n.x2 += step; }
      } else {
        if (e.key === "ArrowUp") n.y -= step;
        if (e.key === "ArrowDown") n.y += step;
        if (e.key === "ArrowLeft") n.x -= step;
        if (e.key === "ArrowRight") n.x += step;
      }
    }
    render(); save();
  }
});

window.addEventListener("paste", (e) => {
  if (e.target && e.target.isContentEditable) return;
  const items = e.clipboardData?.items || [];
  let handled = false;
  const c = viewportCenter();
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) { addImageFromFile(file, c.x, c.y); handled = true; }
    }
  }
  if (handled) { e.preventDefault(); return; }
  if (clipboardNodes.length) { e.preventDefault(); pasteClipboard(); }
});

// ============================================================
// Topbar buttons
// ============================================================
document.getElementById("btn-undo").addEventListener("click", undo);
document.getElementById("btn-redo").addEventListener("click", redo);
document.getElementById("btn-clear").addEventListener("click", () => {
  if (!state.nodes.length) return;
  if (confirm("Clear the entire board? This cannot be undone.")) {
    state.nodes = []; state.selectedIds.clear(); render(); save();
  }
});
// File popover (export PNG / export project / import project)
const filePop = document.getElementById("file-popover");
const projectInput = document.getElementById("project-input");
const btnFile = document.getElementById("btn-file");
btnFile.addEventListener("click", (e) => {
  e.stopPropagation();
  if (filePop.hidden) {
    filePop.hidden = false;
    const r = e.currentTarget.getBoundingClientRect();
    const w = filePop.offsetWidth || 240;
    let left = r.right - w;
    let top = r.bottom + 10;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    filePop.style.left = left + "px";
    filePop.style.top = top + "px";
  } else closePopover(filePop);
});
document.addEventListener("mousedown", (e) => {
  if (!filePop.hidden && !filePop.contains(e.target) && !btnFile.contains(e.target)) closePopover(filePop);
});
document.getElementById("file-export-png").addEventListener("click", () => { closePopover(filePop); exportPNG(); });
document.getElementById("file-export-project").addEventListener("click", () => { closePopover(filePop); exportProject(); });
document.getElementById("file-import-project").addEventListener("click", () => { closePopover(filePop); projectInput.click(); });
projectInput.addEventListener("change", () => {
  const file = projectInput.files && projectInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importProjectJSON(String(reader.result || ""));
    projectInput.value = "";
  };
  reader.readAsText(file);
});

function exportProject() {
  const data = {
    app: "my-playbook",
    version: 1,
    exportedAt: new Date().toISOString(),
    nodes: state.nodes,
    pan: state.pan,
    zoom: state.zoom,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  link.href = url;
  link.download = `my-playbook-${stamp}.json`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importProjectJSON(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (_) { alert("That file isn't valid JSON."); return; }
  if (!data || !Array.isArray(data.nodes)) { alert("That file doesn't look like a My Playbook project."); return; }
  if (state.nodes.length && !confirm("Replace the current board with the imported project? This will overwrite your current work (you can still Undo).")) return;
  state.nodes = data.nodes;
  state.selectedIds.clear();
  if (data.pan && typeof data.pan.x === "number" && typeof data.pan.y === "number") state.pan = data.pan;
  if (typeof data.zoom === "number" && data.zoom > 0) state.zoom = data.zoom;
  applyTransform();
  render();
  saveImmediate();
  pushHistory();
}

// ============================================================
// Copy / paste board as code
// ============================================================
function buildCodeSnapshot() {
  return JSON.stringify({
    app: "my-playbook",
    version: 1,
    nodes: state.nodes,
    pan: state.pan,
    zoom: state.zoom,
  }, null, 2);
}
async function copyCodeToClipboard() {
  const snap = buildCodeSnapshot();
  try {
    await navigator.clipboard.writeText(snap);
    flashToast("Board copied as code");
  } catch (_) {
    // Fallback — open the code modal so the user can copy manually
    openCodeModal(snap);
  }
}
function applyCodeText(text, mode /* "add" | "replace" */) {
  let data;
  try { data = JSON.parse(text); }
  catch (_) { alert("That doesn't look like valid JSON."); return false; }
  const incomingNodes = Array.isArray(data) ? data : (data && Array.isArray(data.nodes) ? data.nodes : null);
  if (!incomingNodes) { alert("Couldn't find a `nodes` array in that snippet."); return false; }

  if (mode === "replace") {
    if (state.nodes.length && !confirm("Replace the current board with this code? You can still Undo.")) return false;
    state.nodes = incomingNodes.map((n) => ({ ...n, id: n.id || uid() }));
    state.selectedIds.clear();
    if (data.pan) state.pan = data.pan;
    if (typeof data.zoom === "number" && data.zoom > 0) state.zoom = data.zoom;
    applyTransform();
  } else {
    // Merge — give incoming nodes new ids and remap line endpoints to the new ids
    const idMap = new Map();
    for (const n of incomingNodes) idMap.set(n.id, uid());
    const newIds = new Set();
    const baseZ = nextZ();
    for (const raw of incomingNodes) {
      const c = clone(raw);
      c.id = idMap.get(raw.id);
      if (c.type === "line") {
        if (c.fromId && idMap.has(c.fromId)) c.fromId = idMap.get(c.fromId); else c.fromId = null;
        if (c.toId && idMap.has(c.toId)) c.toId = idMap.get(c.toId); else c.toId = null;
      }
      c.z = baseZ + newIds.size;
      state.nodes.push(c);
      newIds.add(c.id);
    }
    state.selectedIds = newIds;
  }
  render();
  saveImmediate();
  pushHistory();
  return true;
}

// Tiny toast — small ephemeral confirmation message in the bottom-left
let toastEl = null;
let toastTimer = null;
function flashToast(message) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "mp-toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
}

// ============================================================
// Modal helpers — open/close any .modal element with a backdrop and
// elements marked [data-close]. Each modal also supports Escape and
// returns focus politely.
// ============================================================
function openModal(modalEl) {
  modalEl.hidden = false;
  // First focusable input/textarea inside the modal
  const target = modalEl.querySelector("input, textarea");
  if (target) setTimeout(() => target.focus(), 30);
}
function closeModal(modalEl) { modalEl.hidden = true; }
function wireModalClose(modalEl) {
  modalEl.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => closeModal(modalEl));
  });
}
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const m of document.querySelectorAll(".modal")) {
    if (!m.hidden) { closeModal(m); break; }
  }
});

// Anchor position captured when a modal/popover opens — preserves the
// cursor location so nodes land where the user actually wanted, not on
// the modal button they just clicked.
//
//   pendingNodePos = null  ⇒  no specific position pre-set; fall back
//                              to viewport center so tool-button clicks
//                              don't drop nodes at the corner of the dock.
//
// Right-click menu and keyboard shortcuts call setNodeAnchor() to put
// the precise point in pendingNodePos before opening a modal.
let pendingNodePos = null;
function setNodeAnchor(pos) { pendingNodePos = pos; }
function consumeCursorAnchor() {
  const p = pendingNodePos || viewportCenter();
  pendingNodePos = null;
  return p;
}

// ============================================================
// Paper note modal — type long-form content, then add as a paper node
// ============================================================
const paperModal = document.getElementById("paper-modal");
const paperTitle = document.getElementById("paper-title");
const paperBody = document.getElementById("paper-body");
wireModalClose(paperModal);
function openPaperModal() {
  paperTitle.value = "";
  paperBody.value = "";
  openModal(paperModal);
}
function submitPaperModal() {
  const t = paperTitle.value.trim();
  const b = paperBody.value.trim();
  if (!t && !b) { closeModal(paperModal); return; }
  const content = t && b ? `${t}\n\n${b}` : (t || b);
  const c = consumeCursorAnchor();
  addTextNode("paper", c.x, c.y, { content });
  closeModal(paperModal);
}
document.getElementById("paper-add").addEventListener("click", submitPaperModal);
paperBody.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submitPaperModal(); }
});

// ============================================================
// Paper VIEW modal — read-only popup for compact paper tiles
// ============================================================
const paperViewModal = document.getElementById("paper-view-modal");
const paperViewTitle = document.getElementById("paper-view-title");
const paperViewBody  = document.getElementById("paper-view-body");
if (paperViewModal) wireModalClose(paperViewModal);

function openPaperViewModal(node) {
  if (!paperViewModal) return;
  const content = String(node.content || "");
  // First non-empty line is treated as the title; the rest is the body.
  const lines = content.split(/\r?\n/);
  let titleIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) { titleIdx = i; break; }
  }
  let title = "Paper note";
  let body = content;
  if (titleIdx >= 0) {
    title = lines[titleIdx].trim();
    body = lines.slice(titleIdx + 1).join("\n").replace(/^\s*\n/, "");
  }
  paperViewTitle.textContent = title;
  paperViewBody.innerHTML = "";
  const paragraphs = body.split(/\n{2,}/);
  for (const p of paragraphs) {
    if (!p.trim()) continue;
    const para = document.createElement("p");
    para.textContent = p;
    paperViewBody.appendChild(para);
  }
  if (!paperViewBody.children.length) {
    const para = document.createElement("p");
    para.textContent = "(empty)";
    para.style.color = "var(--muted)";
    paperViewBody.appendChild(para);
  }
  openModal(paperViewModal);
}

// ============================================================
// Image-by-URL modal
// ============================================================
// ============================================================
// Image VIEW modal — fullscreen popup for image nodes (double-click to open)
// ============================================================
const imageViewModal = document.getElementById("image-view-modal");
const imageViewTitle = document.getElementById("image-view-title");
const imageViewImg   = document.getElementById("image-view-img");
const imageViewOpen  = document.getElementById("image-view-open");
if (imageViewModal) wireModalClose(imageViewModal);
function openImageViewModal(node) {
  if (!imageViewModal) return;
  const src = node.src || "";
  const title = (node.caption && String(node.caption).trim())
    || (node.label && String(node.label).trim())
    || "Image";
  imageViewTitle.textContent = title;
  imageViewImg.src = src;
  imageViewImg.alt = title;
  if (/^https?:\/\//i.test(src)) {
    imageViewOpen.href = src;
    imageViewOpen.hidden = false;
  } else {
    imageViewOpen.removeAttribute("href");
    imageViewOpen.hidden = true;
  }
  openModal(imageViewModal);
}

const imageModal = document.getElementById("image-modal");
const imageUrlInput = document.getElementById("image-url");
wireModalClose(imageModal);
function openImageModal() {
  imageUrlInput.value = "";
  openModal(imageModal);
}
function addImageFromURL(url, x, y) {
  // No crossOrigin: rendering uses <img src>, which doesn't need CORS. Forcing
  // crossOrigin="anonymous" makes most public image URLs fail the preflight.
  const img = new Image();
  img.onload = () => {
    const max = 360;
    let w = img.naturalWidth || 320, h = img.naturalHeight || 200;
    if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
    const node = {
      id: uid(), type: "image",
      x: Math.round(x - w / 2), y: Math.round(y - h / 2),
      w, h, z: nextZ(),
      src: url, style: { radius: 12, borderColor: "#a8a8a0", borderWidth: 1 },
    };
    state.nodes.push(node);
    state.selectedIds = new Set([node.id]);
    render(); save();
  };
  img.onerror = () => { alert("Couldn't load that image. Make sure the URL is publicly reachable."); };
  img.src = url;
}
document.getElementById("image-add-url").addEventListener("click", () => {
  const url = imageUrlInput.value.trim();
  if (!url) { imageUrlInput.focus(); return; }
  if (!/^https?:\/\//i.test(url) && !url.startsWith("data:")) {
    alert("Please enter a full URL starting with http:// or https://");
    return;
  }
  const c = consumeCursorAnchor();
  addImageFromURL(url, c.x, c.y);
  closeModal(imageModal);
});
document.getElementById("image-pick-file").addEventListener("click", () => {
  // Hand the anchor over to the file input flow so the picked file lands at
  // the same cursor position the user clicked from.
  pendingImagePos = consumeCursorAnchor();
  closeModal(imageModal);
  imageInput.click();
});
imageUrlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("image-add-url").click();
});

// Replace the original image-tool click handler so it opens the modal
// instead of going straight to the file picker.
toolImage.addEventListener("click", (e) => {
  // Stop propagation so the existing handler (which calls imageInput.click)
  // doesn't double-fire.
  e.stopImmediatePropagation();
  openImageModal();
}, true);

// ============================================================
// Emoji / icon picker — quick-add curated unicode glyphs
// ============================================================
const emojiPop = document.getElementById("emoji-popover");
const emojiGrid = document.getElementById("emoji-grid");
const emojiCustom = document.getElementById("emoji-custom");

const EMOJI_PRESETS = [
  "✨","⭐","🌟","💡","🔥","🚀","🎯","✅",
  "❌","⚠️","💎","📌","📍","🧠","💬","📝",
  "📚","🔗","🖼️","🎨","🛠️","⚙️","📊","📈",
  "🔒","🔓","💰","🌱","🌍","☀️","🌙","☁️",
  "❤️","💚","💙","💛","🧡","💜","🤍","🖤",
  "→","←","↑","↓","✓","✗","★","◆",
];

function buildEmojiGrid() {
  emojiGrid.innerHTML = "";
  for (const ch of EMOJI_PRESETS) {
    const b = document.createElement("button");
    b.className = "emoji-cell";
    b.type = "button";
    b.textContent = ch;
    b.addEventListener("click", () => addEmojiNode(ch));
    emojiGrid.appendChild(b);
  }
}
function addEmojiNode(content) {
  const c = consumeCursorAnchor();
  addTextNode("emoji", c.x, c.y, { content });
  closePopover(emojiPop);
}
document.getElementById("tool-emoji").addEventListener("click", (e) => {
  e.stopPropagation();
  if (emojiPop.hidden) {
    if (!emojiGrid.childElementCount) buildEmojiGrid();
    emojiPop.hidden = false;
    const r = e.currentTarget.getBoundingClientRect();
    const w = emojiPop.offsetWidth || 320;
    const h = emojiPop.offsetHeight || 320;
    let left = r.left + r.width / 2 - w / 2;
    let top = r.top - h - 12;
    if (top < 10) top = r.bottom + 10;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    emojiPop.style.left = left + "px";
    emojiPop.style.top = top + "px";
    setTimeout(() => emojiCustom.focus(), 30);
  } else closePopover(emojiPop);
});
document.getElementById("emoji-custom-add").addEventListener("click", () => {
  const v = emojiCustom.value.trim();
  if (!v) { emojiCustom.focus(); return; }
  addEmojiNode(v);
  emojiCustom.value = "";
});
emojiCustom.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); document.getElementById("emoji-custom-add").click(); }
});
document.addEventListener("mousedown", (e) => {
  if (!emojiPop.hidden && !emojiPop.contains(e.target) && !document.getElementById("tool-emoji").contains(e.target)) closePopover(emojiPop);
});

// ============================================================
// Paper tool button → opens paper modal
// ============================================================
document.getElementById("tool-paper").addEventListener("click", openPaperModal);

// ============================================================
// Code modal — copy / paste board as code
// ============================================================
const codeModal = document.getElementById("code-modal");
const codeTextarea = document.getElementById("code-textarea");
wireModalClose(codeModal);
function openCodeModal(prefill) {
  codeTextarea.value = prefill != null ? prefill : buildCodeSnapshot();
  openModal(codeModal);
}
document.getElementById("code-add").addEventListener("click", () => {
  if (applyCodeText(codeTextarea.value, "add")) closeModal(codeModal);
});
document.getElementById("code-replace").addEventListener("click", () => {
  if (applyCodeText(codeTextarea.value, "replace")) closeModal(codeModal);
});

document.getElementById("file-copy-code").addEventListener("click", () => { closePopover(filePop); copyCodeToClipboard(); });
document.getElementById("file-paste-code").addEventListener("click", () => { closePopover(filePop); openCodeModal(); });

// ============================================================
// PNG export
// ============================================================
function exportPNG() {
  if (!state.nodes.length) { alert("Nothing on the board to export."); return; }
  const rects = state.nodes.map((n) => {
    if (n.type === "line") {
      const { p1, p2 } = resolveLineEndpoints(n);
      const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
      const w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y);
      return { n, x, y, w: Math.max(w, 1), h: Math.max(h, 1), p1, p2 };
    }
    if (n.type === "text") {
      const el = canvas.querySelector(`.node[data-id="${n.id}"]`);
      return { n, x: n.x, y: n.y, w: el ? el.offsetWidth : n.w, h: el ? el.offsetHeight : 40 };
    }
    return { n, x: n.x, y: n.y, w: n.w, h: n.h };
  });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  const pad = 48;
  const w = maxX - minX + pad * 2, h = maxY - minY + pad * 2;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fafaf7"; ctx.fillRect(0, 0, w, h);
  const sorted = [...rects].sort((a, b) => effectiveZ(a.n) - effectiveZ(b.n));
  let pending = 0;
  const finalize = () => {
    const link = document.createElement("a");
    link.download = "my-playbook.png"; link.href = c.toDataURL("image/png"); link.click();
  };
  for (const r of sorted) {
    const n = r.n;
    if (n.type === "line") {
      const x1 = r.p1.x - minX + pad, y1 = r.p1.y - minY + pad;
      const x2 = r.p2.x - minX + pad, y2 = r.p2.y - minY + pad;
      ctx.strokeStyle = n.style?.stroke || "#0e0f0c";
      ctx.lineWidth = n.style?.width || 2;
      ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      if (n.style?.arrow !== false) {
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const ah = (n.style?.width || 2) * 4;
        const aw = ah * 0.6;
        const bx = x2 - ux * ah, by = y2 - uy * ah;
        ctx.fillStyle = n.style?.stroke || "#0e0f0c";
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(bx + uy * aw, by - ux * aw);
        ctx.lineTo(bx - uy * aw, by + ux * aw);
        ctx.closePath();
        ctx.fill();
      }
      continue;
    }
    const x = n.x - minX + pad, y = n.y - minY + pad;
    if (n.type === "text") {
      const s = n.style || {};
      if (s.bg && s.bg !== "transparent") {
        ctx.fillStyle = s.bg;
        roundRect(ctx, x, y, r.w, r.h, s.radius ?? 12); ctx.fill();
      }
      if ((+s.borderWidth || 0) > 0) {
        ctx.strokeStyle = s.borderColor || "#0e0f0c";
        ctx.lineWidth = +s.borderWidth;
        roundRect(ctx, x, y, r.w, r.h, s.radius ?? 12); ctx.stroke();
      }
      ctx.fillStyle = s.color || "#0e0f0c";
      const weight = s.bold ? "700" : "400";
      const style = s.italic ? "italic" : "normal";
      ctx.font = `${style} ${weight} ${s.fontSize || 18}px ${s.fontFamily || "Geist, sans-serif"}`;
      ctx.textBaseline = "top";
      const lines = wrapText(ctx, n.content || "", r.w - 28);
      const lineH = (s.fontSize || 18) * 1.4;
      const align = s.align || "left";
      ctx.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
      const tx = align === "center" ? x + r.w / 2 : align === "right" ? x + r.w - 14 : x + 14;
      lines.forEach((ln, idx) => ctx.fillText(ln, tx, y + 10 + idx * lineH));
      if (s.underline) {
        ctx.strokeStyle = s.color || "#0e0f0c";
        ctx.lineWidth = Math.max(1, (s.fontSize || 18) / 16);
        lines.forEach((ln, idx) => {
          const tw = ctx.measureText(ln).width;
          const baseX = align === "center" ? tx - tw / 2 : align === "right" ? tx - tw : tx;
          const ly = y + 10 + idx * lineH + (s.fontSize || 18) + 2;
          ctx.beginPath(); ctx.moveTo(baseX, ly); ctx.lineTo(baseX + tw, ly); ctx.stroke();
        });
      }
    } else if (n.type === "image") {
      pending++;
      const img = new Image();
      img.onload = () => {
        const s = n.style || {};
        ctx.save();
        roundRect(ctx, x, y, r.w, r.h, s.radius ?? 12); ctx.clip();
        ctx.drawImage(img, x, y, r.w, r.h);
        ctx.restore();
        if ((+s.borderWidth || 0) > 0) {
          ctx.strokeStyle = s.borderColor || "#0e0f0c";
          ctx.lineWidth = +s.borderWidth;
          roundRect(ctx, x, y, r.w, r.h, s.radius ?? 12); ctx.stroke();
        }
        pending--;
        if (pending === 0) finalize();
      };
      img.src = n.src;
    } else if (n.type === "shape") {
      drawShapeOnCanvas(ctx, n, x, y, r.w, r.h);
    }
  }
  if (pending === 0) finalize();
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function wrapText(ctx, text, maxWidth) {
  const out = [];
  for (const para of String(text).split("\n")) {
    const words = para.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxWidth && line) { out.push(line); line = word; }
      else { line = test; }
    }
    out.push(line);
  }
  return out;
}

// ============================================================
// AI generate — paste a JSON spec, build the diagram
// ============================================================
const AI_COLOR_NAMES = {
  // Pastel FILL tier — node fills (sticky backgrounds) only
  yellow:   "#fdf3c7",
  pink:     "#fde2dd",
  blue:     "#dde8f3",
  green:    "#dde8de",
  lavender: "#e4dff0",
  lilac:    "#e4dff0",   // alias of lavender
  peach:    "#fde4d0",
  mint:     "#dceee2",
  cream:    "#f6efd9",
  white:    "#ffffff",
  paper:    "#fafaf7",
  // Stroke / accent tier — line strokes only, never as fills
  red:      "#c25a5a",
  orange:   "#d18a4a",
  amber:    "#bfa050",
  forest:   "#508a6c",
  sky:      "#3d6c8a",
  violet:   "#6b5aa3",
  purple:   "#6b5aa3",   // alias of violet
  magenta:  "#a35a8c",
  pinkish:  "#a35a8c",   // alias of magenta
  gray:     "#6b6e68",
  grey:     "#6b6e68",   // alias of gray
  black:    "#0e0f0c",
};
function resolveColor(input) {
  if (input == null) return null;
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (!s || s === "none" || s === "transparent" || s === "no") return null;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s;
  return AI_COLOR_NAMES[s] || null;
}

const AI_PROMPT_TEMPLATE = `You are a visual diagram designer for "My Playbook", a whiteboard app.
I'll describe an idea — turn it into a DENSE, DEEP, MULTI-LEVEL board with nodes, sections, and arrows.

Reply with ONE JSON object inside a single \`\`\`json … \`\`\` fence. NO commentary.

══════════════════════════════════════════════════════════
SCHEMA — these field names are FIXED. Do not invent others.
══════════════════════════════════════════════════════════

{
  "groups": [
    {
      "title": "Section heading (shown above the section)",
      "layout":  "mindmap | tree | flow | bilateral | radial | grid",
      "density": "tight | normal | wide",   // optional, default "normal"

      "nodes": [
        {
          "id":     "kebab-or-snake-case-id",   // unique, GLOBAL across all groups
          "label":  "Visible text — ≤ 4 words (or full paragraphs for paper / image caption)",
          "kind":   "heading | body | sticky | paper | emoji | image",
          "color":  "pastel name for sticky fills, OR stroke name for line color, OR #hex",
          "border": "yes | no | #hex",
          "align":  "left | center | right",     // optional
          "fontSize": 18,                        // optional override
          "bold":   false,                       // optional
          "italic": false,                       // optional
          "branchLayout": "right-fan | left-fan | bilateral | top-down | bottom-up | horizontal-row | grid", // optional — overrides how THIS node's children are positioned

          // image-only fields:
          "src":    "https://upload.wikimedia.org/...jpg",   // image URL (required for kind=image)
          "w":      320,                                     // optional width  (default 320)
          "h":      200                                      // optional height (default 200)
        }
      ],

      "links": [
        {
          "from":  "node-id",
          "to":    "node-id",
          "label": "≤ 2 words on the arrow (optional, use sparingly)",
          "color": "stroke-tier name or #hex",   // line color
          "width": 2,                            // line thickness
          "arrow": true                          // false for a plain line
        }
      ]
    }
  ]
}

NEVER include x / y. The board lays things out automatically.

══════════════════════════════════════════════════════════
EDIT MODE — when the user pastes an existing board above
══════════════════════════════════════════════════════════
If a JSON board (same schema) appears ABOVE this prompt, you are EDITING that
board, not rebuilding it. Apply the user's request as a small DELTA:

• Reuse existing node IDs verbatim. Don't renumber. Don't rename.
• OMIT every node and link the user didn't ask to change. Do NOT re-emit
  unchanged nodes — silence means "leave it alone".
• To CHANGE a node: emit it with its existing id and the changed fields.
• To ADD a node: emit it with a NEW unique id (prefix "new-" or any
  kebab-case the existing board hasn't used).
• To REMOVE nodes: add a top-level "remove": ["id1", "id2"] array.
  Any links touching a removed node disappear automatically — don't list
  them too.
• Links: same rule. Re-emit only the from/to pairs you are adding or
  restyling. To delete a link, prefer removing one of its endpoints.
• Cross-section links to existing nodes work naturally — IDs are global.
• The output is a delta, not a snapshot. Don't include unchanged sections.

Tiny example. Existing board has nodes "a", "b", "c" linked a→b→c. The user
says "split b into b1 and b2, and remove a." Reply:

\`\`\`json
{
  "remove": ["a"],
  "groups": [
    {
      "title": "Edits",
      "layout": "mindmap",
      "nodes": [
        { "id": "new-b1", "label": "Half one",  "kind": "body" },
        { "id": "new-b2", "label": "Half two",  "kind": "body" },
        { "id": "b",      "label": "Was b",     "kind": "sticky", "color": "blue" }
      ],
      "links": [
        { "from": "b", "to": "new-b1" },
        { "from": "b", "to": "new-b2" },
        { "from": "new-b1", "to": "c" }
      ]
    }
  ]
}
\`\`\`

══════════════════════════════════════════════════════════
DENSITY — pack it dense, but every node must earn its place
══════════════════════════════════════════════════════════
Aim for a dense, information-rich map. Targets:
• ≤ 5 sections (groups) total — width is fine, depth is the goal.
• 8–15 nodes per section, structured into MULTIPLE LEVELS (not a flat fan-out).
• 25–50 nodes total across the whole board. More is fine if every node earns its place.
• ≤ 12 links total per section.
Cut filler. No decorative nodes. No "Introduction" / "Conclusion" / "Summary" sections.
Merge synonyms. But do NOT collapse a real sub-point just to stay small —
expanding a real concept into its parts is the whole point.

Per-section density hint (optional "density" field):
• "tight"  — pack nodes close, for dense reference / FAQ / glossary sections.
• "normal" — default; balanced spacing.
• "wide"   — only when readability genuinely demands it (big paper popups + images).

══════════════════════════════════════════════════════════
DEPTH — go DEEP, not wide. Flat lists are forbidden.
══════════════════════════════════════════════════════════
The #1 failure mode is a 1-level fan-out: heading → 5 stickies → done. Don't do that.

• For mindmap and tree layouts: AT LEAST 3 LEVELS of depth.
    Level 1: heading (the section root).
    Level 2: main branches (2–4 main branches under the root).
    Level 3: sub-points under each main branch.
    Level 4+: keep going where the topic warrants — leaves can be paper popups.
• Every main branch should have 2–4 sub-branches. Every sub-branch should have its
  own children where the topic warrants it.
• THINK DEEPLY before stopping. For every node you write, ask: "what are the parts
  of this? what are its causes, examples, mechanisms, consequences?" Decompose until
  you hit something that's truly atomic.
• Leaves should NOT be terminal one-word stubs. Either decompose them further OR
  attach a paper popup that explains them. Paper popups ARE the depth.
• A "section" with one heading and 5 stickies hanging off it directly is a FAILURE.
  Rebuild it with intermediate stickies that group those 5 into 2–3 sub-clusters,
  each with its own children.

══════════════════════════════════════════════════════════
COLOR DISCIPLINE — pastel fills, deeper strokes, never mix
══════════════════════════════════════════════════════════
Two strict tiers. Do NOT cross them.

FILL tier (sticky note backgrounds ONLY — soft pastels):
  yellow    #fdf3c7
  pink      #fde2dd
  blue      #dde8f3
  green     #dde8de
  lavender  #e4dff0   (alias: lilac)
  peach     #fde4d0
  mint      #dceee2
  cream     #f6efd9

STROKE / ACCENT tier (link "color" ONLY — deeper, never used as a node fill):
  red      #c25a5a
  orange   #d18a4a
  amber    #bfa050
  forest   #508a6c
  sky      #3d6c8a
  violet   #6b5aa3   (alias: purple)
  magenta  #a35a8c
  gray     #6b6e68

Rules:
1. heading nodes → no color field (stay white). body nodes → no color field (stay white).
   paper nodes → no color field (stay paper-cream). emoji nodes → no color field.
   image nodes → no color field (the picture IS the visual).
2. sticky nodes are the ONLY nodes that take a fill color, and ONLY from the FILL tier.
3. Link "color" comes ONLY from the STROKE tier. Default to gray for plain links.
4. NEVER put a stroke-tier color on a sticky. NEVER put a pastel on a link.
5. Use ≤ 3 distinct sticky colors per board. Same color = same theme — never reuse a
   color for unrelated ideas. One sticky color = one cluster id.
6. Black/dark/saturated raw hex values are forbidden for fills. Stick to the names above.

══════════════════════════════════════════════════════════
GROUPING — same idea, same section, same color
══════════════════════════════════════════════════════════
• Cluster related ideas in the SAME section (group). If two nodes share a theme they
  must live in the same group with the same sticky color.
• Each section has ONE clear topic. Name it explicitly via "title".
• Cross-section links are allowed ONLY for high-level concept bridges (e.g. an
  "overview" group pointing into a "details" group). Do not use them for low-level
  detail links — those belong inside one section.

══════════════════════════════════════════════════════════
ANTI-OVERLAP — keep arrows from crossing
══════════════════════════════════════════════════════════
• Prefer linear chains (A → B → C) or clean mindmap branches over webs.
• ≤ 3 outgoing links per node. ≤ 4 incoming links per node.
• No reciprocal links (if A → B exists, do NOT also emit B → A).
• No long cross-board edges that would cut through other nodes — keep linked nodes in
  the same section whenever possible.
• Do not connect every node to every other node. If a node has no clear relation,
  let it sit unlinked inside its section — silence is better than spaghetti.

══════════════════════════════════════════════════════════
LAYOUT SELECTION — pick the GROUP layout AND (optionally) per-node branchLayout
══════════════════════════════════════════════════════════
You now pick TWO things:
  1. The GROUP "layout" — overall section shape (set on the group).
  2. Optionally, "branchLayout" on individual NODES — overrides how THAT node's
     children are arranged. Each node decides for itself; otherwise it inherits
     from its parent, ultimately falling back to the group's layout.

DEFAULT: when in doubt, group layout = mindmap, no branchLayout overrides.

GROUP-LEVEL "layout" values (overall section shape):
• mindmap   — DEFAULT. Deep recursive exploration. Root defaults to "right-fan"
              unless overridden. Children inherit and recurse — every node may pick
              its own branchLayout. Use for brainstorms, idea expansion, "around X".
• tree      — strict hierarchy with real ranks. Root defaults to "top-down".
              Sub-branches recurse and may pick their own branchLayout.
• flow      — RARE. True ordered sequences only. Root defaults to "horizontal-row".
              If the section is "things connected to X", use mindmap NOT flow.
• bilateral — Balanced root with 5+ main branches splitting LEFT and RIGHT.
              Root defaults to "bilateral". Each main branch recurses.
• radial    — SPECIAL. Hub-and-spoke ECOSYSTEM with equal-tier siblings around a
              hub. NO recursion — siblings don't branch. Use for ≤ 8 spokes only.
              Avoid past 10 nodes; prefer right-fan or bilateral.
• grid      — SPECIAL. Flat parallel options/categories. No hierarchy.

Each section chooses ONE group layout. If a section feels like two shapes, either
split it OR use branchLayout on specific sub-branches to give them their own shape.

══════════════════════════════════════════════════════════
BRANCH LAYOUT — pick the right shape per node
══════════════════════════════════════════════════════════
"branchLayout" is OPTIONAL on every node. Set it where a node's children clearly
need a different shape than the default; leave it off where inheritance does the
right thing.

The 7 branch layouts:

• right-fan      — children stack VERTICALLY to the RIGHT of this node.
                   Default for mindmap. General "X has these sub-points".
• left-fan       — children stack VERTICALLY to the LEFT of this node.
                   Mirror of right-fan. Sparingly — balancing a bilateral root.
• bilateral      — half the children go RIGHT, half go LEFT.
                   Use on the ROOT of a balanced mindmap with 5+ main branches.
• top-down       — children in a ROW BELOW the parent.
                   Tree-style. When ranks are real and children are peers.
• bottom-up      — children in a ROW ABOVE the parent.
                   Rare — "leads to" or building UP toward a goal.
• horizontal-row — children in a single ROW to the RIGHT, centered on parent.
                   Sequences, timelines, before→after, pipelines.
• grid           — children in a roughly-square GRID below parent.
                   Parallel options, comparison cards, gallery.

Decision tree — for any node with children, ask in order:
  1. "Are children peers in a clear ORDER (steps, stages, time)?"
        → horizontal-row (default for sequences) or top-down (vertical hierarchy)
  2. "Are children parallel options without ranking?"  → grid
  3. "Are children sub-points of an idea, asymmetric depth?"
        → right-fan (default) or left-fan (rare, mirror only)
  4. "Is this the ROOT of a balanced topic with 5+ main branches?" → bilateral
If "none of the above, just inherit", LEAVE branchLayout off.

Inheritance: node's own branchLayout > parent's effective > group layout's default.

══════════════════════════════════════════════════════════
LABELS & HIERARCHY
══════════════════════════════════════════════════════════
• Node labels ≤ 4 words. Arrow labels ≤ 2 words (omit when obvious).
• Paper notes are the ONLY place for paragraphs (use \\n\\n for line breaks).
• Every section has exactly ONE heading node (the root of that section).
• body nodes for plain ideas. sticky for color-grouped clusters. paper for explanations.
  image for visual references. emoji as section opener or as a semantic marker.

══════════════════════════════════════════════════════════
NODE KINDS
══════════════════════════════════════════════════════════
• heading — section root, big bold text, white. 1–3 words.
• body    — plain card, white. The default. 1–4 words.
• sticky  — colored grouped idea. Fill tier color = cluster id.
• paper   — long-form explanation. Renders on the canvas as a compact "📄 Title" tile;
            DOUBLE-CLICK opens a popup with the full content. Because paper notes no
            longer cost canvas space, USE THEM LIBERALLY. Whenever a node needs more
            than 4 words to be clear, do NOT cram it into a body label — instead emit
            a paper node linked to that node. The paper's "label" field holds the
            FULL content (use \\n\\n for paragraphs, 3–5 sentences typical).
            Best pattern: a body / sticky states the idea ("Cold start problem"); a
            paper node linked to it explains it.
• emoji   — single glyph (✨ 🎯 🚀 ⚠️ ✅ 💡 ★ 📌 🔥 🧠).
            Use 1 per section as the opener (kept). ALSO fine as a semantic marker
            attached to a specific node via a short link: ✅ for done, ⚠️ for risk,
            🎯 for goal, 🔥 for priority. Stay modest — don't decorate everything.
• image   — visual reference. Schema:
            { "id": "...", "label": "caption", "kind": "image",
              "src": "https://example.com/foo.jpg", "w": 320, "h": 200 }
            CRITICAL: only emit an image if you are CERTAIN the URL exists and
            is publicly fetchable. Broken URLs are auto-removed from the board,
            so a fake or guessed URL just wastes a slot and leaves a gap.
            Prefer URLs you have HIGH confidence in:
              • https://upload.wikimedia.org/... (Wikimedia Commons — verify file)
              • https://images.unsplash.com/... (Unsplash photo URLs)
              • Well-known, stable CDNs you've seen before
            DO NOT INVENT plausible-looking Wikimedia paths — they will 404.
            DO NOT use placeholder URLs like example.com or via.placeholder.
            If you cannot recall a real, working URL, SKIP the image entirely
            rather than guess. 0 images is better than broken images.
            When you DO add images, aim for 1–3 per board on main branches
            where the topic has an obvious visual association.

══════════════════════════════════════════════════════════
PAPER-AS-POPUP PATTERN — papers ARE the depth, write them in DETAIL
══════════════════════════════════════════════════════════
Paper notes render as a compact "📄 Title" tile on the canvas. Double-click opens
a popup with the full content. Because they don't cost canvas space, USE THEM
LIBERALLY and write them in DEPTH.

WRITING THE PAPER CONTENT (this is where the real value lives):
• Start with a 1-line title (becomes the popup heading) followed by \\n\\n.
• Then write 3–6 PARAGRAPHS of real explanation. Each paragraph 2–4 sentences.
• Paragraphs separated by \\n\\n. Use this freely.
• Cover: what the concept IS, WHY it matters, HOW it works, EXAMPLES,
  EDGE CASES or COMMON MISTAKES, related concepts.
• Treat the paper as a Wikipedia-style mini-article — not a tweet.
• You can include lists, definitions, examples, contrasts. Be concrete.
• Mention specific tools, numbers, frameworks, names. Concrete > abstract.

WHEN TO ATTACH A PAPER:
• EVERY major sub-branch (sticky / heading / important body) should have at
  least one paper attached.
• When a topic has multiple facets, attach MULTIPLE papers to the same node:
  one for "definition", another for "example", another for "common mistakes",
  another for "tools". Don't cram everything into one paper if the facets are
  distinct — split into multiple connected papers.
• Even small body leaves get a 2–4 sentence paper if their meaning isn't obvious.

QUANTITY TARGETS:
• AT LEAST 6–10 paper-popup nodes per board (more for technical topics).
• A complex concept can have 2–4 papers attached to it (definition / example /
  caveat / tool). The popup tiles all stack as separate "📄" tiles linked off
  the same node — that's the right pattern, not a single mega-paper.
• A board with only 1 paper is severely under-explained — flag this as a
  failure mode and rewrite.

Example — ONE node, MULTIPLE attached papers:
  { "id": "cold-start",  "label": "Cold start problem", "kind": "sticky", "color": "peach" }
  { "id": "cs-def",      "label": "What it is\\n\\nA cold start happens when a service has just been deployed or scaled out and its caches, JIT optimizations, and connection pools are not yet warm. The first wave of requests sees significantly higher latency than steady state — typically 5–20× slower for the first 30–120 seconds.\\n\\nMost severe in JVM/Node/serverless environments where the runtime needs to profile hot paths and warm up internal data structures.", "kind": "paper" }
  { "id": "cs-ex",       "label": "Real-world example\\n\\nAWS Lambda cold starts can add 1–3 seconds to a request when a new container spins up after idle. Java Lambdas are worst (2–10s); Go and Node are typically <500ms.\\n\\nFor always-on services (Kubernetes pods after deploy), the cold-start window is usually 30–60s before P99 latency drops back to baseline.", "kind": "paper" }
  { "id": "cs-fix",      "label": "Mitigations\\n\\n1. Pre-warm via synthetic traffic on deploy. Hit /health and a few representative endpoints before shifting real traffic.\\n2. Keep at least one always-hot replica behind the load balancer.\\n3. Lazy-load non-critical modules so the hot path boots fast.\\n4. For serverless, use provisioned concurrency.\\n5. Use SnapStart or similar runtime checkpointing where available.", "kind": "paper" }

  links:
    { "from": "cold-start", "to": "cs-def", "label": "what" }
    { "from": "cold-start", "to": "cs-ex",  "label": "example" }
    { "from": "cold-start", "to": "cs-fix", "label": "fix" }

══════════════════════════════════════════════════════════
IMAGE EXAMPLE
══════════════════════════════════════════════════════════
{
  "id":   "wiki-octocat",
  "label":"GitHub Octocat (mascot)",
  "kind": "image",
  "src":  "https://upload.wikimedia.org/wikipedia/commons/9/91/Octicons-mark-github.svg",
  "w":    280,
  "h":    280
}

══════════════════════════════════════════════════════════
MINDMAP EXAMPLE — root + main branches + sub-branches + leaves
══════════════════════════════════════════════════════════
The shape to imitate (3+ levels, sub-clusters, paper popups at the leaves):

  Cold start (heading)
  ├── Causes (sticky)
  │   ├── Empty caches (body) → paper "Caches are populated lazily..."
  │   ├── JIT not warm (body) → paper "JIT compilers profile hot paths..."
  │   └── DB connection pool empty (body)
  ├── Mitigations (sticky)
  │   ├── Pre-warm traffic (body) → paper "Synthetic GET to /health on deploy..."
  │   ├── Always-hot replica (body)
  │   └── Lazy module load (body)
  └── Detection (sticky)
      ├── P99 spike on first request
      └── Health-check fails first 30s

══════════════════════════════════════════════════════════
BAD vs GOOD — collapse the bloated reply
══════════════════════════════════════════════════════════
BAD (sprawling, dark fills, every section a long flow, scattered):
  9 sections, "Introduction" + "Summary" sections, sticky colors
  {red #b54343, magenta #8a4378, black #0e0f0c} as fills, flow layouts
  everywhere stretching the board sideways, long body labels with 3-sentence
  explanations crammed in, arrows running across the board between unrelated
  sections.

ALSO BAD (the shallow failure mode this prompt fixes):
  Mindmap with 1 heading + 5 stickies hanging directly off it. No sub-branches.
  No paper popups. Every leaf is a 2-word stub. Total node count under 15.
  This is a flat list pretending to be a mindmap. Rebuild it with depth.

ALSO BAD (uniform shape — failing to use branchLayout):
  Every node uses the same layout because the AI didn't think about per-branch
  shape. A timeline crammed into right-fan so steps stack vertically and read
  like a list. A grid of parallel options forced into top-down so they look
  like a hierarchy that doesn't exist. One shape applied to a topic that has
  multiple intrinsic shapes. Use branchLayout per-node to fix this.

GOOD (mindmap spine, 3 levels deep, paper popups at leaves):
  3 sections. The main mindmap section is 3 LEVELS DEEP: a root, 2–4 main
  branches under it, and each branch has 2–4 sub-points of its own. Leaves
  attach paper popups with 2–4 sentences of real detail. Long explanations
  ALWAYS live in paper popups, never in body labels. One sticky color per
  cluster from the FILL tier (e.g. peach for "Causes", mint for "Mitigations",
  blue for "Detection"). Gray strokes by default; one forest-stroke link
  bridges sections as a high-level concept hand-off. flow used in at most
  ONE section, only because there's a real timeline. No "Summary" section.

══════════════════════════════════════════════════════════
EXAMPLE — minimum viable reply (deep mindmap + paper popups + flow timeline)
══════════════════════════════════════════════════════════
\`\`\`json
{
  "groups": [
    {
      "title": "Around: Cold-start problem",
      "layout": "mindmap",
      "density": "normal",
      "nodes": [
        { "id": "cs-emoji",     "label": "💡",                      "kind": "emoji" },
        { "id": "cs-h",         "label": "Cold start",              "kind": "heading", "branchLayout": "bilateral" },

        { "id": "cs-causes",    "label": "Causes",                  "kind": "sticky", "color": "peach", "branchLayout": "right-fan" },
        { "id": "cs-cause-cache","label": "Empty caches",           "kind": "body" },
        { "id": "cs-cache-p",   "label": "Caches are populated lazily on first access, so right after boot every request is a miss. Latency stays elevated until the working set is hot — typically the first 30–120 seconds of traffic.", "kind": "paper" },
        { "id": "cs-cause-jit", "label": "JIT not warm",            "kind": "body" },
        { "id": "cs-jit-p",     "label": "JIT compilers (V8, HotSpot, .NET) profile hot paths before optimizing them. The first thousand calls run in interpreter mode and are 5–20x slower than steady state.", "kind": "paper" },
        { "id": "cs-cause-pool","label": "DB pool empty",           "kind": "body" },

        { "id": "cs-fixes",     "label": "Mitigations",             "kind": "sticky", "color": "mint", "branchLayout": "right-fan" },
        { "id": "cs-fix-prewarm","label": "Pre-warm traffic",       "kind": "body" },
        { "id": "cs-prewarm-p", "label": "On deploy, fire synthetic GET requests to /health and a handful of representative endpoints before shifting real traffic. This populates caches and triggers JIT compilation while users are still on the old replica.", "kind": "paper" },
        { "id": "cs-fix-replica","label": "Always-hot replica",     "kind": "body" },
        { "id": "cs-fix-lazy",  "label": "Lazy module load",        "kind": "body" },

        { "id": "cs-detect",    "label": "Detection",               "kind": "sticky", "color": "blue", "branchLayout": "horizontal-row" },
        { "id": "cs-detect-p99","label": "P99 spike first request", "kind": "body" },
        { "id": "cs-detect-hc", "label": "Healthcheck fails 30s",   "kind": "body" }
      ],
      "links": [
        { "from": "cs-emoji", "to": "cs-h" },

        { "from": "cs-h",       "to": "cs-causes" },
        { "from": "cs-causes",  "to": "cs-cause-cache" },
        { "from": "cs-causes",  "to": "cs-cause-jit" },
        { "from": "cs-causes",  "to": "cs-cause-pool" },
        { "from": "cs-cause-cache", "to": "cs-cache-p", "label": "explain" },
        { "from": "cs-cause-jit",   "to": "cs-jit-p",   "label": "explain" },

        { "from": "cs-h",       "to": "cs-fixes" },
        { "from": "cs-fixes",   "to": "cs-fix-prewarm" },
        { "from": "cs-fixes",   "to": "cs-fix-replica" },
        { "from": "cs-fixes",   "to": "cs-fix-lazy" },
        { "from": "cs-fix-prewarm", "to": "cs-prewarm-p", "label": "explain" },

        { "from": "cs-h",       "to": "cs-detect" },
        { "from": "cs-detect",  "to": "cs-detect-p99" },
        { "from": "cs-detect",  "to": "cs-detect-hc" }
      ]
    },
    {
      "title": "Deploy timeline",
      "layout": "flow",
      "density": "tight",
      "nodes": [
        { "id": "dp-h",     "label": "Deploy",         "kind": "heading" },
        { "id": "dp-build", "label": "Build image",    "kind": "body" },
        { "id": "dp-canary","label": "Canary 5%",      "kind": "body" },
        { "id": "dp-full",  "label": "Full rollout",   "kind": "body" },
        { "id": "dp-ok",    "label": "✅",             "kind": "emoji" }
      ],
      "links": [
        { "from": "dp-h",     "to": "dp-build" },
        { "from": "dp-build", "to": "dp-canary", "label": "5 min" },
        { "from": "dp-canary","to": "dp-full" },
        { "from": "dp-full",  "to": "dp-ok",     "color": "forest" },
        { "from": "cs-h",     "to": "dp-h",      "color": "sky", "label": "affects" }
      ]
    }
  ]
}
\`\`\`

══════════════════════════════════════════════════════════
SELF-CHECK — verify ALL of these before returning
══════════════════════════════════════════════════════════
[ ] ≤ 5 sections. 8–15 nodes per section. Total node count between 25 and 50 (more if topic deserves it).
[ ] Mindmap/tree sections have AT LEAST 3 LEVELS of depth. No flat lists.
[ ] Every main branch has 2–4 sub-points. Sub-points decompose further where the topic warrants.
[ ] At least 6 paper-popup nodes used. Major branches have multiple papers (definition / example / fix / caveat) when the topic has distinct facets.
[ ] Each paper has 3–6 paragraphs of real content with concrete examples, not 1-line stubs.
[ ] At least 2 image nodes used. Each main branch with a clear visual association has one supporting image (Wikimedia / Unsplash URL).
[ ] Every leaf is either self-explanatory OR has a paper popup attached. No bare 1-word stubs.
[ ] Exactly one heading per section. No "Intro" / "Summary" sections.
[ ] No node fill uses a stroke-tier color. No link uses a pastel color.
[ ] ≤ 3 distinct sticky colors across the whole board; same color = same theme.
[ ] heading / body / paper / emoji / image nodes have NO "color" field.
[ ] No reciprocal links. ≤ 3 outgoing links per node.
[ ] Default layout is mindmap. flow used ONLY for true ordered sequences (rare).
[ ] radial reserved for hub-and-spoke ecosystems (equal-tier siblings around a hub).
[ ] Root node has a branchLayout that fits the topic (or relies on group layout default).
[ ] Sub-branches that are TIMELINES use horizontal-row; PARALLEL OPTIONS use grid; everything else inherits or uses right-fan/top-down.
[ ] Don't use radial / 360° layouts past 10 nodes — prefer right-fan or bilateral.
[ ] Any explanation longer than 4 words lives in a paper node (popup), NOT in a body label.
[ ] 2–4 image nodes used; each has a publicly fetchable "src" URL (Wikimedia / Unsplash preferred).
[ ] Emojis: 1 opener per section max, plus optional semantic markers (✅ ⚠️ 🎯) — modest overall.
[ ] "density" field, when set, is one of "tight" | "normal" | "wide" — used purposefully.
[ ] Labels ≤ 4 words; arrow labels ≤ 2 words; paragraphs only inside paper nodes.
[ ] No "x" / "y" fields anywhere.
[ ] Cross-section links are rare and only bridge concepts, not details.

══════════════════════════════════════════════════════════
NOW BUILD THE BOARD FOR THIS:
══════════════════════════════════════════════════════════

[REPLACE THIS LINE WITH YOUR DESCRIPTION]
`;

const aiModal     = document.getElementById("ai-modal");
const aiInput     = document.getElementById("ai-input");
const aiError     = document.getElementById("ai-error");
const aiCopiedTag = document.getElementById("ai-copied");

function openAIModal() {
  aiModal.hidden = false;
  aiError.hidden = true;
  setTimeout(() => aiInput.focus(), 50);
}
function closeAIModal() {
  aiModal.hidden = true;
  aiError.hidden = true;
}

document.getElementById("btn-ai").addEventListener("click", openAIModal);
document.getElementById("ai-close").addEventListener("click", closeAIModal);
document.getElementById("ai-backdrop").addEventListener("click", closeAIModal);
document.getElementById("ai-clear-input").addEventListener("click", () => {
  aiInput.value = ""; aiError.hidden = true; aiInput.focus();
});
// Compact schema preview — a smaller view of the JSON shape, for users who
// just want to see the schema without copying the full prompt.
const AI_SCHEMA_PREVIEW = `{
  "groups": [
    {
      "title": "Section title (optional)",
      "layout":  "mindmap | tree | flow | radial | grid",
      "density": "tight | normal | wide",
      "nodes": [
        {
          "id":     "unique-id",
          "label":  "Visible text",
          "kind":   "heading | body | sticky | paper | emoji | image",
          "color":  "yellow|pink|blue|green|red|... or #hex",
          "border": "yes | no | #hex",
          "align":  "left | center | right",
          "src":    "https://... (image kind only)",
          "w":      320,
          "h":      200
        }
      ],
      "links": [
        {
          "from":  "node-id",
          "to":    "node-id",
          "label": "optional",
          "color": "name or #hex",
          "width": 2,
          "arrow": true
        }
      ]
    }
  ]
}`;

document.getElementById("ai-show-schema").addEventListener("click", () => {
  const pre = document.getElementById("ai-schema-preview");
  if (pre.hidden) {
    pre.textContent = AI_SCHEMA_PREVIEW;
    pre.hidden = false;
  } else {
    pre.hidden = true;
  }
});

document.getElementById("ai-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(AI_PROMPT_TEMPLATE); }
  catch (_) {
    // Fallback for non-secure contexts
    const t = document.createElement("textarea");
    t.value = AI_PROMPT_TEMPLATE;
    document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } catch (_) {}
    t.remove();
  }
  aiCopiedTag.textContent = "Copied";
  aiCopiedTag.hidden = false;
  clearTimeout(aiCopiedTag._t);
  aiCopiedTag._t = setTimeout(() => { aiCopiedTag.hidden = true; }, 1600);
});
document.getElementById("ai-copy-board").addEventListener("click", async () => {
  const boardJSON = JSON.stringify(exportBoardToAIJSON(), null, 2);
  const text =
    "CURRENT BOARD (edit this):\n" +
    "```json\n" + boardJSON + "\n```\n\n" +
    AI_PROMPT_TEMPLATE + "\n\n" +
    "MY EDIT REQUEST: <describe what to change here>\n";
  try { await navigator.clipboard.writeText(text); }
  catch (_) {
    const t = document.createElement("textarea");
    t.value = text;
    document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } catch (_) {}
    t.remove();
  }
  aiCopiedTag.textContent = "Board + prompt copied";
  aiCopiedTag.hidden = false;
  clearTimeout(aiCopiedTag._t);
  aiCopiedTag._t = setTimeout(() => { aiCopiedTag.hidden = true; }, 1600);
});
document.getElementById("ai-import").addEventListener("click", () => {
  aiError.hidden = true;
  const layoutChoice = "tree";
  const mergeChk = document.getElementById("ai-edit-mode");
  const mergeMode = !!(mergeChk && mergeChk.checked);
  const result = importAIDiagram(aiInput.value, layoutChoice, mergeMode);
  if (result.error) {
    aiError.textContent = result.error;
    aiError.hidden = false;
    return;
  }
  closeAIModal();
  aiInput.value = "";
  if (mergeChk) mergeChk.checked = false;
});

// Esc closes modal (only when modal is open and target isn't the textarea itself)
window.addEventListener("keydown", (e) => {
  if (!aiModal.hidden && e.key === "Escape") {
    e.stopPropagation();
    closeAIModal();
  }
});

// Valid per-node `branchLayout` values — drives how a node's children stack.
const BRANCH_LAYOUTS = new Set([
  "right-fan", "left-fan", "bilateral", "quadrant",
  "top-down", "bottom-up", "horizontal-row", "grid",
]);

// Build a text node from an AI node spec (no positioning yet — done by layout pass)
function buildAINode(ri, internalId, zIdx) {
  // Map all the "kind" synonyms an AI might emit to one of our known variants.
  const kindRaw = String(ri.kind ?? ri.type ?? ri.style ?? "body").toLowerCase();
  const kind = ["heading", "title", "h"].includes(kindRaw)        ? "heading"
             : ["sticky", "note", "post-it"].includes(kindRaw)    ? "sticky"
             : ["paper", "card", "doc", "document"].includes(kindRaw) ? "paper"
             : ["emoji", "icon", "symbol", "glyph"].includes(kindRaw) ? "emoji"
             : "body";
  const preset = TEXT_PRESETS[kind];
  const style = { ...preset.style };

  const colorIn = ri.color ?? ri.bg ?? ri.background;
  const resolvedBg = resolveColor(colorIn);
  if (resolvedBg) style.bg = resolvedBg;

  const textColorIn = ri.textColor ?? ri.text_color ?? ri.fg;
  const resolvedFg = resolveColor(textColorIn);
  if (resolvedFg) style.color = resolvedFg;

  const borderIn = ri.border;
  if (borderIn) {
    if (borderIn === true || borderIn === "yes" || borderIn === "true") {
      style.borderWidth = 2;
      style.borderColor = "#0e0f0c";
    } else if (typeof borderIn === "string" && !["no", "false", "none"].includes(borderIn.toLowerCase())) {
      const bc = resolveColor(borderIn);
      if (bc) { style.borderWidth = 2; style.borderColor = bc; }
    } else if (typeof borderIn === "object") {
      const bc = resolveColor(borderIn.color);
      const bw = +borderIn.width;
      if (bc || bw > 0) {
        style.borderWidth = bw > 0 ? bw : 2;
        style.borderColor = bc || "#0e0f0c";
      }
    }
  }

  // Optional text alignment (especially useful for emoji/icon nodes)
  const alignIn = String(ri.align ?? "").toLowerCase();
  if (["left", "center", "right"].includes(alignIn)) style.align = alignIn;

  // Optional font-size override (e.g. larger emoji, smaller body)
  if (+ri.fontSize > 0) style.fontSize = +ri.fontSize;
  else if (+ri.font_size > 0) style.fontSize = +ri.font_size;

  // Optional bold/italic/underline toggles
  if (ri.bold === true) style.bold = true;
  if (ri.italic === true) style.italic = true;
  if (ri.underline === true) style.underline = true;

  const explicitX = typeof ri.x === "number" ? Math.round(ri.x) : null;
  const explicitY = typeof ri.y === "number" ? Math.round(ri.y) : null;
  const w = +ri.w || preset.w;
  const node = {
    id: internalId, type: "text",
    variant: kind,
    _explicitX: explicitX,
    _explicitY: explicitY,
    // Off-screen placeholder so we can MEASURE real DOM size before laying out
    x: explicitX != null ? explicitX : -100000,
    y: explicitY != null ? explicitY : -100000,
    w, z: zIdx,
    content: String(ri.label ?? ri.text ?? ri.content ?? ri.id ?? "Untitled"),
    style,
  };
  const blRaw = typeof ri.branchLayout === "string" ? ri.branchLayout.toLowerCase() : null;
  if (blRaw && BRANCH_LAYOUTS.has(blRaw)) node.branchLayout = blRaw;
  return node;
}

// Export the current board into the AI JSON schema (inverse of buildAINode /
// buildAIImageNode / the link builder). Returns a JS object — caller stringifies.
// Reuses internal node ids as AI ids (already unique strings). Skips auto-generated
// link-label text nodes (rendering artifacts of the import path).
function exportBoardToAIJSON() {
  const isLabelArtifact = (n) =>
    n.type === "text"
    && n.style && n.style.fontSize === 12
    && n.style.bg === "#ffffff"
    && n.style.borderColor === "#e6e6e0"
    && n.w === 140;

  const aiNodes = [];
  const aiLinks = [];

  for (const n of state.nodes) {
    if (n.type === "text") {
      if (isLabelArtifact(n)) continue;
      const variant = n.variant && TEXT_PRESETS[n.variant] ? n.variant : "body";
      const preset  = TEXT_PRESETS[variant];
      const ps      = preset.style;
      const s       = n.style || {};
      const out     = { id: n.id, kind: variant, label: n.content ?? "" };
      if (s.bg && s.bg !== "transparent" && s.bg !== ps.bg) out.color = s.bg;
      if (s.borderWidth > 0) out.border = s.borderColor || "yes";
      if (s.align && s.align !== ps.align) out.align = s.align;
      if (s.fontSize && s.fontSize !== ps.fontSize) out.fontSize = s.fontSize;
      if (s.bold && !ps.bold)     out.bold = true;
      if (s.italic && !ps.italic) out.italic = true;
      if (n.w && n.w !== preset.w) out.w = n.w;
      aiNodes.push(out);
    } else if (n.type === "image") {
      const out = { id: n.id, kind: "image", src: n.src || "", w: n.w, h: n.h };
      if (typeof n.caption === "string" && n.caption) out.caption = n.caption;
      aiNodes.push(out);
    } else if (n.type === "line" && n.fromId && n.toId) {
      const s = n.style || {};
      const out = { from: n.fromId, to: n.toId };
      if (s.stroke && s.stroke !== "#0e0f0c") out.color = s.stroke;
      if (s.width && s.width !== 2) out.width = s.width;
      if (s.arrow === false) out.arrow = false;
      aiLinks.push(out);
    }
  }

  return { groups: [{ title: "Current board", layout: "mindmap", nodes: aiNodes, links: aiLinks }] };
}

// Build an image node from an AI image spec (kind: "image", src: URL).
function buildAIImageNode(ri, internalId, zIdx) {
  const src = String(ri.src ?? ri.url ?? ri.href ?? "").trim();
  const w = Math.max(40, Math.round(+ri.w || +ri.width  || 240));
  const h = Math.max(40, Math.round(+ri.h || +ri.height || 160));
  const explicitX = typeof ri.x === "number" ? Math.round(ri.x) : null;
  const explicitY = typeof ri.y === "number" ? Math.round(ri.y) : null;
  const style = { radius: 12 };
  const borderIn = ri.border;
  if (borderIn) {
    if (borderIn === true || borderIn === "yes" || borderIn === "true") {
      style.borderWidth = 2; style.borderColor = "#0e0f0c";
    } else if (typeof borderIn === "string" && !["no", "false", "none"].includes(borderIn.toLowerCase())) {
      const bc = resolveColor(borderIn);
      if (bc) { style.borderWidth = 2; style.borderColor = bc; }
    }
  }
  const node = {
    id: internalId, type: "image",
    _explicitX: explicitX,
    _explicitY: explicitY,
    x: explicitX != null ? explicitX : -100000,
    y: explicitY != null ? explicitY : -100000,
    w, h, z: zIdx,
    src, style,
    caption: typeof ri.caption === "string" ? ri.caption : null,
  };
  const blRaw = typeof ri.branchLayout === "string" ? ri.branchLayout.toLowerCase() : null;
  if (blRaw && BRANCH_LAYOUTS.has(blRaw)) node.branchLayout = blRaw;
  return node;
}

// Cascade per-branch colors over an AI import: each top-level child of a group's
// root gets a hue from the STROKE palette, and that hue is applied to any line
// in its subtree whose stroke is still the default #0e0f0c. Sticky/fill colors
// are NEVER overridden — explicit AI choices win.
const BRANCH_STROKE_PALETTE = ["#508a6c", "#3d6c8a", "#d18a4a", "#a35a8c", "#bfa050", "#6b5aa3"];
function cascadeBranchColors(allCreated, groups, idMap) {
  const resolve = (aiId) => idMap.get(String(aiId));
  for (const g of groups) {
    const children = new Map();
    const outDeg = new Map();
    const localIds = new Set();
    for (const [, n] of g.nodesByAi) localIds.add(n.id);
    for (const id of localIds) { children.set(id, []); outDeg.set(id, 0); }
    for (const l of g.rawLinks) {
      const f = resolve(l.from ?? l.source ?? l.a);
      const t = resolve(l.to   ?? l.target ?? l.b);
      if (!f || !t || !localIds.has(f) || !localIds.has(t)) continue;
      children.get(f).push(t);
      outDeg.set(f, (outDeg.get(f) || 0) + 1);
    }
    let root = null;
    for (const [, n] of g.nodesByAi) {
      if (n.type === "text" && n.variant === "heading") { root = n; break; }
    }
    if (!root) {
      let best = -1;
      for (const id of localIds) {
        const o = outDeg.get(id) || 0;
        if (o > best) { best = o; root = state.nodes.find((x) => x.id === id); }
      }
    }
    if (!root) continue;
    const topChildren = children.get(root.id) || [];
    if (!topChildren.length) continue;
    const lineByEdge = new Map();
    for (const ln of state.nodes) {
      if (ln.type !== "line" || !ln.fromId || !ln.toId) continue;
      if (!localIds.has(ln.fromId) || !localIds.has(ln.toId)) continue;
      lineByEdge.set(ln.fromId + ">" + ln.toId, ln);
    }
    topChildren.forEach((branchRoot, idx) => {
      const color = BRANCH_STROKE_PALETTE[idx % BRANCH_STROKE_PALETTE.length];
      const recolor = (ln) => {
        if (!ln) return;
        const cur = ln.style && ln.style.stroke;
        if (!cur || cur === "#0e0f0c") ln.style = { ...(ln.style || {}), stroke: color };
      };
      recolor(lineByEdge.get(root.id + ">" + branchRoot));
      const seen = new Set([branchRoot]);
      const queue = [branchRoot];
      while (queue.length) {
        const cur = queue.shift();
        for (const nxt of (children.get(cur) || [])) {
          if (seen.has(nxt)) continue;
          seen.add(nxt);
          queue.push(nxt);
          recolor(lineByEdge.get(cur + ">" + nxt));
        }
      }
    });
  }
}

function importAIDiagram(rawText, layoutChoice, mergeMode) {
  if (!rawText || !rawText.trim()) return { error: "Paste the AI's JSON reply first." };
  mergeMode = !!mergeMode;
  // Merge mode: index existing nodes by id so the AI's node ids map back to live nodes.
  const existingById = new Map();
  if (mergeMode) for (const n of state.nodes) if (n && n.id) existingById.set(String(n.id), n);
  const mergedExisting = new Set(); // internal node ids that were UPDATED in place

  // Tolerate code fences and surrounding text — extract the first {...} block.
  let jsonText = rawText.trim();
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) jsonText = fenceMatch[1].trim();
  if (jsonText[0] !== "{") {
    const start = jsonText.indexOf("{");
    const end   = jsonText.lastIndexOf("}");
    if (start >= 0 && end > start) jsonText = jsonText.slice(start, end + 1);
  }

  let data;
  try { data = JSON.parse(jsonText); }
  catch (e) { return { error: "Couldn't parse JSON: " + e.message }; }

  if (!data || typeof data !== "object") return { error: "Expected a JSON object with `nodes` / `groups`." };

  const validLayouts = new Set([
    "tree", "flow", "radial", "grid", "mindmap", "bilateral",
    // group-level layout may also be one of the 7 branch layouts directly
    "right-fan", "left-fan", "top-down", "bottom-up", "horizontal-row",
  ]);
  const pickLayout = (raw) => {
    if (typeof raw !== "string") return null;
    const v = raw.toLowerCase();
    return validLayouts.has(v) ? v : null;
  };
  const fallbackLayout = pickLayout(data.layout) || pickLayout(layoutChoice) || "mindmap";

  // ----- Normalize into one or more groups -----
  // A "group" = an independent section with its own layout, laid out around (0,0)
  // first then translated to its slot on the board. Top-level nodes/links also
  // become an (untitled) group.
  const pickArr = (...keys) => {
    for (const k of keys) if (Array.isArray(data[k]) && data[k].length) return data[k];
    return null;
  };
  const groups = [];
  if (Array.isArray(data.groups) && data.groups.length) {
    for (const g of data.groups) {
      if (!g || typeof g !== "object") continue;
      const gNodes = Array.isArray(g.nodes) ? g.nodes : Array.isArray(g.boxes) ? g.boxes : [];
      const gLinks = Array.isArray(g.links) ? g.links
                   : Array.isArray(g.edges) ? g.edges
                   : Array.isArray(g.relations) ? g.relations
                   : Array.isArray(g.arrows) ? g.arrows
                   : [];
      if (!gNodes.length) continue;
      groups.push({
        title: typeof g.title === "string" && g.title.trim() ? g.title.trim() : null,
        layout: pickLayout(g.layout) || fallbackLayout,
        rawNodes: gNodes,
        rawLinks: gLinks,
      });
    }
  }
  const topNodes = pickArr("nodes", "boxes");
  const topLinks = pickArr("links", "edges", "relations", "arrows") || [];
  if (topNodes && topNodes.length) {
    groups.push({
      title: null,
      layout: fallbackLayout,
      rawNodes: topNodes,
      rawLinks: topLinks,
    });
  }

  if (!groups.length) return { error: "No nodes found. Expected `groups` (or `nodes`) with at least one entry." };

  // ----- Create nodes (text boxes) up-front, all groups in one batch -----
  const idMap     = new Map();   // ai id -> internal uid (GLOBAL: cross-group links work)
  const allCreated = [];
  let z = nextZ();

  for (const g of groups) {
    g.nodesByAi = new Map();
    g.created   = [];     // truly new nodes (need layout)
    g.reused    = [];     // already-on-board nodes we updated in place (keep their x/y)
    for (const ri of g.rawNodes) {
      const aiId = String(ri.id ?? ri.name ?? "").trim();
      if (!aiId || idMap.has(aiId)) continue;
      // MERGE MODE: if this id matches an existing node, update fields in place.
      if (mergeMode && existingById.has(aiId)) {
        const existing = existingById.get(aiId);
        idMap.set(aiId, existing.id);
        const kindRaw = String(ri.kind ?? ri.type ?? "").toLowerCase();
        const isImg =
          ["image", "img", "picture", "photo"].includes(kindRaw) ||
          (typeof ri.src === "string" && /^https?:\/\//i.test(ri.src.trim()));
        const fresh = isImg
          ? buildAIImageNode(ri, existing.id, existing.z || z++)
          : buildAINode(ri, existing.id, existing.z || z++);
        // Preserve current position; merge styles so the AI can omit unchanged fields.
        if (existing.type === "text" && fresh.type === "text") {
          if (ri.label != null || ri.text != null || ri.content != null) existing.content = fresh.content;
          existing.style = { ...existing.style, ...fresh.style };
          if (fresh.variant) existing.variant = fresh.variant;
          if (fresh.w) existing.w = fresh.w;
        } else if (existing.type === "image" && fresh.type === "image") {
          if (fresh.src) existing.src = fresh.src;
          existing.style = { ...existing.style, ...fresh.style };
          if (fresh.w) existing.w = fresh.w;
          if (fresh.h) existing.h = fresh.h;
          if (ri.caption !== undefined) existing.caption = fresh.caption;
        }
        g.nodesByAi.set(aiId, existing);
        g.reused.push(existing);
        mergedExisting.add(existing.id);
        continue;
      }
      const newId = uid();
      idMap.set(aiId, newId);
      const kindRaw = String(ri.kind ?? ri.type ?? "").toLowerCase();
      const isImage =
        ["image", "img", "picture", "photo"].includes(kindRaw) ||
        (typeof ri.src === "string" && /^https?:\/\//i.test(ri.src.trim()));
      const node = isImage
        ? buildAIImageNode(ri, newId, z++)
        : buildAINode(ri, newId, z++);
      // Skip image nodes without a usable src — avoids silent broken nodes.
      if (node.type === "image" && !node.src) continue;
      state.nodes.push(node);
      g.nodesByAi.set(aiId, node);
      g.created.push(node);
      allCreated.push(node);
    }
  }

  // In merge mode, a reply may contain only in-place edits and/or a `remove` list —
  // both are valid edits even when no brand-new nodes are created.
  const removeIds = Array.isArray(data.remove) ? data.remove
                  : Array.isArray(data.delete) ? data.delete
                  : [];
  const willRemove = mergeMode && removeIds.some((s) => existingById.has(String(s)));
  if (!allCreated.length && !mergedExisting.size && !willRemove) {
    return { error: "No usable nodes found (each needs a unique `id`)." };
  }

  // Pass 1 — render off-screen so the DOM has real widths/heights for every node.
  render();

  // Pass 2 — read measured sizes (global lookup so cross-group links can use it too)
  const sizes = new Map();
  for (const g of groups) {
    for (const [aiId, n] of g.nodesByAi) {
      const el = canvas.querySelector(`.node[data-id="${n.id}"]`);
      if (el) sizes.set(aiId, { w: el.offsetWidth, h: el.offsetHeight });
      else sizes.set(aiId, { w: n.w || 240, h: 60 });
    }
  }

  // Pass 3 — clear placeholder positions, lay out EACH GROUP around its own (0,0).
  // Merged-existing nodes keep their current x/y as anchors.
  for (const n of allCreated) {
    if (n._explicitX == null) n.x = null;
    if (n._explicitY == null) n.y = null;
  }

  let newIds, extraNodes;

  if (!mergeMode) {
    for (const g of groups) {
      applyLayout(g.layout, g.nodesByAi, g.rawLinks, sizes, { x: 0, y: 0 });
    }

    // Pass 4 — compute each group's bbox, then arrange groups in a square-ish grid
    for (const g of groups) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [aiId, n] of g.nodesByAi) {
        if (n.x == null || n.y == null) continue;
        const s = sizes.get(aiId) || { w: 240, h: 60 };
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + s.w);
        maxY = Math.max(maxY, n.y + s.h);
      }
      if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 240; maxY = 60; }
      g.bbox = { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
    }

    const center  = viewportCenter();
    const N       = groups.length;
    const cols    = Math.max(1, Math.ceil(Math.sqrt(N)));
    const rows    = Math.ceil(N / cols);
    const GAP     = 220;     // gap between sections — generous so they read as distinct
    const TITLE_H = 44;

    const colW = Array(cols).fill(0);
    const rowH = Array(rows).fill(0);
    for (let i = 0; i < N; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      const g = groups[i];
      const groupH = g.bbox.h + (g.title ? TITLE_H : 0);
      if (g.bbox.w > colW[c]) colW[c] = g.bbox.w;
      if (groupH    > rowH[r]) rowH[r] = groupH;
    }
    const totalGridW = colW.reduce((a, b) => a + b, 0) + (cols - 1) * GAP;
    const totalGridH = rowH.reduce((a, b) => a + b, 0) + (rows - 1) * GAP;
    const gridX0 = center.x - totalGridW / 2;
    const gridY0 = center.y - totalGridH / 2;

    for (let i = 0; i < N; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      const cellX = gridX0 + colW.slice(0, c).reduce((a, b) => a + b, 0) + c * GAP;
      const cellY = gridY0 + rowH.slice(0, r).reduce((a, b) => a + b, 0) + r * GAP;
      const g = groups[i];
      const titleAllowance = g.title ? TITLE_H : 0;
      const dx = cellX - g.bbox.minX;
      const dy = cellY + titleAllowance - g.bbox.minY;
      for (const n of g.created) {
        if (n.x != null) n.x = Math.round(n.x + dx);
        if (n.y != null) n.y = Math.round(n.y + dy);
      }
      g.bbox = {
        minX: g.bbox.minX + dx, minY: g.bbox.minY + dy,
        maxX: g.bbox.maxX + dx, maxY: g.bbox.maxY + dy,
        w: g.bbox.w, h: g.bbox.h,
      };
    }

    // Safety: any node still without a position lands near viewport center
    let fx = center.x, fy = center.y;
    for (const n of allCreated) {
      if (n.x == null) { n.x = Math.round(fx); fx += 30; }
      if (n.y == null) { n.y = Math.round(fy); fy += 30; }
      delete n._explicitX;
      delete n._explicitY;
    }

    // Add section titles (rendered as headings above each group).
    newIds = new Set(allCreated.map((n) => n.id));
    extraNodes = [];
    for (const g of groups) {
      if (!g.title) continue;
      const titleNode = {
        id: uid(), type: "text",
        x: Math.round(g.bbox.minX),
        y: Math.round(g.bbox.minY - TITLE_H + 12),
        w: Math.max(280, g.bbox.w),
        z: z++,
        content: g.title,
        style: {
          ...TEXT_PRESETS.heading.style,
          fontSize: 26,
          align: "left",
        },
      };
      state.nodes.push(titleNode);
      newIds.add(titleNode.id);
      extraNodes.push(titleNode);
    }
  } else {
    // MERGE MODE — lay out only the new nodes per group, anchored to existing
    // neighbours' positions. No section titles, no cross-section grid.
    const center0 = viewportCenter();
    for (const g of groups) {
      const newOnly = new Map();
      for (const [aiId, n] of g.nodesByAi) {
        if (!mergedExisting.has(n.id)) newOnly.set(aiId, n);
      }
      if (!newOnly.size) continue;
      // Find anchor positions: existing nodes that link to/from any new node here.
      const anchorPts = [];
      for (const l of g.rawLinks) {
        const fId = String(l.from ?? l.source ?? l.a ?? "");
        const tId = String(l.to   ?? l.target ?? l.b ?? "");
        const fn = g.nodesByAi.get(fId), tn = g.nodesByAi.get(tId);
        const consider = (newSide, anchor, anchorAiId) => {
          if (!newSide || !anchor) return;
          if (!newOnly.has(newSide === fn ? fId : tId)) return;
          if (!mergedExisting.has(anchor.id)) return;
          if (anchor.x == null || anchor.y == null) return;
          const sz = sizes.get(anchorAiId) || { w: anchor.w || 240, h: 60 };
          anchorPts.push({ x: anchor.x + sz.w / 2, y: anchor.y + sz.h / 2 });
        };
        consider(fn, tn, tId);
        consider(tn, fn, fId);
      }
      const cx = anchorPts.length ? anchorPts.reduce((s, p) => s + p.x, 0) / anchorPts.length : center0.x;
      const cy = anchorPts.length ? anchorPts.reduce((s, p) => s + p.y, 0) / anchorPts.length : center0.y;
      applyLayout(g.layout, newOnly, g.rawLinks, sizes, { x: cx, y: cy });
    }
    let fx = center0.x, fy = center0.y;
    for (const n of allCreated) {
      if (n.x == null) { n.x = Math.round(fx); fx += 30; }
      if (n.y == null) { n.y = Math.round(fy); fy += 30; }
      delete n._explicitX; delete n._explicitY;
    }
    newIds = new Set(allCreated.map((n) => n.id));
    extraNodes = [];
  }

  // Pass 5 — build links + offset labels (links can reach across groups; ids are global)
  // resolveOverlaps now runs AFTER this pass (see Pass 5.5) so titles + labels
  // are present and can participate in collision resolution.
  const allLinks = [];
  for (const g of groups) for (const l of g.rawLinks) allLinks.push(l);
  const globalLookup = new Map(); // aiId -> { node, size }
  for (const g of groups) for (const [aiId, n] of g.nodesByAi) globalLookup.set(aiId, { node: n, size: sizes.get(aiId) });

  for (const rl of allLinks) {
    const fromAi = String(rl.from ?? rl.source ?? rl.a ?? "").trim();
    const toAi   = String(rl.to   ?? rl.target ?? rl.b ?? "").trim();
    const fromEntry = globalLookup.get(fromAi);
    const toEntry   = globalLookup.get(toAi);
    if (!fromEntry || !toEntry) continue;
    const lineNode = {
      id: uid(), type: "line", z: z++,
      fromId: fromEntry.node.id, toId: toEntry.node.id,
      x1: 0, y1: 0, x2: 0, y2: 0,
      style: {
        stroke: resolveColor(rl.color ?? rl.stroke) || "#0e0f0c",
        width: +rl.width > 0 ? +rl.width : 2,
        arrow: rl.arrow !== false,
      },
    };
    state.nodes.push(lineNode);
    newIds.add(lineNode.id);

    if (rl.label && typeof rl.label === "string") {
      const fromN = fromEntry.node, toN = toEntry.node;
      const fs    = fromEntry.size || { w: 240, h: 60 };
      const ts    = toEntry.size   || { w: 240, h: 60 };
      const fcx = fromN.x + fs.w / 2;
      const fcy = fromN.y + fs.h / 2;
      const tcx = toN.x + ts.w / 2;
      const tcy = toN.y + ts.h / 2;
      const dx = tcx - fcx, dy = tcy - fcy;
      const L  = Math.hypot(dx, dy) || 1;
      // Perpendicular unit vector — pushes the label sideways from the arrow.
      const px = -dy / L, py = dx / L;
      const off = 16;
      const labelW = 140, labelH = 24;
      const cx = (fcx + tcx) / 2 + px * off - labelW / 2;
      const cy = (fcy + tcy) / 2 + py * off - labelH / 2;
      const labelNode = {
        id: uid(), type: "text",
        x: Math.round(cx), y: Math.round(cy),
        w: labelW, z: z++,
        content: rl.label,
        style: {
          ...TEXT_PRESETS.body.style,
          fontSize: 12,
          color: "#6b6e68",
          bg: "#ffffff",
          align: "center",
          radius: 6,
          borderWidth: 1,
          borderColor: "#e6e6e0",
        },
      };
      state.nodes.push(labelNode);
      newIds.add(labelNode.id);
      extraNodes.push(labelNode);
    }
  }

  // Pass 5.5 — smart positioning. Skipped in merge mode so existing nodes don't shift.
  if (!mergeMode) resolveOverlaps(allCreated, sizes, groups, extraNodes);

  // Cascade per-branch colors so each main branch reads as a coloured "tree".
  if (!mergeMode) cascadeBranchColors(allCreated, groups, idMap);

  // MERGE MODE — process top-level "remove" / "delete" id lists.
  if (mergeMode) {
    const removeRaw = Array.isArray(data.remove) ? data.remove
                    : Array.isArray(data.delete) ? data.delete
                    : [];
    if (removeRaw.length) {
      const killAi = new Set(removeRaw.map((s) => String(s)));
      const killInternal = new Set();
      for (const aid of killAi) {
        if (existingById.has(aid)) killInternal.add(existingById.get(aid).id);
      }
      if (killInternal.size) {
        state.nodes = state.nodes.filter((n) => {
          if (killInternal.has(n.id)) return false;
          if (n.type === "line" && (killInternal.has(n.fromId) || killInternal.has(n.toId))) return false;
          return true;
        });
      }
    }
  }

  state.selectedIds = newIds;
  render(); save();
  return { ok: true, count: allCreated.length, sections: groups.length, merged: mergeMode };
}

// ============================================================
// Layouts — recursive per-branch system + radial/grid specials
// ============================================================
function applyLayout(layoutType, nodesByAi, rawLinks, sizes, center) {
  switch (layoutType) {
    case "radial":         return layoutRadial(nodesByAi, rawLinks, sizes, center);
    case "grid":           return layoutGrid(nodesByAi, sizes, center);
    case "tree":           return layoutBranches(nodesByAi, rawLinks, sizes, center, "top-down");
    case "flow":           return layoutBranches(nodesByAi, rawLinks, sizes, center, "horizontal-row");
    case "bilateral":      return layoutBranches(nodesByAi, rawLinks, sizes, center, "bilateral");
    case "right-fan":
    case "left-fan":
    case "top-down":
    case "bottom-up":
    case "horizontal-row": return layoutBranches(nodesByAi, rawLinks, sizes, center, layoutType);
    case "quadrant":       return layoutBranches(nodesByAi, rawLinks, sizes, center, "quadrant");
    case "mindmap":
    default:               return layoutBranches(nodesByAi, rawLinks, sizes, center, "quadrant");
  }
}

// Per-node branch layout. Each node decides how its OWN children stack;
// children inherit `branchLayout` from their parent if they don't set it
// themselves. Subtree bboxes are computed bottom-up so siblings never overlap.
function layoutBranches(nodesByAi, rawLinks, sizes, center, defaultBranchLayout) {
  const ids = Array.from(nodesByAi.keys());
  if (!ids.length) return;
  const childMap = new Map(), inDeg = new Map(), outDeg = new Map();
  for (const id of ids) { childMap.set(id, []); inDeg.set(id, 0); outDeg.set(id, 0); }
  for (const l of rawLinks) {
    const f = String(l.from ?? l.source ?? l.a ?? "");
    const t = String(l.to   ?? l.target ?? l.b ?? "");
    if (!nodesByAi.has(f) || !nodesByAi.has(t) || f === t) continue;
    if (!childMap.get(f).includes(t)) {
      childMap.get(f).push(t);
      outDeg.set(f, outDeg.get(f) + 1);
      inDeg.set(t, inDeg.get(t) + 1);
    }
  }
  // Pick root: highest out-degree, fall back to in-degree, then first id.
  let root = ids[0], best = -1;
  for (const id of ids) { const d = outDeg.get(id); if (d > best) { best = d; root = id; } }
  if (best <= 0) {
    let bin = -1;
    for (const id of ids) { const d = inDeg.get(id); if (d > bin) { bin = d; root = id; } }
  }
  // BFS spanning tree (one parent per node).
  const parent = new Map([[root, null]]);
  const tree = new Map(ids.map((id) => [id, []]));
  const queue = [root];
  while (queue.length) {
    const id = queue.shift();
    for (const c of childMap.get(id) || []) {
      if (parent.has(c)) continue;
      parent.set(c, id);
      tree.get(id).push(c);
      queue.push(c);
    }
  }
  for (const id of ids) if (!parent.has(id)) { parent.set(id, root); tree.get(root).push(id); }

  const sz = (id) => sizes.get(id) || { w: 240, h: 60 };
  const eff = (id, parentEff) => {
    const n = nodesByAi.get(id);
    if (n && BRANCH_LAYOUTS.has(n.branchLayout)) return n.branchLayout;
    return parentEff || defaultBranchLayout || "right-fan";
  };

  const rootSize = sz(root);
  const rootNode = nodesByAi.get(root);
  if (rootNode.x == null) rootNode.x = Math.round(center.x - rootSize.w / 2);
  if (rootNode.y == null) rootNode.y = Math.round(center.y - rootSize.h / 2);

  // Spacing constants — balanced: enough breathing room without sprawl.
  const SIB = 40, PARENT_GAP = 130, ROW_GAP = 150, CELL = 50;

  // Place a single child + recurse into its subtree. Returns its full bbox.
  const place = (id, x, y, parentEff) => {
    const n = nodesByAi.get(id);
    const s = sz(id);
    if (n.x == null) n.x = Math.round(x);
    if (n.y == null) n.y = Math.round(y);
    const myEff = eff(id, parentEff);
    const kids = tree.get(id) || [];
    const selfBox = { minX: n.x, minY: n.y, maxX: n.x + s.w, maxY: n.y + s.h };
    if (!kids.length) return selfBox;
    const childBox = placeChildren(id, kids, myEff);
    return {
      minX: Math.min(selfBox.minX, childBox.minX),
      minY: Math.min(selfBox.minY, childBox.minY),
      maxX: Math.max(selfBox.maxX, childBox.maxX),
      maxY: Math.max(selfBox.maxY, childBox.maxY),
    };
  };

  // Translate every node in the listed subtrees by (dx,dy). Skips _explicitX/Y.
  function shiftSubtrees(rootIds, dx, dy) {
    const dfs = (id) => {
      const n = nodesByAi.get(id);
      if (n && n._explicitX == null && n.x != null) n.x = Math.round(n.x + dx);
      if (n && n._explicitY == null && n.y != null) n.y = Math.round(n.y + dy);
      for (const c of tree.get(id) || []) dfs(c);
    };
    for (const id of rootIds) dfs(id);
  }
  const unionShift = (b, dx, dy) => ({
    minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy,
  });
  const subtreeLeafCount = (id) => {
    const k = tree.get(id) || [];
    if (!k.length) return 1;
    let s = 0; for (const c of k) s += subtreeLeafCount(c);
    return s;
  };

  // Lay out a parent's direct children + their subtrees according to parentEff.
  function placeChildren(parentId, kids, parentEff) {
    const p = nodesByAi.get(parentId);
    const ps = sz(parentId);
    const pcx = p.x + ps.w / 2;
    const pcy = p.y + ps.h / 2;
    const layout = parentEff;
    const boxes = [];

    const stackVertical = (kidList, side, childEff) => {
      const inherit = childEff || parentEff;
      let cursorY = p.y;
      const placed = [];
      for (let i = 0; i < kidList.length; i++) {
        const id = kidList[i];
        const s = sz(id);
        const x = side > 0 ? p.x + ps.w + PARENT_GAP : p.x - PARENT_GAP - s.w;
        let box = place(id, x, cursorY, inherit);
        // Pull subtree DOWN so its top edge aligns with cursorY — kids' children
        // (vertically centered on their own parent) won't overflow up and crash
        // into the previous sibling's subtree.
        if (box.minY < cursorY) {
          const dy = cursorY - box.minY;
          shiftSubtrees([id], 0, dy);
          box = unionShift(box, 0, dy);
        }
        placed.push({ id, box });
        cursorY = box.maxY + SIB;
      }
      const totalH = cursorY - SIB - p.y;
      const shift = pcy - (p.y + totalH / 2);
      if (Math.abs(shift) > 0.5) shiftSubtrees(placed.map((x) => x.id), 0, shift);
      for (const pl of placed) boxes.push(unionShift(pl.box, 0, shift));
    };

    const stackHorizontal = (kidList, vside, childEff) => {
      const inherit = childEff || parentEff;
      let cursorX = p.x;
      const placed = [];
      for (let i = 0; i < kidList.length; i++) {
        const id = kidList[i];
        const s = sz(id);
        const y = vside > 0 ? p.y + ps.h + PARENT_GAP : p.y - PARENT_GAP - s.h;
        let box = place(id, cursorX, y, inherit);
        if (box.minX < cursorX) {
          const dx = cursorX - box.minX;
          shiftSubtrees([id], dx, 0);
          box = unionShift(box, dx, 0);
        }
        placed.push({ id, box });
        cursorX = box.maxX + SIB;
      }
      const totalW = cursorX - SIB - p.x;
      const shift = pcx - (p.x + totalW / 2);
      if (Math.abs(shift) > 0.5) shiftSubtrees(placed.map((x) => x.id), shift, 0);
      for (const pl of placed) boxes.push(unionShift(pl.box, shift, 0));
    };

    if (layout === "right-fan")          stackVertical(kids, +1);
    else if (layout === "left-fan")      stackVertical(kids, -1);
    else if (layout === "top-down")      stackHorizontal(kids, +1);
    else if (layout === "bottom-up")     stackHorizontal(kids, -1);
    else if (layout === "horizontal-row") {
      let cursorX = p.x + ps.w + ROW_GAP;
      const placed = [];
      for (let i = 0; i < kids.length; i++) {
        const id = kids[i], s = sz(id);
        const y = pcy - s.h / 2;
        const box = place(id, cursorX, y, parentEff);
        placed.push({ id, box });
        cursorX = box.maxX + SIB;
      }
      for (const pl of placed) boxes.push(pl.box);
    } else if (layout === "grid") {
      const cols = Math.max(2, Math.ceil(Math.sqrt(kids.length)));
      const cellW = Math.max(...kids.map((id) => sz(id).w));
      const cellH = Math.max(...kids.map((id) => sz(id).h));
      const totalW = cols * cellW + (cols - 1) * CELL;
      const x0 = pcx - totalW / 2;
      const y0 = p.y + ps.h + PARENT_GAP;
      for (let i = 0; i < kids.length; i++) {
        const r = Math.floor(i / cols), c = i % cols;
        const id = kids[i], s = sz(id);
        const x = x0 + c * (cellW + CELL) + (cellW - s.w) / 2;
        const y = y0 + r * (cellH + CELL);
        boxes.push(place(id, x, y, parentEff));
      }
    } else if (layout === "bilateral") {
      // Split children by subtree size to balance left/right.
      const sized = kids.map((id) => ({ id, w: subtreeLeafCount(id) }));
      sized.sort((a, b) => b.w - a.w);
      const right = [], left = [];
      let rW = 0, lW = 0;
      for (const it of sized) {
        if (rW <= lW) { right.push(it.id); rW += it.w; }
        else          { left.push(it.id);  lW += it.w; }
      }
      if (right.length) stackVertical(right, +1);
      if (left.length)  stackVertical(left,  -1);
    } else if (layout === "quadrant") {
      // True 4-direction mind-map: split children into right / left / down / up
      // by subtree weight so visual mass stays balanced. Each subtree then grows
      // CONSISTENTLY in its assigned direction (right children fan further right,
      // top children stack further up, etc.) so branches never collide head-on.
      const sized = kids.map((id) => ({ id, w: subtreeLeafCount(id) }));
      sized.sort((a, b) => b.w - a.w);
      const dirs = [
        { key: "right", child: "right-fan", arr: [], w: 0 },
        { key: "left",  child: "left-fan",  arr: [], w: 0 },
        { key: "down",  child: "top-down",  arr: [], w: 0 },
        { key: "up",    child: "bottom-up", arr: [], w: 0 },
      ];
      for (const it of sized) {
        // Greedy: drop each subtree into whichever direction has the lightest weight.
        let lightest = dirs[0];
        for (const d of dirs) if (d.w < lightest.w) lightest = d;
        lightest.arr.push(it.id);
        lightest.w += it.w;
      }
      for (const d of dirs) {
        if (!d.arr.length) continue;
        if (d.key === "right") stackVertical(d.arr,   +1, d.child);
        if (d.key === "left")  stackVertical(d.arr,   -1, d.child);
        if (d.key === "down")  stackHorizontal(d.arr, +1, d.child);
        if (d.key === "up")    stackHorizontal(d.arr, -1, d.child);
      }
    } else {
      // Unknown layout — fall back to right-fan
      stackVertical(kids, +1);
    }

    if (!boxes.length) return { minX: p.x, minY: p.y, maxX: p.x + ps.w, maxY: p.y + ps.h };
    return boxes.reduce((u, b) => ({
      minX: Math.min(u.minX, b.minX), minY: Math.min(u.minY, b.minY),
      maxX: Math.max(u.maxX, b.maxX), maxY: Math.max(u.maxY, b.maxY),
    }));
  }

  const rootKids = tree.get(root) || [];
  if (rootKids.length) placeChildren(root, rootKids, eff(root, defaultBranchLayout));
}

// Radial: highest-degree node in the middle, neighbours in concentric rings
function layoutRadial(nodesByAi, rawLinks, sizes, center) {
  const ids = Array.from(nodesByAi.keys());
  const adj = new Map();
  for (const id of ids) adj.set(id, new Set());
  for (const l of rawLinks) {
    const f = String(l.from ?? l.source ?? l.a ?? "");
    const t = String(l.to   ?? l.target ?? l.b ?? "");
    if (!nodesByAi.has(f) || !nodesByAi.has(t) || f === t) continue;
    adj.get(f).add(t); adj.get(t).add(f);
  }

  let hub = ids[0], maxDeg = -1;
  for (const id of ids) {
    const d = adj.get(id).size;
    if (d > maxDeg) { maxDeg = d; hub = id; }
  }

  const placed = new Set([hub]);
  const layers = [[hub]];
  let frontier = [hub];
  while (frontier.length) {
    const seen = new Set();
    const next = [];
    for (const id of frontier) {
      for (const n of adj.get(id)) {
        if (!placed.has(n) && !seen.has(n)) { seen.add(n); next.push(n); }
      }
    }
    if (!next.length) break;
    for (const id of next) placed.add(id);
    layers.push(next);
    frontier = next;
  }
  const leftover = ids.filter((id) => !placed.has(id));
  if (leftover.length) layers.push(leftover);

  const hubSize = sizes.get(hub) || { w: 240, h: 60 };
  const hubNode = nodesByAi.get(hub);
  if (hubNode.x == null) hubNode.x = Math.round(center.x - hubSize.w / 2);
  if (hubNode.y == null) hubNode.y = Math.round(center.y - hubSize.h / 2);

  for (let li = 1; li < layers.length; li++) {
    const row = layers[li];
    const maxNodeW = Math.max(...row.map((id) => sizes.get(id)?.w || 240));
    const maxNodeH = Math.max(...row.map((id) => sizes.get(id)?.h || 60));
    const safeStep = Math.max(maxNodeW, maxNodeH) + 24;
    const minR = li * 110 + Math.max(hubSize.w, hubSize.h) / 2 + Math.max(maxNodeW, maxNodeH) / 2;
    const ringCap = minR * 1.6;
    const needed = Math.min(ringCap, (row.length * safeStep) / (2 * Math.PI));
    const radius = Math.max(minR, needed);
    const angleStep = (Math.PI * 2) / row.length;
    const startAngle = -Math.PI / 2;
    for (let i = 0; i < row.length; i++) {
      const id = row[i];
      const node = nodesByAi.get(id);
      if (!node) continue;
      const ang = startAngle + i * angleStep;
      const w = sizes.get(id)?.w || 240;
      const h = sizes.get(id)?.h || 60;
      if (node.x == null) node.x = Math.round(center.x + Math.cos(ang) * radius - w / 2);
      if (node.y == null) node.y = Math.round(center.y + Math.sin(ang) * radius - h / 2);
    }
  }
}

// Grid: pack nodes in a roughly-square grid, ignoring the link graph
function layoutGrid(nodesByAi, sizes, center) {
  const ids = Array.from(nodesByAi.keys());
  const n = ids.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const colW = Math.max(...ids.map((id) => sizes.get(id)?.w || 240)) + 28;
  const rowH = Math.max(...ids.map((id) => sizes.get(id)?.h || 60)) + 32;
  const totalW = cols * colW;
  const totalH = rows * rowH;
  const startX = center.x - totalW / 2 + colW / 2;
  const startY = center.y - totalH / 2 + rowH / 2;
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    const node = nodesByAi.get(id);
    if (!node) continue;
    const r = Math.floor(i / cols), c = i % cols;
    const w = sizes.get(id)?.w || 240;
    const h = sizes.get(id)?.h || 60;
    if (node.x == null) node.x = Math.round(startX + c * colW - w / 2);
    if (node.y == null) node.y = Math.round(startY + r * rowH - h / 2);
  }
}

// Smart positioning: small AABB-collision iterations push overlapping nodes
// apart along the shorter overlap axis. Cheap, deterministic, organic.
// Accepts extraNodes (titles + link labels) so they participate in de-collision.
function resolveOverlaps(allCreated, sizes, groups, extraNodes) {
  const sizeByNodeId = new Map();
  if (groups) {
    for (const g of groups) for (const [aiId, n] of g.nodesByAi) {
      sizeByNodeId.set(n.id, sizes.get(aiId) || { w: n.w || 240, h: 60 });
    }
  }
  // Best-effort size for nodes not in the AI sizing pass: titles, link labels,
  // generic text. DOM-measure if possible; fall back to heuristics.
  const sizeOf = (n) => {
    const cached = sizeByNodeId.get(n.id);
    if (cached) return cached;
    let w, h;
    if (n.type === "text" && n.style && n.style.fontSize >= 22) {
      w = Math.max(280, n.w || 0); h = 40;             // section-title-ish heading
    } else if (n.type === "text" && n.w && n.w <= 180) {
      w = n.w || 140;                                  // link label
      h = (n.style && n.style.fontSize ? n.style.fontSize + 12 : 24);
    } else if (n.type === "text") {
      try {
        const el = (typeof canvas !== "undefined" && canvas && canvas.querySelector)
          ? canvas.querySelector(`[data-id="${n.id}"]`) : null;
        if (el) { const r = el.getBoundingClientRect(); w = r.width; h = r.height; }
      } catch (_) { /* ignore */ }
      if (!w || !h) { w = n.w || 240; h = 60; }
    } else {
      w = n.w || 240; h = 60;
    }
    const sz = { w, h };
    sizeByNodeId.set(n.id, sz);
    return sz;
  };

  const list = extraNodes && extraNodes.length
    ? allCreated.concat(extraNodes.filter((n) => !allCreated.includes(n)))
    : allCreated;

  const PAD = 12;
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    const damp = pass === 0 ? 0.5 : 0.3;  // first pass full half-push; later passes dampened
    for (let i = 0; i < list.length; i++) {
      const a = list[i]; if (a.x == null || a.y == null) continue;
      const sa = sizeOf(a);
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]; if (b.x == null || b.y == null) continue;
        const sb = sizeOf(b);
        const ovX = Math.min(a.x + sa.w + PAD, b.x + sb.w + PAD) - Math.max(a.x - PAD, b.x - PAD);
        const ovY = Math.min(a.y + sa.h + PAD, b.y + sb.h + PAD) - Math.max(a.y - PAD, b.y - PAD);
        if (ovX <= 0 || ovY <= 0) continue;
        if (ovX < ovY) {
          const push = ovX * damp; const dir = (a.x < b.x) ? -1 : 1;
          a.x = Math.round(a.x + dir * push); b.x = Math.round(b.x - dir * push);
        } else {
          const push = ovY * damp; const dir = (a.y < b.y) ? -1 : 1;
          a.y = Math.round(a.y + dir * push); b.y = Math.round(b.y - dir * push);
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

// ============================================================
// Cursor tracking + add-at-point helpers
// ============================================================
// Last known mouse position in client (screen) coords.
// Used so keyboard shortcuts create nodes where the cursor actually is.
let cursorScreen = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
window.addEventListener("mousemove", (e) => {
  cursorScreen = { x: e.clientX, y: e.clientY };
});
function cursorCanvas() {
  return screenToCanvas(cursorScreen.x, cursorScreen.y);
}

function addLineNodeAt(x, y) {
  const node = {
    id: uid(), type: "line", z: nextZ(),
    fromId: null, toId: null,
    x1: Math.round(x - 70), y1: Math.round(y),
    x2: Math.round(x + 70), y2: Math.round(y),
    style: { stroke: "#0e0f0c", width: 2, arrow: true },
  };
  state.nodes.push(node);
  state.selectedIds = new Set([node.id]);
  render(); save();
}

// Pending position for image picker — used because the file dialog interrupts
// cursor tracking, so we capture where the user wanted the image at trigger time.
let pendingImagePos = null;
function triggerImageAt(x, y) {
  pendingImagePos = { x, y };
  imageInput.click();
}

// Run the action requested from either context menu or keyboard shortcut.
function createNodeAt(action, variant, x, y) {
  if (action === "text") {
    addTextNode(variant || "body", x, y);
  } else if (action === "image") {
    // Pre-fill the cursor anchor and open the image modal so the user can
    // pick URL or file. The modal preserves position via consumeCursorAnchor.
    pendingNodePos = { x, y };
    openImageModal();
  } else if (action === "line") {
    addLineNodeAt(x, y);
  } else if (action === "paper") {
    pendingNodePos = { x, y };
    openPaperModal();
  } else if (action === "emoji") {
    pendingNodePos = { x, y };
    // Open the emoji popover anchored to the emoji tool button
    document.getElementById("tool-emoji").click();
  }
}

// ============================================================
// Shortcut bindings (customizable, persisted)
// ============================================================
const SHORTCUT_KEY = "whiteboard.shortcuts.v1";
const SHORTCUT_LABELS = {
  text:    "Text",
  heading: "Heading",
  sticky:  "Sticky note",
  paper:   "Paper note",
  emoji:   "Emoji / icon",
  image:   "Image",
  line:    "Line",
  front:   "Bring to front",
  back:    "Send to back",
};
const SHORTCUT_DEFAULTS = {
  text: "t", heading: "h", sticky: "s", paper: "p", emoji: "e", image: "i", line: "l",
  front: "Shift+ArrowUp",
  back:  "Shift+ArrowDown",
};
const SHORTCUT_TO_ACTION = {
  text:    { action: "text",   variant: "body" },
  heading: { action: "text",   variant: "heading" },
  sticky:  { action: "text",   variant: "sticky" },
  paper:   { action: "paper" },
  emoji:   { action: "emoji" },
  image:   { action: "image" },
  line:    { action: "line" },
  front:   { action: "front" },
  back:    { action: "back" },
};
// Operations that don't need a cursor position (act on the existing selection).
const SHORTCUT_OPS_WITHOUT_POSITION = new Set(["front", "back"]);
let shortcuts = { ...SHORTCUT_DEFAULTS };
function loadShortcuts() {
  try {
    const raw = localStorage.getItem(SHORTCUT_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      shortcuts = { ...SHORTCUT_DEFAULTS, ...data };
    }
  } catch (_) {}
}
function saveShortcuts() {
  try { localStorage.setItem(SHORTCUT_KEY, JSON.stringify(shortcuts)); } catch (_) {}
}
// Build the canonical combo string for a key event.
//   - modifiers in fixed order: Ctrl, Alt, Shift
//   - single character keys are lowercased  ("t")
//   - named keys (ArrowUp, Enter, …) keep their original casing
//   - bare modifier presses (just Shift, Ctrl, etc.) return null
function eventToCombo(e) {
  const k = e.key;
  if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(k.length === 1 ? k.toLowerCase() : k);
  return parts.join("+");
}
function normalizeCombo(c) {
  if (!c) return "";
  // Keep parts as-is, just trim spaces and lowercase single-character parts.
  return c.split("+").map((p) => p.trim()).filter(Boolean)
    .map((p) => p.length === 1 ? p.toLowerCase() : p)
    .join("+");
}
// Render a stored combo as a friendly label for chips and the help popover.
function formatComboLabel(combo) {
  if (!combo) return "—";
  const map = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
  return combo.split("+").map((p) => map[p] || (p.length === 1 ? p.toUpperCase() : p)).join(" + ");
}
function lookupShortcut(combo) {
  const target = normalizeCombo(combo);
  if (!target) return null;
  for (const id of Object.keys(shortcuts)) {
    if (normalizeCombo(shortcuts[id]) === target) return id;
  }
  return null;
}
function refreshShortcutHints() {
  // Update context menu kbd hints (only nodes with single-key shortcuts;
  // combo bindings like "Shift+ArrowUp" still render but in the formatted form)
  for (const el of ctxMenu.querySelectorAll("[data-key-for]")) {
    el.textContent = formatComboLabel(shortcuts[el.dataset.keyFor]);
  }
  // Update help popover kbd hints
  for (const el of helpPop.querySelectorAll("[data-help-key]")) {
    el.textContent = formatComboLabel(shortcuts[el.dataset.helpKey]);
  }
}

// ============================================================
// Right-click context menu
// ============================================================
function showContextMenu(clientX, clientY) {
  ctxMenu.hidden = false;
  // Measure then clamp to viewport
  const w = ctxMenu.offsetWidth || 220;
  const h = ctxMenu.offsetHeight || 220;
  let left = clientX, top = clientY;
  left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
  top = Math.max(8, Math.min(window.innerHeight - h - 8, top));
  ctxMenu.style.left = left + "px";
  ctxMenu.style.top = top + "px";
  ctxMenu.dataset.cx = clientX;
  ctxMenu.dataset.cy = clientY;
}
function hideContextMenu() { ctxMenu.hidden = true; }

board.addEventListener("contextmenu", (e) => {
  // Only intercept right-clicks on the board background, not on nodes.
  const onNode = e.target.closest && e.target.closest(".node");
  if (onNode) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY);
});

ctxMenu.addEventListener("click", (e) => {
  const item = e.target.closest(".ctx-item");
  if (!item) return;
  const action = item.dataset.action;
  const variant = item.dataset.variant;
  const cx = +ctxMenu.dataset.cx;
  const cy = +ctxMenu.dataset.cy;
  hideContextMenu();
  const p = screenToCanvas(cx, cy);
  createNodeAt(action, variant, p.x, p.y);
});
// Close menu on outside click / escape / scroll
document.addEventListener("mousedown", (e) => {
  if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) hideContextMenu();
}, true);
window.addEventListener("blur", hideContextMenu);
window.addEventListener("wheel", () => { if (!ctxMenu.hidden) hideContextMenu(); }, { passive: true });

// ============================================================
// Settings popover (rebind shortcuts)
// ============================================================
const shortcutRowsEl = document.getElementById("shortcut-rows");
let listeningRow = null; // currently rebinding row id

function buildShortcutRows() {
  shortcutRowsEl.innerHTML = "";
  for (const id of Object.keys(SHORTCUT_DEFAULTS)) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    row.dataset.id = id;

    const label = document.createElement("span");
    label.className = "sr-label";
    label.textContent = SHORTCUT_LABELS[id];

    const key = document.createElement("button");
    key.className = "sr-key";
    key.type = "button";
    key.textContent = formatComboLabel(shortcuts[id]);
    key.title = "Click, then press a key (or modifier + key, e.g. Shift+↑)";
    key.addEventListener("click", () => startRebind(id));

    row.appendChild(label);
    row.appendChild(key);
    shortcutRowsEl.appendChild(row);
  }
}
function refreshShortcutRows() {
  for (const row of shortcutRowsEl.querySelectorAll(".shortcut-row")) {
    const id = row.dataset.id;
    const key = row.querySelector(".sr-key");
    key.textContent = listeningRow === id ? "Press keys…" : formatComboLabel(shortcuts[id]);
    key.classList.toggle("listening", listeningRow === id);
  }
}
function startRebind(id) {
  listeningRow = id;
  refreshShortcutRows();
}
function applyRebind(id, newKey) {
  // Strip duplicate bindings on other rows
  for (const other of Object.keys(shortcuts)) {
    if (other !== id && (shortcuts[other] || "").toLowerCase() === newKey) {
      shortcuts[other] = "";
    }
  }
  shortcuts[id] = newKey;
  saveShortcuts();
  listeningRow = null;
  refreshShortcutRows();
  refreshShortcutHints();
}
// Capture key while listening (use capture phase so it beats other handlers).
// Accepts both single keys ("t") and combos ("Shift+ArrowUp", "Ctrl+/").
window.addEventListener("keydown", (e) => {
  if (!listeningRow) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") { listeningRow = null; refreshShortcutRows(); return; }
  const combo = eventToCombo(e);
  if (!combo) return; // bare modifier press — wait for the actual key
  applyRebind(listeningRow, combo);
}, true);

document.getElementById("btn-settings").addEventListener("click", (e) => {
  e.stopPropagation();
  if (settingsPop.hidden) {
    buildShortcutRows();
    settingsPop.hidden = false;
    const r = e.currentTarget.getBoundingClientRect();
    const w = settingsPop.offsetWidth || 300;
    const h = settingsPop.offsetHeight || 300;
    let left = r.right - w;
    let top = r.top - h - 10;
    if (top < 10) top = r.bottom + 10;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    settingsPop.style.left = left + "px";
    settingsPop.style.top = top + "px";
  } else {
    closePopover(settingsPop);
    listeningRow = null;
  }
});
document.getElementById("btn-shortcuts-reset").addEventListener("click", () => {
  shortcuts = { ...SHORTCUT_DEFAULTS };
  saveShortcuts();
  listeningRow = null;
  refreshShortcutRows();
  refreshShortcutHints();
});
// Close settings popover on outside click
document.addEventListener("mousedown", (e) => {
  if (!settingsPop.hidden && !settingsPop.contains(e.target) && !document.getElementById("btn-settings").contains(e.target)) {
    closePopover(settingsPop);
    listeningRow = null;
    refreshShortcutRows();
  }
});

// ============================================================
// Keyboard: shortcut dispatch.
// Runs in CAPTURE phase so a matched binding beats other window keydown
// handlers (the arrow-nudge handler in particular). Single-key shortcuts
// like "t" still work; combo shortcuts like "Shift+ArrowUp" also work.
// ============================================================
window.addEventListener("keydown", (e) => {
  if (listeningRow) return; // rebind handler owns the keystroke
  const tag = (e.target && e.target.tagName) || "";
  const editable = e.target && e.target.isContentEditable;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || editable) return;

  const combo = eventToCombo(e);
  if (!combo) return; // bare modifier press
  const id = lookupShortcut(combo);
  if (!id) return;

  // Stop other handlers from also acting on this key (e.g. the arrow-nudge
  // handler shouldn't fire when Shift+ArrowUp is bound to "Bring to front").
  e.preventDefault();
  e.stopPropagation();
  hideContextMenu();

  const map = SHORTCUT_TO_ACTION[id];
  if (map.action === "front") return bringSelectionToFront();
  if (map.action === "back")  return sendSelectionToBack();
  // Node-creation actions place at cursor.
  const p = cursorCanvas();
  createNodeAt(map.action, map.variant, p.x, p.y);
}, true);

// ============================================================
// Shape nodes (preset modern shapes — color + roundness only)
// ============================================================
// Curated modern palette — Tailwind 200/300 stops. Pleasing on a warm canvas.
const SHAPE_PALETTE = [
  // Row 1 — neutrals
  { name: "White",    value: "#ffffff" },
  { name: "Slate",    value: "#e2e8f0" },
  { name: "Stone",    value: "#e7e5e4" },
  { name: "Charcoal", value: "#1f2937" },
  // Row 2 — cool
  { name: "Sky",      value: "#bae6fd" },
  { name: "Indigo",   value: "#c7d2fe" },
  { name: "Violet",   value: "#ddd6fe" },
  { name: "Pink",     value: "#fbcfe8" },
  // Row 3 — fresh
  { name: "Emerald",  value: "#a7f3d0" },
  { name: "Lime",     value: "#d9f99d" },
  { name: "Teal",     value: "#99f6e4" },
  { name: "Mint",     value: "#bbf7d0" },
  // Row 4 — warm
  { name: "Yellow",   value: "#fef08a" },
  { name: "Amber",    value: "#fde68a" },
  { name: "Orange",   value: "#fed7aa" },
  { name: "Rose",     value: "#fecdd3" },
];
const SHAPE_DEFAULT_COLOR = "#e2e8f0"; // slate-200 — clean, neutral
// Each shape lands in a different tasteful color so a fresh board feels alive.
const SHAPE_CATALOG = [
  { kind: "rect",          name: "Rectangle",     w: 220, h: 120, color: "#e2e8f0" }, // slate
  { kind: "pill",          name: "Pill",          w: 220, h: 80,  color: "#bae6fd" }, // sky
  { kind: "circle",        name: "Circle",        w: 160, h: 160, color: "#c7d2fe" }, // indigo
  { kind: "diamond",       name: "Diamond",       w: 180, h: 160, color: "#ddd6fe" }, // violet
  { kind: "triangle",      name: "Triangle",      w: 180, h: 160, color: "#fde68a" }, // amber
  { kind: "hexagon",       name: "Hexagon",       w: 200, h: 160, color: "#a7f3d0" }, // emerald
  { kind: "parallelogram", name: "Parallelogram", w: 220, h: 120, color: "#fecdd3" }, // rose
  { kind: "cylinder",      name: "Cylinder",      w: 180, h: 140, color: "#e7e5e4" }, // stone
];

// Color helpers
function _hexToRgb(hex) {
  const h = String(hex || "#e2e8f0").trim().replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0").slice(0, 6);
  const n = parseInt(v, 16) | 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function _rgbToHex(r, g, b) {
  const t = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return "#" + t(r) + t(g) + t(b);
}
function shapeLighten(hex, amt) {
  const { r, g, b } = _hexToRgb(hex);
  return _rgbToHex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt);
}
function shapeDarken(hex, amt) {
  const { r, g, b } = _hexToRgb(hex);
  return _rgbToHex(r * (1 - amt), g * (1 - amt), b * (1 - amt));
}
// Perceived luminance of a hex color (0–1)
function colorLuminance(hex) {
  const { r, g, b } = _hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
// Subtle border that adapts: darker on light fills, lighter on dark fills
function shapeBorderColor(base) {
  return colorLuminance(base) < 0.4
    ? shapeLighten(base, 0.18)
    : shapeDarken(base, 0.09);
}

// Returns the SVG path `d` for a given shape (with `inset` so the stroke isn't clipped)
function shapePathData(kind, w, h, radius, inset) {
  const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
  const W = Math.max(0, x1 - x0), H = Math.max(0, y1 - y0);
  const round = (x, y, ww, hh, rr) => {
    rr = Math.max(0, Math.min(rr, ww / 2, hh / 2));
    return `M ${x + rr} ${y}
            H ${x + ww - rr}
            A ${rr} ${rr} 0 0 1 ${x + ww} ${y + rr}
            V ${y + hh - rr}
            A ${rr} ${rr} 0 0 1 ${x + ww - rr} ${y + hh}
            H ${x + rr}
            A ${rr} ${rr} 0 0 1 ${x} ${y + hh - rr}
            V ${y + rr}
            A ${rr} ${rr} 0 0 1 ${x + rr} ${y} Z`;
  };
  switch (kind) {
    case "rect":          return round(x0, y0, W, H, radius || 0);
    case "pill":          return round(x0, y0, W, H, H / 2);
    case "diamond":       return `M ${(x0 + x1) / 2} ${y0} L ${x1} ${(y0 + y1) / 2} L ${(x0 + x1) / 2} ${y1} L ${x0} ${(y0 + y1) / 2} Z`;
    case "triangle":      return `M ${(x0 + x1) / 2} ${y0} L ${x1} ${y1} L ${x0} ${y1} Z`;
    case "hexagon": {
      const ix = W * 0.25;
      return `M ${x0 + ix} ${y0} L ${x1 - ix} ${y0} L ${x1} ${(y0 + y1) / 2} L ${x1 - ix} ${y1} L ${x0 + ix} ${y1} L ${x0} ${(y0 + y1) / 2} Z`;
    }
    case "parallelogram": {
      const skew = W * 0.18;
      return `M ${x0 + skew} ${y0} L ${x1} ${y0} L ${x1 - skew} ${y1} L ${x0} ${y1} Z`;
    }
    default: return round(x0, y0, W, H, 16);
  }
}

// Re-build the SVG inside a shape node based on its current size + style.
// Modern flat fill + adaptive subtle border. Drop shadow comes from CSS.
function drawShapeSVG(el, node) {
  const w = node.w || 200, h = node.h || 120;
  const s = node.style || {};
  const base    = (s.bg && s.bg !== "transparent") ? s.bg : SHAPE_DEFAULT_COLOR;
  const outline = shapeBorderColor(base);
  const radius  = +s.radius >= 0 ? +s.radius : 14;
  const kind    = node.shape || "rect";
  const sw = 1;
  const inset = sw / 2;

  let svg = el.querySelector("svg.shape-vis");
  if (!svg) {
    svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "shape-vis");
    el.insertBefore(svg, el.firstChild);
  }
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const setAttrs = (node, attrs) => { for (const k in attrs) node.setAttribute(k, attrs[k]); };

  if (kind === "circle") {
    const ell = document.createElementNS(SVG_NS, "ellipse");
    setAttrs(ell, {
      cx: w / 2, cy: h / 2,
      rx: Math.max(0, w / 2 - inset),
      ry: Math.max(0, h / 2 - inset),
      fill: base, stroke: outline, "stroke-width": sw,
    });
    svg.appendChild(ell);
    return;
  }

  if (kind === "cylinder") {
    const ry = Math.min(h * 0.12, 22);
    const body = document.createElementNS(SVG_NS, "path");
    setAttrs(body, {
      d: `M ${inset} ${ry}
          A ${w / 2 - inset} ${ry} 0 0 1 ${w - inset} ${ry}
          V ${h - ry}
          A ${w / 2 - inset} ${ry} 0 0 1 ${inset} ${h - ry} Z`,
      fill: base, stroke: outline, "stroke-width": sw,
    });
    svg.appendChild(body);
    const cap = document.createElementNS(SVG_NS, "path");
    setAttrs(cap, {
      d: `M ${inset} ${ry}
          A ${w / 2 - inset} ${ry} 0 0 0 ${w - inset} ${ry}`,
      fill: "none", stroke: outline, "stroke-width": sw, opacity: "0.55",
    });
    svg.appendChild(cap);
    return;
  }

  const path = document.createElementNS(SVG_NS, "path");
  setAttrs(path, {
    d: shapePathData(kind, w, h, radius, inset),
    fill: base, stroke: outline, "stroke-width": sw,
    "stroke-linejoin": "round",
  });
  svg.appendChild(path);
}

// Draw a shape onto the export canvas (PNG)
function drawShapeOnCanvas(ctx, node, x, y, w, h) {
  const s = node.style || {};
  const base    = (s.bg && s.bg !== "transparent") ? s.bg : SHAPE_DEFAULT_COLOR;
  const outline = shapeBorderColor(base);
  const kind    = node.shape || "rect";
  const radius  = +s.radius >= 0 ? +s.radius : 14;
  const sw = 1;

  // Build a Path2D for the silhouette
  const p = new Path2D();
  if (kind === "circle") {
    p.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2 - sw / 2), Math.max(1, h / 2 - sw / 2), 0, 0, Math.PI * 2);
  } else if (kind === "cylinder") {
    const ry = Math.min(h * 0.12, 22);
    const cx = x + w / 2;
    p.moveTo(x, y + ry);
    p.ellipse(cx, y + ry, w / 2, ry, 0, Math.PI, 0, false);
    p.lineTo(x + w, y + h - ry);
    p.ellipse(cx, y + h - ry, w / 2, ry, 0, 0, Math.PI, false);
    p.closePath();
  } else if (kind === "rect" || kind === "pill") {
    const r = kind === "pill" ? h / 2 : Math.min(radius || 0, w / 2, h / 2);
    p.moveTo(x + r, y);
    p.lineTo(x + w - r, y);
    p.arcTo(x + w, y, x + w, y + r, r);
    p.lineTo(x + w, y + h - r);
    p.arcTo(x + w, y + h, x + w - r, y + h, r);
    p.lineTo(x + r, y + h);
    p.arcTo(x, y + h, x, y + h - r, r);
    p.lineTo(x, y + r);
    p.arcTo(x, y, x + r, y, r);
    p.closePath();
  } else if (kind === "diamond") {
    p.moveTo(x + w / 2, y);
    p.lineTo(x + w, y + h / 2);
    p.lineTo(x + w / 2, y + h);
    p.lineTo(x, y + h / 2);
    p.closePath();
  } else if (kind === "triangle") {
    p.moveTo(x + w / 2, y);
    p.lineTo(x + w, y + h);
    p.lineTo(x, y + h);
    p.closePath();
  } else if (kind === "hexagon") {
    const ix = w * 0.25;
    p.moveTo(x + ix, y);
    p.lineTo(x + w - ix, y);
    p.lineTo(x + w, y + h / 2);
    p.lineTo(x + w - ix, y + h);
    p.lineTo(x + ix, y + h);
    p.lineTo(x, y + h / 2);
    p.closePath();
  } else if (kind === "parallelogram") {
    const skew = w * 0.18;
    p.moveTo(x + skew, y);
    p.lineTo(x + w, y);
    p.lineTo(x + w - skew, y + h);
    p.lineTo(x, y + h);
    p.closePath();
  }

  // Soft drop shadow under the shape (matches the screen filter)
  ctx.save();
  ctx.shadowColor = "rgba(20,20,20,0.08)";
  ctx.shadowBlur = 12; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 4;

  // Flat fill — no gradient
  ctx.fillStyle = base;
  ctx.fill(p);
  ctx.restore();

  // Stroke
  ctx.strokeStyle = outline;
  ctx.lineWidth = sw;
  ctx.lineJoin = "round";
  ctx.stroke(p);

  // Cylinder cap line
  if (kind === "cylinder") {
    const ry = Math.min(h * 0.12, 22);
    const cx = x + w / 2;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.ellipse(cx, y + ry, w / 2, ry, 0, 0, Math.PI, false);
    ctx.strokeStyle = outline;
    ctx.lineWidth = sw;
    ctx.stroke();
    ctx.restore();
  }
}

// Add a new shape node at (x, y), centered. Uses the shape's tasteful default color.
function addShapeNode(kind, x, y) {
  const def = SHAPE_CATALOG.find((s) => s.kind === kind) || SHAPE_CATALOG[0];
  const node = {
    id: uid(), type: "shape", shape: def.kind,
    x: Math.round(x - def.w / 2),
    y: Math.round(y - def.h / 2),
    w: def.w, h: def.h, z: nextZ(),
    style: { bg: def.color || SHAPE_DEFAULT_COLOR, radius: 14 },
  };
  state.nodes.push(node);
  state.selectedIds = new Set([node.id]);
  render(); save();
  return node;
}

// ----- Shape picker popover (tool dock button → grid of shapes) -----
const shapePop = document.getElementById("shape-popover");
const shapeGrid = document.getElementById("shape-grid");
const shapeToolBtn = document.getElementById("tool-shape");

// Thumb uses the same flat-fill / subtle-border recipe as the rendered shape,
// in the shape's default color, so the picker previews the look you'll get.
function buildShapeThumb(kind, fill) {
  const W = 56, H = 40;
  const sw = 1;
  const inset = sw / 2;
  const stroke = shapeBorderColor(fill);
  if (kind === "circle") {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><ellipse cx="${W/2}" cy="${H/2}" rx="${W/2 - inset - 4}" ry="${H/2 - inset}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
  }
  if (kind === "cylinder") {
    const ry = H * 0.16;
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><path d="M ${inset} ${ry} A ${W/2 - inset} ${ry} 0 0 1 ${W - inset} ${ry} V ${H - ry} A ${W/2 - inset} ${ry} 0 0 1 ${inset} ${H - ry} Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/><path d="M ${inset} ${ry} A ${W/2 - inset} ${ry} 0 0 0 ${W - inset} ${ry}" fill="none" stroke="${stroke}" stroke-width="${sw}" opacity="0.55"/></svg>`;
  }
  const d = shapePathData(kind, W, H, kind === "rect" ? 6 : 0, inset);
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/></svg>`;
}

for (const def of SHAPE_CATALOG) {
  const btn = document.createElement("button");
  btn.className = "shape-pick";
  btn.title = def.name;
  btn.dataset.kind = def.kind;
  btn.innerHTML = buildShapeThumb(def.kind, def.color || SHAPE_DEFAULT_COLOR);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    closePopover(shapePop);
    const c = viewportCenter();
    addShapeNode(def.kind, c.x, c.y);
  });
  shapeGrid.appendChild(btn);
}

shapeToolBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (shapePop.hidden) {
    shapePop.hidden = false;
    positionPopoverNear(shapePop, shapeToolBtn);
    // Reposition above the dock instead of below
    const r = shapeToolBtn.getBoundingClientRect();
    const pw = shapePop.offsetWidth || 280;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(8, Math.min(window.innerWidth - pw - 8, left));
    shapePop.style.left = left + "px";
    shapePop.style.top = (r.top - shapePop.offsetHeight - 10) + "px";
  } else closePopover(shapePop);
});
document.addEventListener("mousedown", (e) => {
  if (!shapePop.hidden && !shapePop.contains(e.target) && !shapeToolBtn.contains(e.target)) closePopover(shapePop);
});

// ----- Float toolbar wiring (shape: fill color + roundness) -----
fEl.shapeFill        = document.getElementById("ft-shape-fill");
fEl.shapeFillSwatch  = document.getElementById("ft-shape-fill-swatch");
fEl.shapeRadius      = document.getElementById("ft-shape-radius");

// Build the dedicated shape-color popover with the curated modern palette.
const shapeColorPop = (() => {
  const pop = document.createElement("div");
  pop.id = "shape-color-popover";
  pop.className = "popover";
  pop.hidden = true;

  // Custom hex
  const row = document.createElement("div");
  row.className = "popover-row";
  const well = document.createElement("label");
  well.className = "ft-color-well solid";
  well.title = "Custom color";
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.id = "shape-color-input";
  const square = document.createElement("span");
  square.className = "ft-color-square";
  square.id = "shape-color-current";
  well.appendChild(colorInput); well.appendChild(square);
  const hint = document.createElement("span");
  hint.className = "popover-hint";
  hint.textContent = "Custom color";
  row.appendChild(well); row.appendChild(hint);
  pop.appendChild(row);

  // Curated palette grid
  const label = document.createElement("div");
  label.className = "popover-label";
  label.textContent = "Modern palette";
  pop.appendChild(label);

  const grid = document.createElement("div");
  grid.className = "shape-palette";
  for (const c of SHAPE_PALETTE) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "shape-palette-swatch";
    sw.title = c.name;
    sw.dataset.color = c.value;
    sw.style.background = c.value;
    sw.style.borderColor = shapeBorderColor(c.value);
    sw.addEventListener("click", () => {
      setStyle({ bg: c.value });
      refreshShapeColorPop();
    });
    grid.appendChild(sw);
  }
  pop.appendChild(grid);
  document.body.appendChild(pop);

  colorInput.addEventListener("input", () => {
    setStyle({ bg: colorInput.value });
    refreshShapeColorPop();
  });
  return pop;
})();

function refreshShapeColorPop() {
  const n = getPrimary(); if (!n) return;
  const cur = (n.style?.bg && n.style.bg !== "transparent") ? n.style.bg : SHAPE_DEFAULT_COLOR;
  const input = document.getElementById("shape-color-input");
  const square = document.getElementById("shape-color-current");
  if (input) input.value = cur;
  if (square) square.style.background = cur;
  shapeColorPop.querySelectorAll(".shape-palette-swatch").forEach((sw) => {
    sw.classList.toggle("active", sw.dataset.color.toLowerCase() === cur.toLowerCase());
  });
}

if (fEl.shapeFill) {
  fEl.shapeFill.addEventListener("click", (e) => {
    e.stopPropagation();
    if (shapeColorPop.hidden) {
      shapeColorPop.hidden = false;
      refreshShapeColorPop();
      positionPopoverNear(shapeColorPop, fEl.shapeFill);
    } else closePopover(shapeColorPop);
  });
}
document.addEventListener("mousedown", (e) => {
  if (!shapeColorPop.hidden &&
      !shapeColorPop.contains(e.target) &&
      !(fEl.shapeFill && fEl.shapeFill.contains(e.target))) {
    closePopover(shapeColorPop);
  }
});

if (fEl.shapeRadius) {
  fEl.shapeRadius.addEventListener("input", () => {
    setStyle({ radius: +fEl.shapeRadius.value });
  });
}

// ============================================================
// Init
// ============================================================
loadShortcuts();
refreshShortcutHints();
load();
render();
applyTransform();
pushHistory();
