// Dropbox access for the live playlist. Reads the "Songs in Progress" folder at play time,
// so new bounces / newer versions show up automatically.
//
// Auth (set in Vercel env). Two ways:
//   Preferred (permanent): DROPBOX_APP_KEY + DROPBOX_APP_SECRET + DROPBOX_REFRESH_TOKEN
//   Quick test (expires in ~4h): DROPBOX_TOKEN
// Folder: DROPBOX_SHARED_LINK (the shared folder URL) or DROPBOX_FOLDER_PATH.

const AUDIO_RE = /\.(mp3|wav|aif|aiff|m4a|flac|ogg)$/i;

// The known folder path (resolved from the shared link). Used as a fallback so the app works
// with just the Project Tracker's existing Dropbox credentials — no new env vars needed.
const DEFAULT_FOLDER_PATH =
  "/eric von doymi/the megas/logicx sessions/albums_songs in progress/the belmonts_full album 2024/___songs in progress playlist___";

let cachedTok = null, cachedExp = 0, cachedPath = null;

async function accessToken() {
  if (process.env.DROPBOX_TOKEN) return process.env.DROPBOX_TOKEN;
  if (cachedTok && Date.now() < cachedExp) return cachedTok;
  const key = process.env.DROPBOX_APP_KEY, sec = process.env.DROPBOX_APP_SECRET, rt = process.env.DROPBOX_REFRESH_TOKEN;
  if (!(key && sec && rt)) throw new Error("Dropbox not configured (set DROPBOX_TOKEN, or APP_KEY/APP_SECRET/REFRESH_TOKEN)");
  const r = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${key}:${sec}`).toString("base64"),
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt }),
  });
  if (!r.ok) throw new Error("Dropbox token refresh failed: " + (await r.text()));
  const j = await r.json();
  cachedTok = j.access_token;
  cachedExp = Date.now() + (j.expires_in - 60) * 1000;
  return cachedTok;
}

async function dbx(endpoint, arg, tok) {
  const r = await fetch("https://api.dropboxapi.com/2/" + endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify(arg),
  });
  if (!r.ok) throw new Error(`Dropbox ${endpoint} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function folderPath(tok) {
  if (process.env.DROPBOX_FOLDER_PATH) return process.env.DROPBOX_FOLDER_PATH;
  if (cachedPath) return cachedPath;
  const link = process.env.DROPBOX_SHARED_LINK;
  if (link) {
    // Resolving a shared link needs the sharing.read scope. If it's not granted, fall back below.
    try {
      const m = await dbx("sharing/get_shared_link_metadata", { url: link }, tok);
      cachedPath = m.path_lower;
      return cachedPath;
    } catch (_) { /* fall through to the known path */ }
  }
  return DEFAULT_FOLDER_PATH;
}

// The leading number in "02_Vampire Killer_v01.aif" == the track's Track Order.
function parseOrder(name) {
  const m = name.match(/^\s*0*(\d{1,3})[_\-.\s]/);
  return m ? parseInt(m[1], 10) : null;
}

// List top-level audio files (the PREVIOUS VERSIONS subfolder is excluded automatically
// because we list non-recursively), newest version per track number.
async function newestByOrder() {
  const tok = await accessToken();
  const path = await folderPath(tok);
  let res = await dbx("files/list_folder", { path, recursive: false, limit: 300 }, tok);
  const entries = res.entries.slice();
  while (res.has_more) {
    res = await dbx("files/list_folder/continue", { cursor: res.cursor }, tok);
    entries.push(...res.entries);
  }
  const files = entries.filter((e) => e[".tag"] === "file" && AUDIO_RE.test(e.name));
  const byOrder = {};
  for (const f of files) {
    const o = parseOrder(f.name);
    if (o == null) continue;
    if (!byOrder[o] || f.server_modified > byOrder[o].server_modified) byOrder[o] = f;
  }
  return { tok, byOrder };
}

// All audio files, searched recursively (includes the PREVIOUS VERSIONS subfolder) — used for
// the per-track version history.
async function allFiles() {
  const tok = await accessToken();
  const path = await folderPath(tok);
  let res = await dbx("files/list_folder", { path, recursive: true, limit: 1000 }, tok);
  const entries = res.entries.slice();
  while (res.has_more) {
    res = await dbx("files/list_folder/continue", { cursor: res.cursor }, tok);
    entries.push(...res.entries);
  }
  const files = entries.filter((e) => e[".tag"] === "file" && AUDIO_RE.test(e.name));
  return { tok, files };
}

async function tempLink(path, tok) {
  const j = await dbx("files/get_temporary_link", { path }, tok);
  return j.link;
}

// ---- Per-album model: master folder -> "PREFIX_NN_Name" project folders -> "Bounces" ----

const linkPathCache = {};
async function resolveFolderPath(input, tok) {
  if (!input) return folderPath(tok);
  if (linkPathCache[input]) return linkPathCache[input];
  let path = input;
  if (/^https?:\/\//i.test(input)) {
    const m = await dbx("sharing/get_shared_link_metadata", { url: input }, tok);
    path = m.path_lower;
  }
  linkPathCache[input] = path;
  return path;
}

async function listChildren(path, tok) {
  let res = await dbx("files/list_folder", { path, recursive: false, limit: 1000 }, tok);
  const entries = res.entries.slice();
  while (res.has_more) {
    res = await dbx("files/list_folder/continue", { cursor: res.cursor }, tok);
    entries.push(...res.entries);
  }
  return entries;
}

// "The Belmonts_01_Prologue" (prefix "The Belmonts") -> { order:1, title:"Prologue" }
function parseProject(name, prefix) {
  let rest = name;
  if (prefix && name.toLowerCase().startsWith(prefix.toLowerCase())) rest = name.slice(prefix.length);
  const m = rest.match(/^[\s_\-.]*(\d+)[\s_\-.]+(.+)$/);
  if (!m) return null;
  return { order: parseInt(m[1], 10), title: m[2].replace(/_+/g, " ").replace(/\s+/g, " ").trim() };
}

const newestAudio = (files) => {
  let best = null;
  for (const f of files) if (f[".tag"] === "file" && AUDIO_RE.test(f.name) && (!best || f.server_modified > best.server_modified)) best = f;
  return best;
};

// All songs for an album: order + title from the project folder, newest Bounces file for preview.
async function albumData(input, prefix) {
  const tok = await accessToken();
  const path = await resolveFolderPath(input, tok);
  const children = await listChildren(path, tok);
  const projects = children
    .filter((e) => e[".tag"] === "folder")
    .map((e) => ({ e, p: parseProject(e.name, prefix || "") }))
    .filter((x) => x.p);
  const items = [];
  for (const { e, p } of projects) {
    let file = null;
    try { file = newestAudio(await listChildren(e.path_lower + "/Bounces", tok)); } catch (_) {}
    items.push({ order: p.order, title: p.title, folder: e.name, file: file ? { path_lower: file.path_lower, name: file.name, server_modified: file.server_modified } : null });
  }
  items.sort((a, b) => a.order - b.order);
  return { tok, items };
}

// Every bounce for one song's project folder (version history), newest first.
async function projectVersions(input, prefix, order) {
  const tok = await accessToken();
  const path = await resolveFolderPath(input, tok);
  const children = await listChildren(path, tok);
  const match = children
    .filter((e) => e[".tag"] === "folder")
    .map((e) => ({ e, p: parseProject(e.name, prefix || "") }))
    .find((x) => x.p && x.p.order === Number(order));
  if (!match) return { tok, files: [] };
  let files = [];
  try { files = (await listChildren(match.e.path_lower + "/Bounces", tok)).filter((f) => f[".tag"] === "file" && AUDIO_RE.test(f.name)); } catch (_) {}
  files.sort((a, b) => (a.server_modified < b.server_modified ? 1 : -1));
  return { tok, files };
}

// Create any missing "PREFIX_NN_Name/Bounces" project folders for the given tracks.
// tracks: [{ order, title }]. Requires the Dropbox token to have files.content.write.
async function makeAlbumFolders(input, prefix, tracks) {
  const tok = await accessToken();
  const path = await resolveFolderPath(input, tok);
  const existing = new Set(
    (await listChildren(path, tok))
      .filter((e) => e[".tag"] === "folder")
      .map((e) => parseProject(e.name, prefix || ""))
      .filter(Boolean)
      .map((p) => p.order)
  );
  const created = [];
  for (const t of tracks) {
    if (t.order == null || existing.has(t.order)) continue;
    const nn = String(t.order).padStart(2, "0");
    const safeTitle = String(t.title || "Untitled").replace(/[\/\\]/g, "-").trim();
    const folderName = `${prefix ? prefix + "_" : ""}${nn}_${safeTitle}`;
    const base = `${path}/${folderName}`;
    try { await dbx("files/create_folder_v2", { path: base, autorename: false }, tok); }
    catch (e) { if (!/conflict/i.test(String(e.message))) throw e; }
    try { await dbx("files/create_folder_v2", { path: base + "/Bounces", autorename: false }, tok); }
    catch (e) { if (!/conflict/i.test(String(e.message))) throw e; }
    created.push(folderName);
  }
  return { created };
}

module.exports = { newestByOrder, allFiles, tempLink, parseOrder, albumData, projectVersions, makeAlbumFolders };
