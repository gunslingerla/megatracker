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
};

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

/* ---- Data ------------------------------------------------------------------*/
async function loadData() {
  const r = await fetch("/api/data", { headers: { "Cache-Control": "no-store" } });
  if (r.status === 401) { location.href = "/login.html?next=" + encodeURIComponent("/"); return null; }
  if (!r.ok) { toast("Failed to load data", true); return null; }
  return r.json();
}

async function update(entity, id, fields, opts = {}) {
  const r = await fetch("/api/update", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity, id, fields, force: !!opts.force }),
  });
  if (r.status === 401) { location.href = "/login.html"; return false; }
  if (r.status === 409) { const j = await r.json(); toast(j.message || "Blocked by production gate", true); return false; }
  if (!r.ok) { toast("Update failed", true); return false; }
  return true;
}

async function refresh(keepDrawer = true) {
  const d = await loadData();
  if (!d) return;
  state.data = d;
  syncFilters();
  render();
  if (keepDrawer && state.openTrackId) openDrawer(state.openTrackId);
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

/* ---- Filters UI ------------------------------------------------------------*/
function syncFilters() {
  const { albums, members, tracks } = state.data;
  const fa = $("#filterAlbum");
  fa.innerHTML = albums.map((a) => `<option value="${a.id}">${esc(a.title)}</option>`).join("");
  if (!state.filters.albumId && albums[0]) state.filters.albumId = albums[0].id;
  fa.value = state.filters.albumId;

  const ips = [...new Set(tracks.map((t) => t.inspiredBy).filter(Boolean))].sort();
  $("#filterIP").innerHTML = `<option value="">All inspirations</option>` +
    ips.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
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
  else if (state.view === "albums") main.innerHTML = albumsBoardHTML();
  else if (state.view === "members") main.innerHTML = membersHTML();
  else if (state.view === "calendar") main.innerHTML = calendarHTML();
  wireBoard();
  // Album strip only makes sense on track-level views.
  $("#albumStrip").style.display = (state.view === "tracks") ? "" : "none";
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
        <div class="sub">${esc(alb.artist)} &middot; ${alb.trackCount} tracks &middot; ${esc(alb.stage)}${alb.playlist ? ` &middot; <a href="${esc(alb.playlist)}" target="_blank" rel="noopener">Playlist</a>` : ""}</div>
      </div>
      <div class="albprog">
        <div class="pct">${alb.progress}%</div>
        <div class="bar"><i style="width:${alb.progress}%"></i></div>
      </div>
    </div>`;
}

/* ---- Track board -----------------------------------------------------------*/
function segClass(status) { return status === "Done" ? "done" : status === "In progress" ? "prog" : ""; }

function cardHTML(t) {
  const segs = t.phases.map((p) => `<div class="seg ${segClass(p.status)}" title="${esc(p.phase)}: ${esc(p.status)}"></div>`).join("");
  // "Next up" = owners of phases not yet done (dedup), else the track owner.
  const ownerSet = new Map();
  t.phases.filter((p) => p.status !== "Done").forEach((p) =>
    p.owners.forEach((o, i) => ownerSet.set(o, p.phase)));
  if (ownerSet.size === 0) t.owners.forEach((o) => ownerSet.set(o, ""));
  const avatars = [...ownerSet.entries()].slice(0, 5)
    .map(([name, role]) => `<div class="avatar" data-role="${esc(role)}" title="${esc(name)}${role ? " — " + esc(role) : ""}">${esc(initials(name))}</div>`).join("");
  const gated = t.stage === "Production" && !t.productionComplete;
  return `
    <div class="card" draggable="true" data-id="${t.id}">
      <div class="top">
        <div class="title">${esc(t.title)}</div>
        ${t.inspiredBy ? `<div class="ip">${esc(t.inspiredBy)}</div>` : ""}
      </div>
      ${t.reference ? `<div class="ref">${esc(t.reference)}</div>` : ""}
      <div class="meter">${segs}</div>
      <div class="footer">
        <span class="prog-num">${t.phasesDone}/${t.phasesTotal} phases</span>
        ${gated ? `<span class="lock" title="All phases must be Done to reach Mixing">&#128274; gated</span>` : ""}
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
  start.setDate(1 - ((first.getDay() + 6) % 7)); // week starts Monday
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
  // Open track drawer
  document.querySelectorAll(".card[data-id]").forEach((c) => {
    c.addEventListener("click", (e) => { if (!c.classList.contains("dragging")) openDrawer(c.dataset.id); });
    c.addEventListener("dragstart", (e) => { c.classList.add("dragging"); e.dataTransfer.setData("text/id", c.dataset.id); });
    c.addEventListener("dragend", () => c.classList.remove("dragging"));
  });
  document.querySelectorAll(".card[data-album]").forEach((c) =>
    c.addEventListener("click", () => openAlbumDrawer(c.dataset.album)));

  // Drag & drop onto stage columns (tracks + albums)
  document.querySelectorAll(".col[data-stage]").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault(); col.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/id");
      const stage = col.dataset.stage;
      const entity = col.dataset.entity === "album" ? "album" : "track";
      if (!id) return;
      const ok = await update(entity, id, { stage });
      if (ok) { toast(`Moved to ${stage}`); refresh(false); }
    });
  });

  // Calendar nav + events
  document.querySelectorAll("[data-cal]").forEach((b) =>
    b.addEventListener("click", () => { calMonth.setMonth(calMonth.getMonth() + Number(b.dataset.cal)); render(); }));
  document.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => openDrawer(b.dataset.open)));
}

