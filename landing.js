"use strict";

// =========================================================
// Lobby — manage the project index in localStorage.
// Storage layout:
//   mp.projects.v1     → [{id, name, description, createdAt, updatedAt, count}]
//   mp.project.<id>.v1 → board state (managed by app.js)
// =========================================================

const PROJECTS_KEY = "mp.projects.v1";
const LEGACY_KEY   = "whiteboard.v3";
const LEGACY_FLAG  = "mp.migrated.v1";

const $ = (sel) => document.querySelector(sel);

const grid       = $("#grid");
const empty      = $("#empty");
const searchInp  = $("#search");
const sortSel    = $("#sort");
const newBtn     = $("#new-project-btn");
const emptyNew   = $("#empty-new-btn");

const newModal   = $("#new-modal");
const newName    = $("#new-name");
const newDesc    = $("#new-desc");
const newCreate  = $("#new-create");

const renameModal = $("#rename-modal");
const renameName  = $("#rename-name");
const renameDesc  = $("#rename-desc");
const renameSave  = $("#rename-save");

const confirmModal  = $("#confirm-modal");
const confirmTitle  = $("#confirm-title");
const confirmBtn    = $("#confirm-delete");

let activeId = null;        // for rename / delete modals

// ---------- storage ----------
function readProjects() {
  try { return JSON.parse(localStorage.getItem(PROJECTS_KEY)) || []; }
  catch (_) { return []; }
}
function writeProjects(list) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
}
function uid() { return Math.random().toString(36).slice(2, 10); }

// One-time migration: if a user used the app before projects existed,
// promote their single board to a project so they don't lose work.
(function migrateLegacy() {
  if (localStorage.getItem(LEGACY_FLAG)) return;
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) { localStorage.setItem(LEGACY_FLAG, "1"); return; }
  try {
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.nodes) && data.nodes.length) {
      const id = uid();
      const now = Date.now();
      const list = readProjects();
      list.unshift({
        id, name: "My first board", description: "Imported from your previous session",
        createdAt: now, updatedAt: now, count: data.nodes.length,
      });
      writeProjects(list);
      localStorage.setItem(`mp.project.${id}.v1`, raw);
    }
  } catch (_) {}
  localStorage.setItem(LEGACY_FLAG, "1");
})();

// ---------- create / rename / delete ----------
function createProject(name, description) {
  const id = uid();
  const now = Date.now();
  const list = readProjects();
  list.unshift({
    id,
    name: (name || "Untitled").trim().slice(0, 80) || "Untitled",
    description: (description || "").trim().slice(0, 240),
    createdAt: now, updatedAt: now, count: 0,
  });
  writeProjects(list);
  return id;
}
function deleteProject(id) {
  const list = readProjects().filter((p) => p.id !== id);
  writeProjects(list);
  localStorage.removeItem(`mp.project.${id}.v1`);
}
function patchProject(id, patch) {
  const list = readProjects();
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return;
  list[i] = { ...list[i], ...patch, updatedAt: Date.now() };
  writeProjects(list);
}

