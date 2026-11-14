const { T, F, STAGES, PHASE_NAMES, listAll, getRecord } = require("./_airtable");
const { albumData, tempLink } = require("./_dropbox");
const { requireAuth } = require("./_auth");
const share = require("./_share");

// Login-free read for a mixer link. The token grants a set of track ids; this always
// resolves each track's CURRENT Dropbox bounce (so one link follows the whole process),
// returns its notes for that version, plus a fresh streaming URL for playback.
const mixIds = (t) => (Array.isArray(t) ? t.map((x) => (typeof x === "string" ? x : x && x.id)).filter(Boolean) : []);
// Notes added by a share-link guest have no linked member; update.js stores their link title
// in the note's Name as "Guest: <title> @ m:ss". Read it back as the display author.
const guestOf = (f) => share.guestNameOf(f[F.feedback.name]);
async function mixResolve(q) {
  // Resolve a mix request (by slug or signed token) to its track id list + title.
  if (q.mixslug) {
    const sharesR = await listAll(T.shares);
    const rec = sharesR.find((r) => (r.fields[F.share.slug] || "") === q.mixslug);
    if (!rec) return null;
    let t = []; try { t = JSON.parse(rec.fields[F.share.tracks] || "[]"); } catch {}
    return { idList: Array.isArray(t) ? t : [], title: rec.fields[F.share.title] || "Guest" };
  }
  const data = share.verify(q.mixtoken);
  if (!data) return null;
  if (data.s) { const rec = await getRecord(T.shares, data.s); let t = []; try { t = JSON.parse(rec.fields[F.share.tracks] || "[]"); } catch {} return { idList: Array.isArray(t) ? t : [], title: rec.fields[F.share.title] || "Guest" }; }
  if (Array.isArray(data.t)) return { idList: mixIds(data.t), title: "Guest" };
  return null;
}
async function mixRead(req, res) {
  let resolved; try { resolved = await mixResolve(req.query || {}); } catch { resolved = null; }
  if (!resolved) return res.status(403).json({ error: "invalid link" });
  const idList = resolved.idList, shareTitle = resolved.title;
  const ids = new Set(idList);
  try {
    const [tracksR, albumsR, feedbackR, membersR] = await Promise.all([listAll(T.tracks), listAll(T.albums), listAll(T.feedback), listAll(T.members)]);
    const first = (v) => (Array.isArray(v) ? v[0] : v);
    const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
    const norm = (s) => String(s || "").toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/^\s*\d+[_\-.\s]+/, "").replace(/_v\d+.*$/i, "").replace(/[^a-z0-9]+/g, "");
    const memberName = Object.fromEntries(membersR.map((r) => [r.id, r.fields[F.member.nickname] || r.fields[F.member.name] || "?"]));
    // Member color (hex only) so the share page can tint who wrote each note.
    const hexOnly = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c || "").trim()) ? String(c).trim() : "");
    const memberColor = Object.fromEntries(membersR.map((r) => [r.id, hexOnly(r.fields[F.member.color])]));
    const albumById = Object.fromEntries(albumsR.map((r) => [r.id, r.fields]));
    const wantTracks = tracksR.filter((r) => ids.has(r.id));
    const byAlbum = {};
    wantTracks.forEach((r) => { const aid = first(r.fields[F.track.album]) || "__none"; (byAlbum[aid] = byAlbum[aid] || []).push(r); });
    const bounceByTrack = {}; // trackId -> { name, url }
    for (const aid of Object.keys(byAlbum)) {
      const af = albumById[aid]; if (!af) continue;
      const folder = af[F.album.dropboxFolder] || ""; const prefix = af[F.album.trackPrefix] || "";
      if (!folder) continue;
      try {
        const { tok, items } = await albumData(folder, prefix);
        const idx = {}, byOrder = {}; items.forEach((it) => { idx[norm(it.title)] = it; if (it.order != null) byOrder[it.order] = it; });
        for (const r of byAlbum[aid]) {
          const ord = r.fields[F.track.order];
          const it = idx[norm(r.fields[F.track.title] || "")] || (ord != null ? byOrder[ord] : null);
          if (it && it.file) { const url = await tempLink(it.file.path_lower, tok); bounceByTrack[r.id] = { name: it.file.name, url }; }
        }
      } catch (_) {}
    }
    const songs = idList.map((id) => {
      const r = tracksR.find((x) => x.id === id); if (!r) return null;
      const b = bounceByTrack[id] || null;
      const ver = b ? b.name : "";
      const notes = feedbackR
        .filter((fr) => first(fr.fields[F.feedback.track]) === id && (fr.fields[F.feedback.version] || "") === ver)
        .map((fr) => ({ id: fr.id, timestamp: fr.fields[F.feedback.timestamp] ?? 0, comment: fr.fields[F.feedback.comment] || "", status: fr.fields[F.feedback.status] || "Open", reviewed: !!fr.fields[F.feedback.mixReviewed], author: (arr(fr.fields[F.feedback.author]).map((x) => memberName[x] || "?"))[0] || guestOf(fr.fields), authorColor: memberColor[first(arr(fr.fields[F.feedback.author]))] || "", global: share.isGlobalName(fr.fields[F.feedback.name]), mine: share.isGuestNoteOf(fr.fields[F.feedback.name], shareTitle), thread: (() => { try { const z = JSON.parse(fr.fields[F.feedback.thread] || "[]"); return Array.isArray(z) ? z : []; } catch { return []; } })() }))
        .sort((a, b2) => a.timestamp - b2.timestamp);
      return { id, title: r.fields[F.track.title] || "Untitled", version: ver, url: b ? b.url : null, notes };
    }).filter(Boolean);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ mix: true, title: shareTitle, songs });
  } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
}

