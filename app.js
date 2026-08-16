/* The Megas — Album Tracker (frontend) */
"use strict";

const STAGE_COLOR = {
  Idea: "#948aa8", Writing: "#6cb6ff", Demo: "#4fd0e0", Production: "#ffab4a",
  Mixing: "#f078c0", Mastering: "#b58cff", Released: "#46dba0",
};
const PROD_IDX = 3; // index of "Production" in the pipeline

const state = {
  data: null,
  view: "tracks",
  filters: { albumId: "", ip: "", memberId: "" },
  openTrackId: null,
  audio: { byTrack: {}, order: {}, currentId: null, playing: false, configured: false, queue: [] },
};
const CANT_PLAY_EXT = ["aif", "aiff"]; // browsers (esp. Chrome) usually can't play AIFF
const editingMembers = new Set();
const expandedSubs = new Set(); // phases whose subtask checklist is open
const collapsedSubs = new Set(); // phases the user explicitly collapsed
let newlyAddedSub = null; // "phase:index" of a just-added subtask (for pop-in)
let asgGroup = "phase";
let asgOnlyMe = false; // Assignments grouping: "phase" or "song" // Band cards in edit mode
const PALETTE = ["#6cb6ff", "#46dba0", "#ffab4a", "#f0654f", "#b58cff", "#4fd0e0", "#f078c0", "#e5c94a", "#8a9bff", "#5fd08a"];
const memberById = (id) => (state.data && state.data.members ? state.data.members.find((m) => m.id === id) : null);
// Normalize a title (or filename) for matching Dropbox audio to a track.
const normTitle = (s) => String(s || "").toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/^\s*\d+[_\-.\s]+/, "").replace(/_v\d+.*$/i, "").replace(/[^a-z0-9]+/g, "");
const trackById = (id) => state.data.tracks.find((t) => t.id === id);
const audioFor = (t) => (t && state.audio.byTrack ? state.audio.byTrack[t.id] : null);
// A track's order comes from its Dropbox filename number when available; else the Airtable Track Order.
const effOrder = (t) => (state.audio.order && state.audio.order[t.id] != null ? state.audio.order[t.id] : (t.order ?? 999));
const dispNum = (t) => (state.audio.order && state.audio.order[t.id] != null) ? state.audio.order[t.id] : (t.order || "");
// The current bounce filename for a track — feedback is pinned to this so a new bounce starts fresh.
const currentVersion = (t) => { const it = audioFor(t); return it ? it.name : ""; };
const openFbCount = (t) => (t.feedback || []).filter((fb) => fb.status === "Open" && (fb.version || "") === (currentVersion(t) || "")).length;
function fbCounts(t) { const cur = currentVersion(t); const list = (t.feedback || []).filter((fb) => (fb.version || "") === (cur || "")); return { total: list.length, done: list.filter((fb) => fb.status === "Resolved").length }; }
function fbLabel(t) { const c = fbCounts(t); return c.total ? ` (${c.done}/${c.total})` : ""; }

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

/* ---- Data / API ------------------------------------------------------------*/
async function loadData() {
  const r = await fetch("/api/data", { headers: { "Cache-Control": "no-store" } });
  if (r.status === 401) { location.href = "/login.html?next=" + encodeURIComponent("/"); return null; }
  if (!r.ok) { toast("Failed to load data", true); return null; }
  return r.json();
}

async function post(url, payload) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (r.status === 401) { location.href = "/login.html"; return { ok: false }; }
  let j = {}; try { j = await r.json(); } catch {}
  if (r.status === 409) { toast(j.message || "Blocked", true); return { ok: false, gate: true }; }
  if (!r.ok) { toast(j.message || j.error || "Request failed", true); return { ok: false }; }
  return { ok: true, ...j };
}

const update = (entity, id, fields) => post("/api/update", { entity, id, fields });
const createEntity = (entity, fields) => post("/api/create", { entity, fields });
const deleteEntity = (entity, id) => post("/api/delete", { entity, id });
async function toggleSub(pid, i, checked) {
  const ph = (state.data.phases || []).find((p) => p.id === pid); if (!ph) return;
  const arr = (ph.subtasks || []).map((x) => ({ text: x.text, done: !!x.done, owner: x.owner || null, note: x.note || null }));
  if (!arr[i]) return; arr[i].done = checked;
  const note = arr[i].note;
  const r = await update("phase", pid, { subtasks: JSON.stringify(arr) });
  if (r.ok) { if (note) await update("feedback", note, { status: checked ? "Resolved" : "Open" }); refresh(); }
}

/* ---- Art upload ------------------------------------------------------------*/
async function uploadArt(entity, id, file) {
  if (file.size > 4 * 1024 * 1024) { toast("Image too large (max ~4MB)", true); return { ok: false }; }
  const b64 = await new Promise((resolve, reject) => {
    const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(",")[1]); fr.onerror = reject; fr.readAsDataURL(file);
  });
  return post("/api/upload", { entity, id, filename: file.name, contentType: file.type || "image/png", dataBase64: b64 });
}
function artFieldHTML(entity, id, cover) {
  const has = cover && cover[0];
  return `
    <div class="field"><label>${entity === "album" ? "Cover art" : "Track art"}</label>
      <div class="art-row">
        <div class="art-thumb" ${has ? `style="background-image:url('${has.thumb}')"` : ""}>${has ? "" : ""}</div>
        <label class="add-btn ghost art-upload">Upload / change<input type="file" accept="image/*" data-artupload="${entity}:${id}" hidden /></label>
        ${has ? `<button class="fb-mini" data-artremove="${entity}:${id}">Remove</button>` : ""}
      </div>
    </div>`;
}
function wireArt() {
  document.querySelectorAll("[data-artupload]").forEach((inp) => inp.addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const [entity, id] = inp.dataset.artupload.split(":");
    toast("Uploading art…");
    const r = await uploadArt(entity, id, f);
    if (r.ok) { toast("Art updated"); await refresh(false); (entity === "album" ? openAlbumDrawer : openDrawer)(id); }
  }));
  document.querySelectorAll("[data-artremove]").forEach((b) => b.addEventListener("click", async () => {
    const [entity, id] = b.dataset.artremove.split(":");
    const r = await update(entity, id, { [entity === "album" ? "cover" : "art"]: [] });
    if (r.ok) { toast("Art removed"); await refresh(false); (entity === "album" ? openAlbumDrawer : openDrawer)(id); }
  }));
}

let refreshing = false, refreshQueued = false;
async function refresh(keepDrawer = true) {
  if (refreshing) { refreshQueued = true; return; }
  refreshing = true;
  const d = await loadData();
  refreshing = false;
  if (d) {
    state.data = d;
    syncFilters();
    render();
    if (keepDrawer && state.openTrackId) openDrawer(state.openTrackId);
    if (state.audio.currentId != null) renderMarkers();
  }
  if (refreshQueued) { refreshQueued = false; refresh(keepDrawer); }
}

/* ---- Helpers over state ----------------------------------------------------*/
function currentAlbum() {
  const id = state.filters.albumId;
  if (!id || id === "__all" || id === "__unassigned" || id === "__hold") return null;
  return state.data.albums.find((a) => a.id === id) || null;
}
function visibleTracks() {
  let t = state.data.tracks.slice();
  const id = state.filters.albumId;
  if (id === "__hold") t = t.filter((x) => x.onHold);
  else if (id === "__unassigned") t = t.filter((x) => !x.albumId);
  else if (id && id !== "__all") t = t.filter((x) => x.albumId === id);
  // "__all" (or unset) shows every album's tracks plus unassigned
  if (state.filters.ip) t = t.filter((x) => x.inspiredBy === state.filters.ip);
  if (state.filters.memberId) {
    const mid = state.filters.memberId;
    t = t.filter((x) => x.ownerIds.includes(mid) || x.phases.some((p) => p.ownerIds.includes(mid)));
  }
  return t;
}
function ipOptions() { return [...new Set(state.data.tracks.map((t) => t.inspiredBy).filter(Boolean))].sort(); }

/* ---- Filters ---------------------------------------------------------------*/
// The only filter is the album scope, chosen from the header switcher. Here we just
// pick the default on a fresh load and keep the value valid after data changes.
function syncFilters() {
  const { albums } = state.data;
  if (!state.filters.albumId) {
    const cur = albums.find((a) => a.current);
    state.filters.albumId = cur ? cur.id : "__all";
  }
  const valid = state.filters.albumId === "__all" || state.filters.albumId === "__unassigned" || albums.some((a) => a.id === state.filters.albumId);
  if (!valid) state.filters.albumId = "__all";
}

/* ---- Render dispatch -------------------------------------------------------*/
function render() {
  document.querySelectorAll(".tab, .navitem").forEach((t) => t.classList.toggle("active", t.dataset.view === state.view));
  renderAlbumStrip();
  const main = $("#main");
  if (state.view === "tracks") main.innerHTML = boardHTML(visibleTracks()) + albumsSectionHTML();
  else if (state.view === "preview") main.innerHTML = previewHTML();
  else if (state.view === "members") main.innerHTML = membersHTML();
  else if (state.view === "notes") main.innerHTML = notesHTML();
  else if (state.view === "calendar") main.innerHTML = calendarHTML();
  else if (state.view === "hold") main.innerHTML = holdHTML();
  else if (state.view === "roster") main.innerHTML = rosterHTML();
  wireBoard();
  wireSwitchers();
  wireArtView();
  // The header strip switcher shows on album-scoped views; on Preview each section
  // header is its own switcher, so the strip is hidden there.
  const showStrip = ["tracks", "members", "calendar", "notes"].includes(state.view);
  $("#albumStrip").style.display = showStrip ? "" : "none";
}

// Click any album/track art to view it full-size in a lightbox.
function openLightbox(url) {
  const lb = $("#lightbox");
  lb.innerHTML = `<img src="${esc(url)}" alt="Artwork" />`;
  lb.classList.add("open");
}
function closeLightbox() { const lb = $("#lightbox"); lb.classList.remove("open"); lb.innerHTML = ""; }
function wireArtView() {
  document.querySelectorAll("[data-artview]").forEach((el) =>
    el.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(el.dataset.artview); }));
}

// Album filter lives in the header (and each preview title): the title is a
// click-to-switch control. `selValue` = the value this instance should display;
// defaults to the active filter.
function albumSwitcherHTML(selValue) {
  const albums = state.data.albums;
  const sel = selValue != null ? selValue : state.filters.albumId;
  const label = sel === "__unassigned" ? "Unassigned"
    : sel === "__hold" ? "On hold"
    : (!sel || sel === "__all") ? "All albums"
    : ((albums.find((a) => a.id === sel) || {}).title || "All albums");
  const opt = (o) => `<button class="asw-opt${o.v === sel ? " sel" : ""}" data-albsel="${o.v}">${esc(o.t)}${o.current ? ` <span class="cur-tag">Current</span>` : ""}</button>`;
  const cur = albums.find((a) => a.current);
  // Current album pinned at the very top; the rest listed below (without duplicating it).
  const pinned = cur ? opt({ v: cur.id, t: cur.title, current: true }) + `<div class="asw-div"></div>` : "";
  const albumOpts = [{ v: "__all", t: "All albums" }].concat(albums.filter((a) => !a.current).map((a) => ({ v: a.id, t: a.title })));
  const extraOpts = [{ v: "__unassigned", t: "Unassigned" }, { v: "__hold", t: "On hold" }];
  const menu = pinned + albumOpts.map(opt).join("") + `<div class="asw-div"></div>` + extraOpts.map(opt).join("");
  return `<div class="asw-wrap">
    <button class="asw-btn" title="Switch album">${esc(label)} <span class="asw-caret">&#9662;</span></button>
    <div class="asw-menu">${menu}</div>
  </div>`;
}
// Wire every album switcher currently in the DOM (header strip + preview titles).
function wireSwitchers() {
  document.querySelectorAll(".asw-wrap").forEach((w) => {
    const btn = w.querySelector(".asw-btn"), menu = w.querySelector(".asw-menu");
    if (!btn || !menu) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".asw-menu.open").forEach((m) => { if (m !== menu) m.classList.remove("open"); });
      menu.classList.toggle("open");
    });
    menu.querySelectorAll("[data-albsel]").forEach((o) =>
      o.addEventListener("click", () => { state.filters.albumId = o.dataset.albsel; render(); }));
  });
}

function renderAlbumStrip() {
  const el = $("#albumStrip");
  const alb = currentAlbum();
  const full = state.view === "tracks" && !!alb; // cover + progress only on the dashboard
  if (full) {
    const cover = alb.cover[0] ? `data-artview="${esc(alb.cover[0].url)}" title="View art" style="background-image:url('${alb.cover[0].thumb}')"` : "";
    el.innerHTML = `
      <div class="album-strip">
        <div class="cover" ${cover}></div>
        <div class="album-meta">
          ${albumSwitcherHTML()}
          <div class="sub">${esc(alb.artist)} &middot; ${alb.trackCount} tracks &middot; ${esc(alb.stage)} &middot; <a href="#" id="editAlbumLink">Edit album</a></div>
          <div class="albprog2"><div class="bar"><i style="width:${alb.progress}%"></i></div><span class="pct2">${alb.progress}%</span></div>
        </div>
      </div>`;
  } else {
    el.innerHTML = `<div class="album-strip compact"><div class="album-meta">${albumSwitcherHTML()}</div></div>`;
  }
  const link = $("#editAlbumLink");
  if (link && alb) link.addEventListener("click", (e) => { e.preventDefault(); openAlbumDrawer(alb.id); });
}

/* ---- Track board -----------------------------------------------------------*/
function segClass(status) { return status === "Done" ? "done" : status === "In progress" ? "prog" : ""; }

// Inspiration tag with a hover popover listing the other songs drawing on the same IP.
function ipTagHTML(t) {
  const related = state.data.tracks
    .filter((x) => x.id !== t.id && x.inspiredBy && x.inspiredBy === t.inspiredBy && !x.onHold)
    .sort((a, b) => effOrder(a) - effOrder(b));
  const list = related.length
    ? `<ul>${related.map((x) => `<li>${dispNum(x) !== "" ? `<span class="tnum">${dispNum(x)}</span>` : ""}${esc(x.title)}</li>`).join("")}</ul>`
    : `<div class="empty">No other songs yet.</div>`;
  return `<div class="ip" tabindex="0">${esc(t.inspiredBy)}<div class="ip-pop"><div class="ip-pop-h">Also inspired by ${esc(t.inspiredBy)}</div>${list}</div></div>`;
}

function outstandingNotes(t) {
  const cur = currentVersion(t);
  if (!cur) return [];
  return (t.feedback || []).filter((fb) => fb.status === "Open" && fb.version && fb.version !== cur);
}
function verSeen(tid) { try { return (JSON.parse(localStorage.getItem("megasVerSeen") || "{}"))[tid] || null; } catch { return null; } }
function markVerSeen(tid, ver) { try { const o = JSON.parse(localStorage.getItem("megasVerSeen") || "{}"); o[tid] = ver; localStorage.setItem("megasVerSeen", JSON.stringify(o)); } catch {} }
function maybeVersionPrompt() {
  const m = document.getElementById("modal"); if (m && m.classList.contains("open")) return;
  for (const t of (state.data.tracks || [])) {
    const cur = currentVersion(t);
    if (cur && outstandingNotes(t).length && verSeen(t.id) !== cur) { openVersionTransfer(t.id); return; }
  }
}
function openVersionTransfer(trackId) {
  const t = trackById(trackId); if (!t) return;
  const cur = currentVersion(t);
  markVerSeen(trackId, cur);
  const notes = outstandingNotes(t).slice().sort((a, b) => (a.version || "").localeCompare(b.version || "") || a.timestamp - b.timestamp);
  if (!notes.length) { closeModal(); return; }
  const byVer = {}; notes.forEach((fb) => { (byVer[fb.version || "—"] = byVer[fb.version || "—"] || []).push(fb); });
  const groups = Object.entries(byVer).map(([ver, list]) => `
    <div class="vx-group">
      <div class="vx-verhd">From ${esc(ver)}</div>
      ${list.map((fb) => `
        <label class="vx-row">
          <input type="checkbox" class="vx-chk" data-vid="${fb.id}" checked />
          <span class="vx-time">${mmss(fb.timestamp)}</span>
          <span class="vx-comment">${esc(fb.comment)}</span>
          <span class="vx-author">${esc(fb.author || "")}</span>
          <button class="fb-mini vx-resolve" data-vresolve="${fb.id}" title="Mark resolved instead of moving">Resolve</button>
        </label>`).join("")}
    </div>`).join("");
  openModal(`
    <div class="mhd"><h2>New version detected</h2><button class="icon-btn close" id="mClose">&times;</button></div>
    <div class="mbd">
      <p style="margin:0;color:var(--muted)">&ldquo;${esc(t.title)}&rdquo; has a newer bounce: <strong style="color:var(--text)">${esc(cur || "—")}</strong>. These notes are still open on earlier versions — carry over any that still apply.</p>
      <div class="vx-list">${groups}</div>
      <div class="vx-actions">
        <label class="vx-all"><input type="checkbox" id="vxAll" checked /> Select all</label>
        <span style="flex:1"></span>
        <button class="add-btn ghost" id="vxClose2">Not now</button>
        <button class="add-btn" id="vxGo">Move selected to ${esc(cur || "current")}</button>
      </div>
    </div>`);
  $("#mClose").onclick = closeModal;
  $("#vxClose2").onclick = closeModal;
  $("#vxAll").onchange = (e) => { document.querySelectorAll(".vx-chk").forEach((c) => (c.checked = e.target.checked)); };
  document.querySelectorAll("[data-vresolve]").forEach((b) => b.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const r = await update("feedback", b.dataset.vresolve, { status: "Resolved" });
    if (r.ok) { toast("Resolved"); await refresh(); const left = outstandingNotes(trackById(trackId) || {}); if (left.length) openVersionTransfer(trackId); else { closeModal(); render(); } }
  });
  $("#vxGo").onclick = async () => {
    const ids = [...document.querySelectorAll(".vx-chk")].filter((c) => c.checked).map((c) => c.dataset.vid);
    if (!ids.length) { toast("Select at least one note", true); return; }
    const btn = $("#vxGo"); btn.disabled = true; btn.textContent = "Moving…";
    for (const id of ids) { await update("feedback", id, { version: cur }); }
    toast(`Moved ${ids.length} note${ids.length > 1 ? "s" : ""} to ${cur}`);
    await refresh(); closeModal();
    if (document.getElementById("notesbar") && document.getElementById("notesbar").classList.contains("open") && notesBarTrack === trackId) renderNotesBar();
    render();
  };
}
function cardHTML(t) {
  // Small phase chips tinted by the owner's color: bright while open/in-progress,
  // dark + struck through once Done.
  const segs = t.phases.map((p) => {
    const m = memberById(p.ownerIds[0]);
    const col = m && m.color ? m.color : "#6a6478";
    const who = m ? m.display : "unassigned";
    const done = p.status === "Done";
    const prog = p.status === "In progress";
    const subs = Array.isArray(p.subtasks) ? p.subtasks : [];
    const sdone = subs.filter((x) => x.done).length;
    const style = done
      ? `background:#1b1a22;border-color:${col}55;color:#726d80`
      : `background:${col};border-color:${col};color:#0c0b10`;
    const count = subs.length ? ` (${sdone}/${subs.length})` : "";
    const pop = subs.length ? `<span class="sub-pop"><span class="sub-pop-h">${esc(p.phase)} · ${sdone}/${subs.length} done</span>${subs.map((st) => `<span class="sp-row ${st.done ? "done" : ""}">${st.done ? "&#9745;" : "&#9744;"} ${esc(st.text)}</span>`).join("")}</span>` : "";
    return `<span class="pchip${done ? " done" : ""}${prog ? " prog" : ""}${subs.length ? " has-sub" : ""}" style="${style}" title="${esc(p.phase)} (${esc(who)}): ${esc(p.status)}">${esc(p.phase)}${count}${pop}</span>`;
  }).join("");
  // "Waiting on X" — when every remaining production part belongs to a single member.
  let waitingName = "", waitingId = "";
  {
    const notDone = t.phases.filter((p) => p.status !== "Done");
    const rem = new Set(); const nameById = {};
    notDone.forEach((p) => p.ownerIds.forEach((oid, idx) => { rem.add(oid); nameById[oid] = p.owners[idx] || nameById[oid]; }));
    if (t.stage === "Production" && !t.productionComplete && notDone.length > 0 && rem.size === 1) { waitingId = [...rem][0]; waitingName = nameById[waitingId] || ""; }
  }
  const waitM = waitingId ? memberById(waitingId) : null;
  const waitCol = waitM && waitM.color ? waitM.color : "#6a6478";
  const waitBanner = waitingName
    ? `<div class="wait-banner" style="--wcol:${waitCol}" title="Only ${esc(waitingName)}'s part is left">Waiting on ${esc(waitingName)}</div>`
    : "";
  const audio = audioFor(t);
  const playingThis = state.audio.currentId === t.id && state.audio.playing;
  const playBtn = audio
    ? `<button class="play-btn ${playingThis ? "playing" : ""}" data-play="${t.id}" title="Play latest bounce">${playingThis ? "&#9208;&#xFE0E;" : "&#9654;&#xFE0E;"}</button>`
    : "";
  const num = dispNum(t);
  return `
    <div class="card" draggable="true" data-id="${t.id}">
      <div class="top">
        ${t.cover && t.cover[0] ? `<div class="card-art" data-artview="${esc(t.cover[0].url)}" title="View art" style="background-image:url('${t.cover[0].thumb}')"></div>` : ""}
        <div class="title-wrap">${playBtn}${num !== "" ? `<span class="tnum">${num}</span>` : ""}<div class="title">${esc(t.title)}</div></div>
        ${t.inspiredBy ? ipTagHTML(t) : ""}
      </div>
      ${t.reference ? `<div class="ref">${esc(t.reference)}</div>` : ""}
      <div class="meter">${segs}</div>
      <div class="footer">
        <span class="prog-num">${t.phasesDone}/${t.phasesTotal} phases</span>
        <button class="lyr-btn" data-lyr="${t.id}" title="Lyrics & teleprompter">Lyrics</button>
        <button class="lyr-btn" data-fb="${t.id}" title="Notes (resolved/total on current version)">Notes${fbLabel(t)}</button>
      </div>
      ${outstandingNotes(t).length ? `<button class="ver-alert" data-verxfer="${t.id}" title="Notes from an earlier bounce are still open">New version detected &middot; ${outstandingNotes(t).length} note${outstandingNotes(t).length > 1 ? "s" : ""} outstanding</button>` : ""}
      ${waitBanner}
    </div>`;
}

