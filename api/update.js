const { T, F, STAGES, PHASE_NAMES, listAll, getRecord, patch, create, del } = require("./_airtable");
const { requireAuth } = require("./_auth");
const share = require("./_share");

// Recompute every phase record's owner(s) from the members' "Default Phases" mapping.
// (Folded in from the old /api/reassign to stay under Vercel's function limit.)
async function reassignPhases() {
  const [membersRaw, phasesRaw] = await Promise.all([listAll(T.members), listAll(T.phases)]);
  const ownersByPhase = {};
  PHASE_NAMES.forEach((p) => (ownersByPhase[p] = []));
  membersRaw.forEach((m) => {
    const list = Array.isArray(m.fields[F.member.phases]) ? m.fields[F.member.phases] : [];
    list.forEach((p) => { if (ownersByPhase[p]) ownersByPhase[p].push(m.id); });
  });
  const updates = [];
  for (const rec of phasesRaw) {
    const want = ownersByPhase[rec.fields[F.phase.phase] || ""] || [];
    const have = Array.isArray(rec.fields[F.phase.owner]) ? rec.fields[F.phase.owner] : [];
    const same = want.length === have.length && want.every((id) => have.includes(id));
    if (!same) updates.push({ id: rec.id, fields: { [F.phase.owner]: want } });
  }
  for (let i = 0; i < updates.length; i += 10) await patch(T.phases, updates.slice(i, i + 10), true);
  return updates.length;
}

// Maps friendly field names (sent by the frontend) to Airtable field IDs, per entity.
const MAP = {
  track: {
    table: T.tracks,
    fields: {
      title: F.track.title, stage: F.track.stage, inspiredBy: F.track.inspiredBy,
      reference: F.track.reference, bpm: F.track.bpm, key: F.track.key,
      songLink: F.track.songLink, projectFile: F.track.projectFile, notes: F.track.notes,
      lyrics: F.track.lyrics, lyricsData: F.track.lyricsData, dueDate: F.track.dueDate,
      order: F.track.order, ownerIds: F.track.owner, onHold: F.track.onHold,
      albumId: F.track.album, art: F.track.art,
    },
    links: ["ownerIds", "albumId"],
  },
  feedback: {
    table: T.feedback,
    fields: { status: F.feedback.status, comment: F.feedback.comment, ownerIds: F.feedback.author, version: F.feedback.version, timestamp: F.feedback.timestamp },
    links: ["ownerIds"],
  },
  member: {
    table: T.members,
    fields: { name: F.member.name, nickname: F.member.nickname, role: F.member.role, email: F.member.email, color: F.member.color, phases: F.member.phases, scratch: F.member.scratch },
    links: [],
  },
  phase: {
    table: T.phases,
    fields: { status: F.phase.status, ownerIds: F.phase.owner, due: F.phase.due, subtasks: F.phase.subtasks },
    links: ["ownerIds"],
  },
  album: {
    table: T.albums,
    fields: {
      title: F.album.title, artist: F.album.artist, stage: F.album.stage,
      releaseDate: F.album.releaseDate, playlist: F.album.playlist, genre: F.album.genre,
      label: F.album.label, notes: F.album.notes, ownerIds: F.album.owner,
      dropboxFolder: F.album.dropboxFolder, trackPrefix: F.album.trackPrefix, cover: F.album.cover,
      current: F.album.current,
    },
    links: ["ownerIds"],
  },
};

const PRODUCTION_IDX = STAGES.indexOf("Production");

