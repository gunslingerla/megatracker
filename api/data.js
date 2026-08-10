const { T, F, STAGES, PHASE_NAMES, listAll } = require("./_airtable");
const { requireAuth } = require("./_auth");

// Returns the whole board as clean JSON. All Airtable field IDs are resolved here so the
// frontend deals only with friendly names.
module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const [albumsR, tracksR, phasesR, membersR, feedbackR] = await Promise.all([
      listAll(T.albums),
      listAll(T.tracks),
      listAll(T.phases),
      listAll(T.members),
      listAll(T.feedback),
    ]);

    const first = (v) => (Array.isArray(v) ? v[0] : v);
    const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
    const att = (v) => (Array.isArray(v) ? v.map((a) => ({ url: a.url, thumb: a.thumbnails?.large?.url || a.url })) : []);

    const members = membersR.map((r) => {
      const name = r.fields[F.member.name] || "";
      const nickname = r.fields[F.member.nickname] || "";
      return { id: r.id, name, nickname, display: nickname || name, role: r.fields[F.member.role] || "", email: r.fields[F.member.email] || "", color: r.fields[F.member.color] || "", phases: arr(r.fields[F.member.phases]) };
    });
    // Use the nickname (falling back to name) everywhere owners/authors are shown.
    const memberName = Object.fromEntries(members.map((m) => [m.id, m.display]));

    const phases = phasesR.map((r) => ({
      id: r.id,
      name: r.fields[F.phase.name] || "",
      phase: r.fields[F.phase.phase] || "",
      status: r.fields[F.phase.status] || "Not started",
      trackId: first(r.fields[F.phase.track]) || null,
      ownerIds: arr(r.fields[F.phase.owner]),
      owners: arr(r.fields[F.phase.owner]).map((id) => memberName[id] || "?"),
    }));
    const phasesByTrack = {};
    phases.forEach((p) => {
      (phasesByTrack[p.trackId] = phasesByTrack[p.trackId] || []).push(p);
    });
    // Keep phases in the canonical instrument order.
    Object.values(phasesByTrack).forEach((list) =>
      list.sort((a, b) => PHASE_NAMES.indexOf(a.phase) - PHASE_NAMES.indexOf(b.phase))
    );

    const feedback = feedbackR.map((r) => {
      const f = r.fields;
      return {
        id: r.id,
        trackId: first(f[F.feedback.track]) || null,
        timestamp: f[F.feedback.timestamp] ?? 0,
        comment: f[F.feedback.comment] || "",
        status: f[F.feedback.status] || "Open",
        version: f[F.feedback.version] || "",
        authorId: first(f[F.feedback.author]) || null,
        author: (arr(f[F.feedback.author]).map((id) => memberName[id] || "?"))[0] || "",
        createdTime: r.createdTime,
      };
    });
    const feedbackByTrack = {};
    feedback.forEach((fb) => { (feedbackByTrack[fb.trackId] = feedbackByTrack[fb.trackId] || []).push(fb); });
    Object.values(feedbackByTrack).forEach((l) => l.sort((a, b) => a.timestamp - b.timestamp));

    const tracks = tracksR.map((r) => {
      const f = r.fields;
      const tp = phasesByTrack[r.id] || [];
      const done = tp.filter((p) => p.status === "Done").length;
      return {
        id: r.id,
        title: f[F.track.title] || "Untitled",
        stage: f[F.track.stage] || "Idea",
        inspiredBy: f[F.track.inspiredBy] || "",
        reference: f[F.track.reference] || "",
        bpm: f[F.track.bpm] ?? null,
        key: f[F.track.key] || "",
        songLink: f[F.track.songLink] || "",
        projectFile: f[F.track.projectFile] || "",
        notes: f[F.track.notes] || "",
        lyrics: f[F.track.lyrics] || "",
        lyricsData: f[F.track.lyricsData] || "",
        cover: att(f[F.track.art]),
        dueDate: f[F.track.dueDate] || null,
        order: f[F.track.order] ?? 999,
        albumId: first(f[F.track.album]) || null,
        onHold: !!f[F.track.onHold],
        ownerIds: arr(f[F.track.owner]),
        owners: arr(f[F.track.owner]).map((id) => memberName[id] || "?"),
        progress: f[F.track.progress] ?? 0,
        phasesDone: done,
        phasesTotal: tp.length,
        productionComplete: tp.length > 0 && done === tp.length,
        phases: tp,
        feedback: feedbackByTrack[r.id] || [],
        openFeedback: (feedbackByTrack[r.id] || []).filter((x) => x.status === "Open").length,
      };
    });
    tracks.sort((a, b) => a.order - b.order);

    const albums = albumsR.map((r) => {
      const f = r.fields;
      return {
        id: r.id,
        title: f[F.album.title] || "Untitled",
        artist: f[F.album.artist] || "",
        stage: f[F.album.stage] || "Idea",
        releaseDate: f[F.album.releaseDate] || null,
        cover: att(f[F.album.cover]),
        playlist: f[F.album.playlist] || "",
        notes: f[F.album.notes] || "",
        genre: f[F.album.genre] || "",
        label: f[F.album.label] || "",
        dropboxFolder: f[F.album.dropboxFolder] || "",
        trackPrefix: f[F.album.trackPrefix] || "",
        current: !!f[F.album.current],
        ownerIds: arr(f[F.album.owner]),
        owners: arr(f[F.album.owner]).map((id) => memberName[id] || "?"),
        progress: f[F.album.progress] ?? 0,
        trackCount: f[F.album.trackCount] ?? 0,
      };
    });

    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const feedKey = process.env.CAL_FEED_KEY;
    const feedUrl = `${proto}://${host}/api/calendar.ics${feedKey ? `?key=${encodeURIComponent(feedKey)}` : ""}`;

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ albums, tracks, phases, members, feedback, stages: STAGES, phaseNames: PHASE_NAMES, feedUrl, feedSecured: !!feedKey });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
