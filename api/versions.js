const { projectVersions, tempLink } = require("./_dropbox");
const { requireAuth } = require("./_auth");

// Every bounce for one song's project folder, newest first.
// Pass ?folder=<album folder>&prefix=<prefix>&order=<track number>.
module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  const folder = req.query.folder || "";
  const prefix = req.query.prefix || "";
  const order = Number(req.query.order);
  if (!order) return res.status(400).json({ error: "order required" });
  try {
    const { tok, files } = await projectVersions(folder, prefix, order);
    const items = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const vm = f.name.match(/_v(\d+)/i) || f.name.match(/\bv(\d+)\b/i);
      items.push({
        name: f.name,
        version: vm ? "v" + vm[1] : "",
        ext: f.name.split(".").pop().toLowerCase(),
        modified: f.server_modified,
        current: i === 0,
        url: await tempLink(f.path_lower, tok),
      });
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ order, items });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
