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
  audio: { map: {}, currentOrder: null, playing: false, configured: false },
};
const CANT_PLAY_EXT = ["aif", "aiff"]; // browsers (esp. Chrome) usually can't play AIFF

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
    if (state.audio.currentOrder != null) renderMarkers();
  }
  if (refreshQueued) { refreshQueued = false; refresh(keepDrawer); }
}

/* ---- Helpers over state ----------------------------------------------------*/
function currentAlbum() {
  const { albums } = state.data;
  return albums.find((a) => a.id === state.filters.albumId) || albums[0] || null;
}
function visibleTracks() {
  let t = state.data.tracks.slice();
  const alb = currentAlbum();
  if (alb) t = t.filter((x) => x.albumId === alb.id);
  if (state.filters.ip) t = t.filter((x) => x.inspiredBy === state.filters.ip);
  if (state.filters.memberId) {
    const mid = state.filters.memberId;
    t = t.filter((x) => x.ownerIds.includes(mid) || x.phases.some((p) => p.ownerIds.includes(mid)));
  }
  return t;
}
function ipOptions() { return [...new Set(state.data.tracks.map((t) => t.inspiredBy).filter(Boolean))].sort(); }

/* ---- Filters UI ------------------------------------------------------------*/
function syncFilters() {
  const { albums, members } = state.data;
  const fa = $("#filterAlbum");
  fa.innerHTML = albums.map((a) => `<option value="${a.id}">${esc(a.title)}</option>`).join("");
  if (!state.filters.albumId && albums[0]) state.filters.albumId = albums[0].id;
  if (!albums.find((a) => a.id === state.filters.albumId) && albums[0]) state.filters.albumId = albums[0].id;
  fa.value = state.filters.albumId;

  $("#filterIP").innerHTML = `<option value="">All inspirations</option>` +
    ipOptions().map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
  $("#filterIP").value = state.filters.ip;

  $("#filterMember").innerHTML = `<option value="">All members</option>` +
    members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
  $("#filterMember").value = state.filters.memberId;
}

/* ---- Render dispatch -------------------------------------------------------*/
function render() {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === state.view));
  renderAlbumStrip();
  const main = $("#main");
  if (state.view === "tracks") main.innerHTML = boardHTML(visibleTracks());
  else if (state.view === "preview") main.innerHTML = previewHTML();
  else if (state.view === "albums") main.innerHTML = albumsBoardHTML();
  else if (state.view === "members") main.innerHTML = membersHTML();
  else if (state.view === "calendar") main.innerHTML = calendarHTML();
  wireBoard();
  $("#albumStrip").style.display = (state.view === "tracks") ? "" : "none";
  $("#newTrack").style.display = (state.view === "tracks") ? "" : "none";
}

function renderAlbumStrip() {
  const alb = currentAlbum();
  const el = $("#albumStrip");
  if (!alb) { el.innerHTML = ""; return; }
  const cover = alb.cover[0] ? `style="background-image:url('${alb.cover[0].thumb}')"` : "";
  el.innerHTML = `
    <div class="album-strip">
      <div class="cover" ${cover}>${alb.cover[0] ? "" : "&#9835;"}</div>
      <div>
        <h1>${esc(alb.title)}</h1>
        <div class="sub">${esc(alb.artist)} &middot; ${alb.trackCount} tracks &middot; ${esc(alb.stage)}${alb.playlist ? ` &middot; <a href="${esc(alb.playlist)}" target="_blank" rel="noopener">Playlist</a>` : ""} &middot; <a href="#" id="editAlbumLink">Edit album</a></div>
      </div>
      <div class="albprog">
        <div class="pct">${alb.progress}%</div>
        <div class="bar"><i style="width:${alb.progress}%"></i></div>
      </div>
    </div>`;
  const link = $("#editAlbumLink");
  if (link) link.addEventListener("click", (e) => { e.preventDefault(); openAlbumDrawer(alb.id); });
}

/* ---- Track board -----------------------------------------------------------*/
function segClass(status) { return status === "Done" ? "done" : status === "In progress" ? "prog" : ""; }

