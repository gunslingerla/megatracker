const { T, F, STAGES, getRecord, patch } = require("./_airtable");
const { requireAuth } = require("./_auth");

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
      albumId: F.track.album,
    },
    links: ["ownerIds", "albumId"],
  },
  feedback: {
    table: T.feedback,
    fields: { status: F.feedback.status, comment: F.feedback.comment, ownerIds: F.feedback.author },
    links: ["ownerIds"],
  },
  phase: {
    table: T.phases,
    fields: { status: F.phase.status, ownerIds: F.phase.owner },
    links: ["ownerIds"],
  },
  album: {
    table: T.albums,
    fields: {
      title: F.album.title, artist: F.album.artist, stage: F.album.stage,
      releaseDate: F.album.releaseDate, playlist: F.album.playlist, genre: F.album.genre,
      label: F.album.label, notes: F.album.notes, ownerIds: F.album.owner,
    },
    links: ["ownerIds"],
  },
};

const PRODUCTION_IDX = STAGES.indexOf("Production");

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { entity, id, fields, force } = body || {};

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
