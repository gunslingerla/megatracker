const { T, F, PHASE_NAMES, listAll, create } = require("./_airtable");
const { requireAuth } = require("./_auth");

// Which roster roles own which production phase (matched by the member's Role / Instrument text).
function ownersForPhase(phaseName, members) {
  const has = (m, kw) => (m.role || "").toLowerCase().includes(kw);
  if (phaseName === "Drums") return members.filter((m) => has(m, "drum"));
  if (phaseName === "Bass") return members.filter((m) => has(m, "bass"));
  if (phaseName === "Guitars") return members.filter((m) => has(m, "guitar"));
  if (phaseName === "Vocals") return members.filter((m) => has(m, "vocal"));
  if (phaseName === "Synth & Sound Design") return members.filter((m) => has(m, "synth") || has(m, "sound"));
  return [];
}

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { entity, fields } = body || {};
  if (!entity || !fields) return res.status(400).json({ error: "bad request" });

  try {
    if (entity === "album") {
      const rec = await create(T.albums, [{ fields: {
        [F.album.title]: fields.title || "Untitled album",
        [F.album.artist]: fields.artist || "The Megas",
        [F.album.stage]: fields.stage || "Idea",
        [F.album.genre]: fields.genre || "",
        [F.album.playlist]: fields.playlist || "",
        [F.album.notes]: fields.notes || "",
      } }]);
      return res.status(200).json({ ok: true, id: rec[0].id });
    }

    if (entity === "member") {
      const rec = await create(T.members, [{ fields: {
        [F.member.name]: fields.name || "New member",
        [F.member.role]: fields.role || "",
        [F.member.email]: fields.email || "",
      } }]);
      return res.status(200).json({ ok: true, id: rec[0].id });
    }

    if (entity === "feedback") {
      if (!fields.trackId) return res.status(400).json({ error: "trackId required" });
      const ts = Number(fields.timestamp) || 0;
      const ff = {
        [F.feedback.name]: fields.name || `Note @ ${Math.floor(ts / 60)}:${String(ts % 60).padStart(2, "0")}`,
        [F.feedback.track]: [fields.trackId],
        [F.feedback.timestamp]: ts,
        [F.feedback.comment]: fields.comment || "",
        [F.feedback.status]: "Open",
      };
      if (fields.authorId) ff[F.feedback.author] = [fields.authorId];
      const rec = await create(T.feedback, [{ fields: ff }]);
      return res.status(200).json({ ok: true, id: rec[0].id });
    }

    if (entity === "track") {
      if (!fields.albumId) return res.status(400).json({ error: "albumId required" });
      const tf = {
        [F.track.title]: fields.title || "New track",
        [F.track.album]: [fields.albumId],
        [F.track.stage]: fields.stage || "Idea",
        [F.track.inspiredBy]: fields.inspiredBy || undefined,
        [F.track.reference]: fields.reference || undefined,
        [F.track.bpm]: fields.bpm != null && fields.bpm !== "" ? Number(fields.bpm) : undefined,
        [F.track.key]: fields.key || undefined,
        [F.track.songLink]: fields.songLink || undefined,
        [F.track.projectFile]: fields.projectFile || undefined,
        [F.track.notes]: fields.notes || undefined,
        [F.track.lyrics]: fields.lyrics || undefined,
        [F.track.order]: fields.order != null ? Number(fields.order) : undefined,
      };
      Object.keys(tf).forEach((k) => tf[k] === undefined && delete tf[k]);
      const trackRec = await create(T.tracks, [{ fields: tf }]);
      const trackId = trackRec[0].id;

      // Auto-create the 5 production phases, each assigned to the matching roster member(s).
      const membersRaw = await listAll(T.members);
      const members = membersRaw.map((r) => ({ id: r.id, role: r.fields[F.member.role] || "" }));
      const phaseRecords = PHASE_NAMES.map((p) => ({
        fields: {
          [F.phase.name]: `${tf[F.track.title]} — ${p}`,
          [F.phase.phase]: p,
          [F.phase.status]: "Not started",
          [F.phase.track]: [trackId],
          [F.phase.owner]: ownersForPhase(p, members).map((m) => m.id),
        },
      }));
      await create(T.phases, phaseRecords);
      return res.status(200).json({ ok: true, id: trackId });
    }

    return res.status(400).json({ error: "unknown entity" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
