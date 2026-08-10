const { newestByOrder, tempLink } = require("./_dropbox");
const { requireAuth } = require("./_auth");

// Returns a fresh streaming URL per track number, newest version, from the live Dropbox folder.
// Frontend maps each item to a track by Track Order.
module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { tok, byOrder } = await newestByOrder();
    const items = [];
    for (const key of Object.keys(byOrder)) {
      const f = byOrder[key];
      const url = await tempLink(f.path_lower, tok);
      items.push({
        order: Number(key),
        name: f.name,
        ext: f.name.split(".").pop().toLowerCase(),
        modified: f.server_modified,
        url,
      });
    }
    items.sort((a, b) => a.order - b.order);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ items, configured: true });
  } catch (e) {
    // If Dropbox isn't configured yet, respond gracefully so the board still works.
    const msg = String(e.message || e);
    const configured = !/not configured|DROPBOX_/.test(msg);
    res.status(configured ? 500 : 200).json({ items: [], configured: false, error: msg });
  }
};