function boardHTML(tracks) {
  const stages = state.data.stages;
  const holdView = state.filters.albumId === "__hold";
  const active = holdView ? tracks.slice() : tracks.filter((t) => !t.onHold && t.stage !== "Released");
  const shown = stages.filter((s) => active.some((t) => t.stage === s));
  if (!shown.length) return `<div class="loading">No tracks here yet.</div>`;
  // Distribute cards row-major across sub-columns of up to 5, so track order reads
  // left-to-right across the columns first, then down.
  const spread = (arr) => {
    const n = Math.max(1, Math.ceil(arr.length / 5));
    const out = Array.from({ length: n }, () => []);
    arr.forEach((item, i) => out[i % n].push(item));
    return out;
  };
  const cols = shown.map((s) => {
    const inCol = active.filter((t) => t.stage === s).sort((a, b) => effOrder(a) - effOrder(b));
    const locked = stages.indexOf(s) > PROD_IDX;
    const groups = spread(inCol); // extra columns of ~5, filled left-to-right by track number
    const cards = `<div class="cards${groups.length > 1 ? " multi" : ""}">${groups.map((g) => `<div class="cardcol">${g.map(cardHTML).join("")}</div>`).join("")}</div>`;
    return `
      <div class="col${locked ? " locked-target" : ""}" data-stage="${esc(s)}">
        <h3><span class="dot" style="background:${STAGE_COLOR[s]}"></span>${esc(s)}<span class="count">${inCol.length}</span></h3>
        ${cards}
      </div>`;
  }).join("");
  return `<div class="board">${cols}</div>`;
}

// Dedicated On Hold tab — held tracks live only here, hidden from every other view.
function holdHTML() {
  const held = state.data.tracks.filter((t) => t.onHold).sort((a, b) => effOrder(a) - effOrder(b));
  if (!held.length) return `<div class="loading">Nothing on hold. Put a track on hold from its detail panel.</div>`;
  return `<div class="preview"><div class="palbum">
    <div class="phead"><div class="cover"></div><div><h1>On Hold</h1><div class="sub">${held.length} track(s) parked — open one and untick “On hold” to bring it back</div></div></div>
    ${held.map(trackRowHTML).join("")}
  </div></div>`;
}

/* ---- Albums board ----------------------------------------------------------*/
function albumsBoardHTML() {
  const stages = state.data.stages;
  const cols = stages.map((s) => {
    const inCol = state.data.albums.filter((a) => a.stage === s);
    return `
      <div class="col" data-stage="${esc(s)}" data-entity="album">
        <h3><span class="dot" style="background:${STAGE_COLOR[s]}"></span>${esc(s)}<span class="count">${inCol.length}</span></h3>
        <div class="cards">${inCol.map(albumCardHTML).join("")}</div>
      </div>`;
  }).join("");
  return `<div class="board">${cols}</div>`;
}
function albumCardHTML(a) {
  return `
    <div class="card${a.current ? " is-current" : ""}" data-album="${a.id}">
      <div class="top">${a.cover && a.cover[0] ? `<div class="card-art" data-artview="${esc(a.cover[0].url)}" title="View art" style="background-image:url('${a.cover[0].thumb}')"></div>` : ""}<div class="title">${esc(a.title)}${a.current ? ` <span class="cur-tag">Current</span>` : ""}</div></div>
      <div class="ref">${esc(a.artist)} &middot; ${a.trackCount} tracks</div>
      <div class="meter"><div class="bar" style="flex:1"><i style="width:${a.progress}%"></i></div></div>
      <div class="footer"><span class="prog-num">${a.progress}% complete</span></div>
    </div>`;
}

// Albums live at the bottom of the Dashboard instead of a standalone page.
function albumsSectionHTML() {
  const albums = state.data.albums;
  if (!albums.length) return "";
  return `<div class="albums-section">
    <div class="albums-head">Albums</div>
    <div class="albums-row">${albums.map(albumCardHTML).join("")}</div>
  </div>`;
}

/* ---- Members: Who's Up Next ------------------------------------------------*/
// One phase-on-a-song row for the Assignments list. mode "phase" => show the song name
// (and open it on click); mode "song" => show the phase name.
function assignItemHTML(it, mode) {
  const subs = it.subs || [];
  const subList = subs.length ? `<div class="song-subs">${subs.map((st) => `<label class="song-sub"><input type="checkbox" data-subchk="${it.phaseId}:${st.idx}" ${st.done ? "checked" : ""} /><span class="${st.done ? "done" : ""}">${esc(st.text)}</span></label>`).join("")}</div>` : "";
  const meta = `${subs.length ? `<span class="sub-count">${subs.length}</span>` : ""}${it.due ? `<span class="due-tag sm">${fmtDay(it.due)}</span>` : ""}${it.status === "In progress" ? '<span class="badge prog">In progress</span>' : ""}`;
  const main = mode === "phase"
    ? `<span class="stp" data-open="${it.songId}">${it.songNum !== "" ? `<span class="tnum">${it.songNum}</span> ` : ""}${esc(it.songTitle)}</span>`
    : `<span class="stp">${esc(it.phase)}</span>`;
  let head;
  if (it.ownsPhase) {
    head = mode === "phase"
      ? `<div class="song-task-main"><input type="checkbox" data-phasechk /> ${main}${meta}</div>`
      : `<label class="song-task-main"><input type="checkbox" data-phasechk /> ${main}${meta}</label>`;
  } else {
    head = `<div class="song-task-main no-own">${main}<span class="ctx-tag">subtask</span>${it.due ? `<span class="due-tag sm">${fmtDay(it.due)}</span>` : ""}</div>`;
  }
  return `<div class="song-task" data-phase="${it.phaseId}">${head}${subList}</div>`;
}
function assignmentsFeedbackBox() {
  const alb = currentAlbum();
  const inScope = (t) => !t.onHold && (!alb || t.albumId === alb.id);
  const rows = [];
  state.data.tracks.filter(inScope).forEach((t) => {
    const cur = currentVersion(t);
    (t.feedback || []).filter((fb) => fb.status === "Open" && (fb.version || "") === (cur || "")).forEach((fb) => rows.push({ t, fb }));
  });
  if (!rows.length) return "";
  rows.sort((a, b) => (effOrder(a.t) - effOrder(b.t)) || (a.fb.timestamp - b.fb.timestamp));
  const items = rows.map(({ t, fb }) => `
    <div class="afb-item">
      <span class="afb-song" data-open="${t.id}">${dispNum(t) !== "" ? `<span class="tnum">${dispNum(t)}</span> ` : ""}${esc(t.title)}</span>
      <span class="afb-time">${mmss(fb.timestamp)}</span>
      <span class="afb-comment">${esc(fb.comment)}</span>
      <span class="afb-author">${esc(fb.author || "")}</span>
      <button class="fb-mini" data-afbtask="${t.id}:${fb.id}" title="Turn into a task">&#8594; Task</button>
      <button class="fb-mini" data-afbresolve="${t.id}:${fb.id}" title="Mark resolved">Resolve</button>
    </div>`).join("");
  return `<div class="afb-box"><div class="afb-head">Open feedback<span class="asg-count">${rows.length}</span></div>${items}</div>`;
}
function membersHTML() {
  const alb = currentAlbum();
  const tracks = state.data.tracks.filter((t) => (!alb || t.albumId === alb.id) && !t.onHold);
  const me = getMe();
  const canon = state.data.phaseNames || [];
  const earlier = (a, b) => (a == null ? b : b == null ? a : (a < b ? a : b));
  const dueCmp = (a, b) => (a && b) ? (a < b ? -1 : a > b ? 1 : 0) : (a ? -1 : b ? 1 : 0);
  const byMember = {};
  state.data.members.forEach((m) => (byMember[m.id] = { member: m, items: [], count: 0, nextDue: null }));
  tracks.forEach((t) => {
    t.phases.filter((p) => p.status !== "Done").forEach((p) => {
      const phaseOwners = p.ownerIds || [];
      const subs = (Array.isArray(p.subtasks) ? p.subtasks : []).map((st, idx) => ({ text: st.text, done: !!st.done, owner: st.owner || null, idx }));
      const memberSet = new Set(phaseOwners);
      subs.forEach((st) => { if (st.owner) memberSet.add(st.owner); });
      memberSet.forEach((mid) => {
        const rec = byMember[mid]; if (!rec) return;
        const ownsPhase = phaseOwners.includes(mid);
        const mySubs = subs.filter((st) => !st.done && (st.owner === mid || (!st.owner && ownsPhase)));
        if (!ownsPhase && mySubs.length === 0) return;
        rec.items.push({ songId: t.id, songTitle: t.title, songNum: dispNum(t), songOrder: effOrder(t), phaseId: p.id, phase: p.phase, status: p.status, due: p.due || null, subs: mySubs, ownsPhase });
        if (p.due) rec.nextDue = earlier(rec.nextDue, p.due);
        rec.count++;
      });
    });
  });
  const entries = Object.values(byMember).sort((a, b) => {
    if (me) { if (a.member.id === me.id) return -1; if (b.member.id === me.id) return 1; }
    const d = dueCmp(a.nextDue, b.nextDue); if (d) return d;
    return b.count - a.count;
  });
  const shownEntries = (asgOnlyMe && me) ? entries.filter((e) => e.member.id === me.id) : entries;
  const cards = shownEntries.map(({ member, items, count }) => {
    let body;
    if (!items.length) {
      body = `<div class="empty">All caught up</div>`;
    } else if (asgGroup === "phase") {
      const groups = {};
      items.forEach((it) => (groups[it.phase] = groups[it.phase] || []).push(it));
      const order = Object.keys(groups).sort((a, b) => { const ia = canon.indexOf(a), ib = canon.indexOf(b); return ((ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)) || a.localeCompare(b); });
      body = order.map((pn) => {
        const its = groups[pn].sort((a, b) => dueCmp(a.due, b.due) || (a.songOrder - b.songOrder));
        return `<div class="asg-group"><div class="asg-head">${esc(pn)}<span class="asg-count">${its.length}</span></div>${its.map((it) => assignItemHTML(it, "phase")).join("")}</div>`;
      }).join("");
    } else {
      const songs = {};
      items.forEach((it) => { const s = songs[it.songId] = songs[it.songId] || { id: it.songId, title: it.songTitle, num: it.songNum, order: it.songOrder, nextDue: null, its: [] }; s.its.push(it); if (it.due) s.nextDue = earlier(s.nextDue, it.due); });
      body = Object.values(songs).sort((a, b) => dueCmp(a.nextDue, b.nextDue) || (a.order - b.order)).map((s) => `
        <div class="song-card" data-song="${s.id}">
          <div class="song-title" data-songopen="${s.id}">${s.num !== "" ? `<span class="tnum">${s.num}</span> ` : ""}${esc(s.title)}${s.nextDue ? `<span class="due-tag">${fmtDay(s.nextDue)}</span>` : ""}</div>
          ${s.its.map((it) => assignItemHTML(it, "song")).join("")}
        </div>`).join("");
    }
    const meCls = me && member.id === me.id ? " me" : "";
    return `
      <div class="mcard${meCls}">
        <div class="mhead">
          <div class="avatar" style="${member.color ? `background:${member.color};color:#0c0b10` : ""}" title="${esc(member.display)}">${esc(initials(member.display))}</div>
          <div><div class="mname">${esc(member.display)}</div><div class="mrole">${esc(member.role)}</div></div>
          <div style="margin-left:auto;color:var(--muted);font-weight:700">${count}</div>
        </div>
        ${body}
      </div>`;
  }).join("");
  const toolbar = `<div class="asg-bar"><span class="asg-lbl">Group by</span><div class="asg-toggle"><button class="${asgGroup === "phase" ? "on" : ""}" data-asg="phase">Phase</button><button class="${asgGroup === "song" ? "on" : ""}" data-asg="song">Song</button></div><span style="flex:1"></span>${me ? `<button class="asg-mebtn${asgOnlyMe ? " on" : ""}" data-asgme>${asgOnlyMe ? "Showing you" : "Only me"}</button>` : ""}</div>`;
  return `${toolbar}<div class="members">${cards}</div>`;
}

/* ---- Band (member info) ----------------------------------------------------*/
function rosterHTML() {
  const cards = state.data.members.map((m) => {
    const av = `<div class="avatar" style="${m.color ? `background:${m.color};color:#0c0b10` : ""}" title="${esc(m.display)}">${esc(initials(m.display || m.name || "?"))}</div>`;
    if (editingMembers.has(m.id)) {
      return `
      <div class="mcard editing" data-member="${m.id}">
        <div class="mhead">${av}<div style="flex:1"><input class="title-edit" data-mf="name" value="${esc(m.name)}" placeholder="Name" /></div><button class="fb-mini" data-medone="${m.id}">Done</button></div>
        <div class="field"><label>Nickname (used everywhere if set)</label><input data-mf="nickname" value="${esc(m.nickname)}" placeholder="e.g. Church" /></div>
        <div class="field"><label>Role / Instrument</label><input data-mf="role" value="${esc(m.role)}" placeholder="e.g. Drums" /></div>
        <div class="field"><label>Email</label><input data-mf="email" type="email" value="${esc(m.email)}" placeholder="name@email.com" /></div>
        <div class="field"><label>Color</label><div class="swatches">${PALETTE.map((c) => `<button class="swatch${(m.color || "").toLowerCase() === c ? " sel" : ""}" data-mcolor="${m.id}:${c}" style="background:${c}" title="${c}"></button>`).join("")}</div></div>
        <div class="field"><label>Production phases (who owns what)</label>
          <div class="phase-picks">${phaseNames().map((p) => `<label class="ppick${(m.phases || []).includes(p) ? " on" : ""}"><input type="checkbox" data-mphase="${m.id}:${esc(p)}" ${(m.phases || []).includes(p) ? "checked" : ""} /> ${esc(p)}</label>`).join("")}</div>
        </div>
      </div>`;
    }
    const phaseTags = (m.phases || []).length
      ? `<div class="mtags">${m.phases.map((p) => `<span class="mtag">${esc(p)}</span>`).join("")}</div>`
      : "";
    return `
      <div class="mcard" data-member="${m.id}">
        <div class="mhead">${av}<div style="flex:1"><div class="mname">${esc(m.display || m.name || "—")}</div><div class="mrole">${esc(m.role || "")}</div></div><button class="fb-mini" data-medit="${m.id}">Edit</button></div>
        ${m.nickname ? `<div class="mmeta">Name: ${esc(m.name)}</div>` : ""}
        ${m.email ? `<div class="mmeta">${esc(m.email)}</div>` : ""}
        ${phaseTags}
      </div>`;
  }).join("");
  return `<div class="roster-bar"><button class="add-btn" id="rosterAdd">+ Add member</button><button class="add-btn ghost" id="applyPhases" title="Update every existing track's phase owners to match these assignments">Apply to all tracks</button></div><div class="members">${cards}</div>`;
}
function phaseNames() { return (state.data.phaseNames && state.data.phaseNames.length) ? state.data.phaseNames : ["Drums","Bass","Eric Guitar","Josh Guitar","Eric Vocals","Josh Vocals","Backing Vocals","Synth","Sound Design"]; }

/* ---- Calendar --------------------------------------------------------------*/
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function fmtDay(iso) { if (!iso) return ""; const d = new Date(iso + "T00:00:00"); return isNaN(d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
function computePlan(open, deadlineISO, spread) {
  const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (!deadlineISO) return open.map((p) => ({ phase: p, due: null }));
  const deadline = new Date(deadlineISO + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = []; let cur = new Date(today.getTime() + 864e5);
  while (cur <= deadline) { const dow = cur.getDay(); if (spread !== "week" || (dow !== 0 && dow !== 6)) days.push(new Date(cur)); cur = new Date(cur.getTime() + 864e5); }
  if (!days.length || isoOf(days[days.length - 1]) !== isoOf(deadline)) days.push(new Date(deadline));
  const len = days.length, N = open.length;
  if (spread === "back") return open.map((p, i) => { const idx = len - 1 - (N - 1 - i); return { phase: p, due: isoOf(days[Math.max(0, idx)]) }; });
  return open.map((p, i) => { const idx = N === 1 ? len - 1 : Math.round(i * (len - 1) / (N - 1)); return { phase: p, due: isoOf(days[Math.min(len - 1, idx)]) }; });
}
function openPlanModal() {
  const alb = currentAlbum();
  const songs = state.data.tracks.filter((t) => !t.onHold && t.stage !== "Released" && (!alb || t.albumId === alb.id)).sort((a, b) => effOrder(a) - effOrder(b));
  const opts = songs.map((t) => `<option value="${t.id}">${dispNum(t) !== "" ? dispNum(t) + ". " : ""}${esc(t.title)}</option>`).join("");
  const def = (() => { const d = new Date(Date.now() + 21 * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  openModal(`
    <div class="mhd"><h2>Plan a song</h2><span style="flex:1"></span><button class="icon-btn close" id="mClose">&times;</button></div>
    <div class="mbd">
      <div class="field"><label>Song</label><select id="planSong">${opts || `<option value="">No eligible songs</option>`}</select></div>
      <div class="row2">
        <div class="field"><label>Deadline</label><input type="date" id="planDate" value="${def}" /></div>
        <div class="field"><label>Spread across</label><select id="planSpread"><option value="week">Weekdays (Mon-Fri)</option><option value="all">Every day</option><option value="back">Back-to-back from deadline</option></select></div>
      </div>
      <div id="planPreview" class="plan-preview"></div>
      <div class="drawer-actions"><button class="add-btn" id="planGo">Schedule open phases</button></div>
    </div>`);
  $("#mClose").onclick = closeModal;
  const preview = () => {
    const t = trackById($("#planSong").value); const box = $("#planPreview"); if (!t) { box.innerHTML = ""; return; }
    const open = t.phases.filter((x) => x.status !== "Done");
    if (!open.length) { box.innerHTML = `<div class="empty">This song has no open phases.</div>`; return; }
    const sched = computePlan(open, $("#planDate").value, $("#planSpread").value);
    box.innerHTML = `<div class="plan-h">${open.length} open phase(s):</div>` + sched.map((s) => `<div class="plan-row"><span>${esc(s.phase.phase)}</span><span class="muted">${fmtDay(s.due)}</span></div>`).join("");
  };
  ["#planSong", "#planDate", "#planSpread"].forEach((sel) => { const el = $(sel); if (el) el.addEventListener("change", preview); });
  preview();
  $("#planGo").onclick = async () => {
    const t = trackById($("#planSong").value); if (!t) { toast("Pick a song", true); return; }
    const open = t.phases.filter((x) => x.status !== "Done");
    if (!open.length) { toast("No open phases to schedule", true); return; }
    const deadline = $("#planDate").value;
    const assignments = computePlan(open, deadline, $("#planSpread").value).map((s) => ({ phaseId: s.phase.id, due: s.due }));
    const r = await fetch("/api/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity: "planphases", trackId: t.id, deadline, assignments }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { toast(`Scheduled ${assignments.length} phase(s)`); closeModal(); await refresh(false); render(); }
    else toast(j.error || "Plan failed", true);
  };
}
let calMonth = new Date();
let calView = "month";
let calSong = "";
function calendarHTML() {
  const alb = currentAlbum();
  const inScope = (t) => !t.onHold && (!alb || t.albumId === alb.id);
  const tracksById = {}; state.data.tracks.forEach((t) => (tracksById[t.id] = t));
  const songSel = (t) => !calSong || t.id === calSong;
  const tasks = state.data.phases.filter((p) => p.due && p.status !== "Done" && tracksById[p.trackId] && inScope(tracksById[p.trackId]) && songSel(tracksById[p.trackId]));
  const deadlines = state.data.tracks.filter((t) => t.dueDate && inScope(t) && songSel(t));
  const songOpts = state.data.tracks.filter((t) => inScope(t)).sort((a, b) => effOrder(a) - effOrder(b)).map((t) => `<option value="${t.id}"${calSong === t.id ? " selected" : ""}>${dispNum(t) !== "" ? dispNum(t) + ". " : ""}${esc(t.title)}</option>`).join("");
  const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayIso = isoOf(new Date());
  const weekly = calView === "week";
  const start = new Date(calMonth); start.setHours(0, 0, 0, 0);
  if (weekly) start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  else { start.setDate(1); start.setDate(1 - ((start.getDay() + 6) % 7)); }
  const cellCount = weekly ? 7 : 42;
  const curMonth = calMonth.getMonth();
  const title = weekly
    ? (() => { const e = new Date(start); e.setDate(e.getDate() + 6); const o = { month: "short", day: "numeric" }; return `${start.toLocaleDateString(undefined, o)} – ${e.toLocaleDateString(undefined, o)}`; })()
    : calMonth.toLocaleString(undefined, { month: "long", year: "numeric" });
  const heads = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="cal-head">${d}</div>`).join("");
  let cells = "";
  for (let i = 0; i < cellCount; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const iso = isoOf(d);
    const dl = deadlines.filter((t) => t.dueDate === iso);
    const tk = tasks.filter((p) => p.due === iso).sort((a, b) => effOrder(tracksById[a.trackId]) - effOrder(tracksById[b.trackId]));
    cells += `<div class="cal-cell${(!weekly && d.getMonth() !== curMonth) ? " out" : ""}${iso === todayIso ? " today" : ""}${weekly ? " wk" : ""}" data-day="${iso}">
      <div class="d">${weekly ? d.toLocaleDateString(undefined, { weekday: "short" }) + " " : ""}${d.getDate()}</div>
      ${dl.map((t) => `<div class="cal-deadline" draggable="true" data-cd="${t.id}" data-open="${t.id}" title="Deadline: ${esc(t.title)}"><span class="flag">&#9873;</span><span class="dl-txt">${dispNum(t) !== "" ? `${dispNum(t)}. ` : ""}${esc(t.title)}</span></div>`).join("")}
      ${tk.map((p) => { const t = tracksById[p.trackId]; const mm = memberById(p.ownerIds[0]); const col = mm && mm.color ? mm.color : "#6a6478"; return `<div class="cal-task" draggable="true" data-ct="${p.id}" data-open="${p.trackId}" style="--own:${col}" title="${esc(p.owners.join(', ') || 'unassigned')}">${esc(t.title)} — ${esc(p.phase)}</div>`; }).join("")}
    </div>`;
  }
  return `
    <div class="calendar">
      <div class="cal-nav">
        <button class="icon-btn" data-cal="-1">&#8249;</button>
        <h2>${esc(title)}</h2>
        <button class="icon-btn" data-cal="1">&#8250;</button>
        <div class="cal-viewtoggle">
          <button class="${weekly ? "" : "on"}" data-calview="month">Month</button>
          <button class="${weekly ? "on" : ""}" data-calview="week">Week</button>
        </div>
        <select id="calSongFilter" class="cal-songfilter" title="Filter by song"><option value="">All songs</option>${songOpts}</select>
        <span class="spacer" style="flex:1"></span>
        <button class="add-btn" id="calPlanBtn">Plan a song</button>
        <button class="add-btn ghost" id="calSubBtn">Sync to Google Calendar</button>
      </div>
      <div id="calSubBody"></div>
      <div class="cal-grid">${heads}${cells}</div>
    </div>`;
}
function openCalSync() {
  const body = $("#calSubBody");
  if (!body) return;
  body.innerHTML = `<div class="cal-sync"><div class="loading" style="padding:8px 0">Getting your feed link…</div></div>`;
  Promise.resolve({ url: (state.data && state.data.feedUrl) || "", secured: !!(state.data && state.data.feedSecured) }).then((j) => {
    if (!j || !j.url) { body.innerHTML = `<div class="cal-sync">Couldn't build the feed link.</div>`; return; }
    body.innerHTML = `
      <div class="cal-sync">
        <div class="cal-sync-h">Subscribe in Google Calendar</div>
        <div class="cal-sync-row">
          <input id="calFeedUrl" type="text" readonly value="${esc(j.url)}" />
          <button class="add-btn" id="calCopy">Copy</button>
        </div>
        <ol class="cal-sync-steps">
          <li>Open Google Calendar on the web.</li>
          <li>Left sidebar → <b>Other calendars</b> → <b>+</b> → <b>From URL</b>.</li>
          <li>Paste this link and click <b>Add calendar</b>.</li>
        </ol>
        <div class="cal-sync-note">Your due dates appear as a separate calendar and refresh automatically (Google polls every few hours). It's read-only — edit due dates here in the app.${j.secured ? "" : " Tip: set a CAL_FEED_KEY env var in Vercel to keep this link private."}</div>
      </div>`;
    const copy = $("#calCopy");
    copy.onclick = async () => {
      const inp = $("#calFeedUrl");
      try { await navigator.clipboard.writeText(inp.value); toast("Feed link copied"); }
      catch { inp.select(); document.execCommand("copy"); toast("Feed link copied"); }
    };
  }).catch(() => { body.innerHTML = `<div class="cal-sync">Couldn't build the feed link.</div>`; });
}