// Login-free mixer review: a valid mix token may toggle a note's "Mixer Reviewed"
// flag (distinct from the band's Resolved status), but only on the token's tracks.
const mixIds = (t) => (Array.isArray(t) ? t.map((x) => (typeof x === "string" ? x : x && x.id)).filter(Boolean) : []);
// Resolve a mix token to its allowed track ids + the link title (used to tag replies).
async function shareFromToken(data) {
  if (data && data.s) {
    const rec = await getRecord(T.shares, data.s);
    let ids = []; try { ids = JSON.parse(rec.fields[F.share.tracks] || "[]"); } catch {}
    return { ids: new Set(Array.isArray(ids) ? ids : []), title: rec.fields[F.share.title] || "Guest" };
  }
  return { ids: new Set(mixIds(data && data.t)), title: "Guest" };
}
function slugify(s) { return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }
function randSlug() { return Math.random().toString(36).slice(2, 9); }
async function resolveShareReq(body) {
  if (body.mixslug) {
    const sharesR = await listAll(T.shares);
    const rec = sharesR.find((r) => (r.fields[F.share.slug] || "") === body.mixslug);
    if (!rec) return null;
    let t = []; try { t = JSON.parse(rec.fields[F.share.tracks] || "[]"); } catch {}
    return { ids: new Set(Array.isArray(t) ? t : []), title: rec.fields[F.share.title] || "Guest" };
  }
  const data = share.verify(body.mixtoken);
  if (!data) return null;
  return shareFromToken(data);
}
function readThread(rec) {
  try { const t = JSON.parse(rec.fields[F.feedback.thread] || "[]"); return Array.isArray(t) ? t : []; } catch { return []; }
}
function threadAppend(rec, msg) {
  let t = []; try { t = JSON.parse(rec.fields[F.feedback.thread] || "[]"); if (!Array.isArray(t)) t = []; } catch {}
  t.push(msg); return JSON.stringify(t.slice(-200));
}
// Login-free: mixer toggles a note's "Mixer Reviewed" flag.
async function mixReview(req, res, body) {
  if (!body.id) return res.status(400).json({ error: "id required" });
  try {
    const resolved = await resolveShareReq(body);
    if (!resolved) return res.status(403).json({ error: "invalid link" });
    const { ids } = resolved;
    const rec = await getRecord(T.feedback, body.id);
    const tr = (rec.fields[F.feedback.track] || [])[0];
    if (!ids.has(tr)) return res.status(403).json({ error: "not allowed" });
    await patch(T.feedback, [{ id: body.id, fields: { [F.feedback.mixReviewed]: !!body.reviewed } }], true);
    return res.status(200).json({ ok: true, reviewed: !!body.reviewed });
  } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
}
// Login-free: sharee posts a reply/question on a note, tagged with the link title.
async function mixReply(req, res, body) {
  const text = String(body.text || "").trim();
  if (!body.id || !text) return res.status(400).json({ error: "id and text required" });
  try {
    const resolved = await resolveShareReq(body);
    if (!resolved) return res.status(403).json({ error: "invalid link" });
    const { ids, title } = resolved;
    const rec = await getRecord(T.feedback, body.id);
    const tr = (rec.fields[F.feedback.track] || [])[0];
    if (!ids.has(tr)) return res.status(403).json({ error: "not allowed" });
    const thread = threadAppend(rec, { by: title, side: "share", text: text.slice(0, 2000), at: Date.now() });
    await patch(T.feedback, [{ id: body.id, fields: { [F.feedback.thread]: thread } }], true);
    return res.status(200).json({ ok: true });
  } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
}

// Login-free: sharee adds a brand-new note on one of the link's songs. Still scoped to the
// share's tracks. There's no member to link as author, so the note is authored as a guest:
// the link title goes in the note's Name ("Guest: <title> @ m:ss"), which data.js reads back
// as the displayed author. Pinned to the bounce version the guest was looking at.
async function mixAddNote(req, res, body) {
  const text = String(body.text || "").trim();
  const trackId = String(body.trackId || "");
  if (!trackId || !text) return res.status(400).json({ error: "trackId and text required" });
  try {
    const resolved = await resolveShareReq(body);
    if (!resolved) return res.status(403).json({ error: "invalid link" });
    const { ids, title } = resolved;
    if (!ids.has(trackId)) return res.status(403).json({ error: "not allowed" });
    const isGlobal = !!body.global; // whole-song note: no timestamp
    const ts = isGlobal ? 0 : Math.min(Math.max(Math.round(Number(body.timestamp)) || 0, 0), 86400);
    const fields = {
      [F.feedback.name]: share.guestNoteName(title, isGlobal, ts),
      [F.feedback.track]: [trackId],
      [F.feedback.timestamp]: ts,
      [F.feedback.comment]: text.slice(0, 2000),
      [F.feedback.status]: "Open",
    };
    const version = String(body.version || "").slice(0, 200);
    if (version) fields[F.feedback.version] = version;
    const rec = await create(T.feedback, [{ fields }]);
    return res.status(200).json({ ok: true, id: rec[0].id });
  } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
}