function cardHTML(t) {
  const segs = t.phases.map((p) => `<div class="seg ${segClass(p.status)}" title="${esc(p.phase)}: ${esc(p.status)}"></div>`).join("");
  const ownerSet = new Map();
  t.phases.filter((p) => p.status !== "Done").forEach((p) => p.owners.forEach((o) => ownerSet.set(o, p.phase)));
  if (ownerSet.size === 0) t.owners.forEach((o) => ownerSet.set(o, ""));
  const avatars = [...ownerSet.entries()].slice(0, 5)
    .map(([name, role]) => `<div class="avatar" data-role="${esc(role)}" title="${esc(name)}${role ? " — " + esc(role) : ""}">${esc(initials(name))}</div>`).join("");
  const gated = t.stage === "Production" && !t.productionComplete;
  const audio = state.audio.map[t.order];
  const playingThis = state.audio.currentOrder === t.order && state.audio.playing;
  const playBtn = audio
    ? `<button class="play-btn ${playingThis ? "playing" : ""}" data-play="${t.order}" title="Play latest bounce">${playingThis ? "&#9208;" : "&#9654;"}</button>`
    : "";
  return `
    <div class="card" draggable="true" data-id="${t.id}">
      <div class="top">
        <div class="title-wrap">${playBtn}<div class="title">${esc(t.title)}</div></div>
        ${t.inspiredBy ? `<div class="ip">${esc(t.inspiredBy)}</div>` : ""}
      </div>
      ${t.reference ? `<div class="ref">${esc(t.reference)}</div>` : ""}
      <div class="meter">${segs}</div>
      <div class="footer">
        <span class="prog-num">${t.phasesDone}/${t.phasesTotal} phases</span>
        ${gated ? `<span class="lock" title="All phases must be Done to reach Mixing">&#128274; gated</span>` : ""}
        ${t.openFeedback ? `<span class="fb-badge" title="${t.openFeedback} open feedback">&#128172; ${t.openFeedback}</span>` : ""}
        <div class="avatars">${avatars}</div>
      </div>
    </div>`;
}

function boardHTML(tracks) {
  const stages = state.data.stages;
  const cols = stages.map((s) => {
    const inCol = tracks.filter((t) => t.stage === s);
    const locked = stages.indexOf(s) > PROD_IDX;
    return `
      <div class="col${locked ? " locked-target" : ""}" data-stage="${esc(s)}">
        <h3><span class="dot" style="background:${STAGE_COLOR[s]}"></span>${esc(s)}<span class="count">${inCol.length}</span></h3>
        <div class="cards">${inCol.map(cardHTML).join("")}</div>
      </div>`;
  }).join("");
  return `<div class="board">${cols}</div>`;
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
    <div class="card" data-album="${a.id}">
      <div class="top"><div class="title">${esc(a.title)}</div></div>
      <div class="ref">${esc(a.artist)} &middot; ${a.trackCount} tracks</div>
      <div class="meter"><div class="bar" style="flex:1"><i style="width:${a.progress}%"></i></div></div>
      <div class="footer"><span class="prog-num">${a.progress}% complete</span></div>
    </div>`;
}

/* ---- Members: Who's Up Next ------------------------------------------------*/
function membersHTML() {
  const alb = currentAlbum();
  const tracks = state.data.tracks.filter((t) => !alb || t.albumId === alb.id);
  const byMember = {};
  state.data.members.forEach((m) => (byMember[m.id] = { member: m, tasks: [] }));
  tracks.forEach((t) => {
    t.phases.filter((p) => p.status !== "Done").forEach((p) => {
      p.ownerIds.forEach((oid) => {
        if (byMember[oid]) byMember[oid].tasks.push({ track: t.title, phase: p.phase, status: p.status });
      });
    });
  });
  const cards = Object.values(byMember).map(({ member, tasks }) => {
    const rows = tasks.length
      ? tasks.map((t) => `<div class="mtask"><span class="tt">${esc(t.track)}</span> <span style="color:var(--muted)">${esc(t.phase)}</span> <span class="badge ${t.status === "In progress" ? "prog" : ""}">${esc(t.status)}</span></div>`).join("")
      : `<div class="empty">All caught up &#10003;</div>`;
    return `
      <div class="mcard">
        <div class="mhead">
          <div class="avatar" title="${esc(member.name)}">${esc(initials(member.name))}</div>
          <div><div class="mname">${esc(member.name)}</div><div class="mrole">${esc(member.role)}</div></div>
          <div style="margin-left:auto;color:var(--muted);font-weight:700">${tasks.length}</div>
        </div>
        ${rows}
      </div>`;
  }).join("");
  return `<div class="members">${cards}</div>`;
}

