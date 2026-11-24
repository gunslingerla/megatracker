// Google Calendar two-way sync for The Megas — Album Tracker.
//
// The tracker's dates (song deadlines, production-phase spans, free-form events) are mirrored into a
// Google calendar, and edits made in Google come back:
//   - moving/resizing a phase or deadline in Google updates its dates in the app
//   - editing a free-form event in Google (title, dates, times) updates it in the app
//   - creating an event directly in Google imports it as a free-form app event
//   - deleting a free-form event in Google deletes it in the app; deleting a phase/deadline in Google
//     just gets it put back (those come from the song data and are changed or finished in the app)
//   - if both sides changed the same item since the last sync, the more recent edit wins
// Recurring events and non-ordinary Google events (birthdays, out-of-office, ...) are never imported.
//
// How changes are told apart: every synced Google event carries private extended properties:
//   megas=1   this app manages it
//   base      the "semantic" state (dates/title) both sides agreed on at the last sync
//   sig       hash of everything we wrote (title/description/dates), to spot cosmetic drift
//   at        when we last wrote it (ms)
// A side has "changed" when its current semantic state differs from `base`.
//
// Auth is a Google service account (no OAuth screens). The calendar has to be shared with the
// service account's email with "Make changes to events". Env vars (all server-side):
//   GOOGLE_SERVICE_ACCOUNT_JSON   the whole key file contents  (or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY)
//   GOOGLE_CALENDAR_ID            the calendar to sync with (Calendar settings -> Integrate calendar)
//   GOOGLE_CALENDAR_TZ            optional, for timed events; default America/Los_Angeles
//
// Ids: phase/deadline/app-created events use an id derived from the Airtable record id, so there is no
// mapping table. Events imported from Google keep Google's id, stored in the event's "Google ID" field.
const crypto = require("crypto");
const { T, F, listAll, create, patch, del } = require("./_airtable");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const TZ = () => process.env.GOOGLE_CALENDAR_TZ || "America/Los_Angeles";
const ORPHAN_GRACE_MS = 5 * 60 * 1000; // never delete a Google event we wrote less than this ago (guards stale reads)
const TIME_BUDGET_MS = 6000;           // stop starting new work after this; the caller runs again if `more`
const MAX_OPS = 150;

function creds() {
  let email = process.env.GOOGLE_CLIENT_EMAIL, key = process.env.GOOGLE_PRIVATE_KEY;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) { try { const o = JSON.parse(raw); email = o.client_email || email; key = o.private_key || key; } catch {} }
  if (key) key = String(key).replace(/\\n/g, "\n");
  const cal = process.env.GOOGLE_CALENDAR_ID;
  return email && key && cal ? { email, key, cal } : null;
}
const isConfigured = () => !!creds();
const serviceEmail = () => { const c = creds(); return c ? c.email : ""; };