// Returns the whole board as clean JSON. All Airtable field IDs are resolved here so the
// frontend deals only with friendly names.
module.exports = async (req, res) => {
  if (req.query && (req.query.mixtoken || req.query.mixslug)) return mixRead(req, res); // login-free share link
  if (!requireAuth(req, res)) return;
  try {
    const [albumsR, tracksR, phasesR, membersR, feedbackR, sharesR] = await Promise.all([
      listAll(T.albums),
      listAll(T.tracks),
      listAll(T.phases),
      listAll(T.members),
      listAll(T.feedback),
      listAll(T.shares),
    ]);

    const first = (v) => (Array.isArray(v) ? v[0] : v);
    const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
    const att = (v) => (Array.isArray(v) ? v.map((a) => ({ url: a.url, thumb: a.thumbnails?.large?.url || a.url })) : []);

    const members = membersR.map((r) => {
      const name = r.fields[F.member.name] || "";
      const nickname = r.fields[F.member.nickname] || "";
      return { id: r.id, name, nickname, display: nickname || name, role: r.fields[F.member.role] || "", email: r.fields[F.member.email] || "", color: r.fields[F.member.color] || "", phases: arr(r.fields[F.member.phases]), scratch: r.fields[F.member.scratch] || "" };
    });
    // Use the nickname (falling back to name) everywhere owners/authors are shown.
    const memberName = Object.fromEntries(members.map((m) => [m.id, m.display]));

    const phases = phasesR.map((r) => ({
      id: r.id,
      name: r.fields[F.phase.name] || "",
      phase: r.fields[F.phase.phase] || "",
      status: r.fields[F.phase.status] || "Not started",
      trackId: first(r.fields[F.phase.track]) || null,
      ownerIds: arr(r.fields[F.phase.owner]),
      owners: arr(r.fields[F.phase.owner]).map((id) => memberName[id] || "?"),
      due: r.fields[F.phase.due] || null,
      subtasks: (() => { try { const d = JSON.parse(r.fields[F.phase.subtasks] || "[]"); return Array.isArray(d) ? d.filter((x) => x && typeof x.text === "string").map((x) => ({ text: String(x.text), done: !!x.done, owner: (typeof x.owner === "string" && x.owner) ? x.owner : null, note: (typeof x.note === "string" && x.note) ? x.note : null })) : []; } catch { return []; } })(),
    }));
    const phasesByTrack = {};
    phases.forEach((p) => {
      (phasesByTrack[p.trackId] = phasesByTrack[p.trackId] || []).push(p);
    });
    // Keep phases in the canonical instrument order.
    Object.values(phasesByTrack).forEach((list) =>
      list.sort((a, b) => { const ix = (n) => { const i = PHASE_NAMES.indexOf(n); return i === -1 ? 999 : i; }; return ix(a.phase) - ix(b.phase); })
    );

    const feedback = feedbackR.map((r) => {
      const f = r.fields;
      return {
        id: r.id,
        trackId: first(f[F.feedback.track]) || null,
        timestamp: f[F.feedback.timestamp] ?? 0,
        comment: f[F.feedback.comment] || "",
        status: f[F.feedback.status] || "Open",
        version: f[F.feedback.version] || "",
        authorId: first(f[F.feedback.author]) || null,
        author: (arr(f[F.feedback.author]).map((id) => memberName[id] || "?"))[0] || (guestOf(f) ? guestOf(f) + " (guest)" : ""),
        mixReviewed: !!f[F.feedback.mixReviewed],
        global: share.isGlobalName(f[F.feedback.name]),
        thread: (() => { try { const z = JSON.parse(f[F.feedback.thread] || "[]"); return Array.isArray(z) ? z : []; } catch { return []; } })(),
        createdTime: r.createdTime,
      };
    });
    const feedbackByTrack = {};
    feedback.forEach((fb) => { (feedbackByTrack[fb.trackId] = feedbackByTrack[fb.trackId] || []).push(fb); });
    Object.values(feedbackByTrack).forEach((l) => l.sort((a, b) => a.timestamp - b.timestamp));

    const tracks = tracksR.map((r) => {
      const f = r.fields;
      const tp = phasesByTrack[r.id] || [];
      const done = tp.filter((p) => p.status === "Done").length;
      return {
        id: r.id,
        title: f[F.track.title] || "Untitled",
        stage: f[F.track.stage] || "Idea",
        inspiredBy: f[F.track.inspiredBy] || "",
        reference: f[F.track.reference] || "",
        bpm: f[F.track.bpm] ?? null,
        key: f[F.track.key] || "",
        songLink: f[F.track.songLink] || "",
        projectFile: f[F.track.projectFile] || "",
        notes: f[F.track.notes] || "",
        lyrics: f[F.track.lyrics] || "",
        lyricsData: f[F.track.lyricsData] || "",
        cover: att(f[F.track.art]),
        dueDate: f[F.track.dueDate] || null,
        order: f[F.track.order] ?? 999,
        albumId: first(f[F.track.album]) || null,
        onHold: !!f[F.track.onHold],
        ownerIds: arr(f[F.track.owner]),
        owners: arr(f[F.track.owner]).map((id) => memberName[id] || "?"),
        progress: f[F.track.progress] ?? 0,
        phasesDone: done,
        phasesTotal: tp.length,
        productionComplete: tp.length > 0 && done === tp.length,
        phases: tp,
        feedback: feedbackByTrack[r.id] || [],
        openFeedback: (feedbackByTrack[r.id] || []).filter((x) => x.status === "Open").length,
      };
    });
    tracks.sort((a, b) => a.order - b.order);

    const albums = albumsR.map((r) => {
      const f = r.fields;
      return {
        id: r.id,
        title: f[F.album.title] || "Untitled",
        artist: f[F.album.artist] || "",
        stage: f[F.album.stage] || "Idea",
        releaseDate: f[F.album.releaseDate] || null,
        cover: att(f[F.album.cover]),
        playlist: f[F.album.playlist] || "",
        notes: f[F.album.notes] || "",
        genre: f[F.album.genre] || "",
        label: f[F.album.label] || "",
        dropboxFolder: f[F.album.dropboxFolder] || "",
        trackPrefix: f[F.album.trackPrefix] || "",
        current: !!f[F.album.current],
        ownerIds: arr(f[F.album.owner]),
        owners: arr(f[F.album.owner]).map((id) => memberName[id] || "?"),
        progress: f[F.album.progress] ?? 0,
        trackCount: f[F.album.trackCount] ?? 0,
      };
    });

    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const feedKey = process.env.CAL_FEED_KEY;
    const feedUrl = `${proto}://${host}/api/calendar.ics${feedKey ? `?key=${encodeURIComponent(feedKey)}` : ""}`;

    res.setHeader("Cache-Control", "no-store");
    const shares = sharesR.map((r) => { let t = []; try { t = JSON.parse(r.fields[F.share.tracks] || "[]"); } catch {} return { id: r.id, title: r.fields[F.share.title] || "Untitled link", tracks: Array.isArray(t) ? t : [], slug: r.fields[F.share.slug] || "", token: share.sign({ s: r.id }), createdTime: r.createdTime }; }).sort((a, b) => (a.createdTime < b.createdTime ? 1 : -1));
    res.status(200).json({ albums, tracks, phases, members, feedback, shares, stages: STAGES, phaseNames: PHASE_NAMES, feedUrl, feedSecured: !!feedKey });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
