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
  body:    { content: "Click to edit text", w: 240, style: { fontFamily: "Geist, system-ui, sans-serif", fontSize: 18, color: "#0e0f0c", bg: "transparent", bold: false, italic: false, underline: false, align: "left", radius: 12 } },
  heading: { content: "Heading",            w: 460, style: { fontFamily: "Geist, system-ui, sans-serif", fontSize: 44, color: "#0e0f0c", bg: "transparent", bold: true,  italic: false, underline: false, align: "left", radius: 12 } },
  sticky:  { content: "Sticky note",        w: 220, style: { fontFamily: "Geist, system-ui, sans-serif", fontSize: 17, color: "#2a2c28", bg: "#fdf3c7",     bold: false, italic: false, underline: false, align: "left", radius: 8 } },
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
  el.className = `node ${node.type}-node`;
  el.dataset.id = node.id;
  el.tabIndex = 0;
  if (node.type === "image") {
    const img = document.createElement("img");
    img.src = node.src; img.draggable = false; img.alt = "";
    el.appendChild(img);
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
  el.style.zIndex = node.z || 1;
  el.classList.toggle("selected", state.selectedIds.has(node.id));
  if (node.type === "text") {
    const s = node.style || {};
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
  } else if (node.type === "image") {
    const s = node.style || {};
    el.style.width = node.w + "px"; el.style.height = node.h + "px";
    el.style.maxWidth = "";
    el.style.borderRadius = (s.radius ?? 12) + "px";
    applyBorder(el, s);
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
  // Hit area (transparent thick)
  const hit = document.createElementNS(SVG_NS, "line");
  hit.setAttribute("class", "line-hit");
  // Visible line
  const vis = document.createElementNS(SVG_NS, "line");
  vis.setAttribute("class", "line-vis");
  vis.setAttribute("marker-end", `url(#arrow-${node.id})`);
  // Defs for arrow marker
  const defs = document.createElementNS(SVG_NS, "defs");
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", `arrow-${node.id}`);
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "8");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "6");
  marker.setAttribute("markerHeight", "6");
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
  const minX = Math.min(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxX = Math.max(p1.x, p2.x);
  const maxY = Math.max(p1.y, p2.y);
  const w = (maxX - minX) + LINE_PAD * 2;
  const h = (maxY - minY) + LINE_PAD * 2;

  el.style.left = (minX - LINE_PAD) + "px";
  el.style.top = (minY - LINE_PAD) + "px";
  el.style.width = w + "px";
  el.style.height = h + "px";
  el.style.zIndex = node.z || 1;
  el.classList.toggle("selected", state.selectedIds.has(node.id));

  const x1 = p1.x - minX + LINE_PAD;
  const y1 = p1.y - minY + LINE_PAD;
  const x2 = p2.x - minX + LINE_PAD;
  const y2 = p2.y - minY + LINE_PAD;

  const s = node.style || {};
  const stroke = s.stroke || "#0e0f0c";
  const width = s.width || 2;
  const arrow = s.arrow !== false;

  const hit = el.querySelector(".line-hit");
  hit.setAttribute("x1", x1); hit.setAttribute("y1", y1);
  hit.setAttribute("x2", x2); hit.setAttribute("y2", y2);

  const vis = el.querySelector(".line-vis");
  vis.setAttribute("x1", x1); vis.setAttribute("y1", y1);
  vis.setAttribute("x2", x2); vis.setAttribute("y2", y2);
  vis.setAttribute("stroke", stroke);
  vis.setAttribute("stroke-width", width);
  if (arrow) vis.setAttribute("marker-end", `url(#arrow-${node.id})`);
  else vis.removeAttribute("marker-end");

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
  const c = viewportCenter();
  let off = 0;
  for (const file of imageInput.files) { addImageFromFile(file, c.x + off, c.y + off); off += 16; }
  imageInput.value = "";
});

// ============================================================
// Add nodes
// ============================================================
function nextZ() { return state.nodes.reduce((m, n) => Math.max(m, n.z || 1), 0) + 1; }
function addTextNode(variant, x, y) {
  const preset = TEXT_PRESETS[variant] || TEXT_PRESETS.body;
  const node = {
    id: uid(), type: "text",
    x: Math.round(x - preset.w / 2), y: Math.round(y - 30),
    w: preset.w, z: nextZ(),
    content: preset.content, style: { ...preset.style },
  };
  state.nodes.push(node);
  state.selectedIds = new Set([node.id]);
  render(); save();
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
        src, style: { radius: 12 },
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
  if (!node || node.type !== "text") return;
  e.stopPropagation();
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
  if (e.target !== board && e.target !== canvas && !e.target.closest(".empty-state")) return;
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
    if (type === "text" && n.type !== "text") continue;
    if (type === "image" && n.type !== "image") continue;
    if (type === "line" && n.type !== "line") continue;
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

fEl.front.addEventListener("click", () => {
  const sel = getSelectedNodes(); if (!sel.length) return;
  let z = nextZ(); for (const n of sel) n.z = z++;
  render(); save();
});
fEl.back.addEventListener("click", () => {
  const sel = getSelectedNodes(); if (!sel.length) return;
  let minZ = state.nodes.reduce((m, x) => Math.min(m, x.z || 1), Infinity);
  let z = minZ - sel.length; for (const n of sel) n.z = z++;
  render(); save();
});
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

  if ((e.ctrlKey || e.metaKey) && !editable) {
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
document.getElementById("btn-export").addEventListener("click", exportPNG);

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
  const sorted = [...rects].sort((a, b) => (a.n.z || 1) - (b.n.z || 1));
  let pending = 0;
  const finalize = () => {
    const link = document.createElement("a");
    link.download = "whiteboard.png"; link.href = c.toDataURL("image/png"); link.click();
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
// Init
// ============================================================
load();
render();
applyTransform();
pushHistory();
