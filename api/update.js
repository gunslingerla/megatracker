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
    fields: { status: F.feedback.status, comment: F.feedback.comment, ownerIds: F.feedback.author, version: F.feedback.version },
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
function threadAppend(rec, msg) {
  let t = []; try { t = JSON.parse(rec.fields[F.feedback.thread] || "[]"); if (!Array.isArray(t)) t = []; } catch {}
  t.push(msg); return JSON.stringify(t.slice(-200));
}
// Login-free: mixer toggles a note's "Mixer Reviewed" flag.
async function mixReview(req, res, body) {
  const data = share.verify(body.mixtoken);
  if (!data) return res.status(403).json({ error: "invalid link" });
  if (!body.id) return res.status(400).json({ error: "id required" });
  try {
    const { ids } = await shareFromToken(data);
    const rec = await getRecord(T.feedback, body.id);
    const tr = (rec.fields[F.feedback.track] || [])[0];
    if (!ids.has(tr)) return res.status(403).json({ error: "not allowed" });
    await patch(T.feedback, [{ id: body.id, fields: { [F.feedback.mixReviewed]: !!body.reviewed } }], true);
    return res.status(200).json({ ok: true, reviewed: !!body.reviewed });
  } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
}
// Login-free: sharee posts a reply/question on a note, tagged with the link title.
async function mixReply(req, res, body) {
  const data = share.verify(body.mixtoken);
  if (!data) return res.status(403).json({ error: "invalid link" });
  const text = String(body.text || "").trim();
  if (!body.id || !text) return res.status(400).json({ error: "id and text required" });
  try {
    const { ids, title } = await shareFromToken(data);
    const rec = await getRecord(T.feedback, body.id);
    const tr = (rec.fields[F.feedback.track] || [])[0];
    if (!ids.has(tr)) return res.status(403).json({ error: "not allowed" });
    const thread = threadAppend(rec, { by: title, side: "share", text: text.slice(0, 2000), at: Date.now() });
    await patch(T.feedback, [{ id: body.id, fields: { [F.feedback.thread]: thread } }], true);
    return res.status(200).json({ ok: true });
  } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  if (body && body.mixtoken) return (body.text != null ? mixReply : mixReview)(req, res, body); // login-free path
  if (!requireAuth(req, res)) return;
  const { entity, id, fields, force } = body || {};

  // Create or edit a stored, titled share link (stable URL; songs/title editable).
  if (entity === "shareCreate" || entity === "shareUpdate") {
    const tracks = Array.isArray(body.tracks) ? body.tracks.map((x) => (typeof x === "string" ? x : x && x.id)).filter(Boolean) : [];
    const title = (body.title || "Untitled link").toString().slice(0, 120);
    if (!tracks.length) return res.status(400).json({ error: "pick at least one song" });
    try {
      let sid = body.id;
      if (entity === "shareUpdate" && sid) {
        await patch(T.shares, [{ id: sid, fields: { [F.share.title]: title, [F.share.tracks]: JSON.stringify(tracks) } }], true);
      } else {
        const rec = await create(T.shares, [{ fields: { [F.share.title]: title, [F.share.tracks]: JSON.stringify(tracks) } }]);
        sid = rec[0].id;
      }
      return res.status(200).json({ ok: true, id: sid, token: share.sign({ s: sid }) });
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
      const thread = threadAppend(rec, { by: (body.by || "Band").toString().slice(0, 60), side: "band", text: String(body.text).trim().slice(0, 2000), at: Date.now() });
      await patch(T.feedback, [{ id, fields: { [F.feedback.thread]: thread } }], true);
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

    const airFields = {};
    for (const [k, v] of Object.entries(fields)) {
      const fid = spec.fields[k];
      if (!fid) continue;
      airFields[fid] = spec.links.includes(k) ? (Array.isArray(v) ? v : v ? [v] : []) : v;
    }

    const updated = await patch(spec.table, [{ id, fields: airFields }], true);
    res.status(200).json({ ok: true, record: updated[0] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