/* ---- Drawer: track ---------------------------------------------------------*/
function openDrawer(id) {
  const t = state.data.tracks.find((x) => x.id === id);
  if (!t) return;
  state.openTrackId = id;
  const members = state.data.members;
  const stages = state.data.stages;

  const stageOpts = stages.map((s) => `<option ${s === t.stage ? "selected" : ""}>${esc(s)}</option>`).join("");
  const gateOk = t.productionComplete || t.stage === "Idea" || t.stage === "Writing" || t.stage === "Demo";
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

  $("#drawer").innerHTML = `
    <div class="dhead">
      <div>
        <h2>${esc(t.title)}</h2>
        <div class="sub" style="color:var(--muted);font-size:13px;margin-top:4px">${esc(t.inspiredBy)}${t.reference ? " &middot; " + esc(t.reference) : ""}</div>
      </div>
      <button class="icon-btn close" id="closeDrawer">&times;</button>
    </div>
    <div class="dbody">
      <div class="field">
        <label>Stage</label>
        <select id="dStage">${stageOpts}</select>
        ${gateNote}
      </div>
      <div class="row2">
        <div class="field"><label>BPM</label><input id="dBpm" type="number" value="${t.bpm ?? ""}" /></div>
        <div class="field"><label>Key</label><input id="dKey" type="text" value="${esc(t.key)}" /></div>
      </div>
      <div class="field"><label>Due date</label><input id="dDue" type="date" value="${t.dueDate || ""}" /></div>
      ${links.length ? `<div class="field"><label>Links</label><div class="chip-links">${links.join("")}</div></div>` : ""}
      <div class="field">
        <label>Production phases</label>
        ${phaseRows}
      </div>
      <div class="field"><label>Notes</label><textarea id="dNotes">${esc(t.notes)}</textarea></div>
      <div class="field"><label>Lyrics</label><div class="lyrics">${esc(t.lyrics) || '<span style="color:var(--muted-2)">No lyrics yet</span>'}</div></div>
    </div>`;

  $("#scrim").classList.add("open");
  $("#drawer").classList.add("open");

  $("#closeDrawer").addEventListener("click", closeDrawer);
  $("#dStage").addEventListener("change", async (e) => {
    const ok = await update("track", id, { stage: e.target.value });
    if (ok) { toast(`Stage → ${e.target.value}`); refresh(); } else { e.target.value = t.stage; }
  });
  const saveField = (sel, key, transform = (v) => v) =>
    $(sel).addEventListener("change", async (e) => {
      const ok = await update("track", id, { [key]: transform(e.target.value) });
      if (ok) { toast("Saved"); refresh(); }
    });
  saveField("#dBpm", "bpm", (v) => (v === "" ? null : Number(v)));
  saveField("#dKey", "key");
  saveField("#dDue", "dueDate", (v) => v || null);
  saveField("#dNotes", "notes");

  document.querySelectorAll(".phase-row").forEach((row) => {
    const pid = row.dataset.phase;
    row.querySelector('[data-pf="status"]').addEventListener("change", async (e) => {
      const ok = await update("phase", pid, { status: e.target.value });
      if (ok) { toast("Phase updated"); refresh(); }
    });
    row.querySelector('[data-pf="owner"]').addEventListener("change", async (e) => {
      const ids = [...e.target.selectedOptions].map((o) => o.value);
      const ok = await update("phase", pid, { ownerIds: ids });
      if (ok) { toast("Owner updated"); refresh(); }
    });
  });
}

