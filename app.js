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
  const { albums } = state.data;
  if (state.filters.albumId === "__unassigned") return null;
  return albums.find((a) => a.id === state.filters.albumId) || albums[0] || null;
}
function visibleTracks() {
  let t = state.data.tracks.slice();
  if (state.filters.albumId === "__unassigned") t = t.filter((x) => !x.albumId);
  else { const alb = currentAlbum(); if (alb) t = t.filter((x) => x.albumId === alb.id); }
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
  fa.innerHTML = albums.map((a) => `<option value="${a.id}">${esc(a.title)}</option>`).join("") + `<option value="__unassigned">Unassigned</option>`;
  const isSentinel = state.filters.albumId === "__unassigned";
  if (!isSentinel) {
    if (!state.filters.albumId && albums[0]) state.filters.albumId = albums[0].id;
    if (!albums.find((a) => a.id === state.filters.albumId) && albums[0]) state.filters.albumId = albums[0].id;
  }
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
  else if (state.view === "hold") main.innerHTML = holdHTML();
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
  // "Waiting on X" — when every remaining production part belongs to a single member.
  let waitingName = "";
  {
    const notDone = t.phases.filter((p) => p.status !== "Done");
    const rem = new Set(); const nameById = {};
    notDone.forEach((p) => p.ownerIds.forEach((oid, idx) => { rem.add(oid); nameById[oid] = p.owners[idx] || nameById[oid]; }));
    if (t.stage === "Production" && !t.productionComplete && notDone.length > 0 && rem.size === 1) waitingName = nameById[[...rem][0]] || "";
  }
  const audio = audioFor(t);
  const playingThis = state.audio.currentId === t.id && state.audio.playing;
  const playBtn = audio
    ? `<button class="play-btn ${playingThis ? "playing" : ""}" data-play="${t.id}" title="Play latest bounce">${playingThis ? "&#9208;" : "&#9654;"}</button>`
    : "";
  const num = dispNum(t);
  return `
    <div class="card" draggable="true" data-id="${t.id}">
      <div class="top">
        <div class="title-wrap">${playBtn}${num !== "" ? `<span class="tnum">${num}</span>` : ""}<div class="title">${esc(t.title)}</div></div>
        ${t.inspiredBy ? `<div class="ip">${esc(t.inspiredBy)}</div>` : ""}
      </div>
      ${t.reference ? `<div class="ref">${esc(t.reference)}</div>` : ""}
      <div class="meter">${segs}</div>
      <div class="footer">
        <span class="prog-num">${t.phasesDone}/${t.phasesTotal} phases</span>
        <button class="lyr-btn" data-lyr="${t.id}" title="Edit lyrics">&#9998; Lyrics</button>
        ${waitingName ? `<span class="waiting" title="Only ${esc(waitingName)}'s part is left">&#9203; Waiting on ${esc(waitingName)}</span>` : (gated ? `<span class="lock" title="All phases must be Done to reach Mixing">&#128274; gated</span>` : "")}
        ${openFbCount(t) ? `<span class="fb-badge" title="${openFbCount(t)} open feedback on current version">&#128172; ${openFbCount(t)}</span>` : ""}
        <div class="avatars">${avatars}</div>
      </div>
    </div>`;
}

function boardHTML(tracks) {
  const stages = state.data.stages;
  const active = tracks.filter((t) => !t.onHold);
  const shown = stages.filter((s) => active.some((t) => t.stage === s));
  if (!shown.length) return `<div class="loading">No tracks here yet.</div>`;
  const cols = shown.map((s) => {
    const inCol = active.filter((t) => t.stage === s).sort((a, b) => effOrder(a) - effOrder(b));
    const locked = stages.indexOf(s) > PROD_IDX;
    return `
      <div class="col${locked ? " locked-target" : ""}" data-stage="${esc(s)}">
        <h3><span class="dot" style="background:${STAGE_COLOR[s]}"></span>${esc(s)}<span class="count">${inCol.length}</span></h3>
        <div class="cards">${inCol.map(cardHTML).join("")}</div>
      </div>`;
  }).join("");
  return `<div class="board">${cols}</div>`;
}

// Dedicated On Hold tab — held tracks live only here, hidden from every other view.
function holdHTML() {
  const held = state.data.tracks.filter((t) => t.onHold).sort((a, b) => effOrder(a) - effOrder(b));
  if (!held.length) return `<div class="loading">Nothing on hold. Put a track on hold from its detail panel.</div>`;
  return `<div class="preview"><div class="palbum">
    <div class="phead"><div class="cover">&#9208;</div><div><h1>On Hold</h1><div class="sub">${held.length} track(s) parked — open one and untick “On hold” to bring it back</div></div></div>
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
  const tracks = state.data.tracks.filter((t) => (!alb || t.albumId === alb.id) && !t.onHold);
  const me = getMe();
  const byMember = {};
  state.data.members.forEach((m) => (byMember[m.id] = { member: m, songs: {}, count: 0 }));
  tracks.forEach((t) => {
    t.phases.filter((p) => p.status !== "Done").forEach((p) => {
      p.ownerIds.forEach((oid) => {
        const rec = byMember[oid]; if (!rec) return;
        (rec.songs[t.id] = rec.songs[t.id] || { title: t.title, order: effOrder(t), num: dispNum(t), items: [] }).items.push({ phaseId: p.id, phase: p.phase, status: p.status });
        rec.count++;
      });
    });
  });
  const entries = Object.values(byMember).sort((a, b) => {
    if (me) { if (a.member.id === me.id) return -1; if (b.member.id === me.id) return 1; }
    return b.count - a.count;
  });
  const cards = entries.map(({ member, songs, count }) => {
    const songCards = Object.values(songs).sort((a, b) => a.order - b.order).map((s) => `
      <div class="song-card">
        <div class="song-title">${s.num !== "" ? `<span class="tnum">${s.num}</span> ` : ""}${esc(s.title)}</div>
        ${s.items.map((it) => `<label class="song-task" data-phase="${it.phaseId}"><input type="checkbox" /> <span class="stp">${esc(it.phase)}</span>${it.status === "In progress" ? '<span class="badge prog">In progress</span>' : ""}</label>`).join("")}
      </div>`).join("") || `<div class="empty">All caught up &#10003;</div>`;
    const meCls = me && member.id === me.id ? " me" : "";
    return `
      <div class="mcard${meCls}">
        <div class="mhead">
          <div class="avatar" title="${esc(member.name)}">${esc(initials(member.name))}</div>
          <div><div class="mname">${esc(member.name)}</div><div class="mrole">${esc(member.role)}</div></div>
          <div style="margin-left:auto;color:var(--muted);font-weight:700">${count}</div>
        </div>
        ${songCards}
      </div>`;
  }).join("");
  return `<div class="members">${cards}</div>`;
}

