const { T, F, PHASE_NAMES, listAll, patch } = require("./_airtable");
const { requireAuth } = require("./_auth");

// Recompute every phase record's owner(s) from the members' "Default Phases" mapping,
// then patch only the phases whose owners actually changed. This is the "apply to all
// tracks" action behind the Band page button.
module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  try {
    const [membersRaw, phasesRaw] = await Promise.all([listAll(T.members), listAll(T.phases)]);

    // phaseName -> [memberId, ...]
    const ownersByPhase = {};
    PHASE_NAMES.forEach((p) => (ownersByPhase[p] = []));
    membersRaw.forEach((m) => {
      const list = Array.isArray(m.fields[F.member.phases]) ? m.fields[F.member.phases] : [];
      list.forEach((p) => { if (ownersByPhase[p]) ownersByPhase[p].push(m.id); });
    });

    const updates = [];
    for (const rec of phasesRaw) {
      const phaseName = rec.fields[F.phase.phase] || "";
      const want = ownersByPhase[phaseName] || [];
      const have = Array.isArray(rec.fields[F.phase.owner]) ? rec.fields[F.phase.owner] : [];
      const same = want.length === have.length && want.every((id) => have.includes(id));
      if (!same) updates.push({ id: rec.id, fields: { [F.phase.owner]: want } });
    }

    // Airtable caps PATCH at 10 records per request.
    for (let i = 0; i < updates.length; i += 10) {
      await patch(T.phases, updates.slice(i, i + 10), true);
    }

    res.status(200).json({ ok: true, changed: updates.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
