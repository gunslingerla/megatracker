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
let newlyAddedSub = null; // "phase:index" of a just-added subtask (for pop-in) // Band cards in edit mode
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
  const arr = (ph.subtasks || []).map((x) => ({ text: x.text, done: !!x.done }));
  if (!arr[i]) return; arr[i].done = checked;
  const r = await update("phase", pid, { subtasks: JSON.stringify(arr) });
  if (r.ok) refresh();
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
  else if (state.view === "calendar") main.innerHTML = calendarHTML();
  else if (state.view === "hold") main.innerHTML = holdHTML();
  else if (state.view === "roster") main.innerHTML = rosterHTML();
  wireBoard();
  wireSwitchers();
  wireArtView();
  // The header strip switcher shows on album-scoped views; on Preview each section
  // header is its own switcher, so the strip is hidden there.
  const showStrip = ["tracks", "members", "calendar"].includes(state.view);
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
        <button class="lyr-btn" data-lyr="${t.id}" title="Edit lyrics">Lyrics</button>
        <button class="lyr-btn" data-fb="${t.id}" title="Timestamped feedback">Feedback${openFbCount(t) ? ` (${openFbCount(t)})` : ""}</button>
      </div>
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
function membersHTML() {
  const alb = currentAlbum();
  const tracks = state.data.tracks.filter((t) => (!alb || t.albumId === alb.id) && !t.onHold);
  const me = getMe();
  const byMember = {};
  state.data.members.forEach((m) => (byMember[m.id] = { member: m, songs: {}, count: 0, nextDue: null }));
  const earlier = (a, b) => (a == null ? b : b == null ? a : (a < b ? a : b));
  tracks.forEach((t) => {
    t.phases.filter((p) => p.status !== "Done").forEach((p) => {
      p.ownerIds.forEach((oid) => {
        const rec = byMember[oid]; if (!rec) return;
        const song = (rec.songs[t.id] = rec.songs[t.id] || { id: t.id, title: t.title, order: effOrder(t), num: dispNum(t), nextDue: null, items: [] });
        song.items.push({ phaseId: p.id, phase: p.phase, status: p.status, due: p.due || null, subtasks: Array.isArray(p.subtasks) ? p.subtasks : [] });
        if (p.due) { song.nextDue = earlier(song.nextDue, p.due); rec.nextDue = earlier(rec.nextDue, p.due); }
        rec.count++;
      });
    });
  });
  const byDue = (a, b) => (a.nextDue && b.nextDue) ? (a.nextDue < b.nextDue ? -1 : a.nextDue > b.nextDue ? 1 : 0) : (a.nextDue ? -1 : b.nextDue ? 1 : 0);
  const entries = Object.values(byMember).sort((a, b) => {
    if (me) { if (a.member.id === me.id) return -1; if (b.member.id === me.id) return 1; }
    const d = byDue(a, b); if (d) return d;
    return b.count - a.count;
  });
  const cards = entries.map(({ member, songs, count }) => {
    const songCards = Object.values(songs).sort((a, b) => { const d = byDue(a, b); return d || (a.order - b.order); }).map((s) => `
      <div class="song-card" data-song="${s.id}">
        <div class="song-title" data-songopen="${s.id}">${s.num !== "" ? `<span class="tnum">${s.num}</span> ` : ""}${esc(s.title)}${s.nextDue ? `<span class="due-tag">${fmtDay(s.nextDue)}</span>` : ""}</div>
        ${s.items.map((it) => { const subs = it.subtasks || []; const sd = subs.filter((x) => x.done).length; const subList = subs.length ? `<div class="song-subs">${subs.map((st, i) => `<label class="song-sub"><input type="checkbox" data-subchk="${it.phaseId}:${i}" ${st.done ? "checked" : ""} /><span class="${st.done ? "done" : ""}">${esc(st.text)}</span></label>`).join("")}</div>` : ""; return `<div class="song-task" data-phase="${it.phaseId}"><label class="song-task-main"><input type="checkbox" /> <span class="stp">${esc(it.phase)}</span>${subs.length ? `<span class="sub-count">${sd}/${subs.length}</span>` : ""}${it.due ? `<span class="due-tag sm">${fmtDay(it.due)}</span>` : ""}${it.status === "In progress" ? '<span class="badge prog">In progress</span>' : ""}</label>${subList}</div>`; }).join("")}
      </div>`).join("") || `<div class="empty">All caught up</div>`;
    const meCls = me && member.id === me.id ? " me" : "";
    return `
      <div class="mcard${meCls}">
        <div class="mhead">
          <div class="avatar" style="${member.color ? `background:${member.color};color:#0c0b10` : ""}" title="${esc(member.display)}">${esc(initials(member.display))}</div>
          <div><div class="mname">${esc(member.display)}</div><div class="mrole">${esc(member.role)}</div></div>
          <div style="margin-left:auto;color:var(--muted);font-weight:700">${count}</div>
        </div>
        ${songCards}
      </div>`;
  }).join("");
  return `<div class="members">${cards}</div>`;
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
    b.addEventListener("click", (e) => { e.stopPropagation(); openLyricsEditor(b.dataset.lyr); }));
  document.querySelectorAll(".lyr-btn[data-fb]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); openFeedbackModal(b.dataset.fb); }));

  document.querySelectorAll("[data-playalbum]").forEach((b) => b.onclick = () => playAlbum(b.dataset.playalbum));
  document.querySelectorAll(".trow[data-tid]").forEach((r) =>
    r.addEventListener("click", () => { const t = state.data.tracks.find((x) => x.id === r.dataset.tid); if (t) openDrawer(t.id); }));

  document.querySelectorAll(".song-task[data-phase]").forEach((l) =>
    l.querySelector("input").addEventListener("change", async (e) => {
      const done = e.target.checked;
      const fields = { status: done ? "Done" : "Not started" };
      if (!done) { const ph = (state.data.phases || []).find((p) => p.id === l.dataset.phase); if (ph && !ph.due) fields.due = todayISO(); }
      const r = await update("phase", l.dataset.phase, fields);
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
    if (!confirm("Update every existing track's phase owners to match these assignments? Any manual per-track owner tweaks will be overwritten.")) return;
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
    const subItems = subs.map((st, i) => `<label class="sub-item${newlyAddedSub === p.id + ":" + i ? " just-added" : ""}"><input type="checkbox" data-subchk="${p.id}:${i}" ${st.done ? "checked" : ""} /><span class="${st.done ? "done" : ""}">${esc(st.text)}</span><button class="sub-del" data-subdel="${p.id}:${i}" title="Delete">&times;</button></label>`).join("");
    return `
      <div class="phase-block" style="--own:${col}">
        <div class="phase-row2 ${done ? "done" : ""}${custom ? " custom" : ""}" data-phase="${p.id}">
          <input type="checkbox" data-pf="done" ${done ? "checked" : ""} />
          <span class="pname2">${esc(p.phase)}${custom ? ` <span class="cust-tag">custom</span>` : ""}</span>
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
          <button class="add-btn ghost" id="dLyricsEdit">Edit sections</button>
          <button class="add-btn ghost" id="dTele">Teleprompter</button>
        </div>
      </div>
      <div class="field"><label>Timestamped feedback</label><button class="add-btn ghost" id="dFbBtn">Open feedback${openFbCount(t) ? ` (${openFbCount(t)})` : ""}</button></div>
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
    if (!confirm("Remove this phase from the song?")) return;
    const r = await deleteEntity("phase", b.dataset.pdel);
    if (r.ok) { toast("Phase removed"); await refresh(false); openDrawer(id); } else toast((r && r.error) || "Couldn't remove", true);
  });
  // Subtasks (stored as JSON on each phase)
  const phaseArr = (pid) => { const ph = (state.data.phases || []).find((p) => p.id === pid); return Array.isArray(ph && ph.subtasks) ? ph.subtasks.map((x) => ({ text: x.text, done: !!x.done })) : []; };
  const saveSubs = async (pid, arr) => { expandedSubs.add(pid); const r = await update("phase", pid, { subtasks: JSON.stringify(arr) }); if (r.ok) { await refresh(false); openDrawer(id); } return r; };
  document.querySelectorAll("#drawer [data-subtoggle]").forEach((b) => b.onclick = () => {
    const pid = b.dataset.subtoggle; const panel = document.querySelector(`[data-subpanel="${pid}"]`);
    const nowOpen = !(panel && panel.classList.contains("open"));
    if (nowOpen) { expandedSubs.add(pid); collapsedSubs.delete(pid); } else { expandedSubs.delete(pid); collapsedSubs.add(pid); }
    b.classList.toggle("open", nowOpen); if (panel) panel.classList.toggle("open", nowOpen);
  });
  document.querySelectorAll("#drawer [data-subchk]").forEach((c) => c.addEventListener("change", async (e) => {
    const ix = c.dataset.subchk.lastIndexOf(":"); const pid = c.dataset.subchk.slice(0, ix), i = +c.dataset.subchk.slice(ix + 1);
    const arr = phaseArr(pid); if (arr[i]) { arr[i].done = e.target.checked; await saveSubs(pid, arr); }
  }));
  document.querySelectorAll("#drawer [data-subdel]").forEach((b) => b.onclick = async () => {
    const ix = b.dataset.subdel.lastIndexOf(":"); const pid = b.dataset.subdel.slice(0, ix), i = +b.dataset.subdel.slice(ix + 1);
    const arr = phaseArr(pid); arr.splice(i, 1); await saveSubs(pid, arr);
  });
  document.querySelectorAll("#drawer [data-subadd]").forEach((b) => b.onclick = async () => {
    const pid = b.dataset.subadd; const inp = document.querySelector(`#drawer [data-subnew="${pid}"]`); const txt = ((inp && inp.value) || "").trim();
    if (!txt) { toast("Type a subtask first", true); return; }
    const arr = phaseArr(pid); arr.push({ text: txt, done: false });
    newlyAddedSub = pid + ":" + (arr.length - 1);
    await saveSubs(pid, arr);
    newlyAddedSub = null;
    const ninp = document.querySelector(`#drawer [data-subnew="${pid}"]`); if (ninp) ninp.focus();
  });
  document.querySelectorAll("#drawer [data-subnew]").forEach((inp) => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const b = document.querySelector(`[data-subadd="${inp.dataset.subnew}"]`); if (b) b.click(); } }));

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
  $("#dLyricsEdit").onclick = () => openLyricsEditor(id);
  $("#dTele").onclick = () => openTeleprompter(id);
  $("#dVerLoad").onclick = () => loadVersions(t);
  $("#dMakeFolder").onclick = async () => {
    if (!confirm(`Create the Dropbox project folder (with a Bounces subfolder) for "${t.title}"?`)) return;
    toast("Creating folder…");
    const r = await post("/api/makefolders", { trackId: id });
    if (r.ok) { toast(r.created && r.created.length ? "Folder created" : "Folder already exists"); await refresh(false); await fetchPlaylist(); openDrawer(id); }
  };
  $("#dFbBtn").addEventListener("click", () => openFeedbackModal(t.id));

  $("#dDelete").addEventListener("click", async () => {
    if (!confirm(`Delete "${t.title}" and its 5 phases? This can't be undone.`)) return;
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
    if (!confirm(`Delete album "${a.title}"? (Only works if it has no tracks.)`)) return;
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
function playTrack(id) {
  const item = audioFor(trackById(id));
  if (!item) return;
  const a = audioEl();
  if (state.audio.currentId === id) { a.paused ? a.play().catch(() => {}) : a.pause(); return; }
  state.audio.currentId = id;
  if (!state.audio.queue || !state.audio.queue.includes(id)) state.audio.queue = playQueue();
  triedRelink = false;
  a.src = item.url;
  a.play().catch(() => {});
  renderPlayer();
}
function playNext(dir = 1) {
  const q = (state.audio.queue && state.audio.queue.length) ? state.audio.queue : playQueue();
  const i = q.indexOf(state.audio.currentId);
  const ni = i < 0 ? 0 : i + dir;
  if (ni >= 0 && ni < q.length) playTrack(q[ni]);
}
function playAlbum(albumId) {
  const q = state.data.tracks.filter((t) => t.albumId === albumId && audioFor(t)).sort((a, b) => effOrder(a) - effOrder(b)).map((t) => t.id);
  if (!q.length) { toast("No audio in this album yet", true); return; }
  state.audio.queue = q;
  playTrack(q[0]);
}

function updatePlayButtons() {
  document.querySelectorAll(".play-btn[data-play]").forEach((b) => {
    const on = b.dataset.play === state.audio.currentId && state.audio.playing;
    b.classList.toggle("playing", on);
    b.innerHTML = on ? "&#9208;&#xFE0E;" : "&#9654;&#xFE0E;";
  });
}

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
      <button class="pbtn" id="pToggle" title="Play/Pause">${a.paused ? "&#9654;&#xFE0E;" : "&#9208;&#xFE0E;"}</button>
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
    <button class="fb-mini" id="pFbBtn" title="Add feedback at current time">Note</button>
    <button class="pclose" id="pClose" title="Close">&times;</button>
    <div class="pfb hidden" id="pFbForm">
      <span class="ptime">@ <span id="pFbTime">0:00</span></span>
      <input type="text" id="pFbText" placeholder="Add a note at this moment…" />
      <button class="fb-mini" id="pFbSend">Add note</button>
    </div>`;
  document.getElementById("pToggle").onclick = () => (a.paused ? a.play().catch(() => {}) : a.pause());
  document.getElementById("pPrev").onclick = () => playNext(-1);
  document.getElementById("pNext").onclick = () => playNext(1);
  document.getElementById("pClose").onclick = () => { a.pause(); state.audio.currentId = null; el.className = "player hidden"; updatePlayButtons(); };
  const seek = document.getElementById("pSeek");
  seek.oninput = () => { if (a.duration) a.currentTime = (seek.value / 1000) * a.duration; };

  // Quick timestamped feedback from the play bar.
  let fbStamp = 0;
  document.getElementById("pFbBtn").onclick = () => {
    const form = document.getElementById("pFbForm");
    if (!form.classList.contains("hidden")) { form.classList.add("hidden"); return; }
    fbStamp = Math.floor(a.currentTime || 0);
    document.getElementById("pFbTime").textContent = fmt(fbStamp);
    form.classList.remove("hidden");
    document.getElementById("pFbText").focus();
  };
  const sendFb = async () => {
    const text = document.getElementById("pFbText").value.trim();
    if (!text) { toast("Write a note first", true); return; }
    const me = await ensureMe();
    const r = await createEntity("feedback", { trackId: state.audio.currentId, timestamp: fbStamp, comment: text, authorId: me ? me.id : undefined, version: currentVersion(trackById(state.audio.currentId)) });
    if (r.ok) { toast("Feedback added"); document.getElementById("pFbText").value = ""; document.getElementById("pFbForm").classList.add("hidden"); await refresh(); renderMarkers(); }
  };
  document.getElementById("pFbSend").onclick = sendFb;
  document.getElementById("pFbText").addEventListener("keydown", (e) => { if (e.key === "Enter") sendFb(); });
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
  a.addEventListener("ended", () => playNext(1));
  a.addEventListener("loadedmetadata", renderMarkers);
  a.addEventListener("durationchange", renderMarkers);
  a.addEventListener("timeupdate", () => {
    const seek = document.getElementById("pSeek"), time = document.getElementById("pTime");
    if (seek && a.duration) seek.value = String((a.currentTime / a.duration) * 1000);
    if (time) time.textContent = `${fmt(a.currentTime)} / ${fmt(a.duration)}`;
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
function pickIdentity() {
  return new Promise((resolve) => {
    const members = state.data.members;
    openModal(`
      <div class="mhd"><h2>Who are you?</h2><button class="icon-btn close" id="mClose">&times;</button></div>
      <div class="mbd">
        <p style="color:var(--muted);margin:0">Pick your name — saved on this device so your feedback is tagged to you.</p>
        <div class="owner-picker" id="idPick">${members.map((m) => `<label class="owner-chip"><input type="radio" name="idp" value="${m.id}"/> ${esc(m.display)}</label>`).join("")}</div>
      </div>`);
    $("#mClose").onclick = () => { closeModal(); resolve(getMe()); };
    document.querySelectorAll("#idPick input").forEach((i) =>
      i.addEventListener("change", () => { const m = members.find((x) => x.id === i.value); setMe({ id: m.id, name: m.display }); closeModal(); resolve(getMe()); }));
  });
}
async function ensureMe() { return getMe() || (await pickIdentity()); }

/* ---- Modal helpers ---------------------------------------------------------*/
function openModal(html) { const m = $("#modal"); m.innerHTML = html; $("#mscrim").classList.add("open"); m.classList.add("open"); }
function closeModal() { $("#mscrim").classList.remove("open"); $("#modal").classList.remove("open"); }

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
function openTeleprompter(id, secsOverride) {
  const t = state.data.tracks.find((x) => x.id === id);
  const secs = secsOverride || parseSections(t);
  const tp = $("#teleprompter");
  let font = 46, editing = false, center = true, track = 0, showCtrl = false;
  function close() { tp.classList.remove("open"); tp.innerHTML = ""; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
  function draw() {
    if (editing) { drawEdit(); return; }
    tp.innerHTML = `
      <button class="tp-menu-btn" id="tpMenu" title="Show / hide controls">${showCtrl ? "Close" : "Controls"}</button>
      <div class="tp-panel${showCtrl ? " open" : ""}" id="tpBar">
        <span class="tp-title">${esc(t.title)}</span>
        <div class="tp-row"><button id="tpMinus">A&minus;</button><button id="tpPlus">A+</button></div>
        <label class="tp-ctl"><span>Tracking</span><input type="range" id="tpTrack" min="0" max="10" step="0.5" value="${track}" title="Letter spacing" /></label>
        <button id="tpAlign">${center ? "Left" : "Center"}</button>
        <button id="tpEdit">Edit</button>
        <button id="tpFull">Fullscreen</button>
        <button id="tpPop">Pop-Out</button>
        <button id="tpClose">Close</button>
      </div>
      <div class="tp-scroll${center ? " center" : ""}" id="tpScroll" style="font-size:${font}px;letter-spacing:${track}px">
        ${secs.map((s) => `<div class="tp-section">${s.label ? `<div class="tp-lbl">${esc(s.label)}</div>` : ""}<div class="tp-txt">${esc(s.text)}</div></div>`).join("") || `<div class="tp-section"><div class="tp-txt">No lyrics yet.</div></div>`}
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
      if (r.ok) { secs.length = 0; next.forEach((s) => secs.push(s)); editing = false; toast("Lyrics saved"); draw(); refresh(); }
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
      .l{color:#e5399f;text-transform:uppercase;letter-spacing:.12em;font-size:.42em;margin-bottom:.25em}
      .x{white-space:pre-wrap}
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
        var TID=${JSON.stringify(id)}, secs=parse(${JSON.stringify(flattenSections(secs))});
        var font=46,sc=document.getElementById('sc');
        function esc(s){return String(s).replace(/[&<>]/g,function(c){return c==='&'?'&amp;':c==='<'?'&lt;':'&gt;';});}
        function parse(raw){var lines=String(raw).replace(/\\r/g,'').split('\\n'),out=[],cur=null;for(var i=0;i<lines.length;i++){var m=lines[i].match(/^\\s*\\[(.+?)\\]\\s*$/);if(m){cur={label:m[1].trim(),text:''};out.push(cur);}else{if(!cur){cur={label:'',text:''};out.push(cur);}cur.text+=(cur.text?'\\n':'')+lines[i];}}for(var j=0;j<out.length;j++){out[j].text=out[j].text.replace(/^\\n+|\\n+$/g,'');}return out.filter(function(s){return s.label||s.text.trim();});}
        function flat(a){return a.map(function(s){return (s.label?'['+s.label+']\\n':'')+s.text;}).join('\\n\\n');}
        function render(){
          sc.innerHTML=secs.map(function(s){return '<div class="s">'+(s.label?'<div class="l">'+esc(s.label)+'</div>':'')+'<div class="x">'+esc(s.text)+'</div></div>';}).join('')||'<div class="s"><div class="x">No lyrics yet.</div></div>';
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
function fbItemHTML(fb) {
  return `
    <div class="fb-item ${fb.status === "Resolved" ? "resolved" : ""}" data-fb="${fb.id}">
      <div class="fb-top">
        <span class="fb-time" data-seek="${fb.timestamp}">${mmss(fb.timestamp)}</span>
        <span class="fb-author">${esc(fb.author || "—")}</span>
        <div class="fb-actions">
          <button class="fb-mini" data-fbtoggle="${fb.status}">${fb.status === "Open" ? "Resolve" : "Reopen"}</button>
          <button class="fb-mini" data-fbdel>&times;</button>
        </div>
      </div>
      <div class="fb-comment">${esc(fb.comment)}</div>
    </div>`;
}
// Timestamped feedback lives in its own modal (like the lyrics editor).
function openFeedbackModal(id) {
  const t = trackById(id);
  if (!t) return;
  openModal(`
    <div class="mhd"><h2>Feedback &middot; ${esc(t.title)}</h2><span style="flex:1"></span><button class="icon-btn close" id="mClose">&times;</button></div>
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
  const curRows = curList.length ? curList.map(fbItemHTML).join("") : `<div class="empty">No feedback on the current version yet.</div>`;
  const olderHTML = Object.keys(olderByVer).length
    ? `<details class="fb-older"><summary>Earlier versions (${older.length})</summary>${Object.entries(olderByVer).map(([v, list]) => `<div class="fb-vergroup"><div class="fb-verhd">${esc(v)}</div>${list.map(fbItemHTML).join("")}</div>`).join("")}</details>`
    : "";
  const curT = state.audio.currentId === t.id ? Math.floor(audioEl().currentTime || 0) : 0;
  el.innerHTML = `
    ${cur ? `<div class="fb-vercur" title="Feedback is pinned to this bounce">Current version: ${esc(cur)}</div>` : ""}
    <div class="fb-list">${curRows}</div>
    <div class="fb-add" style="margin-top:8px">
      <div class="fb-atwrap"><span style="color:var(--muted);font-size:12px">At</span>
        <input type="text" id="fbTime" value="${mmss(curT)}" />
        <button class="fb-mini" id="fbNow">Use current time</button>
      </div>
      <textarea id="fbComment" placeholder="Add a note at this time…"></textarea>
      <button class="add-btn" id="fbAdd">Add feedback</button>
    </div>
    ${olderHTML}`;
  el.querySelectorAll("[data-seek]").forEach((s) => s.onclick = () => seekTo(t.id, Number(s.dataset.seek)));
  el.querySelectorAll(".fb-item").forEach((item) => {
    const id = item.dataset.fb;
    item.querySelector("[data-fbtoggle]").onclick = async () => {
      const cur = item.querySelector("[data-fbtoggle]").dataset.fbtoggle;
      const r = await update("feedback", id, { status: cur === "Open" ? "Resolved" : "Open" });
      if (r.ok) { toast("Updated"); await refresh(); reRenderFeedback(t.id); }
    };
    item.querySelector("[data-fbdel]").onclick = async () => {
      if (!confirm("Delete this feedback?")) return;
      const r = await deleteEntity("feedback", id);
      if (r.ok) { toast("Deleted"); await refresh(); reRenderFeedback(t.id); }
    };
  });
  $("#fbNow").onclick = () => {
    if (state.audio.currentId === t.id) $("#fbTime").value = mmss(Math.floor(audioEl().currentTime || 0));
    else toast("Play this track first", true);
  };
  $("#fbAdd").onclick = async () => {
    const comment = $("#fbComment").value.trim();
    if (!comment) { toast("Write a note first", true); return; }
    const me = await ensureMe();
    const r = await createEntity("feedback", { trackId: t.id, timestamp: parseTime($("#fbTime").value), comment, authorId: me ? me.id : undefined, version: cur });
    if (r.ok) { toast("Feedback added"); await refresh(); reRenderFeedback(t.id); }
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
    if (!j.items || !j.items.length) { el.innerHTML = `<div class="empty">No audio files found for this track.</div>`; return; }
    el.innerHTML = `<div class="ver-list">${j.items.map((v) => `
      <div class="ver-item ${v.current ? "current" : ""}">
        <span class="vlabel">${esc(v.version || "—")}</span>
        <span class="vmeta">${esc(v.ext.toUpperCase())} &middot; ${new Date(v.modified).toLocaleDateString()}</span>
        <span class="vtag">${v.current ? "current" : (v.previous ? "previous" : "")}</span>
        <button class="fb-mini" data-vurl="${esc(v.url)}" title="Play this version">Play</button>
      </div>`).join("")}</div>`;
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
  $("#refresh").addEventListener("click", async () => { closeMenu(); await refresh(false); await fetchPlaylist(); render(); });
  $("#logout").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/login.html"; });
  $("#scrim").addEventListener("click", closeDrawer);
  $("#mscrim").addEventListener("click", closeModal);
  $("#lightbox").addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeLightbox(); closeDrawer(); closeModal(); closeMenu(); closeNav(); } });
}

(async function boot() {
  wireChrome();
  wireAudio();
  updateWhoami();
  await refresh(false);
  await fetchPlaylist();
  render(); // re-render so play buttons appear once the playlist is known
})();
