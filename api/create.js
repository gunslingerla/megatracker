const { T, F, PHASE_NAMES, listAll, create } = require("./_airtable");
const { requireAuth } = require("./_auth");

// Default owner(s) for each production phase.
function ownersForPhase(phaseName, members) {
  const role = (kw) => members.filter((m) => (m.role || "").toLowerCase().includes(kw));
  const name = (kw) => members.filter((m) => (m.name || "").toLowerCase().includes(kw));
  const MAP = {
    "Drums": role("drum"),
    "Bass": role("bass"),
    "Eric Guitar": name("eric"),
    "Josh Guitar": name("josh"),
    "Eric Vocals": name("eric"),
    "Josh Vocals": name("josh"),
    "Backing Vocals": name("eric"),
    "Synth": name("brian").length ? name("brian") : role("synth"),
    "Sound Design": name("eric"),
  };
  return MAP[phaseName] || [];
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
      const palette = ["#6cb6ff", "#46dba0", "#ffab4a", "#f0654f", "#b58cff", "#4fd0e0", "#f078c0", "#e5c94a", "#8a9bff", "#5fd08a"];
      const rec = await create(T.members, [{ fields: {
        [F.member.name]: fields.name || "New member",
        [F.member.nickname]: fields.nickname || "",
        [F.member.role]: fields.role || "",
        [F.member.email]: fields.email || "",
        [F.member.color]: fields.color || palette[Math.floor(Math.random() * palette.length)],
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
      if (fields.version) ff[F.feedback.version] = fields.version;
      const rec = await create(T.feedback, [{ fields: ff }]);
      return res.status(200).json({ ok: true, id: rec[0].id });
    }

    if (entity === "track") {
      const tf = {
        [F.track.title]: fields.title || "New track",
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
      if (fields.albumId) tf[F.track.album] = [fields.albumId];
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