/* ---- Calendar --------------------------------------------------------------*/
let calMonth = new Date();
function calendarHTML() {
  const alb = currentAlbum();
  const tracks = state.data.tracks.filter((t) => t.dueDate && !t.onHold && (!alb || t.albumId === alb.id));
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
    b.addEventListener("click", (e) => { e.stopPropagation(); playTrack(b.dataset.play); }));

  document.querySelectorAll(".lyr-btn[data-lyr]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); openLyricsEditor(b.dataset.lyr); }));

  document.querySelectorAll("[data-playalbum]").forEach((b) => b.onclick = () => playAlbum(b.dataset.playalbum));
  document.querySelectorAll(".trow[data-tid]").forEach((r) =>
    r.addEventListener("click", () => { const t = state.data.tracks.find((x) => x.id === r.dataset.tid); if (t) openDrawer(t.id); }));

  document.querySelectorAll(".song-task[data-phase]").forEach((l) =>
    l.querySelector("input").addEventListener("change", async (e) => {
      const r = await update("phase", l.dataset.phase, { status: e.target.checked ? "Done" : "Not started" });
      if (r.ok) { toast("Updated"); refresh(); } else { e.target.checked = !e.target.checked; }
    }));

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
  const albums = state.data.albums;
  const stages = state.data.stages;

  const gateNote = t.phasesTotal
    ? `<div class="gate-note ${t.productionComplete ? "ok" : ""}">${t.productionComplete ? "&#10003; Production complete — clear to advance." : `&#128274; ${t.phasesDone}/${t.phasesTotal} phases done — finish all to reach Mixing.`}</div>`
    : "";

  const phaseRows = t.phases.map((p) => {
    const done = p.status === "Done";
    const owners = p.owners.join(", ") || "Unassigned";
    return `
      <label class="phase-row2 ${done ? "done" : ""}" data-phase="${p.id}">
        <input type="checkbox" data-pf="done" ${done ? "checked" : ""} />
        <span class="pname2">${esc(p.phase)}</span>
        <span class="powner">${esc(owners)}</span>
      </label>`;
  }).join("");

  const links = [];
  if (t.songLink) links.push(`<a class="chip" href="${esc(t.songLink)}" target="_blank" rel="noopener">&#9836; Original</a>`);
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
      ${audioFor(t) ? `<div class="field"><label>Latest bounce</label><button class="add-btn" id="dPlay">&#9654; Play &middot; ${esc(audioFor(t).name)}</button></div>` : ""}
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

  document.querySelectorAll(".phase-row2").forEach((row) => {
    row.querySelector('[data-pf="done"]').addEventListener("change", async (e) => {
      const r = await update("phase", row.dataset.phase, { status: e.target.checked ? "Done" : "Not started" });
      if (r.ok) { toast(e.target.checked ? "Marked done" : "Reopened"); refresh(); }
      else { e.target.checked = !e.target.checked; }
    });
  });

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
      <div class="field"><label>Dropbox album folder</label><input id="aFolder" type="text" value="${esc(a.dropboxFolder)}" placeholder="https://www.dropbox.com/scl/fo/…" /></div>
      <div class="field"><label>Project folder prefix</label><input id="aPrefix" type="text" value="${esc(a.trackPrefix)}" placeholder="e.g. The Belmonts" /><div class="gate-note ok" style="color:var(--muted)">Reads folders named PREFIX_##_Song, pulling audio from each song's “Bounces”.</div></div>
      <div class="field"><button class="add-btn ghost" id="aMakeFolders">&#128193; Create missing song folders</button></div>
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
  const saveFolder = (sel, key) => $(sel).addEventListener("change", async (e) => {
    const r = await update("album", id, { [key]: e.target.value.trim() });
    if (r.ok) { toast("Saved"); await refresh(false); await fetchPlaylist(); render(); }
  });
  saveFolder("#aFolder", "dropboxFolder");
  saveFolder("#aPrefix", "trackPrefix");
  $("#aMakeFolders").onclick = async () => {
    if (!confirm("Create a Dropbox project folder (with a Bounces subfolder) for every track that doesn't already have one?")) return;
    toast("Creating folders…");
    const r = await post("/api/makefolders", { albumId: id });
    if (r.ok) { toast(`Created ${r.created ? r.created.length : 0} folder(s)`); await refresh(false); await fetchPlaylist(); render(); }
  };
  $("#aDelete").addEventListener("click", async () => {
    if (!confirm(`Delete album "${a.title}"? (Only works if it has no tracks.)`)) return;
    const r = await deleteEntity("album", id);
    if (r.ok) { toast("Album deleted"); closeDrawer(); state.filters.albumId = ""; refresh(false); }
  });
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
    b.innerHTML = on ? "&#9208;" : "&#9654;";
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
    <button class="pbtn mini" id="pFbBtn" title="Add feedback at current time">&#128172;</button>
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
function trackRowHTML(t) {
  const audio = audioFor(t);
  const playing = state.audio.currentId === t.id && state.audio.playing;
  const btn = audio
    ? `<button class="play-btn ${playing ? "playing" : ""}" data-play="${t.id}">${playing ? "&#9208;" : "&#9654;"}</button>`
    : `<span class="play-btn" style="visibility:hidden">&#9654;</span>`;
  return `
    <div class="trow ${playing ? "playing" : ""}" data-tid="${t.id}">
      <div class="num">${dispNum(t)}</div>${btn}
      <div class="tp"><div class="tt">${esc(t.title)}</div><div class="ts">${esc(t.inspiredBy || "")}${t.reference ? " &middot; " + esc(t.reference) : ""}</div></div>
      ${openFbCount(t) ? `<span class="fb-badge">&#128172; ${openFbCount(t)}</span>` : ""}
      <span class="badge">${esc(t.stage)}</span>
      ${audio ? "" : `<span class="noaudio">no audio</span>`}
    </div>`;
}
function albumPreviewSection(alb) {
  const tracks = state.data.tracks.filter((t) => t.albumId === alb.id && !t.onHold).sort((a, b) => effOrder(a) - effOrder(b));
  const cover = alb.cover[0] ? `style="background-image:url('${alb.cover[0].thumb}')"` : "";
  const anyAudio = tracks.some((t) => audioFor(t));
  return `
    <div class="palbum">
      <div class="phead">
        <div class="cover" ${cover}>${alb.cover[0] ? "" : "&#9835;"}</div>
        <div>
          <h1>${esc(alb.title)}</h1>
          <div class="sub">${esc(alb.artist)} &middot; ${tracks.length} tracks &middot; ${alb.progress}% complete</div>
          <div class="playall">${anyAudio ? `<button class="add-btn" data-playalbum="${alb.id}">&#9654; Play album</button>` : `<span class="empty">No audio yet</span>`}</div>
        </div>
      </div>
      ${tracks.map(trackRowHTML).join("") || `<div class="empty">No tracks yet.</div>`}
    </div>`;
}
function previewHTML() {
  const albums = state.data.albums;
  const unassigned = state.data.tracks.filter((t) => !t.albumId && !t.onHold).sort((a, b) => effOrder(a) - effOrder(b));
  if (!albums.length && !unassigned.length) return `<div class="loading">No albums yet — use “+ Album”.</div>`;
  let html = albums.map(albumPreviewSection).join("");
  if (unassigned.length) html += `<div class="palbum"><div class="phead"><div class="cover">&#9834;</div><div><h1>Unassigned</h1><div class="sub">${unassigned.length} track(s) not on an album</div></div></div>${unassigned.map(trackRowHTML).join("")}</div>`;
  return `<div class="preview">${html}</div>`;
}

/* ---- Lyrics: sections ------------------------------------------------------*/
const LYRIC_LABELS = ["Intro", "Verse 1", "Verse 2", "Verse 3", "Verse 4", "Pre-Chorus", "Chorus", "Post-Chorus", "Bridge", "Breakdown", "Solo", "VO", "Outro", "Bench"];
function parseSections(t) {
  if (t.lyricsData) { try { const d = JSON.parse(t.lyricsData); if (Array.isArray(d) && d.length) return d; } catch {} }
  if (t.lyrics && t.lyrics.trim()) return [{ label: "Lyrics", text: t.lyrics }];
  return [];
}
function flattenSections(secs) { return secs.map((s) => `[${s.label}]\n${s.text}`).join("\n\n"); }
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
      <div class="mhd"><h2>Lyrics &middot; ${esc(t.title)}</h2><span style="flex:1"></span><button class="add-btn ghost" id="teleBtn">&#128253; Teleprompter</button><button class="icon-btn close" id="mClose">&times;</button></div>
      <div class="mbd">
        ${secs.map((s, i) => sectionHTML(s, i, secs)).join("") || `<p style="color:var(--muted-2)">No sections yet — add one below.</p>`}
        <div class="addsec">
          <select id="newLabel">${LYRIC_LABELS.map((l) => `<option>${l}</option>`).join("")}</select>
          <button class="add-btn ghost" id="addSec">+ Add section</button>
          <button class="add-btn ghost" id="importBtn">&#128203; Paste / import</button>
          <span class="spacer" style="flex:1"></span>
          <button class="add-btn" id="saveSecs">Save lyrics</button>
        </div>
      </div>`);
    $("#mClose").onclick = closeModal;
    $("#addSec").onclick = () => { collect(); secs.push({ label: $("#newLabel").value, text: "" }); draw(); };
    $("#importBtn").onclick = () => { collect(); drawImport(); };
    $("#teleBtn").onclick = () => { collect(); openTeleprompter(id, secs.map((s) => ({ label: s.label, text: s.text }))); };
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
      if (r.ok) { toast("Updated"); refresh(); }
    };
    item.querySelector("[data-fbdel]").onclick = async () => {
      if (!confirm("Delete this feedback?")) return;
      const r = await deleteEntity("feedback", id);
      if (r.ok) { toast("Deleted"); refresh(); }
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
    if (r.ok) { toast("Feedback added"); refresh(); }
  };
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
        <button class="fb-mini" data-vurl="${esc(v.url)}" title="Play this version">&#9654;</button>
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
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => { state.view = t.dataset.view; render(); }));
  $("#filterAlbum").addEventListener("change", (e) => { state.filters.albumId = e.target.value; render(); });
  $("#filterIP").addEventListener("change", (e) => { state.filters.ip = e.target.value; render(); });
  $("#filterMember").addEventListener("change", (e) => { state.filters.memberId = e.target.value; render(); });
  $("#newTrack").addEventListener("click", openCreateTrack);
  $("#newAlbum").addEventListener("click", openCreateAlbum);
  $("#whoami").addEventListener("click", pickIdentity);
  $("#refresh").addEventListener("click", async () => { await refresh(false); await fetchPlaylist(); render(); });
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