// Login-free: a guest edits/deletes things THEY wrote — their own replies (thread entries on
// this link, tagged with its title) and notes they added through it. Still scoped to the
// share's tracks. Can't touch band replies, other links' replies, or band-authored notes.
async function mixManage(req, res, body) {
  const op = String(body.op || "");
  const text = String(body.text || "").trim();
  if (!body.id || !["editReply", "deleteReply", "editNote", "deleteNote"].includes(op)) return res.status(400).json({ error: "bad request" });
  if ((op === "editReply" || op === "editNote") && !text) return res.status(400).json({ error: "text required" });
  try {
    const resolved = await resolveShareReq(body);
    if (!resolved) return res.status(403).json({ error: "invalid link" });
    const { ids, title } = resolved;
    const rec = await getRecord(T.feedback, body.id);
    const tr = (rec.fields[F.feedback.track] || [])[0];
    if (!ids.has(tr)) return res.status(403).json({ error: "not allowed" });
    const mineMsg = (m) => !!m && m.side === "share" && m.by === title;
    const thread = readThread(rec);
    if (op === "editReply" || op === "deleteReply") {
      const at = Number(body.at);
      const i = thread.findIndex((m) => mineMsg(m) && m.at === at);
      if (i < 0) return res.status(403).json({ error: "You can only change your own replies." });
      if (op === "editReply") thread[i] = { ...thread[i], text: text.slice(0, 2000), edited: Date.now() }; else thread.splice(i, 1);
      await patch(T.feedback, [{ id: body.id, fields: { [F.feedback.thread]: JSON.stringify(thread) } }], true);
    } else {
      if (!share.isGuestNoteOf(rec.fields[F.feedback.name], title)) return res.status(403).json({ error: "You can only change notes you added." });
      if (op === "editNote") {
        await patch(T.feedback, [{ id: body.id, fields: { [F.feedback.comment]: text.slice(0, 2000) } }], true);
      } else {
        // Deleting would also wipe anyone else's replies on it, so only allow when it's just yours.
        if (thread.some((m) => !mineMsg(m))) return res.status(409).json({ error: "Others have replied to this note, so it can't be deleted — edit it instead." });
        await del(T.feedback, [body.id]);
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  if (body && (body.mixtoken || body.mixslug)) return (body.op ? mixManage : body.newNote ? mixAddNote : body.text != null ? mixReply : mixReview)(req, res, body); // login-free path
  if (!requireAuth(req, res)) return;
  const { entity, id, fields, force } = body || {};

  // Create or edit a stored, titled share link (stable URL; songs/title editable).
  if (entity === "shareCreate" || entity === "shareUpdate") {
    const tracks = Array.isArray(body.tracks) ? body.tracks.map((x) => (typeof x === "string" ? x : x && x.id)).filter(Boolean) : [];
    const title = (body.title || "Untitled link").toString().slice(0, 120);
    if (!tracks.length) return res.status(400).json({ error: "pick at least one song" });
    try {
      let sid = body.id;
      const sharesR = await listAll(T.shares);
      const taken = new Set(sharesR.filter((r) => r.id !== sid).map((r) => r.fields[F.share.slug]).filter(Boolean));
      let slug = slugify(body.slug);
      const custom = !!slug;
      if (custom && taken.has(slug)) return res.status(409).json({ error: "That custom link is already taken — pick another." });
      if (!custom) {
        const existing = sid ? (sharesR.find((r) => r.id === sid) || {}).fields : null;
        slug = (existing && existing[F.share.slug]) || randSlug();
        while (taken.has(slug)) slug = randSlug();
      }
      const fields = { [F.share.title]: title, [F.share.tracks]: JSON.stringify(tracks), [F.share.slug]: slug, [F.share.links]: JSON.stringify(share.cleanLinks(body.links)) };
      if (entity === "shareUpdate" && sid) { await patch(T.shares, [{ id: sid, fields }], true); }
      else { const rec = await create(T.shares, [{ fields }]); sid = rec[0].id; }
      return res.status(200).json({ ok: true, id: sid, slug, token: share.sign({ s: sid }) });
    } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  }
  if (entity === "shareDelete") {
    if (!id) return res.status(400).json({ error: "id required" });
    try { await del(T.shares, [id]); return res.status(200).json({ ok: true }); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  }
  // Band-side reply on a note's thread.
  if (entity === "noteReply") {
    if (!id || !body.text) return res.status(400).json({ error: "id and text required" });
    try {
      const rec = await getRecord(T.feedback, id);
      const msg = { by: (body.by || "Band").toString().slice(0, 60), side: "band", text: String(body.text).trim().slice(0, 2000), at: Date.now() };
      if (body.byId) msg.byId = String(body.byId).slice(0, 40); // member id, so the reply can be tinted with their color
      const thread = threadAppend(rec, msg);
      await patch(T.feedback, [{ id, fields: { [F.feedback.thread]: thread } }], true);
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  }

  // Band-side moderation of a note's thread: delete any reply; edit only band replies
  // (a guest's words stay the guest's). Replies are identified by their `at` timestamp.
  if (entity === "threadEdit" || entity === "threadDelete") {
    if (!id || body.at == null) return res.status(400).json({ error: "id and at required" });
    try {
      const rec = await getRecord(T.feedback, id);
      const thread = readThread(rec);
      const i = thread.findIndex((m) => m && m.at === Number(body.at));
      if (i < 0) return res.status(404).json({ error: "reply not found" });
      if (entity === "threadEdit") {
        const text = String(body.text || "").trim();
        if (!text) return res.status(400).json({ error: "text required" });
        if (thread[i].side === "share") return res.status(403).json({ error: "Only the guest can edit their own reply." });
        thread[i] = { ...thread[i], text: text.slice(0, 2000), edited: Date.now() };
      } else thread.splice(i, 1);
      await patch(T.feedback, [{ id, fields: { [F.feedback.thread]: JSON.stringify(thread) } }], true);
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  }

  // Bulk action: re-derive all phase owners from the member->phase mapping.
  if (entity === "reassign") {
    try { const changed = await reassignPhases(); return res.status(200).json({ ok: true, changed }); }
    catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  }

  if (entity === "planphases") {
    try {
      const b = body || {};
      const ops = [];
      if (b.trackId && b.deadline) ops.push(patch(T.tracks, [{ id: b.trackId, fields: { [F.track.dueDate]: b.deadline } }], true));
      const asg = Array.isArray(b.assignments) ? b.assignments : [];
      for (let i = 0; i < asg.length; i += 10) {
        ops.push(patch(T.phases, asg.slice(i, i + 10).map((a) => ({ id: a.phaseId, fields: { [F.phase.due]: a.due || null } })), true));
      }
      await Promise.all(ops);
      return res.status(200).json({ ok: true, count: asg.length });
    } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  }

  const spec = MAP[entity];
  if (!spec || !id || !fields) return res.status(400).json({ error: "bad request" });

  try {
    // Enforce the Production gate: a track can't move to Mixing or beyond until all 5 phases are Done.
    if (entity === "track" && typeof fields.stage === "string") {
      const targetIdx = STAGES.indexOf(fields.stage);
      if (targetIdx > PRODUCTION_IDX && !force) {
        const rec = await getRecord(T.tracks, id);
        const complete = rec.fields[F.track.productionComplete] === 1;
        if (!complete) {
          const done = rec.fields[F.track.phasesDone] || 0;
          const total = rec.fields[F.track.phasesTotal] || 0;
          return res.status(409).json({
            error: "gate",
            message: `All production phases must be Done before moving to ${fields.stage}. Currently ${done}/${total}.`,
            done, total,
          });
        }
      }
    }

    // Editing a note: it can't be emptied, and its time must be a sane number of seconds.
    if (entity === "feedback") {
      if ("comment" in fields && !String(fields.comment || "").trim()) return res.status(400).json({ error: "A note can't be empty." });
      if ("timestamp" in fields) {
        const ts = Math.round(Number(fields.timestamp));
        if (!isFinite(ts) || ts < 0 || ts > 86400) return res.status(400).json({ error: "That time isn't valid." });
        fields.timestamp = ts;
      }
    }

    const airFields = {};
    for (const [k, v] of Object.entries(fields)) {
      const fid = spec.fields[k];
      if (!fid) continue;
      airFields[fid] = spec.links.includes(k) ? (Array.isArray(v) ? v : v ? [v] : []) : v;
    }
    // Switching a note between global (whole song) and timestamped, or changing a timestamped note's
    // time, keeps its Name in step ("Note @ m:ss" etc.). A pure global switch leaves the stored
    // timestamp alone so switching back restores the original time.
    if (entity === "feedback" && (typeof fields.global === "boolean" || "timestamp" in fields)) {
      const rec = await getRecord(T.feedback, id);
      const oldName = rec.fields[F.feedback.name];
      const makeGlobal = typeof fields.global === "boolean" ? fields.global : share.isGlobalName(oldName);
      const ts = "timestamp" in fields ? fields.timestamp : rec.fields[F.feedback.timestamp];
      if (typeof fields.global === "boolean" || !makeGlobal) airFields[F.feedback.name] = share.noteNameFor(oldName, makeGlobal, ts);
    }

    const updated = await patch(spec.table, [{ id, fields: airFields }], true);
    res.status(200).json({ ok: true, record: updated[0] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