// ---------- render ----------
function relTime(ts) {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)         return "just now";
  if (s < 3600)       return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)      return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7)  return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function projectThumb(id) {
  // Lightweight preview from a project's persisted board state.
  // We render up to 6 sticky-shaped tiles, scaled to thumb space.
  let raw;
  try { raw = JSON.parse(localStorage.getItem(`mp.project.${id}.v1`) || "null"); }
  catch (_) { raw = null; }
  if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    return `<div class="thumb-empty">Empty board</div>`;
  }
  const nodes = raw.nodes.filter((n) => n.type !== "line").slice(0, 24);
  if (nodes.length === 0) return `<div class="thumb-empty">Empty board</div>`;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const w = n.w || 200, h = n.h || (n.type === "text" ? 40 : 100);
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + w > maxX) maxX = n.x + w;
    if (n.y + h > maxY) maxY = n.y + h;
  }
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const W = 280, H = 120, pad = 8;
  const scale = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh);
  const offX = pad + ((W - pad * 2) - bw * scale) / 2;
  const offY = pad + ((H - pad * 2) - bh * scale) / 2;

  const tiles = nodes.slice(0, 12).map((n) => {
    const w = (n.w || 200) * scale;
    const h = (n.h || (n.type === "text" ? 40 : 100)) * scale;
    const x = (n.x - minX) * scale + offX;
    const y = (n.y - minY) * scale + offY;
    let bg = "#fff";
    if (n.type === "text" && n.style && n.style.bg && n.style.bg !== "transparent") bg = n.style.bg;
    if (n.type === "shape" && n.fill) bg = n.fill;
    return `<div class="thumb-mini" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${Math.max(6, w).toFixed(1)}px;height:${Math.max(6, h).toFixed(1)}px;background:${bg};"></div>`;
  }).join("");
  return tiles;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function render() {
  let list = readProjects();

  const q = (searchInp.value || "").trim().toLowerCase();
  if (q) list = list.filter((p) =>
    (p.name || "").toLowerCase().includes(q) ||
    (p.description || "").toLowerCase().includes(q)
  );

  const sort = sortSel.value;
  list = list.slice().sort((a, b) => {
    if (sort === "name")    return (a.name || "").localeCompare(b.name || "");
    if (sort === "created") return (b.createdAt || 0) - (a.createdAt || 0);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  const total = readProjects().length;
  empty.hidden = total !== 0;
  grid.hidden = total === 0;

  if (total === 0) { grid.innerHTML = ""; return; }

  const newCardHtml = `
    <button class="project-card new-card" id="card-new" type="button">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      <span>New project</span>
    </button>`;

  const cards = list.map((p) => `
    <div class="project-card" data-id="${p.id}" role="button" tabindex="0">
      <div class="project-thumb">${projectThumb(p.id)}</div>
      <div class="project-body">
        <div class="project-name">${escapeHtml(p.name || "Untitled")}</div>
        <div class="project-desc">${escapeHtml(p.description || " ")}</div>
        <div class="project-meta">
          <span>${relTime(p.updatedAt)}</span>
          <span>${(p.count || 0)} item${(p.count || 0) === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div class="project-actions">
        <button class="icon-btn" data-act="rename" title="Rename" aria-label="Rename">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        </button>
        <button class="icon-btn danger" data-act="delete" title="Delete" aria-label="Delete">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    </div>
  `).join("");

  grid.innerHTML = newCardHtml + cards;
}

// ---------- modal helpers ----------
function openModal(modal) { modal.hidden = false; }
function closeModal(modal) { modal.hidden = true; }

// generic close handlers (backdrop, x, cancel)
document.addEventListener("click", (e) => {
  if (e.target.matches("[data-close]")) {
    const m = e.target.closest(".lp-modal");
    if (m) closeModal(m);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const m of document.querySelectorAll(".lp-modal")) if (!m.hidden) closeModal(m);
});

// ---------- new project ----------
function openNew() {
  newName.value = "";
  newDesc.value = "";
  openModal(newModal);
  setTimeout(() => newName.focus(), 30);
}
newBtn.addEventListener("click", openNew);
emptyNew.addEventListener("click", openNew);

newCreate.addEventListener("click", () => {
  const id = createProject(newName.value, newDesc.value);
  closeModal(newModal);
  // Send them straight into the new board.
  location.href = `board.html?id=${id}`;
});
newName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); newCreate.click(); }
});

// ---------- card events ----------
grid.addEventListener("click", (e) => {
  if (e.target.closest("#card-new")) { openNew(); return; }
  const card = e.target.closest(".project-card");
  if (!card || card.classList.contains("new-card")) return;

  const id = card.dataset.id;
  const actBtn = e.target.closest("[data-act]");
  if (actBtn) {
    e.stopPropagation();
    const act = actBtn.dataset.act;
    if (act === "rename") openRename(id);
    else if (act === "delete") openDelete(id);
    return;
  }
  location.href = `board.html?id=${id}`;
});
grid.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const card = e.target.closest(".project-card");
  if (!card || card.classList.contains("new-card")) return;
  location.href = `board.html?id=${card.dataset.id}`;
});

// ---------- rename ----------
function openRename(id) {
  const p = readProjects().find((x) => x.id === id);
  if (!p) return;
  activeId = id;
  renameName.value = p.name || "";
  renameDesc.value = p.description || "";
  openModal(renameModal);
  setTimeout(() => renameName.focus(), 30);
}
renameSave.addEventListener("click", () => {
  if (!activeId) return;
  patchProject(activeId, {
    name: (renameName.value || "Untitled").trim().slice(0, 80) || "Untitled",
    description: (renameDesc.value || "").trim().slice(0, 240),
  });
  activeId = null;
  closeModal(renameModal);
  render();
});

// ---------- delete ----------
function openDelete(id) {
  const p = readProjects().find((x) => x.id === id);
  if (!p) return;
  activeId = id;
  confirmTitle.textContent = `Delete "${p.name || "Untitled"}"?`;
  openModal(confirmModal);
}
confirmBtn.addEventListener("click", () => {
  if (!activeId) return;
  deleteProject(activeId);
  activeId = null;
  closeModal(confirmModal);
  render();
});

// ---------- search / sort ----------
searchInp.addEventListener("input", render);
sortSel.addEventListener("change", render);

// ---------- init ----------
render();
