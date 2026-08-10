const { F, uploadAttachment } = require("./_airtable");
const { requireAuth } = require("./_auth");

// Upload album/track art directly into Airtable. POST { entity, id, filename, contentType, dataBase64 }.
module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { entity, id, filename, contentType, dataBase64 } = body || {};
  if (!entity || !id || !dataBase64) return res.status(400).json({ error: "bad request" });
  const fieldId = entity === "album" ? F.album.cover : entity === "track" ? F.track.art : null;
  if (!fieldId) return res.status(400).json({ error: "unknown entity" });
  try {
    const out = await uploadAttachment(id, fieldId, {
      filename: filename || "art.png",
      contentType: contentType || "image/png",
      base64: dataBase64,
    });
    res.status(200).json({ ok: true, field: out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
