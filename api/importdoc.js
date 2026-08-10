const { requireAuth } = require("./_auth");

// Fetches plain text from a public/link-shared Google Doc so lyrics can be imported.
module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  const url = req.query.url || "";
  const m = String(url).match(/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return res.status(400).json({ error: "That doesn't look like a Google Docs link." });
  try {
    const exportUrl = `https://docs.google.com/document/d/${m[1]}/export?format=txt`;
    const r = await fetch(exportUrl, { redirect: "follow" });
    if (!r.ok) return res.status(400).json({ error: "Couldn't open the doc — make sure link-sharing is on (Anyone with the link)." });
    const text = await r.text();
    // A sign-in HTML page rather than the doc means it isn't public.
    if (/<html/i.test(text.slice(0, 200))) {
      return res.status(400).json({ error: "The doc isn't publicly shared. Set it to 'Anyone with the link'." });
    }
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
