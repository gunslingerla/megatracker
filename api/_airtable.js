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
  feedback: "tblPqaEXRjvC5JLNv",
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
    dropboxFolder: "fldrgy8vF45MirkKT",
    trackPrefix: "fldtoIxyNrItdk0gJ",
    current: "fldK6h7H7VLwrRp9H",
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
    lyricsData: "fldT7D6xs1JgQW7JF",
    feedback: "fldzqpxcV9hlsxRMY",
    onHold: "fldpiE7ps65IYglWH",
    art: "fldxcUo4xqXzmkcCr",
  },
  feedback: {
    name: "fldtengI4Ng7UGxKL",
    timestamp: "fldQpNmJkk8Sm7ck1",
    comment: "fld4YnET22K9HZ5EL",
    status: "fldZr8ROpMgbAmrry",
    track: "fldNAQ2fPgNBobOQ3",
    author: "fldjtnnsl8PhwxePj",
    version: "fldciN7WbSCDDT5l1",
  },
  phase: {
    name: "fld1LCOJADedeOh8e",
    phase: "fldiEwqSoFnwfagjO",
    status: "flda8GxVD2s3JTf6H",
    track: "flds4K8cRciMmQ1MB",
    owner: "fldbkJWmPuq89wfsu",
    isDone: "fldFNK4qLW250BiGn",
    due: "fldIdcVR9Ae64NCUF",
    subtasks: "fldza2Sz3EBFOe2Io",
  },
  member: {
    name: "fldLdKtbqycPlKp2k",
    role: "fldiUoQtGn9Aohw3R",
    email: "fldWg3Ns8qMCCmxYr",
    nickname: "fldlqmdVveUp6Ndto",
    color: "fldjGoImeca6pSVMA",
    phases: "fldW5lVAr3vWuzlyl", // "Default Phases" (multipleSelects of phase names)
  },
};

// The production pipeline, in order. Index used for the progress meter + gate logic.
const STAGES = ["Idea", "Writing", "Demo", "Production", "Mixing", "Mastering", "Released"];
const PHASE_NAMES = ["Drums", "Bass", "Eric Guitar", "Josh Guitar", "Eric Vocals", "Josh Vocals", "Backing Vocals", "Synth", "Sound Design"];

function authHeaders() {
  if (!TOKEN) throw new Error("AIRTABLE_TOKEN is not set");
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch wrapper with automatic retry on rate-limit (429) and transient 5xx errors.
// Airtable allows ~5 requests/sec per base, so bursts of edits can hit 429 — this smooths that out.
async function air(url, opts = {}, tries = 5) {
  let lastText = "";
  for (let attempt = 0; attempt < tries; attempt++) {
    const r = await fetch(url, { ...opts, headers: authHeaders() });
    if (r.ok) return r;
    if (r.status === 429 || r.status >= 500) {
      const retryAfter = Number(r.headers.get("retry-after"));
      const wait = retryAfter ? retryAfter * 1000 : Math.min(200 * 2 ** attempt, 2000);
      lastText = await r.text().catch(() => "");
      await sleep(wait + Math.random() * 120);
      continue;
    }
    throw new Error(`Airtable ${r.status}: ${await r.text()}`);
  }
  throw new Error(`Airtable retries exhausted: ${lastText}`);
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
    const data = await (await air(url)).json();
    out.push(...data.records);
    offset = data.offset;
  } while (offset);
  return out;
}

// Fetch a single record (fields keyed by field ID).
async function getRecord(tableId, id) {
  const url = new URL(`https://api.airtable.com/v0/${BASE}/${tableId}/${id}`);
  url.searchParams.set("returnFieldsByFieldId", "true");
  return (await air(url)).json();
}

// Update records. `records` = [{ id, fields: { [fieldId]: value } }].
async function patch(tableId, records, typecast = false) {
  const url = `https://api.airtable.com/v0/${BASE}/${tableId}`;
  const r = await air(url, {
    method: "PATCH",
    body: JSON.stringify({ records, typecast, returnFieldsByFieldId: true }),
  });
  return (await r.json()).records;
}

// Create records. `records` = [{ fields: { [fieldId]: value } }].
async function create(tableId, records, typecast = true) {
  const url = `https://api.airtable.com/v0/${BASE}/${tableId}`;
  const r = await air(url, {
    method: "POST",
    body: JSON.stringify({ records, typecast, returnFieldsByFieldId: true }),
  });
  return (await r.json()).records;
}

// Upload an image straight into an attachment field (base64), no external hosting needed.
async function uploadAttachment(recordId, fieldId, { filename, contentType, base64 }) {
  const url = `https://content.airtable.com/v0/${BASE}/${recordId}/${fieldId}/uploadAttachment`;
  const r = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ contentType, filename, file: base64 }),
  });
  if (!r.ok) throw new Error(`Airtable upload failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Delete records by ID (chunks of 10, Airtable's per-request limit).
async function del(tableId, ids) {
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${tableId}`);
    chunk.forEach((id) => url.searchParams.append("records[]", id));
    await air(url, { method: "DELETE" });
  }
}

module.exports = { BASE, T, F, STAGES, PHASE_NAMES, listAll, getRecord, patch, create, del, uploadAttachment };