// ---- Free-form event validation (shared by create.js and update.js) -----------------------------
const validDate = (s) => DATE.test(String(s || "")) && !isNaN(new Date(s + "T00:00:00Z"));
// partial=true: only validate the keys present (an edit); otherwise title and date are required.
function cleanEvent(f, partial) {
  f = f || {}; const out = {};
  if (!partial || "title" in f) {
    const t = String(f.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!t) return { error: "An event needs a title." };
    out.title = t;
  }
  if (!partial || "date" in f) { if (!validDate(f.date)) return { error: "Pick a valid date." }; out.date = f.date; }
  if ("endDate" in f) { const v = f.endDate || ""; if (v && !validDate(v)) return { error: "That end date isn't valid." }; out.endDate = v || null; }
  for (const k of ["startTime", "endTime"]) {
    if (k in f) { const v = String(f[k] || "").trim(); if (v && !TIME.test(v)) return { error: "Times look like 14:30." }; out[k] = v; }
  }
  if ("kind" in f) out.kind = String(f.kind || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if ("notes" in f) out.notes = String(f.notes || "").slice(0, 2000);
  if (out.date && out.endDate && out.endDate < out.date) return { error: "The end date can't be before the start." };
  return { fields: out };
}

// ---- Dates ---------------------------------------------------------------------------------------
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const eventId = (kind, recId) => "megas" + Buffer.from(kind + ":" + recId, "utf8").toString("hex");
const sha = (o) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex").slice(0, 16);
const ms = (iso) => { const t = Date.parse(iso || ""); return isNaN(t) ? 0 : t; };

// "2026-12-01T14:00:00" (already local) or "...-08:00"/"Z" (converted into the calendar's time zone).
function localParts(s, tz) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(String(s || ""));
  if (!m) return null;
  if (!m[3]) return { date: m[1], time: m[2] };
  const d = new Date(s); if (isNaN(d)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}` };
}
// A Google event's (or one of our request bodies') span: first day, last day (inclusive) and times.
function gParse(ev, tz) {
  const st = ev && ev.start, en = ev && ev.end; if (!st) return null;
  if (st.date) {
    if (!validDate(st.date)) return null;
    let e = en && en.date ? addDays(en.date, -1) : st.date; if (e < st.date) e = st.date;
    return { s: st.date, e, st: "", et: "", allDay: true };
  }
  if (st.dateTime) {
    const a = localParts(st.dateTime, tz); if (!a) return null;
    const b = (en && en.dateTime && localParts(en.dateTime, tz)) || a;
    return { s: a.date, e: b.date < a.date ? a.date : b.date, st: a.time, et: b.time, allDay: false };
  }
  return null;
}
// The part of an item both sides can change, as a comparable string.
function semOf(ev, kind, tz) {
  const p = gParse(ev, tz); if (!p) return null;
  if (kind === "phase") return p.s + "|" + p.e;
  if (kind === "track") return p.s;
  return JSON.stringify([String((ev && ev.summary) || ""), p.s, p.e, p.st, p.et]);
}

// ---- The events the calendar should hold, from Airtable records -----------------------------------
// data = { tracks, albums, phases, members, events } raw Airtable records. Returns Map(googleId -> item).
function buildItems(data, appUrl) {
  const out = new Map(), tz = TZ();
  const link = appUrl ? "\n\nOpen the tracker: " + appUrl : "";
  const albumName = {}; (data.albums || []).forEach((a) => (albumName[a.id] = a.fields[F.album.title] || ""));
  const memberName = {}; (data.members || []).forEach((m) => (memberName[m.id] = m.fields[F.member.nickname] || m.fields[F.member.name] || "?"));
  const trackById = {}; (data.tracks || []).forEach((t) => (trackById[t.id] = t));
  const albumOf = (t) => (Array.isArray(t.fields[F.track.album]) ? t.fields[F.track.album] : []).map((x) => albumName[x]).filter(Boolean)[0];
  const put = (kind, recId, gid, summary, description, start, end, modifiedAt) => {
    const core = { summary: String(summary).slice(0, 250), description, start, end };
    const body = { ...core, id: gid, status: "confirmed" };
    out.set(gid, { gid, kind, recId, body, sig: sha(core), sem: semOf(body, kind, tz), modifiedAt });
  };

  (data.tracks || []).forEach((t) => {
    const due = t.fields[F.track.dueDate]; if (!validDate(due) || t.fields[F.track.onHold]) return;
    const al = albumOf(t);
    const bits = [al ? "Album: " + al : "", t.fields[F.track.stage] ? "Stage: " + t.fields[F.track.stage] : ""].filter(Boolean);
    put("track", t.id, eventId("track", t.id), "DEADLINE - " + (t.fields[F.track.title] || "Untitled"), bits.join("\n") + link, { date: due }, { date: addDays(due, 1) }, ms(t.fields[F.track.dueModified]));
  });

  (data.phases || []).forEach((p) => {
    const due = p.fields[F.phase.due]; if (!validDate(due)) return;
    if ((p.fields[F.phase.status] || "") === "Done") return;
    const tid = (Array.isArray(p.fields[F.phase.track]) ? p.fields[F.phase.track] : [])[0];
    const t = trackById[tid]; if (!t || t.fields[F.track.onHold]) return;
    let start = p.fields[F.phase.start]; if (!validDate(start) || start > due) start = due;
    const owners = (Array.isArray(p.fields[F.phase.owner]) ? p.fields[F.phase.owner] : []).map((x) => memberName[x]).filter(Boolean);
    const label = p.fields[F.phase.phase] || p.fields[F.phase.name] || "Phase", al = albumOf(t);
    put("phase", p.id, eventId("phase", p.id), label + " - " + (t.fields[F.track.title] || "Untitled") + (owners.length ? " (" + owners.join(", ") + ")" : ""),
      [al ? "Album: " + al : "", "Status: " + (p.fields[F.phase.status] || "Not started"), owners.length ? "Owner: " + owners.join(", ") : ""].filter(Boolean).join("\n") + link,
      { date: start }, { date: addDays(due, 1) }, ms(p.fields[F.phase.modified]));
  });

  (data.events || []).forEach((e) => {
    const date = e.fields[F.event.date]; if (!validDate(date)) return;
    const gid = String(e.fields[F.event.googleId] || "").trim() || eventId("event", e.id);
    const imported = !!String(e.fields[F.event.googleId] || "").trim();
    const endDate = validDate(e.fields[F.event.endDate]) && e.fields[F.event.endDate] >= date ? e.fields[F.event.endDate] : date;
    const st = String(e.fields[F.event.startTime] || "").trim(), et = String(e.fields[F.event.endTime] || "").trim();
    const desc = [e.fields[F.event.kind] ? "Kind: " + e.fields[F.event.kind] : "", e.fields[F.event.notes] || ""].filter(Boolean).join("\n") + (imported ? "" : link);
    const title = e.fields[F.event.title] || "Event";
    const mod = ms(e.fields[F.event.modified]);
    if (TIME.test(st)) {
      let end;
      if (TIME.test(et) && (endDate > date || et > st)) end = { dateTime: endDate + "T" + et + ":00", timeZone: tz };
      else { const h = Number(st.slice(0, 2)); end = { dateTime: (h === 23 ? addDays(date, 1) : date) + "T" + String((h + 1) % 24).padStart(2, "0") + st.slice(2) + ":00", timeZone: tz }; }
      put("event", e.id, gid, title, desc, { dateTime: date + "T" + st + ":00", timeZone: tz }, end, mod);
    } else put("event", e.id, gid, title, desc, { date }, { date: addDays(endDate, 1) }, mod);
  });
  return out;
}

// ---- Deciding what to do ---------------------------------------------------------------------------
const priv = (g) => (g && g.extendedProperties && g.extendedProperties.private) || {};
const isOurs = (g) => !!g && (String(g.id || "").startsWith("megas") || priv(g).megas === "1");

// One item vs its Google event (or null). Returns an action, or null when already in sync.
//   ctx = { tz, checkMissing }   checkMissing: a free-form event absent from the list must be looked up
//   by id first, because "never synced" and "deleted in Google" look the same in a list.
function decide(it, g, ctx) {
  if (!g) return it.kind === "event" && ctx.checkMissing ? { t: "check", it } : { t: "push", it, mode: "create" };
  if (g.status === "cancelled") return it.kind === "event" ? { t: "appdelete", it } : { t: "push", it, mode: "replace" };
  const p = priv(g);
  const gs = semOf(g, it.kind, ctx.tz);
  const base = p.base !== undefined ? p.base : it.sem; // untracked yet: assume both sides agreed
  const appCh = it.sem !== base, gCh = gs !== null && gs !== base;
  if (gCh && !appCh) return { t: "pull", it, g, gs };
  if (gCh && appCh) {
    if (gs === it.sem) return { t: "props", it, gs };                       // same change on both sides
    return it.modifiedAt > ms(g.updated) ? { t: "push", it, mode: "update" } : { t: "pull", it, g, gs }; // latest edit wins
  }
  if (appCh) return { t: "push", it, mode: "update" };
  if (p.megas !== "1" || p.sig !== it.sig) return { t: "push", it, mode: "update" }; // cosmetic change, or take over
  return null;
}

// A native Google event we may import as an app event, or null.
function importable(g, tz) {
  if (!g || g.status === "cancelled") return null;
  if (g.recurrence || g.recurringEventId) return null;
  if (g.eventType && g.eventType !== "default") return null;
  const p = gParse(g, tz); if (!p) return null;
  const title = String(g.summary || "").replace(/\s+/g, " ").trim().slice(0, 120) || "(no title)";
  return { g, p, title, notes: String(g.description || "").slice(0, 2000) };
}

// Everything to do for one sync pass (pure; no network). `googleList` = events from the calendar window.
function planSync(items, googleList, ctx) {
  const byId = new Map(googleList.map((g) => [g.id, g]));
  const actions = []; let unchanged = 0;
  items.forEach((it) => { const a = decide(it, byId.get(it.gid), ctx); if (a) actions.push(a); else unchanged++; });
  // Events this app manages that no longer correspond to anything in the tracker.
  const orphans = googleList.filter((g) => g.status !== "cancelled" && isOurs(g) && !items.has(g.id)
    && !(priv(g).at && ctx.now - Number(priv(g).at) < ORPHAN_GRACE_MS));
  const ours = googleList.filter((g) => g.status !== "cancelled" && isOurs(g)).length;
  let guard = "";
  if (orphans.length > 10 && orphans.length > ours * 0.6) guard = `Refused to delete ${orphans.length} of ${ours} Google events because the tracker looked almost empty. Check that Airtable is reachable, then sync again.`;
  else orphans.forEach((g) => actions.push({ t: "gdelete", id: g.id }));
  // New events created in Google.
  const fresh = [];
  googleList.forEach((g) => { if (!isOurs(g) && !items.has(g.id)) { const c = importable(g, ctx.tz); if (c) fresh.push(c); } });
  for (let i = 0; i < fresh.length; i += 10) actions.push({ t: "import", batch: fresh.slice(i, i + 10) });
  return { actions, unchanged, guard };
}

// ---- Google API ---------------------------------------------------------------------------------
const pause = (n) => (typeof setTimeout === "function" ? new Promise((r) => setTimeout(r, n)) : Promise.resolve());
const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let tokenCache = { tok: "", exp: 0 };
async function accessToken(c) {
  if (tokenCache.tok && tokenCache.exp > Date.now() + 60000) return tokenCache.tok;
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64u(JSON.stringify({ iss: c.email, scope: "https://www.googleapis.com/auth/calendar.events", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = b64u(crypto.createSign("RSA-SHA256").update(head + "." + claim).sign(c.key));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + head + "." + claim + "." + sig,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Google sign-in failed: " + (j.error_description || j.error || r.status) + ". Check the service account key.");
  tokenCache = { tok: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.tok;
}
function googleApi(c) {
  const base = "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(c.cal) + "/events";
  // Google throttles bursts of writes ("Rate Limit Exceeded"); retry with a growing pause, then give up
  // quietly (e.rateLimited) so the caller can carry on with the rest on the next pass.
  const call = async (method, path, body) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(base + path, { method, headers: { Authorization: "Bearer " + (await accessToken(c)), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 204) return {};
      const j = await r.json().catch(() => ({}));
      if (r.ok) return j;
      const text = ((j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || "") + " " + ((j.error && j.error.message) || "");
      const limited = r.status === 429 || (r.status === 403 && /rate\s?limit|quota/i.test(text));
      if ((limited || r.status >= 500) && attempt < 3) { await pause(700 * 2 ** attempt + Math.random() * 300); continue; }
      const e = new Error(((j.error && j.error.message) || "Google error " + r.status)); e.status = r.status; e.rateLimited = limited; throw e;
    }
  };
  return {
    // Everything in the sync window, including deleted events (status "cancelled").
    async list(timeMin, timeMax) {
      const items = []; let page = "";
      do {
        const j = await call("GET", "?maxResults=2500&showDeleted=true&singleEvents=false&timeMin=" + encodeURIComponent(timeMin) + "&timeMax=" + encodeURIComponent(timeMax) + (page ? "&pageToken=" + encodeURIComponent(page) : ""));
        (j.items || []).forEach((it) => items.push(it)); page = j.nextPageToken || "";
      } while (page);
      return items;
    },
    async get(id) { try { return await call("GET", "/" + encodeURIComponent(id)); } catch (e) { if (e.status === 404) return null; throw e; } },
    insert: (body) => call("POST", "", body),
    patch: (id, body) => call("PATCH", "/" + encodeURIComponent(id), body),
    replace: (id, body) => call("PUT", "/" + encodeURIComponent(id), body),
    remove: async (id) => { try { await call("DELETE", "/" + encodeURIComponent(id)); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; } },
  };
}

// ---- Applying a plan ------------------------------------------------------------------------------
// A PATCH merges nested objects, so when an event flips between all-day and timed the old form must be cleared.
function clearOther(body) {
  const fix = (x) => (x.date ? { date: x.date, dateTime: null, timeZone: null } : { dateTime: x.dateTime, timeZone: x.timeZone, date: null });
  return { ...body, start: fix(body.start), end: fix(body.end) };
}
const propsFor = (now, base, sig) => ({ extendedProperties: { private: { megas: "1", base: String(base), sig, at: String(now) } } });
function appFieldsFromGoogle(it, p, summary) {
  if (it.kind === "phase") return { table: T.phases, fields: { [F.phase.start]: p.s, [F.phase.due]: p.e } };
  if (it.kind === "track") return { table: T.tracks, fields: { [F.track.dueDate]: p.s } };
  const title = String(summary || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const f = { [F.event.date]: p.s, [F.event.endDate]: p.e > p.s ? p.e : null, [F.event.startTime]: p.allDay ? "" : p.st, [F.event.endTime]: p.allDay ? "" : p.et };
  if (title) f[F.event.title] = title;
  return { table: T.events, fields: f };
}

// deps = { api, air: {create, patch, del}, tz, now }. Runs actions in small parallel batches.
async function applyPlan(plan, deps, stat, t0) {
  const { api, air, tz } = deps;
  const run = async (a) => {
    try {
      if (a.t === "check") { const g = await api.get(a.it.gid); const next = decide(a.it, g, { tz, checkMissing: false }); if (!next) { stat.unchanged++; return; } return run(next); }
      if (a.t === "push") {
        const body = { ...a.it.body, ...propsFor(deps.now, a.it.sem, a.it.sig) };
        if (a.mode === "update") { await api.patch(a.it.gid, clearOther(body)); stat.updated++; return; }
        if (a.mode === "replace") { await api.replace(a.it.gid, body); stat.created++; return; }
        try { await api.insert(body); } catch (e) { if (e.status === 409) await api.replace(a.it.gid, body); else throw e; } // id left behind by a deleted event
        stat.created++; return;
      }
      if (a.t === "props") { await api.patch(a.it.gid, propsFor(deps.now, a.gs, "synced")); stat.unchanged++; return; }
      if (a.t === "pull") {
        const p = gParse(a.g, tz); if (!p) return;
        const w = appFieldsFromGoogle(a.it, p, a.g.summary);
        await air.patch(w.table, [{ id: a.it.recId, fields: w.fields }], true);
        await api.patch(a.it.gid, propsFor(deps.now, a.gs, "pulled")); // sig differs on purpose: next pass refreshes titles from the app
        stat.pulled++; return;
      }
      if (a.t === "appdelete") { await air.del(T.events, [a.it.recId]); stat.removed++; return; }
      if (a.t === "gdelete") { await api.remove(a.id); stat.deleted++; return; }
      if (a.t === "import") {
        const recs = a.batch.map((c) => ({ fields: { [F.event.title]: c.title, [F.event.date]: c.p.s, ...(c.p.e > c.p.s ? { [F.event.endDate]: c.p.e } : {}), ...(c.p.allDay ? {} : { [F.event.startTime]: c.p.st, [F.event.endTime]: c.p.et }), ...(c.notes ? { [F.event.notes]: c.notes } : {}), [F.event.googleId]: c.g.id } }));
        await air.create(T.events, recs);
        stat.imported += recs.length;
        // Take over the Google event (marker + agreed state) so later edits are tracked.
        await Promise.all(a.batch.map((c) => api.patch(c.g.id, propsFor(deps.now, semOf(c.g, "event", tz), "imported")).catch((e) => stat.errors.push("Couldn't tag imported event: " + String(e.message || e).slice(0, 100)))));
        return;
      }
    } catch (e) {
      if (e.rateLimited) { stat.throttled = (stat.throttled || 0) + 1; stat.more = true; return; } // not an error: finish on the next pass
      stat.errors.push(String(e.message || e).slice(0, 160));
    }
  };
  const weight = (a) => (a.t === "import" ? a.batch.length : 1);
  const order = { pull: 0, appdelete: 1, push: 2, props: 2, check: 3, gdelete: 4, import: 5 };
  const todo = plan.actions.slice().sort((x, y) => order[x.t] - order[y.t]);
  let used = 0;
  for (let i = 0; i < todo.length; ) {
    if (used >= MAX_OPS || Date.now() - t0 > TIME_BUDGET_MS) { stat.more = true; break; }
    const batch = [];
    while (i < todo.length && batch.length < 3) { used += weight(todo[i]); batch.push(todo[i++]); }
    await Promise.all(batch.map(run));
    if (stat.throttled) { stat.more = true; break; } // Google asked us to slow down: stop here, resume next pass
    if (i < todo.length) await (deps.pause || pause)(400);
  }
  return stat;
}

// Remove duplicate event records that point at the same Google event (two syncs importing at once).
async function dedupeImported(events, air) {
  const seen = new Map(), dupes = [];
  events.slice().sort((a, b) => String(a.createdTime || "").localeCompare(String(b.createdTime || ""))).forEach((e) => {
    const gid = String(e.fields[F.event.googleId] || "").trim(); if (!gid) return;
    if (seen.has(gid)) dupes.push(e.id); else seen.set(gid, e.id);
  });
  if (dupes.length) await air.del(T.events, dupes);
  return events.filter((e) => !dupes.includes(e.id));
}

// One sync pass. deps are injectable for tests; the default talks to Airtable and Google.
async function runSync(deps, appUrl) {
  const t0 = Date.now(), tz = deps.tz || TZ(), now = deps.now || Date.now();
  const data = await deps.load();
  data.events = await dedupeImported(data.events || [], deps.air);
  const items = buildItems(data, appUrl);
  const day = 864e5;
  let list;
  try { list = await deps.api.list(new Date(now - 45 * day).toISOString(), new Date(now + 3 * 365 * day).toISOString()); }
  catch (e) {
    if (e.status === 404) throw new Error("Google can't find that calendar. Check GOOGLE_CALENDAR_ID, and share the calendar with " + deps.email + " (permission: Make changes to events).");
    if (e.status === 403) throw new Error("Google refused access. Share the calendar with " + deps.email + " with the permission 'Make changes to events' (and enable the Google Calendar API for the project).");
    throw e;
  }
  const plan = planSync(items, list, { tz, now, checkMissing: true });
  const stat = { created: 0, updated: 0, deleted: 0, pulled: 0, imported: 0, removed: 0, unchanged: plan.unchanged, more: false, errors: [], total: items.size };
  if (plan.guard) stat.errors.push(plan.guard);
  await applyPlan(plan, { ...deps, tz, now }, stat, t0);
  return stat;
}

async function syncAll(appUrl) {
  const c = creds(); if (!c) throw new Error("Google Calendar isn't set up yet.");
  const api = googleApi(c);
  return runSync({
    api, email: c.email, air: { create, patch, del },
    load: async () => {
      const [tracks, albums, phases, members, events] = await Promise.all([T.tracks, T.albums, T.phases, T.members, T.events].map((t) => listAll(t)));
      return { tracks, albums, phases, members, events };
    },
  }, appUrl);
}

module.exports = { googleApi, isConfigured, serviceEmail, cleanEvent, buildItems, decide, planSync, applyPlan, runSync, syncAll, eventId, addDays, gParse, semOf, importable };
