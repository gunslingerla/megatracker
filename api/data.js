const { T, F, STAGES, PHASE_NAMES, listAll } = require("./_airtable");
const { requireAuth } = require("./_auth");

// Returns the whole board as clean JSON. All Airtable field IDs are resolved here so the
// frontend deals only with friendly names.
module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const [albumsR, tracksR, phasesR, membersR] = await Promise.all([
      listAll(T.albums),
      listAll(T.tracks),
      listAll(T.phases),
      listAll(T.members),
    ]);

    const first = (v) => (Array.isArray(v) ? v[0] : v);
    const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
    const att = (v) => (Array.isArray(v) ? v.map((a) => ({ url: a.url, thumb: a.thumbnails?.large?.url || a.url })) : []);

    const members = membersR.map((r) => ({
      id: r.id,
      name: r.fields[F.member.name] || "",
      role: r.fields[F.member.role] || "",
      email: r.fields[F.member.email] || "",
    }));
    const memberName = Object.fromEntries(members.map((m) => [m.id, m.name]));

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
        dueDate: f[F.track.dueDate] || null,
        order: f[F.track.order] ?? 999,
        albumId: first(f[F.track.album]) || null,
        ownerIds: arr(f[F.track.owner]),
        owners: arr(f[F.track.owner]).map((id) => memberName[id] || "?"),
        progress: f[F.track.progress] ?? 0,
        phasesDone: done,
        phasesTotal: tp.length,
        productionComplete: tp.length > 0 && done === tp.length,
        phases: tp,
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
        ownerIds: arr(f[F.album.owner]),
        owners: arr(f[F.album.owner]).map((id) => memberName[id] || "?"),
        progress: f[F.album.progress] ?? 0,
        trackCount: f[F.album.trackCount] ?? 0,
      };
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ albums, tracks, phases, members, stages: STAGES, phaseNames: PHASE_NAMES });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
