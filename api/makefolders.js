const { T, F, listAll, getRecord } = require("./_airtable");
const { makeAlbumFolders } = require("./_dropbox");
const { requireAuth } = require("./_auth");

const first = (v) => (Array.isArray(v) ? v[0] : v);

// Creates missing "PREFIX_NN_Name/Bounces" project folders in an album's Dropbox folder.
// POST { trackId } to create just that song's folder, or { albumId } for all missing in an album.
module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { albumId, trackId } = body || {};
  if (!albumId && !trackId) return res.status(400).json({ error: "albumId or trackId required" });

  try {
    let resolvedAlbumId = albumId;
    let tracks;

    if (trackId) {
      const tr = await getRecord(T.tracks, trackId);
      resolvedAlbumId = first(tr.fields[F.track.album]);
      if (!resolvedAlbumId) return res.status(400).json({ error: "This track isn't on an album." });
      if (tr.fields[F.track.order] == null) return res.status(400).json({ error: "This track has no track number." });
      tracks = [{ order: tr.fields[F.track.order], title: tr.fields[F.track.title] || "Untitled" }];
    }

    const alb = await getRecord(T.albums, resolvedAlbumId);
    const folder = alb.fields[F.album.dropboxFolder];
    const prefix = alb.fields[F.album.trackPrefix] || "";
    if (!folder) return res.status(400).json({ error: "This album has no Dropbox folder set." });

    if (!tracks) {
      const tracksR = await listAll(T.tracks);
      tracks = tracksR
        .filter((r) => (r.fields[F.track.album] || []).includes(resolvedAlbumId))
        .map((r) => ({ order: r.fields[F.track.order], title: r.fields[F.track.title] || "Untitled" }))
        .filter((t) => t.order != null)
        .sort((a, b) => a.order - b.order);
    }

    const { created } = await makeAlbumFolders(folder, prefix, tracks);
    res.status(200).json({ ok: true, created });
  } catch (e) {
    const msg = String(e.message || e);
    const scope = /write|scope|insufficient|403/i.test(msg);
    res.status(500).json({ error: scope ? "The Dropbox token needs the files.content.write scope to create folders." : msg });
  }
};
