const { T, F, listAll } = require("./_airtable");

// Public iCal feed of track due dates, for subscribing in Google Calendar / Apple Calendar.
// This endpoint is NOT behind the app password (calendar apps fetch it server-side with no
// cookie), so it's gated by an optional secret: set CAL_FEED_KEY and pass ?key=... to match.
function esc(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
// Fold long lines to <=75 octets per RFC 5545.
function fold(line) {
  if (line.length <= 73) return line;
  let out = "", rest = line;
  while (rest.length > 73) { out += rest.slice(0, 73) + "\r\n "; rest = rest.slice(73); }
  return out + rest;
}
const pad = (n) => String(n).padStart(2, "0");
function stamp(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

module.exports = async (req, res) => {
  const need = process.env.CAL_FEED_KEY;
  if (need) {
    const got = (req.query && req.query.key) || "";
    if (got !== need) return res.status(403).send("Forbidden: bad or missing ?key");
  }

  try {
    const [tracksR, albumsR] = await Promise.all([listAll(T.tracks), listAll(T.albums)]);
    const albumName = {};
    albumsR.forEach((a) => (albumName[a.id] = a.fields[F.album.title] || ""));

    const now = new Date();
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//The Megas//Album Tracker//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:The Megas — Due Dates",
      "X-WR-CALDESC:Track due dates from the Album Tracker",
      "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
      "X-PUBLISHED-TTL:PT6H",
    ];

    for (const r of tracksR) {
      const f = r.fields;
      const due = f[F.track.dueDate];
      if (!due) continue;
      const start = new Date(due + "T00:00:00Z");
      if (isNaN(start)) continue;
      const end = new Date(start.getTime() + 24 * 3600 * 1000);
      const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
      const albumId = Array.isArray(f[F.track.album]) ? f[F.track.album][0] : null;
      const bits = [];
      if (f[F.track.stage]) bits.push(`Stage: ${f[F.track.stage]}`);
      if (albumId && albumName[albumId]) bits.push(`Album: ${albumName[albumId]}`);
      if (f[F.track.inspiredBy]) bits.push(`Inspired by: ${f[F.track.inspiredBy]}`);
      lines.push(
        "BEGIN:VEVENT",
        fold(`UID:${r.id}@themegas-albumtracker`),
        `DTSTAMP:${stamp(now)}`,
        `DTSTART;VALUE=DATE:${ymd(start)}`,
        `DTEND;VALUE=DATE:${ymd(end)}`,
        fold(`SUMMARY:${esc(f[F.track.title] || "Untitled")}`),
        fold(`DESCRIPTION:${esc(bits.join("\n"))}`),
        "END:VEVENT"
      );
    }
    lines.push("END:VCALENDAR");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'inline; filename="the-megas.ics"');
    res.setHeader("Cache-Control", "public, max-age=1800");
    res.status(200).send(lines.join("\r\n"));
  } catch (e) {
    res.status(500).send("Calendar feed error: " + String(e.message || e));
  }
};
