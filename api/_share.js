// Signed, login-free share tokens for mixer review links.
// A token carries the list of {id, v} (track id + pinned bounce version) it grants
// read + check-off access to, signed with AUTH_SECRET so it can't be forged.
const crypto = require("crypto");
const SECRET = process.env.AUTH_SECRET || "change-me";

const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uDec = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();

function sign(payloadObj) {
  const p = b64u(JSON.stringify(payloadObj));
  const sig = b64u(crypto.createHmac("sha256", SECRET).update(p).digest());
  return p + "." + sig;
}
function verify(token) {
  if (!token || typeof token !== "string" || token.indexOf(".") < 0) return null;
  const [p, sig] = token.split(".");
  const expect = b64u(crypto.createHmac("sha256", SECRET).update(p).digest());
  if (sig !== expect) return null;
  try { return JSON.parse(b64uDec(p)); } catch { return null; }
}

// Note naming. There are no Airtable fields for "guest" or "global", so both live in a note's Name:
//   band note            "Note @ m:ss"                      band global   "Global note"
//   guest note           "Guest: <label> @ m:ss"            guest global  "Guest: <label> @ Global"
// (<label> is the share link's title.) These helpers keep write (update.js/create.js) and read
// (data.js) agreeing on the format, on which share a guest note belongs to, and on what is global.
const { GLOBAL_NOTE_NAME } = require("./_airtable");
const GUEST_NAME = /^Guest: (.+) @ (\d+:\d{2}|Global)$/;
function guestLabel(title) { return String(title || "").replace(/\s+/g, " ").trim().slice(0, 60) || "Guest"; }
function clockOf(ts) { ts = Math.max(0, Math.round(Number(ts) || 0)); return Math.floor(ts / 60) + ":" + String(ts % 60).padStart(2, "0"); }
function isGuestNoteOf(name, title) { const m = GUEST_NAME.exec(String(name || "")); return !!m && m[1] === guestLabel(title); }
function guestNameOf(name) { const m = GUEST_NAME.exec(String(name || "")); return m ? m[1] : ""; }
function isGlobalName(name) { const n = String(name || ""); return n === GLOBAL_NOTE_NAME || /^Guest: .+ @ Global$/.test(n); }
function guestNoteName(title, makeGlobal, ts) { return "Guest: " + guestLabel(title) + " @ " + (makeGlobal ? "Global" : clockOf(ts)); }
// The name a note should have after switching it to/from global; a guest note stays a guest note.
function noteNameFor(oldName, makeGlobal, ts) {
  const g = guestNameOf(oldName);
  if (g) return "Guest: " + g + " @ " + (makeGlobal ? "Global" : clockOf(ts));
  return makeGlobal ? GLOBAL_NOTE_NAME : "Note @ " + clockOf(ts);
}
// Extra links on a share page (stems / deliverables folders): JSON [{label,url}] in the share's Links field.
// Only http(s) URLs are kept, so a stored link can never become a javascript: URL on the share page.
function cleanLinks(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    let url = String((x && x.url) || "").trim();
    if (!url) continue;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
    let u; try { u = new URL(url); } catch { continue; }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    const label = String((x && x.label) || "").replace(/\s+/g, " ").trim().slice(0, 80) || u.hostname.replace(/^www\./, "");
    out.push({ label, url: u.href.slice(0, 1000) });
    if (out.length >= 20) break;
  }
  return out;
}
function parseLinks(raw) { try { return cleanLinks(JSON.parse(raw || "[]")); } catch { return []; } }
module.exports = { cleanLinks, parseLinks, sign, verify, guestLabel, isGuestNoteOf, guestNameOf, isGlobalName, guestNoteName, noteNameFor };
