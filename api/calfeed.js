const { requireAuth } = require("./_auth");

// Returns the subscribe URL for the iCal feed (including the secret key if one is set),
// so the in-app Calendar view can show a ready-to-copy link. Behind the app password.
module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const key = process.env.CAL_FEED_KEY;
  const url = `${proto}://${host}/api/calendar.ics${key ? `?key=${encodeURIComponent(key)}` : ""}`;
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ url, secured: !!key });
};
