const { allFiles, tempLink, parseOrder } = require("./_dropbox");
const { requireAuth } = require("./_auth");

// Returns every version of a track's audio (current + PREVIOUS VERSIONS), newest first,
// with streaming links — so the band can see and play the version history.
module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  const order = Number(req.query.order);
  if (!order) return res.status(400).json({ error: "order required" });
  try {
    const { tok, files } = await allFiles();
    const mine = files
      .filter((f) => parseOrder(f.name) === order)
      .sort((a, b) => (a.server_modified < b.server_modified ? 1 : -1));
    // The current version is the top-level file (not inside PREVIOUS VERSIONS).
    const currentIdx = mine.findIndex((f) => !/previous versions/i.test(f.path_lower || ""));
    const items = [];
    for (let i = 0; i < mine.length; i++) {
      const f = mine[i];
      const vm = f.name.match(/_v(\d+)/i) || f.name.match(/\bv(\d+)\b/i);
      items.push({
        name: f.name,
        version: vm ? "v" + vm[1] : "",
        ext: f.name.split(".").pop().toLowerCase(),
        modified: f.server_modified,
        current: i === (currentIdx === -1 ? 0 : currentIdx),
        previous: /previous versions/i.test(f.path_lower || ""),
        url: await tempLink(f.path_lower, tok),
      });
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ order, items });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