/* ---- Wiring ----------------------------------------------------------------*/
function wireBoard() {
  document.querySelectorAll(".card[data-id]").forEach((c) => {
    c.addEventListener("click", () => { if (!c.classList.contains("dragging")) openDrawer(c.dataset.id); });
    c.addEventListener("dragstart", (e) => { c.classList.add("dragging"); e.dataTransfer.setData("text/id", c.dataset.id); });
    c.addEventListener("dragend", () => c.classList.remove("dragging"));
  });
  document.querySelectorAll(".card[data-album]").forEach((c) =>
    c.addEventListener("click", () => openAlbumDrawer(c.dataset.album)));

  document.querySelectorAll(".play-btn[data-play]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); playTrack(b.dataset.play); }));

  document.querySelectorAll(".lyr-btn[data-lyr]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); openTeleprompter(b.dataset.lyr); }));
  document.querySelectorAll(".lyr-btn[data-fb]").forEach((b) =>
    b.addEventListener("click", async (e) => { e.stopPropagation(); const id = b.dataset.fb; if (state.audio.currentId && state.audio.currentId !== id && audioFor(trackById(id))) { if (await confirmDialog("Another song is playing. Play this one instead?", { title: "Switch song?", okText: "Play it" })) playTrack(id); } openNotesBar(id); }));
  document.querySelectorAll("[data-verxfer]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); openVersionTransfer(b.dataset.verxfer); }));

  document.querySelectorAll("[data-playalbum]").forEach((b) => b.onclick = () => playAlbum(b.dataset.playalbum));
  document.querySelectorAll(".trow[data-tid]").forEach((r) =>
    r.addEventListener("click", () => { const t = state.data.tracks.find((x) => x.id === r.dataset.tid); if (t) openDrawer(t.id); }));

  document.querySelectorAll(".song-task-main input[data-phasechk]").forEach((c) => c.addEventListener("change", async (e) => {
    const l = c.closest(".song-task"); const pid = l.dataset.phase;
    const done = e.target.checked;
    const fields = { status: done ? "Done" : "Not started" };
    if (!done) { const ph = (state.data.phases || []).find((p) => p.id === pid); if (ph && !ph.due) fields.due = todayISO(); }
    const r = await update("phase", pid, fields);
    if (r.ok) { toast("Updated"); refresh(); } else { e.target.checked = !e.target.checked; }
  }));
  document.querySelectorAll(".song-sub input[data-subchk]").forEach((c) => c.addEventListener("change", (e) => {
    const key = c.dataset.subchk; const ix = key.lastIndexOf(":"); toggleSub(key.slice(0, ix), +key.slice(ix + 1), e.target.checked);
  }));

  // Assignments page: clicking a song tile (or its title) opens the track drawer,
  // except when the click lands on a phase checkbox.
  document.querySelectorAll(".song-card[data-song]").forEach((card) =>
    card.addEventListener("click", (e) => {
      if (e.target.closest(".song-task")) return;
      openDrawer(card.dataset.song);
    }));
  document.querySelectorAll("[data-asg]").forEach((b) => b.onclick = () => { asgGroup = b.dataset.asg; render(); });
  document.querySelectorAll("[data-asgme]").forEach((b) => b.onclick = () => { asgOnlyMe = !asgOnlyMe; render(); });
  document.querySelectorAll("#main .note-time[data-nseek]").forEach((b) => b.onclick = () => seekTo(b.dataset.ntrack, Math.max(0, Number(b.dataset.nseek) - preRoll)));
  document.querySelectorAll("#main [data-nresolve]").forEach((b) => b.onclick = async () => { const r = await update("feedback", b.dataset.nresolve, { status: "Resolved" }); if (r.ok) { toast("Resolved"); refresh(); } });
  document.querySelectorAll("#main [data-ndel]").forEach((b) => b.onclick = async () => { if (!(await confirmDialog("Delete this note? This can\u2019t be undone.", { title: "Delete note", okText: "Delete", danger: true }))) return; const r = await deleteEntity("feedback", b.dataset.ndel); if (r.ok) { toast("Deleted"); refresh(); } });
  wireNoteCtrls(document.getElementById("main"));

  document.querySelectorAll(".mcard[data-member]").forEach((card) => {
    const id = card.dataset.member;
    card.querySelectorAll("[data-mf]").forEach((inp) => inp.addEventListener("change", async () => {
      const r = await update("member", id, { [inp.dataset.mf]: inp.value.trim() });
      if (r.ok) { toast("Saved"); refresh(false); }
    }));
  });
  const rAdd = document.getElementById("rosterAdd");
  if (rAdd) rAdd.onclick = async () => { const r = await createEntity("member", { name: "New member" }); if (r.ok) { toast("Member added"); refresh(false); } };
  document.querySelectorAll("[data-medit]").forEach((b) => b.onclick = () => { editingMembers.add(b.dataset.medit); render(); });
  document.querySelectorAll("[data-medone]").forEach((b) => b.onclick = () => { editingMembers.delete(b.dataset.medone); render(); });
  document.querySelectorAll("[data-mcolor]").forEach((b) => b.onclick = async () => {
    const [id, c] = b.dataset.mcolor.split(":");
    const r = await update("member", id, { color: c });
    if (r.ok) { toast("Color set"); refresh(false); }
  });
  // Toggle which production phases a member owns (their "Default Phases").
  document.querySelectorAll("[data-mphase]").forEach((inp) => inp.addEventListener("change", async () => {
    const sep = inp.dataset.mphase.indexOf(":");
    const id = inp.dataset.mphase.slice(0, sep);
    const phase = inp.dataset.mphase.slice(sep + 1);
    const m = state.data.members.find((x) => x.id === id);
    if (!m) return;
    const set = new Set(m.phases || []);
    if (inp.checked) set.add(phase); else set.delete(phase);
    const next = phaseNames().filter((p) => set.has(p)); // keep canonical order
    const r = await update("member", id, { phases: next });
    if (r.ok) { toast("Assignments saved"); m.phases = next; } else { inp.checked = !inp.checked; }
  }));
  const applyBtn = document.getElementById("applyPhases");
  if (applyBtn) applyBtn.onclick = async () => {
    if (!(await confirmDialog("Update every existing track's phase owners to match these assignments? Any manual per-track owner tweaks will be overwritten.", { title: "Apply to all tracks?", okText: "Apply" }))) return;
    applyBtn.disabled = true; applyBtn.textContent = "Applying…";
    try {
      const res = await fetch("/api/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity: "reassign" }) });
      const j = await res.json();
      if (res.ok && j.ok) { toast(`Updated ${j.changed} phase${j.changed === 1 ? "" : "s"}`); await refresh(false); }
      else toast(j.error || "Failed");
    } catch (e) { toast("Failed"); }
    applyBtn.disabled = false; applyBtn.textContent = "Apply to all tracks";
  };

  document.querySelectorAll(".col[data-stage]").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault(); col.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/id");
      const stage = col.dataset.stage;
      const entity = col.dataset.entity === "album" ? "album" : "track";
      if (!id) return;
      const fields = entity === "track" ? { stage, onHold: false } : { stage };
      const r = await update(entity, id, fields);
      if (r.ok) { toast(`Moved to ${stage}`); refresh(false); }
    });
  });

  document.querySelectorAll(".col[data-hold]").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault(); col.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/id");
      if (!id) return;
      const r = await update("track", id, { onHold: true });
      if (r.ok) { toast("Put on hold"); refresh(false); }
    });
  });

  document.querySelectorAll("[data-cal]").forEach((b) =>
    b.addEventListener("click", () => { const n = Number(b.dataset.cal); if (calView === "week") calMonth.setDate(calMonth.getDate() + 7 * n); else calMonth.setMonth(calMonth.getMonth() + n); render(); }));
  document.querySelectorAll("[data-calview]").forEach((b) => b.onclick = () => { calView = b.dataset.calview; render(); });
  { const sf = document.getElementById("calSongFilter"); if (sf) sf.onchange = () => { calSong = sf.value; render(); }; }
  { const cs = document.getElementById("calSubBtn"); if (cs) cs.onclick = openCalSync; }
  { const cp = document.getElementById("calPlanBtn"); if (cp) cp.onclick = openPlanModal; }
  document.querySelectorAll(".cal-task[data-ct], .cal-deadline[data-cd]").forEach((el) => {
    el.addEventListener("dragstart", (e) => { el.classList.add("dragging"); const kind = el.dataset.ct ? "phase" : "track"; e.dataTransfer.setData("text/cal", kind + ":" + (el.dataset.ct || el.dataset.cd)); e.dataTransfer.effectAllowed = "move"; });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
  });
  document.querySelectorAll(".cal-cell[data-day]").forEach((cell) => {
    cell.addEventListener("dragover", (e) => { if ((e.dataTransfer.types || []).includes && [].slice.call(e.dataTransfer.types).indexOf("text/cal") >= 0) { e.preventDefault(); cell.classList.add("cal-over"); } });
    cell.addEventListener("dragleave", () => cell.classList.remove("cal-over"));
    cell.addEventListener("drop", async (e) => {
      e.preventDefault(); cell.classList.remove("cal-over");
      const data = e.dataTransfer.getData("text/cal"); if (!data) return;
      const ix = data.indexOf(":"); const kind = data.slice(0, ix), idv = data.slice(ix + 1); const day = cell.dataset.day;
      const r = kind === "phase" ? await update("phase", idv, { due: day }) : await update("track", idv, { dueDate: day });
      if (r.ok) { toast("Rescheduled to " + fmtDay(day)); refresh(false); }
    });
  });
  document.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => openDrawer(b.dataset.open)));
}

