const { albumData, tempLink } = require("./_dropbox");
const { requireAuth } = require("./_auth");

// Streaming URLs for one album's songs. Pass ?folder=<album folder link/path>&prefix=<project prefix>.
// Order + title come from each "PREFIX_NN_Name" project folder; audio is the newest file in its Bounces.
module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  const folder = req.query.folder || "";
  const prefix = req.query.prefix || "";
  try {
    const { tok, items } = await albumData(folder, prefix);
    const out = [];
    for (const it of items) {
      let url = null, ext = null, modified = null, name = it.folder;
      if (it.file) {
        url = await tempLink(it.file.path_lower, tok);
        name = it.file.name;
        ext = it.file.name.split(".").pop().toLowerCase();
        modified = it.file.server_modified;
      }
      out.push({ order: it.order, title: it.title, folder: it.folder, name, ext, modified, url });
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ items: out, configured: true });
  } catch (e) {
    const msg = String(e.message || e);
    const configured = !/not configured|DROPBOX_/.test(msg);
    res.status(configured ? 500 : 200).json({ items: [], configured: false, error: msg });
  }
};
