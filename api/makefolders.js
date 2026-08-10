const { T, F, listAll, getRecord } = require("./_airtable");
const { makeAlbumFolders } = require("./_dropbox");
const { requireAuth } = require("./_auth");

// Creates missing "PREFIX_NN_Name/Bounces" project folders in an album's Dropbox folder,
// one per track that doesn't already have one. POST { albumId }.
module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { albumId } = body || {};
  if (!albumId) return res.status(400).json({ error: "albumId required" });

  try {
    const alb = await getRecord(T.albums, albumId);
    const folder = alb.fields[F.album.dropboxFolder];
    const prefix = alb.fields[F.album.trackPrefix] || "";
    if (!folder) return res.status(400).json({ error: "This album has no Dropbox folder set." });

    const tracksR = await listAll(T.tracks);
    const tracks = tracksR
      .filter((r) => (r.fields[F.track.album] || []).includes(albumId))
      .map((r) => ({ order: r.fields[F.track.order], title: r.fields[F.track.title] || "Untitled" }))
      .filter((t) => t.order != null)
      .sort((a, b) => a.order - b.order);

    const { created } = await makeAlbumFolders(folder, prefix, tracks);
    res.status(200).json({ ok: true, created });
  } catch (e) {
    const msg = String(e.message || e);
    const scope = /write|scope|insufficient|403/i.test(msg);
    res.status(500).json({ error: scope ? "The Dropbox token needs the files.content.write scope to create folders." : msg });
  }
};