/* ---- Calendar --------------------------------------------------------------*/
let calMonth = new Date();
function calendarHTML() {
  const alb = currentAlbum();
  const tracks = state.data.tracks.filter((t) => t.dueDate && (!alb || t.albumId === alb.id));
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const first = new Date(y, m, 1), start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const monthName = calMonth.toLocaleString(undefined, { month: "long", year: "numeric" });
  const heads = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="cal-head">${d}</div>`).join("");
  let cells = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const evs = tracks.filter((t) => t.dueDate === iso);
    cells += `<div class="cal-cell${d.getMonth() !== m ? " out" : ""}">
      <div class="d">${d.getDate()}</div>
      ${evs.map((e) => `<div class="cal-ev" data-open="${e.id}">${esc(e.title)}</div>`).join("")}
    </div>`;
  }
  return `
    <div class="calendar">
      <div class="cal-nav">
        <button class="icon-btn" data-cal="-1">&#8249;</button>
        <h2>${monthName}</h2>
        <button class="icon-btn" data-cal="1">&#8250;</button>
        <span style="color:var(--muted);font-size:13px;margin-left:8px">Track due dates</span>
      </div>
      <div class="cal-grid">${heads}${cells}</div>
    </div>`;
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
    b.addEventListener("click", (e) => { e.stopPropagation(); playOrder(Number(b.dataset.play)); }));

  const pa = document.getElementById("playAll");
  if (pa) pa.onclick = () => { const q = playQueue(); if (q.length) playOrder(q[0]); };
  document.querySelectorAll(".trow[data-prow]").forEach((r) =>
    r.addEventListener("click", () => { const t = state.data.tracks.find((x) => x.order === Number(r.dataset.prow)); if (t) openDrawer(t.id); }));

  document.querySelectorAll(".col[data-stage]").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault(); col.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/id");
      const stage = col.dataset.stage;
      const entity = col.dataset.entity === "album" ? "album" : "track";
      if (!id) return;
      const r = await update(entity, id, { stage });
      if (r.ok) { toast(`Moved to ${stage}`); refresh(false); }
    });
  });

  document.querySelectorAll("[data-cal]").forEach((b) =>
    b.addEventListener("click", () => { calMonth.setMonth(calMonth.getMonth() + Number(b.dataset.cal)); render(); }));
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
  state.openTrackId = id;
  const members = state.data.members;
  const stages = state.data.stages;

  const gateNote = t.phasesTotal
    ? `<div class="gate-note ${t.productionComplete ? "ok" : ""}">${t.productionComplete ? "&#10003; Production complete — clear to advance." : `&#128274; ${t.phasesDone}/${t.phasesTotal} phases done — finish all to reach Mixing.`}</div>`
    : "";

  const phaseRows = t.phases.map((p) => {
    const statusOpts = ["Not started", "In progress", "Done"].map((s) => `<option ${s === p.status ? "selected" : ""}>${esc(s)}</option>`).join("");
    const ownerOpts = members.map((m) => `<option value="${m.id}" ${p.ownerIds.includes(m.id) ? "selected" : ""}>${esc(m.name)}</option>`).join("");
    return `
      <div class="phase-row" data-phase="${p.id}">
        <div class="pname"><span class="pdot" style="background:${p.status === "Done" ? "var(--good)" : p.status === "In progress" ? "var(--warn)" : "var(--idle)"}"></span>${esc(p.phase)}</div>
        <select data-pf="status">${statusOpts}</select>
        <select data-pf="owner" multiple size="1">${ownerOpts}</select>
      </div>`;
  }).join("");

  const links = [];
  if (t.songLink) links.push(`<a class="chip" href="${esc(t.songLink)}" target="_blank" rel="noopener">&#9836; Song</a>`);
  if (t.projectFile) links.push(`<a class="chip" href="${esc(t.projectFile)}" target="_blank" rel="noopener">&#128193; Project file</a>`);

  openShell(`
    <div class="dhead">
      <div style="flex:1"><input id="dTitle" type="text" value="${esc(t.title)}" style="font-size:19px;font-weight:700;background:transparent;border:1px solid transparent;padding:4px 6px" /></div>
      <button class="icon-btn close" id="closeDrawer">&times;</button>
    </div>
    <div class="dbody">
      <div class="row2">
        <div class="field"><label>Stage</label>${stageSelect("dStage", t.stage, stages)}</div>
        <div class="field"><label>Inspired by (game / IP)</label><input id="dIP" list="ipList" value="${esc(t.inspiredBy)}" />${ipDatalist()}</div>
      </div>
      ${gateNote}
      <div class="field"><label>Reference (stage / theme)</label><input id="dRef" type="text" value="${esc(t.reference)}" /></div>
      <div class="row2">
        <div class="field"><label>BPM</label><input id="dBpm" type="number" value="${t.bpm ?? ""}" /></div>
        <div class="field"><label>Key</label><input id="dKey" type="text" value="${esc(t.key)}" /></div>
      </div>
      <div class="field"><label>Due date</label><input id="dDue" type="date" value="${t.dueDate || ""}" /></div>
      <div class="row2">
        <div class="field"><label>Song link</label><input id="dSong" type="text" value="${esc(t.songLink)}" placeholder="https://…" /></div>
        <div class="field"><label>Project file</label><input id="dProj" type="text" value="${esc(t.projectFile)}" placeholder="https://…" /></div>
      </div>
      ${links.length ? `<div class="field"><label>Open</label><div class="chip-links">${links.join("")}</div></div>` : ""}
      ${state.audio.map[t.order] ? `<div class="field"><label>Latest bounce</label><button class="add-btn" id="dPlay">&#9654; Play &middot; ${esc(state.audio.map[t.order].name)}</button></div>` : ""}
      <div class="field"><label>Track owner / next up</label>${memberChecks(members, t.ownerIds)}</div>
      <div class="field">
        <label>Production phases</label>
        ${phaseRows}
      </div>
      <div class="field"><label>Notes</label><textarea id="dNotes">${esc(t.notes)}</textarea></div>
      <div class="field">
        <label>Lyrics</label>
        <div class="drawer-actions" style="margin-top:0">
          <button class="add-btn ghost" id="dLyricsEdit">&#9998; Edit sections</button>
          <button class="add-btn ghost" id="dTele">&#128253; Teleprompter</button>
        </div>
      </div>
      <div class="field"><label>Timestamped feedback</label><div id="dFeedback"></div></div>
      <div class="field"><label>Versions (from Dropbox)</label><div id="dVersions"><button class="fb-mini" id="dVerLoad">Show version history</button></div></div>
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

  $(".owner-picker").addEventListener("change", async () => {
    const ids = selectedOwnerIds($("#drawer"));
    const r = await update("track", id, { ownerIds: ids });
    if (r.ok) { toast("Owner updated"); refresh(); }
  });

  document.querySelectorAll(".phase-row").forEach((row) => {
    const pid = row.dataset.phase;
    row.querySelector('[data-pf="status"]').addEventListener("change", async (e) => {
      const r = await update("phase", pid, { status: e.target.value });
      if (r.ok) { toast("Phase updated"); refresh(); }
    });
    row.querySelector('[data-pf="owner"]').addEventListener("change", async (e) => {
      const ids = [...e.target.selectedOptions].map((o) => o.value);
      const r = await update("phase", pid, { ownerIds: ids });
      if (r.ok) { toast("Owner updated"); refresh(); }
    });
  });

  const dPlay = $("#dPlay");
  if (dPlay) dPlay.onclick = () => playOrder(t.order);
  $("#dLyricsEdit").onclick = () => openLyricsEditor(id);
  $("#dTele").onclick = () => openTeleprompter(id);
  $("#dVerLoad").onclick = () => loadVersions(t.order);
  renderFeedback(t);

  $("#dDelete").addEventListener("click", async () => {
    if (!confirm(`Delete "${t.title}" and its 5 phases? This can't be undone.`)) return;
    const r = await deleteEntity("track", id);
    if (r.ok) { toast("Track deleted"); closeDrawer(); refresh(false); }
  });
}

/* ---- Drawer: album (edit) --------------------------------------------------*/
function openAlbumDrawer(id) {
  const a = state.data.albums.find((x) => x.id === id);
  if (!a) return;
  const stages = state.data.stages;
  openShell(`
    <div class="dhead"><div style="flex:1"><input id="aTitle" type="text" value="${esc(a.title)}" style="font-size:19px;font-weight:700;background:transparent;border:1px solid transparent;padding:4px 6px" /></div><button class="icon-btn close" id="closeDrawer">&times;</button></div>
    <div class="dbody">
      <div class="row2">
        <div class="field"><label>Artist</label><input id="aArtist" type="text" value="${esc(a.artist)}" /></div>
        <div class="field"><label>Stage</label>${stageSelect("aStage", a.stage, stages)}</div>
      </div>
      <div class="row2">
        <div class="field"><label>Genre</label><input id="aGenre" type="text" value="${esc(a.genre)}" /></div>
        <div class="field"><label>Release date</label><input id="aRelease" type="date" value="${a.releaseDate || ""}" /></div>
      </div>
      <div class="field"><label>Playlist link</label><input id="aPlaylist" type="text" value="${esc(a.playlist)}" placeholder="https://…" /></div>
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
  save("#aPlaylist", "playlist", (v) => v.trim(), true);
  save("#aNotes", "notes");
  $("#aDelete").addEventListener("click", async () => {
    if (!confirm(`Delete album "${a.title}"? (Only works if it has no tracks.)`)) return;
    const r = await deleteEntity("album", id);
    if (r.ok) { toast("Album deleted"); closeDrawer(); state.filters.albumId = ""; refresh(false); }
  });
}

/* ---- Drawer: create --------------------------------------------------------*/
function openCreateTrack() {
  const alb = currentAlbum();
  if (!alb) { toast("Create an album first", true); return; }
  const stages = state.data.stages;
  openShell(`
    <div class="dhead"><div><h2>New track</h2><div class="sub" style="color:var(--muted);font-size:13px;margin-top:4px">in ${esc(alb.title)}</div></div><button class="icon-btn close" id="closeDrawer">&times;</button></div>
    <div class="dbody">
      <div class="field"><label>Title</label><input id="cTitle" type="text" placeholder="Song title" autofocus /></div>
      <div class="row2">
        <div class="field"><label>Stage</label>${stageSelect("cStage", "Idea", stages)}</div>
        <div class="field"><label>Inspired by (game / IP)</label><input id="cIP" list="ipList" placeholder="e.g. Castlevania 1" />${ipDatalist()}</div>
      </div>
      <div class="field"><label>Reference (stage / theme)</label><input id="cRef" type="text" placeholder="e.g. Stage 1" /></div>
      <div class="row2">
        <div class="field"><label>Song link</label><input id="cSong" type="text" placeholder="https://…" /></div>
        <div class="field"><label>Project file</label><input id="cProj" type="text" placeholder="https://…" /></div>
      </div>
      <div class="field"><label>Notes</label><textarea id="cNotes"></textarea></div>
      <div class="field"><label>Lyrics</label><textarea id="cLyrics" style="min-height:140px"></textarea></div>
      <div class="drawer-actions"><button class="add-btn" id="cCreate">Create track (+ 5 phases)</button></div>
    </div>`);
  $("#cCreate").addEventListener("click", async () => {
    const fields = {
      albumId: alb.id,
      title: $("#cTitle").value.trim() || "New track",
      stage: $("#cStage").value,
      inspiredBy: $("#cIP").value.trim(),
      reference: $("#cRef").value.trim(),
      songLink: $("#cSong").value.trim(),
      projectFile: $("#cProj").value.trim(),
      notes: $("#cNotes").value,
      lyrics: $("#cLyrics").value,
      order: (state.data.tracks.filter((t) => t.albumId === alb.id).length + 1),
    };
    const r = await createEntity("track", fields);
    if (r.ok) { toast("Track created"); await refresh(false); openDrawer(r.id); }
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
  try {
    const r = await fetch("/api/playlist", { headers: { "Cache-Control": "no-store" } });
    if (!r.ok) return;
    const j = await r.json();
    state.audio.configured = !!j.configured;
    state.audio.map = {};
    (j.items || []).forEach((it) => (state.audio.map[it.order] = it));
  } catch {}
}

const audioEl = () => document.getElementById("audio");
function trackByOrder(order) { return state.data.tracks.find((t) => t.order === order); }
function playQueue() {
  const alb = currentAlbum();
  return state.data.tracks
    .filter((t) => (!alb || t.albumId === alb.id) && state.audio.map[t.order])
    .sort((a, b) => a.order - b.order)
    .map((t) => t.order);
}
const fmt = (s) => (isNaN(s) ? "0:00" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);

let triedRelink = false;
function playOrder(order) {
  const item = state.audio.map[order];
  if (!item) return;
  const a = audioEl();
  if (state.audio.currentOrder === order) { a.paused ? a.play().catch(() => {}) : a.pause(); return; }
  state.audio.currentOrder = order;
  triedRelink = false;
  a.src = item.url;
  a.play().catch(() => {});
  renderPlayer();
}
function playNext(dir = 1) {
  const q = playQueue();
  const i = q.indexOf(state.audio.currentOrder);
  const ni = i < 0 ? 0 : i + dir;
  if (ni >= 0 && ni < q.length) playOrder(q[ni]);
}

function updatePlayButtons() {
  document.querySelectorAll(".play-btn[data-play]").forEach((b) => {
    const on = Number(b.dataset.play) === state.audio.currentOrder && state.audio.playing;
    b.classList.toggle("playing", on);
    b.innerHTML = on ? "&#9208;" : "&#9654;";
  });
}

function renderPlayer() {
  const el = document.getElementById("player");
  const order = state.audio.currentOrder;
  const item = state.audio.map[order];
  const t = trackByOrder(order);
  if (!item || !t) { el.className = "player hidden"; return; }
  const a = audioEl();
  const warn = CANT_PLAY_EXT.includes(item.ext)
    ? `<div class="pwarn">${item.ext.toUpperCase()} may not play in this browser — try Safari, or export an MP3.</div>` : "";
  el.className = "player";
  el.innerHTML = `
    <div class="pctrl">
      <button class="pbtn mini" id="pPrev" title="Previous">&#9198;</button>
      <button class="pbtn" id="pToggle" title="Play/Pause">${a.paused ? "&#9654;" : "&#9208;"}</button>
      <button class="pbtn mini" id="pNext" title="Next">&#9197;</button>
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
    <button class="pclose" id="pClose" title="Close">&times;</button>`;
  document.getElementById("pToggle").onclick = () => (a.paused ? a.play().catch(() => {}) : a.pause());
  document.getElementById("pPrev").onclick = () => playNext(-1);
  document.getElementById("pNext").onclick = () => playNext(1);
  document.getElementById("pClose").onclick = () => { a.pause(); state.audio.currentOrder = null; el.className = "player hidden"; updatePlayButtons(); };
  const seek = document.getElementById("pSeek");
  seek.oninput = () => { if (a.duration) a.currentTime = (seek.value / 1000) * a.duration; };
  renderMarkers();
}

// Feedback dots on the player's seek bar (only for a real track, not a version preview).
function renderMarkers() {
  const wrap = document.getElementById("pMarkers");
  if (!wrap) return;
  const a = audioEl();
  const t = trackByOrder(state.audio.currentOrder);
  if (!t || !a.duration || !isFinite(a.duration)) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = (t.feedback || []).map((fb) => {
    const pct = Math.min(100, Math.max(0, (fb.timestamp / a.duration) * 100));
    return `<div class="marker ${fb.status === "Resolved" ? "resolved" : "open"}" style="left:${pct}%" data-mk="${fb.timestamp}" title="${esc(mmss(fb.timestamp))} — ${esc(fb.author || "")}: ${esc((fb.comment || "").slice(0, 80))}"></div>`;
  }).join("");
  wrap.querySelectorAll("[data-mk]").forEach((m) =>
    m.onclick = () => { a.currentTime = Number(m.dataset.mk); a.play().catch(() => {}); });
}

function wireAudio() {
  const a = audioEl();
  a.addEventListener("play", () => { state.audio.playing = true; updatePlayButtons(); const b = document.getElementById("pToggle"); if (b) b.innerHTML = "&#9208;"; });
  a.addEventListener("pause", () => { state.audio.playing = false; updatePlayButtons(); const b = document.getElementById("pToggle"); if (b) b.innerHTML = "&#9654;"; });
  a.addEventListener("ended", () => playNext(1));
  a.addEventListener("loadedmetadata", renderMarkers);
  a.addEventListener("durationchange", renderMarkers);
  a.addEventListener("timeupdate", () => {
    const seek = document.getElementById("pSeek"), time = document.getElementById("pTime");
    if (seek && a.duration) seek.value = String((a.currentTime / a.duration) * 1000);
    if (time) time.textContent = `${fmt(a.currentTime)} / ${fmt(a.duration)}`;
  });
  a.addEventListener("error", async () => {
    const item = state.audio.map[state.audio.currentOrder];
    if (item && CANT_PLAY_EXT.includes(item.ext)) { toast(`${item.ext.toUpperCase()} can't play in this browser`, true); return; }
    if (!triedRelink) { // temp links expire (~4h) — refresh once and retry
      triedRelink = true;
      await fetchPlaylist();
      const fresh = state.audio.map[state.audio.currentOrder];
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
  b.innerHTML = me ? esc(initials(me.name)) : "&#128100;";
}
function pickIdentity() {
  return new Promise((resolve) => {
    const members = state.data.members;
    openModal(`
      <div class="mhd"><h2>Who are you?</h2><button class="icon-btn close" id="mClose">&times;</button></div>
      <div class="mbd">
        <p style="color:var(--muted);margin:0">Pick your name — saved on this device so your feedback is tagged to you.</p>
        <div class="owner-picker" id="idPick">${members.map((m) => `<label class="owner-chip"><input type="radio" name="idp" value="${m.id}"/> ${esc(m.name)}</label>`).join("")}</div>
      </div>`);
    $("#mClose").onclick = () => { closeModal(); resolve(getMe()); };
    document.querySelectorAll("#idPick input").forEach((i) =>
      i.addEventListener("change", () => { const m = members.find((x) => x.id === i.value); setMe({ id: m.id, name: m.name }); closeModal(); resolve(getMe()); }));
  });
}
async function ensureMe() { return getMe() || (await pickIdentity()); }

/* ---- Modal helpers ---------------------------------------------------------*/
function openModal(html) { const m = $("#modal"); m.innerHTML = html; $("#mscrim").classList.add("open"); m.classList.add("open"); }
function closeModal() { $("#mscrim").classList.remove("open"); $("#modal").classList.remove("open"); }

/* ---- Preview album ---------------------------------------------------------*/
function previewHTML() {
  const alb = currentAlbum();
  if (!alb) return `<div class="loading">No album selected.</div>`;
  const tracks = state.data.tracks.filter((t) => t.albumId === alb.id).sort((a, b) => a.order - b.order);
  const cover = alb.cover[0] ? `style="background-image:url('${alb.cover[0].thumb}')"` : "";
  const anyAudio = tracks.some((t) => state.audio.map[t.order]);
  const rows = tracks.map((t) => {
    const audio = state.audio.map[t.order];
    const playing = state.audio.currentOrder === t.order && state.audio.playing;
    const btn = audio
      ? `<button class="play-btn ${playing ? "playing" : ""}" data-play="${t.order}">${playing ? "&#9208;" : "&#9654;"}</button>`
      : `<span class="play-btn" style="visibility:hidden">&#9654;</span>`;
    return `
      <div class="trow ${playing ? "playing" : ""}" data-prow="${t.order}">
        <div class="num">${t.order}</div>${btn}
        <div class="tp"><div class="tt">${esc(t.title)}</div><div class="ts">${esc(t.inspiredBy || "")}${t.reference ? " &middot; " + esc(t.reference) : ""}</div></div>
        ${t.openFeedback ? `<span class="fb-badge">&#128172; ${t.openFeedback}</span>` : ""}
        <span class="badge">${esc(t.stage)}</span>
        ${audio ? "" : `<span class="noaudio">no audio</span>`}
      </div>`;
  }).join("");
  return `
    <div class="preview">
      <div class="phead">
        <div class="cover" ${cover}>${alb.cover[0] ? "" : "&#9835;"}</div>
        <div>
          <h1>${esc(alb.title)}</h1>
          <div class="sub">${esc(alb.artist)} &middot; ${tracks.length} tracks &middot; ${alb.progress}% complete</div>
          <div class="playall">${anyAudio ? `<button class="add-btn" id="playAll">&#9654; Play album</button>` : `<span class="empty">No audio files yet — add bounces to Dropbox.</span>`}</div>
        </div>
      </div>
      ${rows}
    </div>`;
}

/* ---- Lyrics: sections ------------------------------------------------------*/
const LYRIC_LABELS = ["Intro", "Verse 1", "Verse 2", "Verse 3", "Pre-Chorus", "Chorus", "Post-Chorus", "Bridge", "Breakdown", "Solo", "VO", "Outro"];
function parseSections(t) {
  if (t.lyricsData) { try { const d = JSON.parse(t.lyricsData); if (Array.isArray(d) && d.length) return d; } catch {} }
  if (t.lyrics && t.lyrics.trim()) return [{ label: "Lyrics", text: t.lyrics }];
  return [];
}
function flattenSections(secs) { return secs.map((s) => `[${s.label}]\n${s.text}`).join("\n\n"); }
async function saveSections(id, secs) {
  return update("track", id, { lyricsData: JSON.stringify(secs), lyrics: flattenSections(secs) });
}
function sectionHTML(s, i) {
  const inList = LYRIC_LABELS.includes(s.label);
  const opts = LYRIC_LABELS.map((l) => `<option ${l === s.label ? "selected" : ""}>${esc(l)}</option>`).join("");
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
      <textarea data-s="text" placeholder="Lyrics for this section…">${esc(s.text)}</textarea>
    </div>`;
}
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
      <div class="mhd"><h2>Lyrics &middot; ${esc(t.title)}</h2><button class="icon-btn close" id="mClose">&times;</button></div>
      <div class="mbd">
        ${secs.map((s, i) => sectionHTML(s, i)).join("") || `<p style="color:var(--muted-2)">No sections yet — add one below.</p>`}
        <div class="addsec">
          <select id="newLabel">${LYRIC_LABELS.map((l) => `<option>${l}</option>`).join("")}</select>
          <button class="add-btn ghost" id="addSec">+ Add section</button>
          <span class="spacer" style="flex:1"></span>
          <button class="add-btn" id="saveSecs">Save lyrics</button>
        </div>
      </div>`);
    $("#mClose").onclick = closeModal;
    $("#addSec").onclick = () => { collect(); secs.push({ label: $("#newLabel").value, text: "" }); draw(); };
    $("#saveSecs").onclick = async () => { collect(); const r = await saveSections(id, secs); if (r.ok) { toast("Lyrics saved"); closeModal(); refresh(); } };
    document.querySelectorAll("#modal .sec").forEach((el) => {
      const i = Number(el.dataset.i);
      const sel = el.querySelector('[data-s="label"]');
      sel.addEventListener("change", (e) => {
        if (e.target.value === "__custom") { const name = prompt("Section label:", secs[i].label); collect(); secs[i].label = name || secs[i].label; draw(); }
      });
      el.querySelector('[data-s="up"]').onclick = () => { if (i > 0) { collect(); [secs[i - 1], secs[i]] = [secs[i], secs[i - 1]]; draw(); } };
      el.querySelector('[data-s="down"]').onclick = () => { if (i < secs.length - 1) { collect(); [secs[i + 1], secs[i]] = [secs[i], secs[i + 1]]; draw(); } };
      el.querySelector('[data-s="del"]').onclick = () => { collect(); secs.splice(i, 1); draw(); };
    });
  }
  draw();
}

/* ---- Teleprompter ----------------------------------------------------------*/
function openTeleprompter(id) {
  const t = state.data.tracks.find((x) => x.id === id);
  const secs = parseSections(t);
  const tp = $("#teleprompter");
  let font = 46, auto = false, speed = 40, raf = null, last = 0;
  function loop(now) {
    if (!auto) return;
    if (!last) last = now;
    const sc = $("#tpScroll");
    sc.scrollTop += (speed * (now - last)) / 1000;
    last = now;
    raf = requestAnimationFrame(loop);
  }
  function stop() { auto = false; cancelAnimationFrame(raf); last = 0; }
  function close() { stop(); tp.classList.remove("open"); tp.innerHTML = ""; }
  function draw() {
    tp.innerHTML = `
      <div class="tp-bar">
        <span class="tp-title">${esc(t.title)}</span>
        <div class="tp-jump">${secs.map((s, i) => `<button data-j="${i}">${esc(s.label)}</button>`).join("")}</div>
        <span class="spacer" style="flex:1"></span>
        <button id="tpMinus">A&minus;</button><button id="tpPlus">A+</button>
        <button id="tpAuto">${auto ? "&#10073;&#10073; Pause" : "&#9654; Auto"}</button>
        <input type="range" id="tpSpeed" min="10" max="140" value="${speed}" title="Scroll speed" />
        <button id="tpClose">Close</button>
      </div>
      <div class="tp-scroll" id="tpScroll" style="font-size:${font}px">
        ${secs.map((s) => `<div class="tp-section"><div class="tp-lbl">${esc(s.label)}</div><div class="tp-txt">${esc(s.text)}</div></div>`).join("") || `<div class="tp-section"><div class="tp-txt">No lyrics yet.</div></div>`}
      </div>`;
    const sc = $("#tpScroll");
    $("#tpClose").onclick = close;
    $("#tpPlus").onclick = () => { font = Math.min(140, font + 4); sc.style.fontSize = font + "px"; };
    $("#tpMinus").onclick = () => { font = Math.max(20, font - 4); sc.style.fontSize = font + "px"; };
    $("#tpSpeed").oninput = (e) => { speed = Number(e.target.value); };
    $("#tpAuto").onclick = () => { auto = !auto; $("#tpAuto").innerHTML = auto ? "&#10073;&#10073; Pause" : "&#9654; Auto"; last = 0; if (auto) raf = requestAnimationFrame(loop); else cancelAnimationFrame(raf); };
    document.querySelectorAll("#teleprompter [data-j]").forEach((b) =>
      b.onclick = () => { const el = sc.querySelectorAll(".tp-section")[Number(b.dataset.j)]; if (el) sc.scrollTo({ top: el.offsetTop - 40, behavior: "smooth" }); });
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
function seekTo(order, seconds) {
  if (!state.audio.map[order]) { toast("No audio for this track", true); return; }
  if (state.audio.currentOrder !== order) playOrder(order);
  const a = audioEl();
  const go = () => { a.currentTime = seconds; a.play().catch(() => {}); };
  if (a.readyState > 0) go(); else a.addEventListener("loadedmetadata", go, { once: true });
}
function renderFeedback(t) {
  const el = $("#dFeedback"); if (!el) return;
  const list = t.feedback || [];
  const rows = list.map((fb) => `
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
    </div>`).join("") || `<div class="empty">No feedback yet.</div>`;
  const curT = state.audio.currentOrder === t.order ? Math.floor(audioEl().currentTime || 0) : 0;
  el.innerHTML = `
    <div class="fb-list">${rows}</div>
    <div class="fb-add" style="margin-top:8px">
      <div class="fb-atwrap"><span style="color:var(--muted);font-size:12px">At</span>
        <input type="text" id="fbTime" value="${mmss(curT)}" />
        <button class="fb-mini" id="fbNow">Use current time</button>
      </div>
      <textarea id="fbComment" placeholder="Add a note at this time…"></textarea>
      <button class="add-btn" id="fbAdd">Add feedback</button>
    </div>`;
  el.querySelectorAll("[data-seek]").forEach((s) => s.onclick = () => seekTo(t.order, Number(s.dataset.seek)));
  el.querySelectorAll(".fb-item").forEach((item) => {
    const id = item.dataset.fb;
    item.querySelector("[data-fbtoggle]").onclick = async () => {
      const cur = item.querySelector("[data-fbtoggle]").dataset.fbtoggle;
      const r = await update("feedback", id, { status: cur === "Open" ? "Resolved" : "Open" });
      if (r.ok) { toast("Updated"); refresh(); }
    };
    item.querySelector("[data-fbdel]").onclick = async () => {
      if (!confirm("Delete this feedback?")) return;
      const r = await deleteEntity("feedback", id);
      if (r.ok) { toast("Deleted"); refresh(); }
    };
  });
  $("#fbNow").onclick = () => {
    if (state.audio.currentOrder === t.order) $("#fbTime").value = mmss(Math.floor(audioEl().currentTime || 0));
    else toast("Play this track first", true);
  };
  $("#fbAdd").onclick = async () => {
    const comment = $("#fbComment").value.trim();
    if (!comment) { toast("Write a note first", true); return; }
    const me = await ensureMe();
    const r = await createEntity("feedback", { trackId: t.id, timestamp: parseTime($("#fbTime").value), comment, authorId: me ? me.id : undefined });
    if (r.ok) { toast("Feedback added"); refresh(); }
  };
}

/* ---- Versions --------------------------------------------------------------*/
async function loadVersions(order) {
  const el = $("#dVersions"); if (!el) return;
  el.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const r = await fetch("/api/versions?order=" + order);
    const j = await r.json();
    if (!j.items || !j.items.length) { el.innerHTML = `<div class="empty">No audio files found for this track.</div>`; return; }
    el.innerHTML = `<div class="ver-list">${j.items.map((v) => `
      <div class="ver-item ${v.current ? "current" : ""}">
        <span class="vlabel">${esc(v.version || "—")}</span>
        <span class="vmeta">${esc(v.ext.toUpperCase())} &middot; ${new Date(v.modified).toLocaleDateString()}</span>
        <span class="vtag">${v.current ? "current" : (v.previous ? "previous" : "")}</span>
        <button class="fb-mini" data-vurl="${esc(v.url)}" title="Play this version">&#9654;</button>
      </div>`).join("")}</div>`;
    el.querySelectorAll("[data-vurl]").forEach((b) => b.onclick = () => {
      const a = audioEl(); state.audio.currentOrder = null; a.src = b.dataset.vurl; a.play().catch(() => {});
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
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => { state.view = t.dataset.view; render(); }));
  $("#filterAlbum").addEventListener("change", (e) => { state.filters.albumId = e.target.value; render(); });
  $("#filterIP").addEventListener("change", (e) => { state.filters.ip = e.target.value; render(); });
  $("#filterMember").addEventListener("change", (e) => { state.filters.memberId = e.target.value; render(); });
  $("#newTrack").addEventListener("click", openCreateTrack);
  $("#newAlbum").addEventListener("click", openCreateAlbum);
  $("#whoami").addEventListener("click", pickIdentity);
  $("#refresh").addEventListener("click", () => refresh(false));
  $("#logout").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/login.html"; });
  $("#scrim").addEventListener("click", closeDrawer);
  $("#mscrim").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); closeModal(); } });
}

(async function boot() {
  wireChrome();
  wireAudio();
  updateWhoami();
  await refresh(false);
  await fetchPlaylist();
  render(); // re-render so play buttons appear once the playlist is known
})();