/* ---- Reusable form bits ----------------------------------------------------*/
function memberChecks(members, selectedIds) {
  return `<div class="owner-picker">` + members.map((m) =>
    `<label class="owner-chip"><input type="checkbox" value="${m.id}" ${selectedIds.includes(m.id) ? "checked" : ""}/> ${esc(m.name)}</label>`
  ).join("") + `</div>`;
}
function selectedOwnerIds(scope) {
  return [...scope.querySelectorAll(".owner-picker input:checked")].map((i) => i.value);
}
function stageSelect(id, current, stages) {
  return `<select id="${id}">${stages.map((s) => `<option ${s === current ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>`;
}
function ipDatalist() {
  return `<datalist id="ipList">${ipOptions().map((x) => `<option value="${esc(x)}"></option>`).join("")}</datalist>`;
}
function openShell(html) {
  $("#drawer").innerHTML = html;
  $("#scrim").classList.add("open");
  $("#drawer").classList.add("open");
  const c = $("#closeDrawer");
  if (c) c.addEventListener("click", closeDrawer);
}

/* ---- Drawer: track (edit) --------------------------------------------------*/
function openDrawer(id) {
  const t = state.data.tracks.find((x) => x.id === id);
  if (!t) return;
  const _prevBody = (state.openTrackId === id) ? document.querySelector("#drawer .dbody") : null;
  const _keepScroll = _prevBody ? _prevBody.scrollTop : 0;
  state.openTrackId = id;
  const members = state.data.members;
  const albums = state.data.albums;
  const stages = state.data.stages;

  const gateNote = t.phasesTotal
    ? `<div class="gate-note ${t.productionComplete ? "ok" : ""}">${t.productionComplete ? "Production complete — clear to advance." : `${t.phasesDone}/${t.phasesTotal} phases done — finish all to reach Mixing.`}</div>`
    : "";

  const canonPhases = state.data.phaseNames || [];
  const phaseRows = t.phases.map((p) => {
    const done = p.status === "Done";
    const m = memberById(p.ownerIds[0]);
    const col = m && m.color ? m.color : "#6a6478";
    const custom = !canonPhases.includes(p.phase);
    const ownerLabel = (p.owners && p.owners.length) ? esc(p.owners.join(", ")) : "Unassigned";
    const ownerChecks = state.data.members.map((mm) => `<label class="owner-opt"><input type="checkbox" data-owner="${p.id}:${mm.id}" ${p.ownerIds.includes(mm.id) ? "checked" : ""} /> ${esc(mm.display)}</label>`).join("");
    const subs = Array.isArray(p.subtasks) ? p.subtasks : [];
    const sdone = subs.filter((x) => x.done).length;
    const open = !collapsedSubs.has(p.id) && (subs.length > 0 || expandedSubs.has(p.id));
    const subItems = subs.map((st, i) => `<div class="sub-item${newlyAddedSub === p.id + ":" + i ? " just-added" : ""}"><input type="checkbox" data-subchk="${p.id}:${i}" ${st.done ? "checked" : ""} /><span class="st-text${st.done ? " done" : ""}">${esc(st.text)}</span><select class="sub-owner" data-subowner="${p.id}:${i}" title="Assign subtask"><option value="">\u2014</option>${state.data.members.map((mm) => `<option value="${mm.id}"${st.owner === mm.id ? " selected" : ""}>${esc(mm.display)}</option>`).join("")}</select><button class="sub-del" data-subdel="${p.id}:${i}" title="Delete">&times;</button></div>`).join("");
    return `
      <div class="phase-block" style="--own:${col}">
        <div class="phase-row2 ${done ? "done" : ""}${custom ? " custom" : ""}" data-phase="${p.id}">
          <input type="checkbox" data-pf="done" ${done ? "checked" : ""} />
          <span class="pname2${custom ? " is-custom" : ""}">${esc(p.phase)}${custom ? ` <span class="cust-dot" title="Custom phase — unique to this song"></span>` : ""}</span>
          <button class="sub-toggle${open ? " open" : ""}" data-subtoggle="${p.id}" title="Subtasks">&#9745; ${subs.length ? `${sdone}/${subs.length}` : "+"}</button>
          <details class="powner-det"><summary class="powner-sum" title="Assign owner(s)"><span data-ownersum="${p.id}">${ownerLabel}</span></summary><div class="powner-menu">${ownerChecks}</div></details>
          <input type="date" class="pdue" data-pf="due" value="${p.due || ""}" title="Phase due date" />
          ${custom ? `<button class="pdel" data-pdel="${p.id}" title="Remove this phase">&times;</button>` : ""}
        </div>
        <div class="subtasks${open ? " open" : ""}" data-subpanel="${p.id}">
          ${subItems || `<div class="sub-empty">No subtasks yet.</div>`}
          <div class="sub-add"><span class="sub-plus">+</span><input type="text" data-subnew="${p.id}" placeholder="Add subtask" /><button class="sub-addbtn" data-subadd="${p.id}">Add</button></div>
        </div>
      </div>`;
  }).join("");

  const links = [];
  if (t.songLink) links.push(`<a class="chip" href="${esc(t.songLink)}" target="_blank" rel="noopener">Original song</a>`);
  if (t.projectFile) links.push(`<a class="chip" href="${esc(t.projectFile)}" target="_blank" rel="noopener">Project file</a>`);

  openShell(`
    <div class="dhead">
      <div style="flex:1"><input id="dTitle" type="text" value="${esc(t.title)}" class="title-edit" title="Click to rename" /></div>
      <button class="icon-btn close" id="closeDrawer">&times;</button>
    </div>
    <div class="dbody">
      ${artFieldHTML("track", t.id, t.cover)}
      <div class="row2">
        <div class="field"><label>Stage</label>${stageSelect("dStage", t.stage, stages)}</div>
        <div class="field"><label>Inspired by (game / IP)</label><input id="dIP" list="ipList" value="${esc(t.inspiredBy)}" />${ipDatalist()}</div>
      </div>
      ${gateNote}
      <div class="row2">
        <div class="field"><label>Album</label><select id="dAlbum"><option value="">— Unassigned —</option>${albums.map((a) => `<option value="${a.id}" ${t.albumId === a.id ? "selected" : ""}>${esc(a.title)}</option>`).join("")}</select></div>
        <div class="field"><label>Status</label><label class="owner-chip" style="margin-top:2px"><input type="checkbox" id="dHold" ${t.onHold ? "checked" : ""} /> On hold</label></div>
      </div>
      <div class="field"><label>Reference (stage / theme)</label><input id="dRef" type="text" value="${esc(t.reference)}" /></div>
      <div class="row2">
        <div class="field"><label>BPM</label><input id="dBpm" type="number" value="${t.bpm ?? ""}" /></div>
        <div class="field"><label>Key</label><input id="dKey" type="text" value="${esc(t.key)}" /></div>
      </div>
      <div class="field"><label>Due date</label><input id="dDue" type="date" value="${t.dueDate || ""}" /></div>
      <div class="row2">
        <div class="field"><label>Original song link</label><input id="dSong" type="text" value="${esc(t.songLink)}" placeholder="https://…" /></div>
        <div class="field"><label>Project file</label><input id="dProj" type="text" value="${esc(t.projectFile)}" placeholder="https://…" /></div>
      </div>
      ${links.length ? `<div class="field"><label>Open</label><div class="chip-links">${links.join("")}</div></div>` : ""}
      ${audioFor(t) ? `<div class="field"><label>Latest bounce</label><button class="add-btn" id="dPlay">Play &middot; ${esc(audioFor(t).name)}</button></div>` : ""}
      <div class="field">
        <label>Production phases</label>
        ${phaseRows}
        <div class="addphase"><input id="newPhaseName" type="text" placeholder="Add a custom phase for this song…" /><button class="add-btn ghost" id="addPhaseBtn">+ Add phase</button></div>
      </div>
      <div class="field"><label>Notes</label><textarea id="dNotes">${esc(t.notes)}</textarea></div>
      <div class="field">
        <label>Lyrics</label>
        <div class="drawer-actions" style="margin-top:0">
          <button class="add-btn ghost" id="dTele">Open lyrics / teleprompter</button>
        </div>
      </div>
      <div class="field"><label>Notes</label><button class="add-btn ghost" id="dFbBtn">Open notes${fbLabel(t)}</button></div>
      <div class="field"><label>Versions (from Dropbox)</label><div id="dVersions"><button class="fb-mini" id="dVerLoad">Show version history</button></div></div>
      <div class="field"><label>Dropbox project folder</label><button class="add-btn ghost" id="dMakeFolder">Create this song's folder</button></div>
      <div class="drawer-actions">
        <button class="danger-btn" id="dDelete">Delete track</button>
      </div>
    </div>`);

  $("#dStage").addEventListener("change", async (e) => {
    const r = await update("track", id, { stage: e.target.value });
    if (r.ok) { toast(`Stage → ${e.target.value}`); refresh(); } else { e.target.value = t.stage; }
  });
  const save = (sel, key, transform = (v) => v, reload = false) =>
    $(sel).addEventListener("change", async (e) => {
      const r = await update("track", id, { [key]: transform(e.target.value) });
      if (r.ok) { toast("Saved"); if (reload) refresh(); }
    });
  save("#dTitle", "title", (v) => v.trim() || "Untitled", true);
  save("#dIP", "inspiredBy", (v) => v.trim(), true);
  save("#dRef", "reference", (v) => v.trim(), true);
  save("#dBpm", "bpm", (v) => (v === "" ? null : Number(v)));
  save("#dKey", "key");
  save("#dDue", "dueDate", (v) => v || null, true);
  save("#dSong", "songLink", (v) => v.trim(), true);
  save("#dProj", "projectFile", (v) => v.trim(), true);
  save("#dNotes", "notes");

  document.querySelectorAll(".phase-row2").forEach((row) => {
    row.querySelector('[data-pf="done"]').addEventListener("change", async (e) => {
      const done = e.target.checked;
      const fields = { status: done ? "Done" : "Not started" };
      if (!done) { const ph = (state.data.phases || []).find((p) => p.id === row.dataset.phase); if (ph && !ph.due) fields.due = todayISO(); }
      const r = await update("phase", row.dataset.phase, fields);
      if (r.ok) { toast(done ? "Marked done" : "Reopened — added to today's calendar"); refresh(); }
      else { e.target.checked = !e.target.checked; }
    });
    const du = row.querySelector('[data-pf="due"]');
    if (du) du.addEventListener("change", async (e) => {
      const r = await update("phase", row.dataset.phase, { due: e.target.value || null });
      if (r.ok) toast(e.target.value ? "Phase date set" : "Phase date cleared");
    });
    row.querySelectorAll('[data-owner]').forEach((c) => c.addEventListener("change", async () => {
      const pid = row.dataset.phase;
      const ids = [...row.querySelectorAll('[data-owner]')].filter((x) => x.checked).map((x) => x.dataset.owner.slice(x.dataset.owner.indexOf(":") + 1));
      const r = await update("phase", pid, { ownerIds: ids });
      if (r.ok) { const sp = row.querySelector('[data-ownersum]'); if (sp) sp.textContent = ids.length ? ids.map((mid) => { const mm = memberById(mid); return mm ? mm.display : "?"; }).join(", ") : "Unassigned"; refresh(false); }
    }));
  });
  { const ap = $("#addPhaseBtn"); if (ap) ap.onclick = async () => {
      const nm = ($("#newPhaseName").value || "").trim();
      if (!nm) { toast("Name the phase first", true); return; }
      const r = await createEntity("phase", { trackId: id, phase: nm });
      if (r.ok) { toast("Phase added"); await refresh(false); openDrawer(id); } else toast((r && r.error) || "Couldn't add phase", true);
    }; }
  { const np = $("#newPhaseName"); if (np) np.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#addPhaseBtn").click(); } }); }
  document.querySelectorAll("[data-pdel]").forEach((b) => b.onclick = async () => {
    if (!(await confirmDialog("Remove this phase from the song?", { title: "Remove phase", okText: "Remove", danger: true }))) return;
    const r = await deleteEntity("phase", b.dataset.pdel);
    if (r.ok) { toast("Phase removed"); await refresh(false); openDrawer(id); } else toast((r && r.error) || "Couldn't remove", true);
  });
  // Subtasks (stored as JSON on each phase)
  const phaseArr = (pid) => { const ph = (state.data.phases || []).find((p) => p.id === pid); return Array.isArray(ph && ph.subtasks) ? ph.subtasks.map((x) => ({ text: x.text, done: !!x.done, owner: x.owner || null, note: x.note || null })) : []; };
  const saveSubs = async (pid, arr) => { expandedSubs.add(pid); const r = await update("phase", pid, { subtasks: JSON.stringify(arr) }); if (r.ok) { await refresh(false); openDrawer(id); } return r; };
  document.querySelectorAll("#drawer [data-subtoggle]").forEach((b) => b.onclick = () => {
    const pid = b.dataset.subtoggle; const panel = document.querySelector(`[data-subpanel="${pid}"]`);
    const nowOpen = !(panel && panel.classList.contains("open"));
    if (nowOpen) { expandedSubs.add(pid); collapsedSubs.delete(pid); } else { expandedSubs.delete(pid); collapsedSubs.add(pid); }
    b.classList.toggle("open", nowOpen); if (panel) panel.classList.toggle("open", nowOpen);
  });
  document.querySelectorAll("#drawer [data-subchk]").forEach((c) => c.addEventListener("change", async (e) => {
    const ix = c.dataset.subchk.lastIndexOf(":"); const pid = c.dataset.subchk.slice(0, ix), i = +c.dataset.subchk.slice(ix + 1);
    const arr = phaseArr(pid); if (arr[i]) { const note = arr[i].note; arr[i].done = e.target.checked; await saveSubs(pid, arr); if (note) await update("feedback", note, { status: e.target.checked ? "Resolved" : "Open" }); }
  }));
  document.querySelectorAll("#drawer [data-subdel]").forEach((b) => b.onclick = async () => {
    const ix = b.dataset.subdel.lastIndexOf(":"); const pid = b.dataset.subdel.slice(0, ix), i = +b.dataset.subdel.slice(ix + 1);
    const arr = phaseArr(pid); arr.splice(i, 1); await saveSubs(pid, arr);
  });
  document.querySelectorAll("#drawer [data-subadd]").forEach((b) => b.onclick = async () => {
    const pid = b.dataset.subadd; const inp = document.querySelector(`#drawer [data-subnew="${pid}"]`); const txt = ((inp && inp.value) || "").trim();
    if (!txt) { toast("Type a subtask first", true); return; }
    const arr = phaseArr(pid);
    const ph0 = (state.data.phases || []).find((p) => p.id === pid);
    arr.push({ text: txt, done: false, owner: (ph0 && ph0.ownerIds && ph0.ownerIds[0]) || null });
    newlyAddedSub = pid + ":" + (arr.length - 1);
    await saveSubs(pid, arr);
    newlyAddedSub = null;
    const ninp = document.querySelector(`#drawer [data-subnew="${pid}"]`); if (ninp) ninp.focus();
  });
  document.querySelectorAll("#drawer [data-subnew]").forEach((inp) => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const b = document.querySelector(`[data-subadd="${inp.dataset.subnew}"]`); if (b) b.click(); } }));
  document.querySelectorAll("#drawer [data-subowner]").forEach((sel) => sel.addEventListener("change", async (e) => {
    const key = sel.dataset.subowner; const ix = key.lastIndexOf(":"); const pid = key.slice(0, ix), i = +key.slice(ix + 1);
    const arr = phaseArr(pid); if (arr[i]) { arr[i].owner = e.target.value || null; const r = await update("phase", pid, { subtasks: JSON.stringify(arr) }); if (r.ok) refresh(false); }
  }));

  $("#dAlbum").addEventListener("change", async (e) => {
    const r = await update("track", id, { albumId: e.target.value || "" });
    if (r.ok) { toast("Album updated"); closeDrawer(); refresh(false); }
  });
  $("#dHold").addEventListener("change", async (e) => {
    const r = await update("track", id, { onHold: e.target.checked });
    if (r.ok) { toast(e.target.checked ? "Put on hold" : "Resumed"); refresh(); }
  });

  const dPlay = $("#dPlay");
  if (dPlay) dPlay.onclick = () => playTrack(t.id);
  $("#dTele").onclick = () => openTeleprompter(id);
  $("#dVerLoad").onclick = () => loadVersions(t);
  $("#dMakeFolder").onclick = async () => {
    if (!(await confirmDialog(`Create the Dropbox project folder (with a Bounces subfolder) for \u201c${t.title}\u201d?`, { title: "Create folder?", okText: "Create" }))) return;
    toast("Creating folder…");
    const r = await post("/api/makefolders", { trackId: id });
    if (r.ok) { toast(r.created && r.created.length ? "Folder created" : "Folder already exists"); await refresh(false); await fetchPlaylist(); openDrawer(id); }
  };
  $("#dFbBtn").addEventListener("click", () => openNotesBar(t.id));

  $("#dDelete").addEventListener("click", async () => {
    if (!(await confirmDialog(`Delete \u201c${t.title}\u201d and its 5 phases? This can't be undone.`, { title: "Delete track", okText: "Delete", danger: true }))) return;
    const r = await deleteEntity("track", id);
    if (r.ok) { toast("Track deleted"); closeDrawer(); refresh(false); }
  });
  wireArt();
  const _nb = document.querySelector("#drawer .dbody"); if (_nb && _keepScroll) _nb.scrollTop = _keepScroll;
}

