// Shared Airtable access layer for The Megas — Album Tracker.
// The Airtable Personal Access Token is read from env and never sent to the browser.

const BASE = process.env.AIRTABLE_BASE || "app8R88gFzgjBftgo";
const TOKEN = process.env.AIRTABLE_TOKEN;

// Table + field IDs (using IDs makes the app resilient to field renames in Airtable).
const T = {
  albums: "tblE2SJFR7P1bpjqA",
  tracks: "tbl6cHXtPvV92UiZM",
  phases: "tbleJ6Qb48oHzO94M",
  members: "tblwgBJzoEHAmfISz",
};

const F = {
  album: {
    title: "fld0dRzoMvO8HeujB",
    artist: "fldAgLGam8Oi7NwiS",
    stage: "fldAZErtPnSLe9oaA",
    releaseDate: "fldqwKTzp5sjXP1NT",
    cover: "fldmZHnx4jckjGJcH",
    playlist: "fldE00UqHw7JCiHt3",
    notes: "fldIyqcLkQ4Ym30A3",
    genre: "fld35W83UssPzpGm7",
    label: "fldEaWAo6liSlTR13",
    owner: "fldsEBt9D267ZuuJb",
    tracks: "fldCxxX53zNoRKUvt",
    progress: "fldqndhUQdqjbcQhr",
    trackCount: "fldr9b77emNbU1nV4",
  },
  track: {
    title: "fldmHI4nP7OIeZQ3q",
    stage: "fldzuChoMdG78cA87",
    inspiredBy: "fldleeOskjBex0b4u",
    reference: "fld1GgIaLiNPO2nl3",
    bpm: "fldI5545TN0ebqiaW",
    key: "fldeZXmquGmdYkpGs",
    songLink: "fldoTNPURvt1Xahi7",
    projectFile: "fldQeXyEXbDpoFgbR",
    notes: "fldUISZAPAm1Na75e",
    lyrics: "fldkCENxYs2jBKGU7",
    dueDate: "fldKnV8H8zDNm1NoK",
    order: "fld4e5fhcrFpIxQgx",
    album: "fldhuUu1qlJ5dhjQQ",
    owner: "fldjGKYW7MmeplnLp",
    phases: "fldw8voUhMmEwA4eh",
    phasesDone: "flduBIOo9auljC738",
    phasesTotal: "fldn3ZsFUwNhlpuiu",
    productionComplete: "fld2bxQxzaR3dWZGK",
    progress: "fld890Pju1apupjHC",
  },
  phase: {
    name: "fld1LCOJADedeOh8e",
    phase: "fldiEwqSoFnwfagjO",
    status: "flda8GxVD2s3JTf6H",
    track: "flds4K8cRciMmQ1MB",
    owner: "fldbkJWmPuq89wfsu",
    isDone: "fldFNK4qLW250BiGn",
  },
  member: {
    name: "fldLdKtbqycPlKp2k",
    role: "fldiUoQtGn9Aohw3R",
    email: "fldWg3Ns8qMCCmxYr",
  },
};

// The production pipeline, in order. Index used for the progress meter + gate logic.
const STAGES = ["Idea", "Writing", "Demo", "Production", "Mixing", "Mastering", "Released"];
const PHASE_NAMES = ["Drums", "Bass", "Guitars", "Vocals", "Synth & Sound Design"];

function authHeaders() {
  if (!TOKEN) throw new Error("AIRTABLE_TOKEN is not set");
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

// Fetch every record in a table (handles pagination), returning fields keyed by field ID.
async function listAll(tableId) {
  const out = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${tableId}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    if (offset) url.searchParams.set("offset", offset);
    const r = await fetch(url, { headers: authHeaders() });
    if (!r.ok) throw new Error(`Airtable list ${tableId} failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    out.push(...data.records);
    offset = data.offset;
  } while (offset);
  return out;
}

// Fetch a single record (fields keyed by field ID).
async function getRecord(tableId, id) {
  const url = new URL(`https://api.airtable.com/v0/${BASE}/${tableId}/${id}`);
  url.searchParams.set("returnFieldsByFieldId", "true");
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw new Error(`Airtable get ${tableId}/${id} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Update records. `records` = [{ id, fields: { [fieldId]: value } }].
async function patch(tableId, records) {
  const url = `https://api.airtable.com/v0/${BASE}/${tableId}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ records, returnFieldsByFieldId: true }),
  });
  if (!r.ok) throw new Error(`Airtable patch ${tableId} failed: ${r.status} ${await r.text()}`);
  return (await r.json()).records;
}

module.exports = { BASE, T, F, STAGES, PHASE_NAMES, listAll, getRecord, patch };