function openAlbumDrawer(id) {
  const a = state.data.albums.find((x) => x.id === id);
  if (!a) return;
  const stages = state.data.stages;
  const stageOpts = stages.map((s) => `<option ${s === a.stage ? "selected" : ""}>${esc(s)}</option>`).join("");
  $("#drawer").innerHTML = `
    <div class="dhead"><div><h2>${esc(a.title)}</h2><div class="sub" style="color:var(--muted);font-size:13px;margin-top:4px">${esc(a.artist)} &middot; ${a.trackCount} tracks &middot; ${a.progress}%</div></div><button class="icon-btn close" id="closeDrawer">&times;</button></div>
    <div class="dbody">
      <div class="field"><label>Stage</label><select id="aStage">${stageOpts}</select></div>
      <div class="field"><label>Genre</label><input id="aGenre" type="text" value="${esc(a.genre)}" /></div>
      <div class="field"><label>Playlist link</label><input id="aPlaylist" type="text" value="${esc(a.playlist)}" /></div>
      <div class="field"><label>Concept / Notes</label><textarea id="aNotes" style="min-height:160px">${esc(a.notes)}</textarea></div>
    </div>`;
  $("#scrim").classList.add("open"); $("#drawer").classList.add("open");
  $("#closeDrawer").addEventListener("click", closeDrawer);
  $("#aStage").addEventListener("change", async (e) => { if (await update("album", id, { stage: e.target.value })) { toast("Saved"); refresh(false); } });
  $("#aGenre").addEventListener("change", async (e) => { if (await update("album", id, { genre: e.target.value })) toast("Saved"); });
  $("#aPlaylist").addEventListener("change", async (e) => { if (await update("album", id, { playlist: e.target.value })) { toast("Saved"); refresh(false); } });
  $("#aNotes").addEventListener("change", async (e) => { if (await update("album", id, { notes: e.target.value })) toast("Saved"); });
}

function closeDrawer() {
  state.openTrackId = null;
  $("#scrim").classList.remove("open");
  $("#drawer").classList.remove("open");
}

/* ---- Toast -----------------------------------------------------------------*/
let toastTimer;
function toast(msg, bad = false) {
  const el = $("#toast");
  el.textContent = msg; el.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 2600);
}

/* ---- Boot ------------------------------------------------------------------*/
function wireChrome() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => { state.view = t.dataset.view; render(); }));
  $("#filterAlbum").addEventListener("change", (e) => { state.filters.albumId = e.target.value; render(); });
  $("#filterIP").addEventListener("change", (e) => { state.filters.ip = e.target.value; render(); });
  $("#filterMember").addEventListener("change", (e) => { state.filters.memberId = e.target.value; render(); });
  $("#refresh").addEventListener("click", () => refresh(false));
  $("#logout").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/login.html"; });
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
}

(async function boot() {
  wireChrome();
  await refresh(false);
})();