/* ---- Drawer: album (edit) --------------------------------------------------*/
function openAlbumDrawer(id) {
  const a = state.data.albums.find((x) => x.id === id);
  if (!a) return;
  const stages = state.data.stages;
  openShell(`
    <div class="dhead"><div style="flex:1"><input id="aTitle" type="text" value="${esc(a.title)}" class="title-edit" title="Click to rename" /></div><button class="icon-btn close" id="closeDrawer">&times;</button></div>
    <div class="dbody">
      ${artFieldHTML("album", a.id, a.cover)}
      <div class="row2">
        <div class="field"><label>Artist</label><input id="aArtist" type="text" value="${esc(a.artist)}" /></div>
        <div class="field"><label>Stage</label>${stageSelect("aStage", a.stage, stages)}</div>
      </div>
      <div class="row2">
        <div class="field"><label>Genre</label><input id="aGenre" type="text" value="${esc(a.genre)}" /></div>
        <div class="field"><label>Release date</label><input id="aRelease" type="date" value="${a.releaseDate || ""}" /></div>
      </div>
      <div class="field"><label>Dashboard default</label><label class="owner-chip" style="margin-top:2px"><input type="checkbox" id="aCurrent" ${a.current ? "checked" : ""} /> Current album — the Dashboard opens to this on a fresh load</label></div>
      <div class="field"><label>Dropbox album folder</label><input id="aFolder" type="text" value="${esc(a.dropboxFolder)}" placeholder="/Your/Folder/Path  or  https://…share link" /><div class="gate-note ok" style="color:var(--muted)">A folder path works with your current scopes; a share link needs Dropbox 'sharing.read'.</div></div>
      <div class="field"><label>Project folder prefix</label><input id="aPrefix" type="text" value="${esc(a.trackPrefix)}" placeholder="e.g. The Belmonts" /><div class="gate-note ok" style="color:var(--muted)">Reads folders named PREFIX_##_Song, pulling audio from each song's “Bounces”.</div></div>
      <div class="field"><label>Add a production phase to every track</label><div class="addphase"><input id="albPhaseName" type="text" placeholder="e.g. Orchestration" /><button class="add-btn ghost" id="albPhaseAdd">+ Add to all tracks</button></div><div class="gate-note ok" style="color:var(--muted)">Adds this phase to every song in the album (skips songs that already have it).</div></div>
      <div class="field"><label>Concept / Notes</label><textarea id="aNotes" style="min-height:200px">${esc(a.notes)}</textarea></div>
      <div class="drawer-actions"><button class="danger-btn" id="aDelete">Delete album</button></div>
    </div>`);
  const save = (sel, key, transform = (v) => v, reload = false) =>
    $(sel).addEventListener("change", async (e) => {
      const r = await update("album", id, { [key]: transform(e.target.value) });
      if (r.ok) { toast("Saved"); if (reload) refresh(false); }
    });
  save("#aTitle", "title", (v) => v.trim() || "Untitled album", true);
  save("#aArtist", "artist", (v) => v.trim(), true);
  save("#aStage", "stage", (v) => v, true);
  save("#aGenre", "genre");
  save("#aRelease", "releaseDate", (v) => v || null);
  save("#aNotes", "notes");
  const saveFolder = (sel, key) => $(sel).addEventListener("change", async (e) => {
    const r = await update("album", id, { [key]: e.target.value.trim() });
    if (r.ok) { toast("Saved"); await refresh(false); await fetchPlaylist(); render(); }
  });
  saveFolder("#aFolder", "dropboxFolder");
  saveFolder("#aPrefix", "trackPrefix");
  { const ab = $("#albPhaseAdd"); if (ab) ab.onclick = async () => {
      const nm = ($("#albPhaseName").value || "").trim();
      if (!nm) { toast("Name the phase first", true); return; }
      ab.disabled = true; ab.textContent = "Adding…";
      const r = await createEntity("albumphase", { albumId: id, phase: nm });
      if (r.ok) { toast(`Added to ${r.added} track(s)` + (r.skipped ? `, ${r.skipped} already had it` : "")); await refresh(false); openAlbumDrawer(id); }
      else { toast((r && r.error) || "Couldn't add", true); ab.disabled = false; ab.textContent = "+ Add to all tracks"; }
    }; }
  { const ai = $("#albPhaseName"); if (ai) ai.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#albPhaseAdd").click(); } }); }
  // Only one album can be Current — checking this one clears the flag on the others.
  $("#aCurrent").addEventListener("change", async (e) => {
    const on = e.target.checked;
    if (on) {
      const others = state.data.albums.filter((x) => x.id !== id && x.current);
      await Promise.all(others.map((x) => update("album", x.id, { current: false })));
    }
    const r = await update("album", id, { current: on });
    if (r.ok) { toast(on ? "Set as current album" : "Cleared current album"); if (on) state.filters.albumId = id; await refresh(false); render(); }
  });
  $("#aDelete").addEventListener("click", async () => {
    if (!(await confirmDialog(`Delete album \u201c${a.title}\u201d? This only works if it has no tracks.`, { title: "Delete album", okText: "Delete", danger: true }))) return;
    const r = await deleteEntity("album", id);
    if (r.ok) { toast("Album deleted"); closeDrawer(); state.filters.albumId = ""; refresh(false); }
  });
  wireArt();
}

/* ---- Drawer: create --------------------------------------------------------*/
function openCreateTrack() {
  const stages = state.data.stages;
  const albums = state.data.albums;
  const cur = currentAlbum();
  const defAlb = cur ? cur.id : "";
  openShell(`
    <div class="dhead"><div><h2>New track</h2></div><button class="icon-btn close" id="closeDrawer">&times;</button></div>
    <div class="dbody">
      <div class="field"><label>Title</label><input id="cTitle" type="text" placeholder="Song title" autofocus /></div>
      <div class="row2">
        <div class="field"><label>Album</label><select id="cAlbum"><option value="">— Unassigned —</option>${albums.map((a) => `<option value="${a.id}" ${a.id === defAlb ? "selected" : ""}>${esc(a.title)}</option>`).join("")}</select></div>
        <div class="field"><label>Stage</label>${stageSelect("cStage", "Idea", stages)}</div>
      </div>
      <div class="field"><label>Inspired by (game / IP)</label><input id="cIP" list="ipList" placeholder="e.g. Castlevania 1" />${ipDatalist()}</div>
      <div class="field"><label>Reference (stage / theme)</label><input id="cRef" type="text" placeholder="e.g. Stage 1" /></div>
      <div class="row2">
        <div class="field"><label>Original song link</label><input id="cSong" type="text" placeholder="https://…" /></div>
        <div class="field"><label>Project file</label><input id="cProj" type="text" placeholder="https://…" /></div>
      </div>
      <div class="field"><label>Notes</label><textarea id="cNotes"></textarea></div>
      <div class="drawer-actions"><button class="add-btn" id="cCreate">Create track (+ phases)</button></div>
    </div>`);
  $("#cCreate").addEventListener("click", async () => {
    const albumId = $("#cAlbum").value;
    const fields = {
      albumId: albumId || undefined,
      title: $("#cTitle").value.trim() || "New track",
      stage: $("#cStage").value,
      inspiredBy: $("#cIP").value.trim(),
      reference: $("#cRef").value.trim(),
      songLink: $("#cSong").value.trim(),
      projectFile: $("#cProj").value.trim(),
      notes: $("#cNotes").value,
      order: (state.data.tracks.filter((t) => t.albumId === albumId).length + 1),
    };
    const r = await createEntity("track", fields);
    if (r.ok) { toast("Track created"); if (albumId) state.filters.albumId = albumId; await refresh(false); openDrawer(r.id); }
  });
}

function openCreateAlbum() {
  const stages = state.data.stages;
  openShell(`
    <div class="dhead"><div><h2>New album</h2></div><button class="icon-btn close" id="closeDrawer">&times;</button></div>
    <div class="dbody">
      <div class="field"><label>Title</label><input id="cTitle" type="text" placeholder="Album title" autofocus /></div>
      <div class="row2">
        <div class="field"><label>Artist</label><input id="cArtist" type="text" value="The Megas" /></div>
        <div class="field"><label>Stage</label>${stageSelect("cStage", "Idea", stages)}</div>
      </div>
      <div class="field"><label>Genre</label><input id="cGenre" type="text" placeholder="e.g. Video Game Metal" /></div>
      <div class="field"><label>Playlist link</label><input id="cPlaylist" type="text" placeholder="https://…" /></div>
      <div class="field"><label>Concept / Notes</label><textarea id="cNotes" style="min-height:140px"></textarea></div>
      <div class="drawer-actions"><button class="add-btn" id="cCreate">Create album</button></div>
    </div>`);
  $("#cCreate").addEventListener("click", async () => {
    const fields = {
      title: $("#cTitle").value.trim() || "Untitled album",
      artist: $("#cArtist").value.trim() || "The Megas",
      stage: $("#cStage").value,
      genre: $("#cGenre").value.trim(),
      playlist: $("#cPlaylist").value.trim(),
      notes: $("#cNotes").value,
    };
    const r = await createEntity("album", fields);
    if (r.ok) { toast("Album created"); state.filters.albumId = r.id; await refresh(false); openAlbumDrawer(r.id); }
  });
}

function closeDrawer() {
  state.openTrackId = null;
  $("#scrim").classList.remove("open");
  $("#drawer").classList.remove("open");
}

/* ---- Audio playlist --------------------------------------------------------*/
async function fetchPlaylist() {
  const byTrack = {}, order = {};
  let configured = state.audio.configured;
  const albums = (state.data && state.data.albums) ? state.data.albums.filter((a) => a.dropboxFolder) : [];
  for (const alb of albums) {
    try {
      const u = "/api/playlist?folder=" + encodeURIComponent(alb.dropboxFolder) + "&prefix=" + encodeURIComponent(alb.trackPrefix || "");
      const r = await fetch(u, { headers: { "Cache-Control": "no-store" } });
      if (!r.ok) continue;
      const j = await r.json();
      configured = !!j.configured || configured;
      const idx = {};
      (j.items || []).forEach((it) => { idx[normTitle(it.title)] = it; });
      state.data.tracks.filter((t) => t.albumId === alb.id).forEach((t) => {
        const it = idx[normTitle(t.title)];
        if (it) { order[t.id] = it.order; if (it.url) byTrack[t.id] = it; } // order from Dropbox even if no bounce yet
      });
    } catch {}
  }
  state.audio.byTrack = byTrack;
  state.audio.order = order;
  state.audio.configured = configured;
}

const audioEl = () => document.getElementById("audio");
function playQueue() {
  const alb = currentAlbum();
  return state.data.tracks
    .filter((t) => (!alb || t.albumId === alb.id) && !t.onHold && audioFor(t))
    .sort((a, b) => effOrder(a) - effOrder(b))
    .map((t) => t.id);
}
const fmt = (s) => (isNaN(s) ? "0:00" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);

let triedRelink = false;
let albumRoll = false;
function playTrack(id, keepRoll) {
  const item = audioFor(trackById(id));
  if (!item) return;
  const a = audioEl();
  if (state.audio.currentId === id) { a.paused ? a.play().catch(() => {}) : a.pause(); return; }
  if (!keepRoll) albumRoll = false;
  state.audio.currentId = id;
  if (!state.audio.queue || !state.audio.queue.includes(id)) state.audio.queue = playQueue();
  triedRelink = false;
  a.src = item.url;
  a.play().catch(() => {});
  renderPlayer();
  const nb = document.getElementById("notesbar");
  if (nb && nb.classList.contains("open") && notesBarTrack !== id) { notesBarTrack = id; notesTimeLocked = false; renderNotesBar(); }
}
function playNext(dir = 1) {
  const q = (state.audio.queue && state.audio.queue.length) ? state.audio.queue : playQueue();
  const i = q.indexOf(state.audio.currentId);
  const ni = i < 0 ? 0 : i + dir;
  if (ni >= 0 && ni < q.length) playTrack(q[ni], true);
}
function playAlbum(albumId) {
  const q = state.data.tracks.filter((t) => t.albumId === albumId && audioFor(t)).sort((a, b) => effOrder(a) - effOrder(b)).map((t) => t.id);
  if (!q.length) { toast("No audio in this album yet", true); return; }
  state.audio.queue = q;
  albumRoll = true;
  playTrack(q[0], true);
}

function updatePlayButtons() {
  document.querySelectorAll(".play-btn[data-play]").forEach((b) => {
    const on = b.dataset.play === state.audio.currentId && state.audio.playing;
    b.classList.toggle("playing", on);
    b.innerHTML = on ? "&#9208;&#xFE0E;" : "&#9654;&#xFE0E;";
  });
}

let seeking = false;
function renderPlayer() {
  const el = document.getElementById("player");
  const id = state.audio.currentId;
  const t = trackById(id);
  const item = audioFor(t);
  if (!item || !t) { el.className = "player hidden"; return; }
  const a = audioEl();
  const warn = CANT_PLAY_EXT.includes(item.ext)
    ? `<div class="pwarn">${item.ext.toUpperCase()} may not play in this browser — try Safari, or export an MP3.</div>` : "";
  el.className = "player";
  el.innerHTML = `
    <div class="pctrl">
      <button class="pbtn mini" id="pPrev" title="Previous">&#9198;&#xFE0E;</button>
      <button class="pbtn mini" id="pBack10" title="Back 10 seconds"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g transform="translate(0 1.4)"><path d="M15.75 5.5A7.5 7.5 0 1 1 8.25 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><polygon points="8.25 3.4 8.25 7.6 4.9 5.5" fill="currentColor"/><text x="12" y="12.5" text-anchor="middle" dominant-baseline="central" font-size="8.5" fill="currentColor" font-weight="700">10</text></g></svg></button>
      <button class="pbtn" id="pToggle" title="Play/Pause">${a.paused ? "&#9654;&#xFE0E;" : "&#9208;&#xFE0E;"}</button>
      <button class="pbtn mini" id="pFwd10" title="Forward 10 seconds"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g transform="translate(0 1.4)"><path d="M8.25 5.5A7.5 7.5 0 1 0 15.75 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><polygon points="15.75 3.4 15.75 7.6 19.1 5.5" fill="currentColor"/><text x="12" y="12.5" text-anchor="middle" dominant-baseline="central" font-size="8.5" fill="currentColor" font-weight="700">10</text></g></svg></button>
      <button class="pbtn mini" id="pNext" title="Next">&#9197;&#xFE0E;</button>
    </div>
    <div class="pinfo"><div class="pt">${esc(t.title)}</div><div class="ps">${esc(t.inspiredBy || "")}${item.ext ? " &middot; " + item.ext.toUpperCase() : ""}</div></div>
    <div class="pseek">
      <div class="seekwrap">
        <input type="range" id="pSeek" min="0" max="1000" value="0" />
        <div class="markers" id="pMarkers"></div>
      </div>
    </div>
    <div class="ptime" id="pTime">0:00 / 0:00</div>
    ${warn}
    <button class="fb-mini" id="pFbBtn" title="Notes for this song">Notes</button>
    <button class="pclose" id="pClose" title="Close">&times;</button>`;
  document.getElementById("pToggle").onclick = () => (a.paused ? a.play().catch(() => {}) : a.pause());
  document.getElementById("pPrev").onclick = () => playNext(-1);
  document.getElementById("pNext").onclick = () => playNext(1);
  document.getElementById("pClose").onclick = () => { a.pause(); state.audio.currentId = null; el.className = "player hidden"; updatePlayButtons(); positionNotesBar(); };
  document.getElementById("pBack10").onclick = () => { a.currentTime = Math.max(0, (a.currentTime || 0) - 10); };
  document.getElementById("pFwd10").onclick = () => { const d = (a.duration && isFinite(a.duration)) ? a.duration : (a.currentTime || 0) + 10; a.currentTime = Math.min(d, (a.currentTime || 0) + 10); };
  const seek = document.getElementById("pSeek");
  seek.oninput = () => { seeking = true; if (a.duration) { a.currentTime = (seek.value / 1000) * a.duration; const tEl = document.getElementById("pTime"); if (tEl) tEl.textContent = `${fmt(a.currentTime)} / ${fmt(a.duration)}`; } };
  seek.onpointerdown = () => { seeking = true; const up = () => { seeking = false; document.removeEventListener("pointerup", up); }; document.addEventListener("pointerup", up); };
  seek.onchange = () => { seeking = false; };

  document.getElementById("pFbBtn").onclick = () => { if (state.audio.currentId) openNotesBar(state.audio.currentId, true); };
  if (document.getElementById("notesbar") && document.getElementById("notesbar").classList.contains("open")) { if (notesBarTrack === state.audio.currentId) renderNotesBar(); positionNotesBar(); }
  renderMarkers();
}

// Feedback dots on the player's seek bar (only for a real track, not a version preview).
function renderMarkers() {
  const wrap = document.getElementById("pMarkers");
  if (!wrap) return;
  const a = audioEl();
  const t = trackById(state.audio.currentId);
  if (!t || !a.duration || !isFinite(a.duration)) { wrap.innerHTML = ""; return; }
  const cur = currentVersion(t);
  wrap.innerHTML = (t.feedback || []).filter((fb) => (fb.version || "") === (cur || "")).map((fb) => {
    const pct = Math.min(100, Math.max(0, (fb.timestamp / a.duration) * 100));
    return `<div class="marker ${fb.status === "Resolved" ? "resolved" : "open"}" style="left:${pct}%" data-mk="${fb.timestamp}" title="${esc(mmss(fb.timestamp))} — ${esc(fb.author || "")}: ${esc((fb.comment || "").slice(0, 80))}"></div>`;
  }).join("");
  wrap.querySelectorAll("[data-mk]").forEach((m) =>
    m.onclick = () => { a.currentTime = Number(m.dataset.mk); a.play().catch(() => {}); });
}

function wireAudio() {
  const a = audioEl();
  a.addEventListener("play", () => { state.audio.playing = true; updatePlayButtons(); const b = document.getElementById("pToggle"); if (b) b.innerHTML = "&#9208;&#xFE0E;"; });
  a.addEventListener("pause", () => { state.audio.playing = false; updatePlayButtons(); const b = document.getElementById("pToggle"); if (b) b.innerHTML = "&#9654;&#xFE0E;"; });
  a.addEventListener("ended", () => {
    if (albumRoll) { playNext(1); return; }
    state.audio.playing = false; updatePlayButtons();
    const b = document.getElementById("pToggle"); if (b) b.innerHTML = "&#9654;&#xFE0E;";
  });
  a.addEventListener("loadedmetadata", renderMarkers);
  a.addEventListener("durationchange", renderMarkers);
  a.addEventListener("timeupdate", () => {
    const seek = document.getElementById("pSeek"), time = document.getElementById("pTime");
    if (seek && a.duration && !seeking) seek.value = String((a.currentTime / a.duration) * 1000);
    if (time) time.textContent = `${fmt(a.currentTime)} / ${fmt(a.duration)}`;
    if (!notesTimeLocked && notesBarTrack && notesBarTrack === state.audio.currentId) { const tb = document.getElementById("nbTime"); if (tb) tb.textContent = mmss(Math.floor(a.currentTime || 0)); }
  });
  a.addEventListener("error", async () => {
    const item = audioFor(trackById(state.audio.currentId));
    if (item && CANT_PLAY_EXT.includes(item.ext)) { toast(`${item.ext.toUpperCase()} can't play in this browser`, true); return; }
    if (!triedRelink) { // temp links expire (~4h) — refresh once and retry
      triedRelink = true;
      await fetchPlaylist();
      const fresh = audioFor(trackById(state.audio.currentId));
      if (fresh) { a.src = fresh.url; a.play().catch(() => {}); }
    } else {
      toast("Couldn't play this file", true);
    }
  });
}

/* ---- Identity (who am I, saved on device) ---------------------------------*/
function getMe() { try { return JSON.parse(localStorage.getItem("megasMe") || "null"); } catch { return null; } }
function setMe(m) { localStorage.setItem("megasMe", JSON.stringify(m)); updateWhoami(); }
function updateWhoami() {
  const b = $("#whoami"); if (!b) return;
  const me = getMe();
  b.title = me ? `You: ${me.name} (click to change)` : "Set your name";
  b.innerHTML = me ? esc(initials(me.name)) : "You";
}
function pickIdentity(required) {
  return new Promise((resolve) => {
    const members = state.data.members;
    identityLock = !!required;
    openModal(`
      <div class="mhd"><h2>${required ? "Identify yourself, stranger." : "Who are you?"}</h2>${required ? "" : `<button class="icon-btn close" id="mClose">&times;</button>`}</div>
      <div class="mbd">
        <p style="color:var(--muted);margin:0">${required ? "Choose your name to start — this tags your notes and assignments to you. Saved on this device; change it anytime with the “You” button." : "Pick your name — saved on this device so your feedback is tagged to you."}</p>
        <div class="owner-picker" id="idPick">${members.map((m) => `<label class="owner-chip"><input type="radio" name="idp" value="${m.id}"/> ${esc(m.display)}</label>`).join("")}</div>
      </div>`);
    const closeBtn = $("#mClose"); if (closeBtn) closeBtn.onclick = () => { closeModal(); resolve(getMe()); };
    document.querySelectorAll("#idPick input").forEach((i) =>
      i.addEventListener("change", () => { const m = members.find((x) => x.id === i.value); identityLock = false; setMe({ id: m.id, name: m.display }); closeModal(); resolve(getMe()); }));
  });
}
async function ensureMe() { return getMe() || (await pickIdentity()); }

/* ---- Modal helpers ---------------------------------------------------------*/
function openModal(html) { const m = $("#modal"); m.innerHTML = html; $("#mscrim").classList.add("open"); m.classList.add("open"); }
let identityLock = false;
function closeModal() { if (identityLock) return; $("#mscrim").classList.remove("open"); $("#modal").classList.remove("open"); }
function confirmDialog(message, opts = {}) {
  const okText = opts.okText || "Confirm", cancelText = opts.cancelText || "Cancel";
  const danger = opts.danger === true, title = opts.title || "Are you sure?";
  return new Promise((resolve) => {
    openModal(`
      <div class="mhd"><h2>${esc(title)}</h2><button class="icon-btn close" id="cfClose">&times;</button></div>
      <div class="mbd">
        <p style="margin:0;color:var(--text);line-height:1.45">${esc(message)}</p>
        <div class="cf-actions">
          <button class="add-btn ghost" id="cfCancel">${esc(cancelText)}</button>
          <button class="add-btn${danger ? " danger" : ""}" id="cfOk">${esc(okText)}</button>
        </div>
      </div>`);
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
    document.getElementById("cfClose").onclick = () => finish(false);
    document.getElementById("cfCancel").onclick = () => finish(false);
    const ok = document.getElementById("cfOk"); ok.onclick = () => finish(true); ok.focus();
  });
}

/* ---- Preview album ---------------------------------------------------------*/
function trackRowHTML(t) {
  const audio = audioFor(t);
  const playing = state.audio.currentId === t.id && state.audio.playing;
  const btn = audio
    ? `<button class="play-btn ${playing ? "playing" : ""}" data-play="${t.id}">${playing ? "&#9208;&#xFE0E;" : "&#9654;&#xFE0E;"}</button>`
    : `<span class="play-btn" style="visibility:hidden">&#9654;&#xFE0E;</span>`;
  return `
    <div class="trow ${playing ? "playing" : ""}" data-tid="${t.id}">
      <div class="num">${dispNum(t)}</div>${btn}
      <div class="tp"><div class="tt">${esc(t.title)}</div><div class="ts">${esc(t.inspiredBy || "")}${t.reference ? " &middot; " + esc(t.reference) : ""}</div></div>
      ${openFbCount(t) ? `<span class="fb-badge">${openFbCount(t)} notes</span>` : ""}
      <span class="badge">${esc(t.stage)}</span>
      ${audio ? "" : `<span class="noaudio">no audio</span>`}
    </div>`;
}
function albumPreviewSection(alb) {
  const tracks = state.data.tracks.filter((t) => t.albumId === alb.id && !t.onHold).sort((a, b) => effOrder(a) - effOrder(b));
  const cover = alb.cover[0] ? `data-artview="${esc(alb.cover[0].url)}" title="View art" style="background-image:url('${alb.cover[0].thumb}')"` : "";
  const anyAudio = tracks.some((t) => audioFor(t));
  return `
    <div class="palbum">
      <div class="phead">
        <div class="cover" ${cover}>${alb.cover[0] ? "" : ""}</div>
        <div>
          ${albumSwitcherHTML(alb.id)}
          <div class="sub">${esc(alb.artist)} &middot; ${tracks.length} tracks &middot; ${alb.progress}% complete</div>
          <div class="playall">${anyAudio ? `<button class="add-btn" data-playalbum="${alb.id}">&#9654;&#xFE0E; Play album</button>` : `<span class="empty">No audio yet</span>`}</div>
        </div>
      </div>
      ${tracks.map(trackRowHTML).join("") || `<div class="empty">No tracks yet.</div>`}
    </div>`;
}
function previewHTML() {
  const id = state.filters.albumId;
  // On-hold acts like its own album scope.
  if (id === "__hold") {
    const held = state.data.tracks.filter((t) => t.onHold).sort((a, b) => effOrder(a) - effOrder(b));
    const body = held.length ? held.map(trackRowHTML).join("") : `<div class="empty">Nothing on hold.</div>`;
    return `<div class="preview"><div class="palbum"><div class="phead"><div class="cover"></div><div>${albumSwitcherHTML("__hold")}<div class="sub">${held.length} track(s) on hold</div></div></div>${body}</div></div>`;
  }
  // Current album floats to the top; the rest keep their existing order.
  let albums = state.data.albums.slice().sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
  if (id === "__unassigned") albums = [];
  else if (id && id !== "__all") albums = albums.filter((a) => a.id === id);
  const showUnassigned = !id || id === "__all" || id === "__unassigned";
  const unassigned = showUnassigned ? state.data.tracks.filter((t) => !t.albumId && !t.onHold).sort((a, b) => effOrder(a) - effOrder(b)) : [];
  if (!albums.length && !unassigned.length) return `<div class="loading">Nothing to preview for this filter.</div>`;
  let html = albums.map(albumPreviewSection).join("");
  if (unassigned.length) html += `<div class="palbum"><div class="phead"><div class="cover"></div><div>${albumSwitcherHTML("__unassigned")}<div class="sub">${unassigned.length} track(s) not on an album</div></div></div>${unassigned.map(trackRowHTML).join("")}</div>`;
  return `<div class="preview">${html}</div>`;
}

/* ---- Lyrics: sections ------------------------------------------------------*/
const LYRIC_LABELS = ["Intro", "Verse 1", "Verse 2", "Verse 3", "Verse 4", "Pre-Chorus", "Chorus", "Post-Chorus", "Bridge", "Breakdown", "Solo", "VO", "Outro", "Bench"];
function parseSections(t) {
  if (t.lyricsData) { try { const d = JSON.parse(t.lyricsData); if (Array.isArray(d) && d.length) return d; } catch {} }
  if (t.lyrics && t.lyrics.trim()) return sectionsFromText(t.lyrics);
  return [];
}
// Split raw text into sections using [Label] lines as headers.
function sectionsFromText(raw) {
  const lines = String(raw).replace(/\r/g, "").split("\n");
  const secs = []; let cur = null;
  for (const line of lines) {
    const m = line.match(/^\s*\[(.+?)\]\s*$/);
    if (m) { cur = { label: m[1].trim(), text: "" }; secs.push(cur); }
    else { if (!cur) { cur = { label: "", text: "" }; secs.push(cur); } cur.text += (cur.text ? "\n" : "") + line; }
  }
  secs.forEach((s) => (s.text = s.text.replace(/^\n+|\n+$/g, "")));
  return secs.filter((s) => s.label || s.text.trim());
}
// Sections back to text: bracketed label lines (label omitted when empty).
function flattenSections(secs) { return secs.map((s) => (s.label ? `[${s.label}]\n` : "") + s.text).join("\n\n"); }
async function saveSections(id, secs) {
  return update("track", id, { lyricsData: JSON.stringify(secs), lyrics: flattenSections(secs) });
}
// Best-effort split of pasted lyrics into labeled sections; user adjusts before saving.
function guessSections(raw) {
  const KW = /^(intro|verses?|pre[-\s]?chorus|chorus|post[-\s]?chorus|bridge|break\s?down|hook|refrain|outro|solo|interlude|v\.?o\.?|drop|build|tag|vamp)\b/i;
  const NAMEMAP = { intro: "Intro", verse: "Verse", verses: "Verse", "pre-chorus": "Pre-Chorus", prechorus: "Pre-Chorus", "pre chorus": "Pre-Chorus", chorus: "Chorus", "post-chorus": "Post-Chorus", postchorus: "Post-Chorus", "post chorus": "Post-Chorus", bridge: "Bridge", breakdown: "Breakdown", "break down": "Breakdown", hook: "Hook", refrain: "Refrain", outro: "Outro", solo: "Solo", interlude: "Interlude", vo: "VO", "v.o": "VO", drop: "Drop", build: "Build", tag: "Tag", vamp: "Vamp", bench: "Bench" };
  const isHeader = (l) => {
    const s = l.trim(); if (!s) return false;
    if (/^\[.+\]$/.test(s)) return true;
    const bare = s.replace(/[:\-–—\.]+$/, "").trim();
    if (KW.test(bare) && bare.length <= 26) return true;
    if (bare.length <= 24 && /[A-Za-z]/.test(bare) && bare === bare.toUpperCase() && !/[.!?,]$/.test(bare)) return true;
    return false;
  };
  const norm = (l) => {
    let s = l.trim().replace(/^\[|\]$/g, "").replace(/[:\-–—\.]+$/, "").trim();
    const m = s.match(/^([A-Za-z][A-Za-z\.\s-]*?)\s*(\d+)?$/);
    if (m) { const key = m[1].toLowerCase().trim(); if (NAMEMAP[key]) return NAMEMAP[key] + (m[2] ? " " + m[2] : ""); }
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  };
  const lines = String(raw).replace(/\r/g, "").split("\n");
  const secs = []; let cur = null;
  for (const line of lines) {
    if (isHeader(line)) { cur = { label: norm(line), text: "" }; secs.push(cur); }
    else { if (!cur) { if (!line.trim()) continue; cur = { label: "Verse 1", text: "" }; secs.push(cur); } cur.text += (cur.text ? "\n" : "") + line; }
  }
  secs.forEach((s) => (s.text = s.text.replace(/\n{3,}/g, "\n\n").trim()));
  if (secs.length <= 1 && String(raw).trim()) {
    const paras = String(raw).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (paras.length > 1) return paras.map((p, i) => ({ label: i === 0 ? "Verse 1" : `Section ${i + 1}`, text: p }));
  }
  return secs.length ? secs : [{ label: "Lyrics", text: String(raw).trim() }];
}
function sectionHTML(s, i, secs) {
  const inList = LYRIC_LABELS.includes(s.label);
  const opts = LYRIC_LABELS.map((l) => `<option ${l === s.label ? "selected" : ""}>${esc(l)}</option>`).join("");
  const existingOpts = secs.map((o, j) => (j === i ? "" : `<option value="i:${j}">${esc(o.label)}</option>`)).join("");
  const newOpts = LYRIC_LABELS.map((l) => `<option value="n:${esc(l)}">${esc(l)}</option>`).join("");
  return `
    <div class="sec" data-i="${i}">
      <div class="sechd">
        <span class="sgrip">&#8942;</span>
        <select data-s="label">${inList ? "" : `<option selected>${esc(s.label)}</option>`}${opts}<option value="__custom">Custom…</option></select>
        <div class="sec-actions">
          <button class="fb-mini" data-s="up" title="Move up">&#8593;</button>
          <button class="fb-mini" data-s="down" title="Move down">&#8595;</button>
          <button class="fb-mini" data-s="del" title="Delete">&times;</button>
        </div>
      </div>
      <textarea class="autogrow" data-s="text" placeholder="Lyrics for this section…">${esc(s.text)}</textarea>
      <div class="sec-move">
        <select data-s="move">
          <option value="">Move highlighted text to…</option>
          ${existingOpts ? `<optgroup label="Existing sections">${existingOpts}</optgroup>` : ""}
          <optgroup label="New section">${newOpts}<option value="n:__custom">Custom…</option></optgroup>
        </select>
      </div>
    </div>`;
}
function autoGrow(el) { el.style.height = "auto"; el.style.height = Math.max(60, el.scrollHeight) + "px"; }
function openLyricsEditor(id) {
  let secs = parseSections(state.data.tracks.find((x) => x.id === id));
  const t = state.data.tracks.find((x) => x.id === id);
  function collect() {
    document.querySelectorAll("#modal .sec").forEach((el) => {
      const i = Number(el.dataset.i);
      secs[i].label = el.querySelector('[data-s="label"]').value;
      secs[i].text = el.querySelector('[data-s="text"]').value;
    });
  }
  function draw() {
    openModal(`
      <div class="mhd"><h2>Lyrics &middot; ${esc(t.title)}</h2><span style="flex:1"></span><button class="add-btn ghost" id="teleBtn">Teleprompter</button><button class="icon-btn close" id="mClose">&times;</button></div>
      <div class="mbd">
        <p class="lyr-hint">Type freely. Put a section title in brackets on its own line — like <code>[Verse 1]</code> or <code>[Chorus]</code> — and it becomes a labeled section on the teleprompter.</p>
        <textarea id="lyrText" class="lyr-big" spellcheck="false" placeholder="[Verse 1]&#10;First line…">${esc(flattenSections(secs))}</textarea>
        <div class="addsec"><span class="spacer" style="flex:1"></span><button class="add-btn" id="saveSecs">Save lyrics</button></div>
      </div>`);
    $("#mClose").onclick = closeModal;
    $("#teleBtn").onclick = () => openTeleprompter(id, sectionsFromText($("#lyrText").value));
    $("#saveSecs").onclick = async () => {
      const raw = $("#lyrText").value;
      const r = await update("track", id, { lyrics: raw.trim(), lyricsData: JSON.stringify(sectionsFromText(raw)) });
      if (r.ok) { toast("Lyrics saved"); closeModal(); refresh(); }
    };
    document.querySelectorAll("#modal .sec").forEach((el) => {
      const i = Number(el.dataset.i);
      const sel = el.querySelector('[data-s="label"]');
      sel.addEventListener("change", (e) => {
        if (e.target.value === "__custom") { const name = prompt("Section label:", secs[i].label); collect(); secs[i].label = name || secs[i].label; draw(); }
      });
      el.querySelector('[data-s="up"]').onclick = () => { if (i > 0) { collect(); [secs[i - 1], secs[i]] = [secs[i], secs[i - 1]]; draw(); } };
      el.querySelector('[data-s="down"]').onclick = () => { if (i < secs.length - 1) { collect(); [secs[i + 1], secs[i]] = [secs[i], secs[i + 1]]; draw(); } };
      el.querySelector('[data-s="del"]').onclick = () => { collect(); secs.splice(i, 1); draw(); };
      const ta = el.querySelector('[data-s="text"]');
      autoGrow(ta);
      ta.addEventListener("input", () => autoGrow(ta));
      // Remember the highlighted range, because clicking the dropdown blurs the textarea.
      let lastSel = { start: 0, end: 0 };
      const remember = () => { lastSel = { start: ta.selectionStart, end: ta.selectionEnd }; };
      ["select", "keyup", "mouseup", "blur"].forEach((ev) => ta.addEventListener(ev, remember));
      el.querySelector('[data-s="move"]').addEventListener("change", (e) => {
        const val = e.target.value; e.target.value = "";
        if (!val) return;
        const { start, end } = lastSel;
        const sel = secs.length ? String(ta.value).slice(start, end).trim() : "";
        if (start === end || !sel) { toast("Highlight some lyrics in this section first", true); return; }
        collect();
        secs[i].text = (secs[i].text.slice(0, start) + secs[i].text.slice(end)).replace(/\n{3,}/g, "\n\n").trim();
        if (val.startsWith("i:")) { const ti = Number(val.slice(2)); secs[ti].text = (secs[ti].text ? secs[ti].text + "\n\n" : "") + sel; }
        else { let label = val.slice(2); if (label === "__custom") { const p = prompt("New section label:", "Verse"); if (p === null) { draw(); return; } label = p || "Section"; } secs.push({ label, text: sel }); }
        draw();
      });
    });
  }
  function drawImport() {
    openModal(`
      <div class="mhd"><h2>Import lyrics</h2><button class="icon-btn close" id="mClose">&times;</button></div>
      <div class="mbd">
        <div class="field"><label>Paste lyrics</label><textarea id="impText" style="min-height:200px" placeholder="Paste lyrics here — headers like [Chorus], VERSE 1, Pre-Chorus are detected automatically…"></textarea></div>
        <div class="field"><label>…or a public Google Doc link</label><input id="impUrl" type="text" placeholder="https://docs.google.com/document/d/…" /></div>
        <p style="color:var(--muted-2);font-size:12px;margin:0">I'll split it into sections you can rename, reorder, and edit before saving.</p>
        <div class="addsec"><button class="add-btn ghost" id="impBack">&#8592; Back</button><span class="spacer" style="flex:1"></span><button class="add-btn" id="impGuess">Guess sections &#8594;</button></div>
      </div>`);
    $("#mClose").onclick = closeModal;
    $("#impBack").onclick = draw;
    $("#impGuess").onclick = async () => {
      let text = $("#impText").value;
      const url = $("#impUrl").value.trim();
      if (!text.trim() && url) {
        toast("Fetching doc…");
        try {
          const r = await fetch("/api/importdoc?url=" + encodeURIComponent(url));
          const j = await r.json();
          if (j.text) text = j.text; else { toast(j.error || "Couldn't fetch doc", true); return; }
        } catch { toast("Couldn't fetch doc", true); return; }
      }
      if (!text.trim()) { toast("Paste lyrics or a link first", true); return; }
      const guessed = guessSections(text);
      secs.length = 0; guessed.forEach((s) => secs.push(s));
      draw();
      toast(`Found ${guessed.length} section${guessed.length === 1 ? "" : "s"} — adjust & save`);
    };
  }
  draw();
}

/* ---- Teleprompter ----------------------------------------------------------*/
function renderHL(text, ranges) {
  text = String(text == null ? "" : text);
  if (!ranges || !ranges.length) return esc(text);
  const rs = ranges.map((r) => [Math.max(0, r[0]), Math.min(text.length, r[1])]).filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0]);
  const m = [];
  rs.forEach((r) => { if (m.length && r[0] <= m[m.length - 1][1]) m[m.length - 1][1] = Math.max(m[m.length - 1][1], r[1]); else m.push([r[0], r[1]]); });
  let out = "", pos = 0;
  m.forEach(([a, b]) => { out += esc(text.slice(pos, a)) + `<mark class="tp-hl">${esc(text.slice(a, b))}</mark>`; pos = b; });
  out += esc(text.slice(pos));
  return out;
}
function toggleRange(ranges, s, e) {
  let rs = (ranges || []).map((r) => [r[0], r[1]]);
  if (rs.some(([a, b]) => a <= s && b >= e)) {
    const out = [];
    rs.forEach(([a, b]) => { if (b <= s || a >= e) out.push([a, b]); else { if (a < s) out.push([a, s]); if (b > e) out.push([e, b]); } });
    return out;
  }
  rs.push([s, e]); rs.sort((x, y) => x[0] - y[0]);
  const m = []; rs.forEach((r) => { if (m.length && r[0] <= m[m.length - 1][1]) m[m.length - 1][1] = Math.max(m[m.length - 1][1], r[1]); else m.push([r[0], r[1]]); });
  return m;
}
function openTeleprompter(id, secsOverride) {
  const t = state.data.tracks.find((x) => x.id === id);
  const secs = secsOverride || parseSections(t);
  secs.forEach((s) => { if (s && typeof s.text === "string" && s.text.indexOf("\r") >= 0) s.text = s.text.replace(/\r/g, ""); });
  const tp = $("#teleprompter");
  let font = 46, editing = (secs.length === 0), center = true, track = 0, showCtrl = false;
  let hlColor = localStorage.getItem("megasHlColor") || "#ffd54a";
  function close() { document.removeEventListener("keydown", onKey); tp.classList.remove("open"); tp.innerHTML = ""; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
  function onKey(e) { if (e.key === "Escape") { e.preventDefault(); if (editing) { editing = false; draw(); } else close(); } }
  function draw() {
    if (editing) { drawEdit(); return; }
    tp.innerHTML = `
      <button class="tp-menu-btn" id="tpMenu" title="Show / hide controls">${showCtrl ? "Close" : "Controls"}</button>
      <div class="tp-panel${showCtrl ? " open" : ""}" id="tpBar">
        <span class="tp-title">${esc(t.title)}</span>
        <div class="tp-row"><button id="tpMinus">A&minus;</button><button id="tpPlus">A+</button></div>
        <label class="tp-ctl"><span>Tracking</span><input type="range" id="tpTrack" min="0" max="10" step="0.5" value="${track}" title="Letter spacing" /></label>
        <label class="tp-ctl"><span>Highlight</span><input type="color" id="tpHl" value="${hlColor}" title="Highlight color" /></label>
        <button id="tpAlign">${center ? "Left" : "Center"}</button>
        <button id="tpEdit">Edit</button>
        <button id="tpFull">Fullscreen</button>
        <button id="tpPop">Pop-Out</button>
        <button id="tpClose">Exit</button>
      </div>
      <div class="tp-scroll${center ? " center" : ""}" id="tpScroll" style="font-size:${font}px;letter-spacing:${track}px">
        ${secs.map((s, i) => `<div class="tp-section" data-i="${i}">${s.label ? `<div class="tp-lbl">${esc(s.label)}</div>` : ""}<div class="tp-txt">${renderHL(s.text, s.hl)}</div></div>`).join("") || `<div class="tp-section"><div class="tp-txt">No lyrics yet.</div></div>`}
      </div>`;
    const sc = $("#tpScroll");
    $("#tpMenu").onclick = () => { showCtrl = !showCtrl; $("#tpBar").classList.toggle("open", showCtrl); $("#tpMenu").textContent = showCtrl ? "Close" : "Controls"; };
    $("#tpClose").onclick = close;
    $("#tpPlus").onclick = () => { font = Math.min(140, font + 4); sc.style.fontSize = font + "px"; };
    $("#tpMinus").onclick = () => { font = Math.max(20, font - 4); sc.style.fontSize = font + "px"; };
    $("#tpTrack").oninput = (e) => { track = Number(e.target.value); sc.style.letterSpacing = track + "px"; };
    $("#tpAlign").onclick = () => { center = !center; sc.classList.toggle("center", center); $("#tpAlign").textContent = center ? "Left" : "Center"; };
    $("#tpEdit").onclick = () => { editing = true; draw(); };
    sc.addEventListener("dblclick", () => { editing = true; draw(); }); // double-click lyrics to edit
    { const hc = $("#tpHl"); if (hc) hc.oninput = (e) => { hlColor = e.target.value; localStorage.setItem("megasHlColor", hlColor); tp.style.setProperty("--hl", hlColor); }; }
    sc.addEventListener("mouseup", (e) => {
      if (editing || e.detail > 1) return;
      const selc = window.getSelection(); if (!selc || selc.isCollapsed || selc.rangeCount === 0) return;
      const rg = selc.getRangeAt(0);
      const txts = Array.from(document.querySelectorAll("#tpScroll .tp-txt"));
      // Every section the selection touches (supports highlighting across section/paragraph breaks).
      const hit = txts.filter((el) => { try { return rg.intersectsNode(el); } catch (_) { return el.contains(rg.startContainer) || el.contains(rg.endContainer); } });
      if (!hit.length) return;
      const offOf = (el, container, offset, fallback) => {
        if (!(el === container || el.contains(container))) return fallback;
        const pre = document.createRange(); pre.selectNodeContents(el); pre.setEnd(container, offset);
        return pre.toString().length;
      };
      const proposed = {};
      hit.forEach((el) => {
        const i = Number(el.closest(".tp-section").dataset.i);
        if (isNaN(i) || !secs[i]) return;
        const plain = el.textContent; secs[i].text = plain;
        const s = offOf(el, rg.startContainer, rg.startOffset, 0);
        const eo = offOf(el, rg.endContainer, rg.endOffset, plain.length);
        if (eo > s) proposed[i] = [s, eo];
      });
      const keys = Object.keys(proposed);
      if (!keys.length) return;
      // Single highlight at a time; re-selecting the exact same span clears it.
      const same = secs.every((sec, k) => { const pr = proposed[k]; const cur = (sec.hl && sec.hl.length) ? sec.hl : null; return pr ? (cur && cur.length === 1 && cur[0][0] === pr[0] && cur[0][1] === pr[1]) : !cur; });
      secs.forEach((sec) => { sec.hl = []; });
      if (!same) keys.forEach((k) => (secs[k].hl = [proposed[k]]));
      selc.removeAllRanges();
      // Re-render only the section text in place, so the scroll position never moves.
      document.querySelectorAll("#tpScroll .tp-section").forEach((secEl) => {
        const k = Number(secEl.dataset.i); const txtEl = secEl.querySelector(".tp-txt");
        if (txtEl && secs[k]) txtEl.innerHTML = renderHL(secs[k].text, secs[k].hl);
      });
      update("track", id, { lyricsData: JSON.stringify(secs), lyrics: flattenSections(secs) });
    });
    $("#tpFull").onclick = toggleFull;
    $("#tpPop").onclick = popOut;
  }
  function drawEdit() {
    tp.innerHTML = `
      <div class="tp-edithd">
        <span class="tp-title">Editing &middot; ${esc(t.title)}</span>
        <span class="spacer" style="flex:1"></span>
        <button id="tpEsave">Save</button>
        <button id="tpEcancel">Cancel</button>
      </div>
      <div class="tp-editwrap"><textarea id="tpEdit" class="tp-editarea" spellcheck="false" placeholder="[Verse 1]&#10;First line…">${esc(flattenSections(secs))}</textarea></div>`;
    $("#tpEcancel").onclick = () => { editing = false; draw(); };
    $("#tpEsave").onclick = async () => {
      const raw = $("#tpEdit").value;
      const next = sectionsFromText(raw);
      const r = await update("track", id, { lyrics: raw.trim(), lyricsData: JSON.stringify(next) });
      if (r.ok) {
        secs.length = 0; next.forEach((s) => secs.push(s)); editing = false; toast("Lyrics saved"); draw(); refresh();
        // Keep the lyrics editor (if open underneath) in sync so it can't overwrite these edits.
        const lt = document.getElementById("lyrText"); if (lt) lt.value = raw;
      }
    };
  }
  function toggleFull() {
    if (!document.fullscreenElement) (tp.requestFullscreen || tp.webkitRequestFullscreen || (() => {})).call(tp);
    else (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
  }
  function popOut() {
    const w = window.open("", "tp_" + id, "width=900,height=1000");
    if (!w) { toast("Allow pop-ups to use Pop-Out", true); return; }
    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.title)} — Teleprompter</title><style>
      :root{color-scheme:dark}*{box-sizing:border-box}
      body{margin:0;background:#0a0a0e;color:#ede8f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
      .bar{position:fixed;top:0;right:0;height:100%;width:min(280px,82vw);z-index:5;display:flex;flex-direction:column;align-items:stretch;gap:10px;padding:58px 16px 20px;overflow-y:auto;background:rgba(10,9,15,.97);border-left:1px solid rgba(255,255,255,.1);box-shadow:-18px 0 40px rgba(0,0,0,.4);transform:translateX(100%);transition:transform .22s ease}
      .bar.open{transform:none}
      .bar .ttl{font-weight:800;font-size:15px;margin-bottom:4px}
      .bar button{background:rgba(255,255,255,.06);color:#ede8f5;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:9px 12px;cursor:pointer;font-weight:600;font-size:13px;width:100%}
      .bar button:hover{border-color:#e5399f}
      .bar input{accent-color:#e5399f}
      .row{display:flex;gap:8px}
      .row button{flex:1}
      .ctl{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:rgba(237,232,245,.65)}
      .ctl input[type=range]{flex:1}
      .mbtn{position:absolute;top:10px;right:12px;z-index:6;background:rgba(255,255,255,.08);color:#ede8f5;border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px;font-weight:600;opacity:.6}
      .mbtn:hover{opacity:1;border-color:#e5399f}
      .sc{padding:8vh 3vw 60vh;font-size:46px;font-weight:700;line-height:1.32;scroll-behavior:smooth;height:100vh;overflow:auto}
      .sc.center .s{text-align:center}
      .s{margin:0 0 1.1em;max-width:none}
      .l{color:#e5399f;text-transform:uppercase;letter-spacing:.12em;font-size:.42em;margin-bottom:.25em;user-select:none;-webkit-user-select:none}
      .x{white-space:pre-wrap}
      .x mark{background:${hlColor};color:#0c0b10;border-radius:3px;padding:0 .06em}
      .edwrap{display:none;position:fixed;inset:0;z-index:5;background:#0a0a0e;flex-direction:column;padding:3vh 5vw 14px}
      .edwrap textarea{flex:1;width:100%;background:rgba(255,255,255,.03);color:#ede8f5;border:1px solid #34303f;border-radius:12px;padding:16px 18px;font-size:18px;line-height:1.5;resize:none;font-family:ui-monospace,Menlo,Consolas,monospace}
      .edbar{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
    </style></head><body>
      <button class="mbtn" id="mbtn" onclick="mt()">Controls</button>
      <div class="bar" id="bar">
        <span class="ttl">${esc(t.title)}</span>
        <div class="row"><button onclick="fz(-4)">A&minus;</button><button onclick="fz(4)">A+</button></div>
        <label class="ctl"><span>Tracking</span><input id="tr" type="range" min="0" max="10" step="0.5" value="0" title="Letter spacing"></label>
        <button id="al" onclick="ce()">Left</button>
        <button onclick="edit()">Edit</button>
        <button onclick="fs()">Fullscreen</button>
      </div>
      <div class="sc center" id="sc"></div>
      <div class="edwrap" id="edwrap">
        <textarea id="ta" spellcheck="false" placeholder="[Verse 1]&#10;First line…"></textarea>
        <div class="edbar"><button onclick="save()">Save</button><button onclick="cancelEd()">Cancel</button></div>
      </div>
      <script>
        var TID=${JSON.stringify(id)}, secs=${JSON.stringify(secs.map((s) => ({ label: s.label || "", text: s.text || "", hl: Array.isArray(s.hl) ? s.hl : [] })))};
        var font=46,sc=document.getElementById('sc');
        function esc(s){return String(s).replace(/[&<>]/g,function(c){return c==='&'?'&amp;':c==='<'?'&lt;':'&gt;';});}
        function parse(raw){var lines=String(raw).replace(/\\r/g,'').split('\\n'),out=[],cur=null;for(var i=0;i<lines.length;i++){var m=lines[i].match(/^\\s*\\[(.+?)\\]\\s*$/);if(m){cur={label:m[1].trim(),text:''};out.push(cur);}else{if(!cur){cur={label:'',text:''};out.push(cur);}cur.text+=(cur.text?'\\n':'')+lines[i];}}for(var j=0;j<out.length;j++){out[j].text=out[j].text.replace(/^\\n+|\\n+$/g,'');}return out.filter(function(s){return s.label||s.text.trim();});}
        function flat(a){return a.map(function(s){return (s.label?'['+s.label+']\\n':'')+s.text;}).join('\\n\\n');}
        function hl(t,ranges){t=String(t==null?'':t);if(!ranges||!ranges.length)return esc(t);var rs=ranges.map(function(r){return [Math.max(0,r[0]),Math.min(t.length,r[1])];}).filter(function(r){return r[1]>r[0];}).sort(function(a,b){return a[0]-b[0];});var m=[];rs.forEach(function(r){if(m.length&&r[0]<=m[m.length-1][1])m[m.length-1][1]=Math.max(m[m.length-1][1],r[1]);else m.push([r[0],r[1]]);});var out='',pos=0;m.forEach(function(r){out+=esc(t.slice(pos,r[0]))+'<mark>'+esc(t.slice(r[0],r[1]))+'</mark>';pos=r[1];});out+=esc(t.slice(pos));return out;}
        function render(){
          sc.innerHTML=secs.map(function(s){return '<div class="s">'+(s.label?'<div class="l">'+esc(s.label)+'</div>':'')+'<div class="x">'+hl(s.text,s.hl)+'</div></div>';}).join('')||'<div class="s"><div class="x">No lyrics yet.</div></div>';
        }
        function fz(d){font=Math.max(20,Math.min(160,font+d));sc.style.fontSize=font+'px';}
        function fs(){var e=document.documentElement;if(!document.fullscreenElement){(e.requestFullscreen||e.webkitRequestFullscreen||function(){}).call(e);}else{(document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document);}}
        function ce(){var on=sc.classList.toggle('center');document.getElementById('al').textContent=on?'Left':'Center';}
        function mt(){var o=document.getElementById('bar').classList.toggle('open');document.getElementById('mbtn').textContent=o?'Close':'Controls';}
        function edit(){document.getElementById('ta').value=flat(secs);document.getElementById('edwrap').style.display='flex';}
        function cancelEd(){document.getElementById('edwrap').style.display='none';}
        function save(){var raw=document.getElementById('ta').value;secs=parse(raw);
          fetch('/api/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entity:'track',id:TID,fields:{lyrics:raw.trim(),lyricsData:JSON.stringify(secs)}})})
          .then(function(r){return r.json();}).then(function(j){if(j&&j.ok){render();cancelEd();try{if(window.opener&&!window.opener.closed&&window.opener.__tpRefresh)window.opener.__tpRefresh();}catch(e){}}else{alert((j&&j.error)||'Save failed');}}).catch(function(){alert('Save failed');});
        }
        document.getElementById('tr').oninput=function(e){sc.style.letterSpacing=(+e.target.value)+'px';};
        sc.addEventListener('dblclick',edit);
        render();
      <\/script>
    </body></html>`);
    w.document.close();
  }
  tp.classList.add("open");
  tp.style.setProperty("--hl", hlColor);
  document.addEventListener("keydown", onKey);
  draw();
}

