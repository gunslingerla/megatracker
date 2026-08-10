const { T, F, listAll, del } = require("./_airtable");
const { requireAuth } = require("./_auth");

// Deletes a track (and its production phases) or an empty album.
module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { entity, id } = body || {};
  if (!entity || !id) return res.status(400).json({ error: "bad request" });

  try {
    if (entity === "track") {
      const phases = await listAll(T.phases);
      const phaseIds = phases
        .filter((p) => (p.fields[F.phase.track] || []).includes(id))
        .map((p) => p.id);
      if (phaseIds.length) await del(T.phases, phaseIds);
      await del(T.tracks, [id]);
      return res.status(200).json({ ok: true });
    }
    if (entity === "feedback") {
      await del(T.feedback, [id]);
      return res.status(200).json({ ok: true });
    }
    if (entity === "album") {
      const tracks = await listAll(T.tracks);
      const inAlbum = tracks.filter((t) => (t.fields[F.track.album] || []).includes(id));
      if (inAlbum.length) {
        return res.status(409).json({ error: "not empty", message: `This album still has ${inAlbum.length} track(s). Delete or move them first.` });
      }
      await del(T.albums, [id]);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "unknown entity" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