/* ---- Feedback (timestamped) ------------------------------------------------*/
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function parseTime(str) {
  const p = String(str).split(":").map(Number);
  if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) return p[0] * 60 + p[1];
  const n = Number(str); return isNaN(n) ? 0 : Math.floor(n);
}
function seekTo(id, seconds) {
  if (!audioFor(trackById(id))) { toast("No audio for this track", true); return; }
  if (state.audio.currentId !== id) playTrack(id);
  const a = audioEl();
  const go = () => { a.currentTime = seconds; a.play().catch(() => {}); };
  if (a.readyState > 0) go(); else a.addEventListener("loadedmetadata", go, { once: true });
}
function convertNoteToTask(trackId, note) {
  const t = trackById(trackId); if (!t) return;
  const phases = t.phases || [];
  const stage = t.stage || "";
  const POST = ["Mixing", "Mastering"];
  const stagePhase = phases.find((p) => p.phase === stage);
  const canOfferStage = !!stage && stage !== "Production" && !stagePhase;
  const defSel = stagePhase ? stagePhase.id : (POST.includes(stage) && canOfferStage) ? "__stage" : (phases[0] ? phases[0].id : (canOfferStage ? "__stage" : ""));
  const stageOpt = canOfferStage ? `<option value="__stage"${defSel === "__stage" ? " selected" : ""}>New phase: ${esc(stage)}</option>` : "";
  const phaseOpts = phases.map((p) => `<option value="${p.id}"${p.id === defSel ? " selected" : ""}>${esc(p.phase)}</option>`).join("");
  const inner = (stageOpt + phaseOpts) || `<option value="">No phases yet — add one on the track</option>`;
  const text0 = `[${mmss(note.timestamp)}] ${note.comment || ""}`;
  openModal(`
    <div class="mhd"><h2>Turn note into a task</h2><span style="flex:1"></span><button class="icon-btn close" id="mClose">&times;</button></div>
    <div class="mbd">
      <div class="field"><label>Add to phase</label><select id="ctPhase">${inner}</select></div>
      <div class="field"><label>Task</label><textarea id="ctText" style="min-height:70px">${esc(text0)}</textarea></div>
      <div class="row2">
        <div class="field"><label>Assign to</label><select id="ctOwner"><option value="">Unassigned</option>${state.data.members.map((m) => `<option value="${m.id}">${esc(m.display)}</option>`).join("")}</select></div>
        <div class="field"><label>Options</label><label class="owner-chip" style="margin-top:2px"><input type="checkbox" id="ctResolve" checked /> Mark note resolved</label></div>
      </div>
      <div class="drawer-actions"><button class="add-btn ghost" id="ctBack">Back to notes</button><button class="add-btn" id="ctGo">Create task</button></div>
    </div>`);
  $("#mClose").onclick = () => openFeedbackModal(trackId);
  $("#ctBack").onclick = () => openFeedbackModal(trackId);
  $("#ctGo").onclick = async () => {
    const text = ($("#ctText").value || "").trim(); if (!text) { toast("Task text is empty", true); return; }
    let phaseId = $("#ctPhase").value;
    if (phaseId === "__stage") {
      const rc = await createEntity("phase", { trackId, phase: stage });
      if (!rc.ok) { toast((rc && rc.error) || "Couldn't create phase", true); return; }
      phaseId = rc.id; await refresh(false);
    }
    if (!phaseId) { toast("Pick a phase", true); return; }
    const ph = (state.data.phases || []).find((p) => p.id === phaseId);
    const arr = (ph && Array.isArray(ph.subtasks)) ? ph.subtasks.map((x) => ({ text: x.text, done: !!x.done, owner: x.owner || null })) : [];
    arr.push({ text, done: false, owner: $("#ctOwner").value || null });
    const r2 = await update("phase", phaseId, { subtasks: JSON.stringify(arr) });
    if (!r2.ok) { toast((r2 && r2.error) || "Couldn't add task", true); return; }
    if ($("#ctResolve").checked) await update("feedback", note.id, { status: "Resolved" });
    toast("Task created");
    await refresh(false);
    openFeedbackModal(trackId);
  };
}
function noteHasTask(t, fbId) { return (t.phases || []).some((p) => (p.subtasks || []).some((st) => st.note === fbId)); }
function fmtWhen(iso) { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
// Inline controls to file a note as a task: phase + assignee (auto-filled from phase) + Add.
function guessNoteTarget(t, comment) {
  const c = " " + (comment || "").toLowerCase() + " ";
  const phases = t.phases || [];
  const has = (name) => phases.find((p) => p.phase === name);
  const eric = /\beric\b/.test(c), josh = /\bjosh\b/.test(c);
  let phase = null;
  if (/\b(guitar|riff|lead|solo|strum|chord|tele|strat|amp|distortion)\b/.test(c)) {
    phase = (josh && has("Josh Guitar")) || (eric && has("Eric Guitar")) || has("Eric Guitar") || has("Josh Guitar") || null;
  } else if (/\b(vocal|vox|sing|sung|pitch|lyric|verse|chorus|melody|tune|harmon|falsetto|scream|ad-?lib)\b/.test(c)) {
    if (/\b(backing|back-?up|harmon|bgv|choir|double|stack)\b/.test(c)) phase = has("Backing Vocals");
    phase = phase || (josh && has("Josh Vocals")) || (eric && has("Eric Vocals")) || has("Eric Vocals") || has("Josh Vocals") || null;
  }
  if (!phase) {
    const KW = [
      [/\b(drum|kick|snare|hi-?hat|hat|cymbal|tom|beat|groove|fill|percussion|ride|crash)\b/, "Drums"],
      [/\b(bass|low ?end|sub|808)\b/, "Bass"],
      [/\b(synth|keys?|keyboard|pad|arp|organ|piano)\b/, "Synth"],
      [/\b(reverb|delay|fx|effect|ambien|texture|foley|sound ?design|sfx|riser|whoosh|automation)\b/, "Sound Design"],
    ];
    for (const [re, name] of KW) { if (re.test(c)) { phase = has(name); if (phase) break; } }
  }
  const members = state.data.members || [];
  let owner = null;
  const named = members.find((m) => { const first = ((m.display || m.name || "").split(/\s+/)[0] || "").toLowerCase(); return first.length > 1 && c.indexOf(" " + first) >= 0; });
  if (named) owner = named.id;
  if (!owner && phase) owner = (phase.ownerIds || [])[0] || null;
  return { phaseId: phase ? phase.id : null, ownerId: owner };
}
function noteTaskCtrls(t, fb) {
  const phases = t.phases || [];
  const stage = t.stage || "";
  const POST = ["Mixing", "Mastering"];
  const stagePhase = phases.find((p) => p.phase === stage);
  const canOfferStage = !!stage && stage !== "Production" && !stagePhase;
  const guess = guessNoteTarget(t, fb.comment);
  const defSel = guess.phaseId || (stagePhase ? stagePhase.id : (POST.includes(stage) && canOfferStage) ? "__stage" : (phases[0] ? phases[0].id : (canOfferStage ? "__stage" : "")));
  const stageOpt = canOfferStage ? `<option value="__stage"${defSel === "__stage" ? " selected" : ""}>New: ${esc(stage)}</option>` : "";
  const phaseOpts = phases.map((p) => `<option value="${p.id}"${p.id === defSel ? " selected" : ""}>${esc(p.phase)}</option>`).join("");
  const defOwner = guess.ownerId || ((defSel && defSel !== "__stage") ? (((phases.find((p) => p.id === defSel) || {}).ownerIds || [])[0] || "") : "");
  const ownerOpts = `<option value="">Unassigned</option>` + state.data.members.map((m) => `<option value="${m.id}"${m.id === defOwner ? " selected" : ""}>${esc(m.display)}</option>`).join("");
  const phaseInner = (stageOpt + phaseOpts) || `<option value="">No phases</option>`;
  return `<div class="nt-ctrls" data-ntfor="${t.id}:${fb.id}"><select class="nt-sel" data-ntphase>${phaseInner}</select><select class="nt-sel" data-ntowner>${ownerOpts}</select><button class="fb-mini nt-add" data-ntadd>Add task</button></div>`;
}
function wireNoteCtrls(root) {
  (root || document).querySelectorAll(".nt-ctrls").forEach((boxEl) => {
    const sep = boxEl.dataset.ntfor.indexOf(":"); const tid = boxEl.dataset.ntfor.slice(0, sep), fid = boxEl.dataset.ntfor.slice(sep + 1);
    const phaseSel = boxEl.querySelector("[data-ntphase]"); const ownerSel = boxEl.querySelector("[data-ntowner]");
    if (phaseSel) phaseSel.addEventListener("change", () => { const t = trackById(tid); const ph = t && (t.phases || []).find((p) => p.id === phaseSel.value); if (ownerSel) ownerSel.value = ph ? ((ph.ownerIds || [])[0] || "") : ""; });
    const addBtn = boxEl.querySelector("[data-ntadd]");
    if (addBtn) addBtn.onclick = async () => {
      const t = trackById(tid); const fb = t && (t.feedback || []).find((x) => x.id === fid); if (!t || !fb) return;
      let phaseId = phaseSel ? phaseSel.value : "";
      if (phaseId === "__stage") { const rc = await createEntity("phase", { trackId: tid, phase: t.stage || "" }); if (!rc.ok) { toast((rc && rc.error) || "Couldn't create phase", true); return; } phaseId = rc.id; await refresh(false); }
      if (!phaseId) { toast("Pick a phase", true); return; }
      const ph = (state.data.phases || []).find((p) => p.id === phaseId);
      const arr = (ph && Array.isArray(ph.subtasks)) ? ph.subtasks.map((x) => ({ text: x.text, done: !!x.done, owner: x.owner || null, note: x.note || null })) : [];
      arr.push({ text: `[${mmss(fb.timestamp)}] ${fb.comment || ""}`, done: false, owner: (ownerSel ? ownerSel.value : "") || null, note: fid });
      const r2 = await update("phase", phaseId, { subtasks: JSON.stringify(arr) });
      if (!r2.ok) { toast((r2 && r2.error) || "Couldn't add task", true); return; }
      toast("Task filed — the note resolves when it's done"); await refresh(false);
      if (document.getElementById("dFeedback")) reRenderFeedback(tid); else if (document.getElementById("notesbar") && document.getElementById("notesbar").classList.contains("open")) renderNotesBar(); else render();
    };
  });
}
function noteRowHTML(t, fb) {
  const filed = noteHasTask(t, fb.id);
  return `<div class="note-row" data-fb="${fb.id}">
    <div class="note-main">
      <span class="afb-song" data-open="${t.id}">${dispNum(t) !== "" ? `<span class="tnum">${dispNum(t)}</span> ` : ""}${esc(t.title)}</span>
      <button class="note-time" data-nseek="${fb.timestamp}" data-ntrack="${t.id}" title="Play from pre-roll before">${mmss(fb.timestamp)}</button>
      <span class="note-when">${fmtWhen(fb.createdTime)}</span>
      <span class="note-author">${esc(fb.author || "")}</span>
      <div class="fb-actions"><button class="fb-mini" data-nresolve="${fb.id}">Resolve</button><button class="fb-mini" data-ndel="${fb.id}">&times;</button></div>
    </div>
    <div class="fb-body">
      <div class="fb-comment">${esc(fb.comment)}</div>
      <div class="fb-right">${filed ? `<div class="nt-filed">&#10003; Task filed — resolves when done</div>` : noteTaskCtrls(t, fb)}</div>
    </div>
  </div>`;
}
function notesHTML() {
  const alb = currentAlbum();
  const inScope = (t) => !t.onHold && (!alb || t.albumId === alb.id);
  const rows = [];
  state.data.tracks.filter(inScope).forEach((t) => { const cur = currentVersion(t); (t.feedback || []).filter((fb) => fb.status === "Open" && (fb.version || "") === (cur || "")).forEach((fb) => rows.push({ t, fb })); });
  rows.sort((a, b) => (effOrder(a.t) - effOrder(b.t)) || (a.fb.timestamp - b.fb.timestamp));
  const list = rows.length ? rows.map(({ t, fb }) => noteRowHTML(t, fb)).join("") : `<div class="empty" style="padding:24px">No open notes${alb ? " for this album" : ""}.</div>`;
  return `<div class="notes-page"><div class="notes-head">Open notes<span class="asg-count">${rows.length}</span></div>${list}</div>`;
}
function fbItemHTML(fb, t) {
  const showCtrls = fb.status === "Open" && t;
  const right = showCtrls ? (noteHasTask(t, fb.id) ? `<div class="nt-filed">&#10003; Task filed</div>` : noteTaskCtrls(t, fb)) : "";
  return `
    <div class="fb-item ${fb.status === "Resolved" ? "resolved" : ""}" data-fb="${fb.id}">
      <div class="fb-top">
        <button class="fb-time" data-seek="${fb.timestamp}" title="Play from pre-roll before">${mmss(fb.timestamp)}</button>
        <span class="fb-when">${fmtWhen(fb.createdTime)}</span>
        <span class="fb-author">${esc(fb.author || "—")}</span>
        <div class="fb-actions">
          <button class="fb-mini" data-fbtoggle="${fb.status}">${fb.status === "Open" ? "Resolve" : "Reopen"}</button>
          <button class="fb-mini" data-fbdel>&times;</button>
        </div>
      </div>
      <div class="fb-body">
        <div class="fb-comment">${esc(fb.comment)}</div>
        ${right ? `<div class="fb-right">${right}</div>` : ""}
      </div>
    </div>`;
}
// Timestamped feedback lives in its own modal (like the lyrics editor).
let notesBarTrack = null;
let preRoll = (() => { const raw = localStorage.getItem("megasPreroll"); const v = Number(raw); return raw !== null && raw !== "" && isFinite(v) && v >= 0 ? v : 5; })();
let notesTimeLocked = false;
function positionNotesBar() {
  const bar = document.getElementById("notesbar"); if (!bar) return;
  const player = document.getElementById("player");
  const shown = player && !player.classList.contains("hidden");
  bar.style.bottom = (shown ? player.offsetHeight : 0) + "px";
}
function closeNotesBar() { const bar = document.getElementById("notesbar"); if (!bar) return; bar.classList.remove("open"); notesBarTrack = null; setTimeout(() => { if (!bar.classList.contains("open")) bar.innerHTML = ""; }, 380); }
function openNotesBar(id, lockNow) { const t = trackById(id); if (!t) return; notesBarTrack = id; notesTimeLocked = false; document.getElementById("notesbar").classList.add("open"); renderNotesBar(); if (lockNow) notesTimeLocked = true; }
function renderNotesBar() {
  const bar = document.getElementById("notesbar"); if (!bar || !notesBarTrack) return;
  const t = trackById(notesBarTrack); if (!t) { closeNotesBar(); return; }
  const cur = currentVersion(t);
  const list = (t.feedback || []).filter((fb) => (fb.version || "") === (cur || "")).sort((a, b) => a.timestamp - b.timestamp);
  const playing = state.audio.currentId === t.id;
  const curT = playing ? Math.floor(audioEl().currentTime || 0) : 0;
  const rows = list.length ? list.map((fb) => fbItemHTML(fb, t)).join("") : `<div class="empty">No notes on the current version yet.</div>`;
  const older = (t.feedback || []).filter((fb) => (fb.version || "") !== (cur || ""));
  const olderByVer = {}; older.forEach((fb) => { const k = fb.version || "(no version)"; (olderByVer[k] = olderByVer[k] || []).push(fb); });
  const olderHTML = Object.keys(olderByVer).length ? `<details class="fb-older"><summary>Previous versions (${older.length})</summary>${Object.entries(olderByVer).map(([v, l]) => `<div class="fb-vergroup"><div class="fb-verhd">${esc(v)}</div>${l.map((fb) => fbItemHTML(fb, t)).join("")}</div>`).join("")}</details>` : "";
  bar.innerHTML = `
    <div class="nb-head">
      <span class="nb-title">${dispNum(t) !== "" ? `<span class="tnum">${dispNum(t)}</span> ` : ""}${esc(t.title)}</span>
      ${cur ? `<span class="nb-ver" title="Notes are pinned to this bounce">${esc(cur)}</span>` : ""}
      <span style="flex:1"></span>
      <button class="icon-btn" id="nbClose" title="Close">&times;</button>
    </div>
    <div class="nb-preroll">Pre-roll <input type="number" id="nbPreroll" min="0" max="30" step="1" value="${preRoll}" /> s before each note</div>
    <div class="nb-list">${rows}${olderHTML}</div>
    <div class="nb-add">
      <button class="nb-time" id="nbTime" title="${playing ? "Live time — click to resync; locks when you type" : "Timestamp"}">${mmss(curT)}</button>
      <input type="text" id="nbText" placeholder="Add a note${playing ? " here" : ""}…" />
      <button class="add-btn" id="nbAdd">Add note</button>
    </div>
    <div class="nb-hint">${playing ? "Live time — click to resync; locks when you type" : "Timestamp"}</div>`;
  bar.querySelectorAll("[data-seek]").forEach((s) => s.onclick = () => seekTo(t.id, Math.max(0, Number(s.dataset.seek) - preRoll)));
  bar.querySelectorAll(".fb-item").forEach((item) => {
    const fid = item.dataset.fb;
    const tg = item.querySelector("[data-fbtoggle]"); if (tg) tg.onclick = async () => { const c = tg.dataset.fbtoggle; const r = await update("feedback", fid, { status: c === "Open" ? "Resolved" : "Open" }); if (r.ok) { toast("Updated"); await refresh(); renderNotesBar(); } };
    const dl = item.querySelector("[data-fbdel]"); if (dl) dl.onclick = async () => { if (!(await confirmDialog("Delete this note? This can\u2019t be undone.", { title: "Delete note", okText: "Delete", danger: true }))) return; const r = await deleteEntity("feedback", fid); if (r.ok) { toast("Deleted"); await refresh(); renderNotesBar(); } };
  });
  wireNoteCtrls(bar);
  notesTimeLocked = false;
  const textEl = document.getElementById("nbText");
  const lock = () => { notesTimeLocked = true; };
  textEl.addEventListener("focus", lock); textEl.addEventListener("input", lock);
  document.getElementById("nbTime").onclick = () => { if (state.audio.currentId === t.id) { document.getElementById("nbTime").textContent = mmss(Math.floor(audioEl().currentTime || 0)); notesTimeLocked = false; } };
  { const pr = document.getElementById("nbPreroll"); if (pr) pr.onchange = () => { const v = Number(pr.value); preRoll = isFinite(v) && v >= 0 ? Math.min(30, v) : 5; localStorage.setItem("megasPreroll", preRoll); pr.value = preRoll; }; }
  document.getElementById("nbClose").onclick = closeNotesBar;
  document.getElementById("nbAdd").onclick = async () => {
    const comment = textEl.value.trim(); if (!comment) { toast("Write a note first", true); return; }
    const me = await ensureMe();
    const ts = parseTime(document.getElementById("nbTime").textContent);
    const r = await createEntity("feedback", { trackId: t.id, timestamp: ts, comment, authorId: me ? me.id : undefined, version: cur });
    if (r.ok) { toast("Note added"); await refresh(); renderNotesBar(); if (state.audio.currentId === t.id) renderMarkers(); }
  };
  textEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); document.getElementById("nbAdd").click(); } });
  positionNotesBar();
}
function openFeedbackModal(id) {
  const t = trackById(id);
  if (!t) return;
  openModal(`
    <div class="mhd"><h2>Notes &middot; ${esc(t.title)}</h2><span style="flex:1"></span><button class="icon-btn close" id="mClose">&times;</button></div>
    <div class="mbd"><div id="dFeedback"></div></div>`);
  $("#mClose").onclick = closeModal;
  renderFeedback(t);
}
function renderFeedback(t) {
  const el = $("#dFeedback"); if (!el) return;
  const all = t.feedback || [];
  const cur = currentVersion(t);
  const curList = all.filter((fb) => (fb.version || "") === (cur || ""));
  const older = all.filter((fb) => (fb.version || "") !== (cur || ""));
  const olderByVer = {};
  older.forEach((fb) => { const k = fb.version || "(no version)"; (olderByVer[k] = olderByVer[k] || []).push(fb); });
  const curRows = curList.length ? curList.map((fb) => fbItemHTML(fb, t)).join("") : `<div class="empty">No notes on the current version yet.</div>`;
  const olderHTML = Object.keys(olderByVer).length
    ? `<details class="fb-older"><summary>Earlier versions (${older.length})</summary>${Object.entries(olderByVer).map(([v, list]) => `<div class="fb-vergroup"><div class="fb-verhd">${esc(v)}</div>${list.map((fb) => fbItemHTML(fb, t)).join("")}</div>`).join("")}</details>`
    : "";
  const curT = state.audio.currentId === t.id ? Math.floor(audioEl().currentTime || 0) : 0;
  el.innerHTML = `
    ${cur ? `<div class="fb-vercur" title="Notes are pinned to this bounce">Current version: ${esc(cur)}</div>` : ""}
    <div class="fb-list">${curRows}</div>
    <div class="fb-add" style="margin-top:8px">
      <div class="fb-atwrap"><span style="color:var(--muted);font-size:12px">At</span>
        <input type="text" id="fbTime" value="${mmss(curT)}" />
        <button class="fb-mini" id="fbNow">Use current time</button>
      </div>
      <textarea id="fbComment" placeholder="Add a note at this time…"></textarea>
      <div class="fb-addrow"><button class="add-btn" id="fbAdd">Add note</button></div>
    </div>
    ${olderHTML}`;
  el.querySelectorAll("[data-seek]").forEach((s) => s.onclick = () => seekTo(t.id, Math.max(0, Number(s.dataset.seek) - preRoll)));
  el.querySelectorAll(".fb-item").forEach((item) => {
    const id = item.dataset.fb;
    item.querySelector("[data-fbtoggle]").onclick = async () => {
      const cur = item.querySelector("[data-fbtoggle]").dataset.fbtoggle;
      const r = await update("feedback", id, { status: cur === "Open" ? "Resolved" : "Open" });
      if (r.ok) { toast("Updated"); await refresh(); reRenderFeedback(t.id); }
    };
    item.querySelector("[data-fbdel]").onclick = async () => {
      if (!(await confirmDialog("Delete this note? This can\u2019t be undone.", { title: "Delete note", okText: "Delete", danger: true }))) return;
      const r = await deleteEntity("feedback", id);
      if (r.ok) { toast("Deleted"); await refresh(); reRenderFeedback(t.id); }
    };
  });
  wireNoteCtrls(el);
  $("#fbNow").onclick = () => {
    if (state.audio.currentId === t.id) $("#fbTime").value = mmss(Math.floor(audioEl().currentTime || 0));
    else toast("Play this track first", true);
  };
  $("#fbAdd").onclick = async () => {
    const comment = $("#fbComment").value.trim();
    if (!comment) { toast("Write a note first", true); return; }
    const me = await ensureMe();
    const r = await createEntity("feedback", { trackId: t.id, timestamp: parseTime($("#fbTime").value), comment, authorId: me ? me.id : undefined, version: cur });
    if (r.ok) { toast("Note added"); await refresh(); reRenderFeedback(t.id); }
  };
}
// After data reloads, repaint the feedback list in the open modal (if any).
function reRenderFeedback(id) {
  if (!document.getElementById("dFeedback")) return;
  const nt = trackById(id);
  if (nt) renderFeedback(nt);
}

/* ---- Versions --------------------------------------------------------------*/
async function loadVersions(t) {
  const el = $("#dVersions"); if (!el) return;
  const alb = state.data.albums.find((a) => a.id === t.albumId);
  if (!alb || !alb.dropboxFolder) { el.innerHTML = `<div class="empty">Set this album's Dropbox folder to see versions.</div>`; return; }
  el.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const u = "/api/versions?folder=" + encodeURIComponent(alb.dropboxFolder) + "&prefix=" + encodeURIComponent(alb.trackPrefix || "") + "&order=" + effOrder(t);
    const r = await fetch(u);
    const j = await r.json();
    if (!j.items || !j.items.length) {
      const offline = [...new Set((t.feedback || []).map((fb) => fb.version).filter(Boolean))];
      if (!offline.length) { el.innerHTML = `<div class="empty">No audio files found for this track.</div>`; return; }
      el.innerHTML = `<div class="ver-list">${offline.map((ver) => { const n = (t.feedback || []).filter((fb) => fb.version === ver).length; return `<div class="ver-item offline"><span class="vlabel">${esc(ver)}</span><span class="vmeta">Offline — file not in Dropbox</span><span class="vtag">${n} note(s)</span></div>`; }).join("")}</div>`;
      return;
    }
    const live = new Set((j.items || []).map((v) => v.version));
    const offline = [...new Set((t.feedback || []).map((fb) => fb.version).filter((v) => v && !live.has(v)))];
    const offlineHTML = offline.map((ver) => { const n = (t.feedback || []).filter((fb) => fb.version === ver).length; return `<div class="ver-item offline"><span class="vlabel">${esc(ver)}</span><span class="vmeta">Offline — file not in Dropbox</span><span class="vtag">${n} note(s)</span></div>`; }).join("");
    el.innerHTML = `<div class="ver-list">${j.items.map((v) => `
      <div class="ver-item ${v.current ? "current" : ""}">
        <span class="vlabel">${esc(v.version || "—")}</span>
        <span class="vmeta">${esc(v.ext.toUpperCase())} &middot; ${new Date(v.modified).toLocaleDateString()}</span>
        <span class="vtag">${v.current ? "current" : (v.previous ? "previous" : "")}</span>
        <button class="fb-mini" data-vurl="${esc(v.url)}" title="Play this version">Play</button>
      </div>`).join("")}${offlineHTML}</div>`;
    el.querySelectorAll("[data-vurl]").forEach((b) => b.onclick = () => {
      const a = audioEl(); state.audio.currentId = null; a.src = b.dataset.vurl; a.play().catch(() => {});
      toast("Playing selected version");
    });
  } catch { el.innerHTML = `<div class="empty">Couldn't load versions.</div>`; }
}

/* ---- Toast -----------------------------------------------------------------*/
let toastTimer;
function toast(msg, bad = false) {
  const el = $("#toast");
  el.textContent = msg; el.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 3200);
}

/* ---- Boot ------------------------------------------------------------------*/

/* ---- Scratchpad (private, per-member, autosaving) --------------------------*/
let scratchData = { current: "", history: [] };
let scratchSaveTimer = null;
let scratchDirty = false;
function scratchCacheKey() { const me = getMe(); return "megasScratch:" + (me ? me.id : "anon"); }
function scratchMemberRec() { const me = getMe(); return me ? (state.data.members || []).find((m) => m.id === me.id) : null; }
function scratchNormalize(d) { if (!d || typeof d !== "object") d = {}; if (typeof d.current !== "string") d.current = ""; if (!Array.isArray(d.history)) d.history = []; return d; }
function scratchLoad() {
  const mem = scratchMemberRec();
  let d = null;
  if (mem && mem.scratch) { try { d = JSON.parse(mem.scratch); } catch {} }
  if (!d) { try { d = JSON.parse(localStorage.getItem(scratchCacheKey()) || "null"); } catch {} }
  return scratchNormalize(d);
}
function scratchStatus(t) { const s = document.getElementById("scrSave"); if (s) s.textContent = t; }
function scratchSave(immediate) {
  try { localStorage.setItem(scratchCacheKey(), JSON.stringify(scratchData)); } catch {}
  const me = getMe();
  if (!me) { scratchStatus("Saved on device — set “You” to sync"); setTimeout(() => scratchStatus(""), 1600); return; }
  clearTimeout(scratchSaveTimer);
  const doSave = async () => {
    scratchStatus("Saving…");
    const json = JSON.stringify(scratchData);
    let ok = false;
    try { const r = await update("member", me.id, { scratch: json }); ok = !!(r && r.ok); } catch {}
    const mem = scratchMemberRec(); if (mem) mem.scratch = json;
    if (ok) scratchDirty = false;
    scratchStatus(ok ? "Saved" : "Save failed — kept on device");
    setTimeout(() => scratchStatus(""), 1600);
  };
  if (immediate) doSave(); else scratchSaveTimer = setTimeout(doSave, 900);
}
function scratchFlush() {
  if (!scratchDirty) return;
  const me = getMe(); if (!me) return;
  const ta = document.getElementById("scrText"); if (ta) scratchData.current = ta.value;
  const json = JSON.stringify(scratchData);
  try { localStorage.setItem("megasScratch:" + me.id, json); } catch {}
  try { if (navigator.sendBeacon) navigator.sendBeacon("/api/update", new Blob([JSON.stringify({ entity: "member", id: me.id, fields: { scratch: json } })], { type: "application/json" })); } catch {}
  scratchDirty = false;
}
function scratchSyncFromStorage(e) {
  const me = getMe(); if (!me || !e || e.key !== "megasScratch:" + me.id || e.newValue == null) return;
  try {
    scratchData = scratchNormalize(JSON.parse(e.newValue));
    const mem = scratchMemberRec(); if (mem) mem.scratch = e.newValue;
    const ta = document.getElementById("scrText"); if (ta && document.activeElement !== ta) ta.value = scratchData.current;
    const box = document.getElementById("scrHistBox"); if (box && !box.hidden) renderScratchHist(true);
  } catch {}
}
function openScratch(notice) {
  const el = document.getElementById("scratch"); if (!el) return;
  const btn = document.getElementById("scratchBtn"); if (btn) btn.classList.add("active");
  if (el.classList.contains("open")) { const ta = document.getElementById("scrText"); if (ta) ta.focus(); return; }
  const me = getMe();
  scratchData = scratchLoad();
  el.innerHTML = `
    <div class="scr-head" id="scrHead">
      <span class="scr-title">Scratchpad${me ? " — " + esc(me.name) : ""}</span>
      <span class="scr-save" id="scrSave"></span>
      <button class="icon-btn" id="scrHist" title="Session history">&#9776;</button>
      <button class="icon-btn" id="scrPop" title="Pop out into its own window">&#8599;</button>
      <button class="icon-btn" id="scrClose" title="Close">&times;</button>
    </div>
    ${notice ? `<div class="scr-note">${esc(notice)}</div>` : ""}
    <textarea id="scrText" placeholder="Jot notes, lyrics, ideas… saves automatically."></textarea>
    <div class="scr-foot">
      <button class="fb-mini" id="scrSaveEntry" title="Snapshot the current text to history and start fresh">Save entry &amp; clear</button>
    </div>
    <div class="scr-history" id="scrHistBox" hidden></div>`;
  el.classList.add("open");
  const ta = document.getElementById("scrText");
  ta.value = scratchData.current;
  if (!me) scratchStatus("Set “You” to sync");
  ta.oninput = () => { scratchData.current = ta.value; scratchDirty = true; scratchStatus("Saving…"); scratchSave(false); };
  document.getElementById("scrClose").onclick = () => { scratchData.current = ta.value; scratchSave(true); closeScratch(); };
  document.getElementById("scrHist").onclick = () => renderScratchHist();
  document.getElementById("scrPop").onclick = () => { scratchData.current = ta.value; scratchSave(true); window.open("/scratch.html", "megasScratch", "width=380,height=560,menubar=no,toolbar=no,location=no,status=no"); closeScratch(); };
  document.getElementById("scrSaveEntry").onclick = () => {
    const txt = ta.value.trim();
    if (!txt) { scratchStatus("Nothing to save"); setTimeout(() => scratchStatus(""), 1200); return; }
    scratchData.history.unshift({ t: Date.now(), text: ta.value });
    scratchData.history = scratchData.history.slice(0, 50);
    scratchData.current = ""; ta.value = "";
    scratchSave(true);
    const box = document.getElementById("scrHistBox"); if (box && !box.hidden) renderScratchHist(true);
    ta.focus();
  };
  makeDraggable(el, document.getElementById("scrHead"));
  ta.focus();
}
function closeScratch() { const el = document.getElementById("scratch"); if (el) { el.classList.remove("open"); el.innerHTML = ""; } const btn = document.getElementById("scratchBtn"); if (btn) btn.classList.remove("active"); }
function renderScratchHist(keepOpen) {
  const box = document.getElementById("scrHistBox"); if (!box) return;
  if (!keepOpen && !box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  const h = scratchData.history || [];
  box.innerHTML = h.length ? h.map((e, i) => `
    <div class="scr-hitem" data-i="${i}">
      <div class="scr-hmeta"><span>${esc(fmtWhen(new Date(e.t).toISOString()))}</span><button class="scr-hdel" data-hdel="${i}" title="Delete">&times;</button></div>
      <div class="scr-hprev">${esc((e.text || "").slice(0, 160))}${(e.text || "").length > 160 ? "…" : ""}</div>
    </div>`).join("") : `<div class="scr-hempty">No saved entries yet. Use “Save entry &amp; clear” to snapshot the current note.</div>`;
  box.querySelectorAll(".scr-hitem").forEach((it) => it.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-hdel]")) return;
    const e = (scratchData.history || [])[Number(it.dataset.i)]; if (!e) return;
    const ta = document.getElementById("scrText"); if (!ta) return;
    const cur = ta.value.trim();
    ta.value = cur ? (cur + "\n\n" + e.text) : e.text; scratchData.current = ta.value; scratchSave(true);
    scratchStatus("Restored"); setTimeout(() => scratchStatus(""), 1200);
    ta.focus();
  }));
  box.querySelectorAll("[data-hdel]").forEach((b) => b.addEventListener("click", (ev) => {
    ev.stopPropagation(); scratchData.history.splice(Number(b.dataset.hdel), 1); scratchSave(true); renderScratchHist(true);
  }));
}
function makeDraggable(panel, handle) {
  if (!handle) return;
  handle.onpointerdown = (e) => {
    if (e.target.closest("button")) return;
    const r = panel.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    panel.style.right = "auto"; panel.style.bottom = "auto";
    const move = (ev) => {
      const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, ev.clientX - ox));
      const y = Math.max(4, Math.min(window.innerHeight - 40, ev.clientY - oy));
      panel.style.left = x + "px"; panel.style.top = y + "px";
    };
    const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  };
}

function wireChrome() {
  // Lets a popped-out teleprompter window trigger a data refresh after saving edits.
  window.__tpRefresh = () => refresh(false);
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => { state.view = t.dataset.view; render(); }));
  // Left slide-out navigation (mobile)
  const openNav = () => { $("#navmenu").classList.add("open"); $("#navScrim").classList.add("open"); };
  const closeNav = () => { $("#navmenu").classList.remove("open"); $("#navScrim").classList.remove("open"); };
  $("#navBtn").addEventListener("click", openNav);
  $("#navClose").addEventListener("click", closeNav);
  $("#navScrim").addEventListener("click", closeNav);
  document.querySelectorAll(".navitem").forEach((t) =>
    t.addEventListener("click", () => { state.view = t.dataset.view; closeNav(); render(); }));
  // Close any open album switcher menu when clicking outside of it.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".asw-wrap")) document.querySelectorAll(".asw-menu.open").forEach((m) => m.classList.remove("open"));
  });
  // Right slide-out menu
  const openMenu = () => { $("#sidemenu").classList.add("open"); $("#menuScrim").classList.add("open"); };
  const closeMenu = () => { $("#sidemenu").classList.remove("open"); $("#menuScrim").classList.remove("open"); };
  $("#menuBtn").addEventListener("click", openMenu);
  $("#menuClose").addEventListener("click", closeMenu);
  $("#menuScrim").addEventListener("click", closeMenu);

  $("#newTrack").addEventListener("click", () => { closeMenu(); openCreateTrack(); });
  $("#newAlbum").addEventListener("click", () => { closeMenu(); openCreateAlbum(); });
  $("#whoami").addEventListener("click", () => { closeMenu(); pickIdentity(); });
  $("#scratchBtn").addEventListener("click", () => {
    closeMenu();
    let w = null; try { w = window.open("/scratch.html", "megasScratch", "width=380,height=560,menubar=no,toolbar=no,location=no,status=no"); } catch {}
    if (w && !w.closed) { w.focus(); }
    else { openScratch("Pop-ups are blocked, so the scratchpad opened here. Allow pop-ups for this site and it’ll open in its own window next time."); }
  });
  window.addEventListener("storage", scratchSyncFromStorage);
  window.addEventListener("beforeunload", scratchFlush);
  window.addEventListener("pagehide", scratchFlush);
  $("#refresh").addEventListener("click", async () => { closeMenu(); await refresh(false); await fetchPlaylist(); render(); });
  $("#logout").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/login.html"; });
  $("#scrim").addEventListener("click", closeDrawer);
  $("#mscrim").addEventListener("click", closeModal);
  $("#lightbox").addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { const tpEl = document.getElementById("teleprompter"); if (tpEl && tpEl.classList.contains("open")) return; closeNotesBar(); closeLightbox(); closeDrawer(); closeModal(); closeMenu(); closeNav(); } });
}

(async function boot() {
  wireChrome();
  wireAudio();
  updateWhoami();
  await refresh(false);
  await fetchPlaylist();
  render(); // re-render so play buttons appear once the playlist is known
  // First-time on this browser: ask who "you" are so notes/assignments are tagged correctly.
  if (!getMe() && (state.data.members || []).length) pickIdentity(true);
  else if (getMe()) maybeVersionPrompt();
})();
