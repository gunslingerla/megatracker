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

// Guest notes (added by a share-link guest) have no linked member, so the link title is stored
// in the note's Name as "Guest: <label> @ m:ss". These helpers keep write (update.js) and read
// (data.js) agreeing on that format, and on which share a guest note belongs to.
function guestLabel(title) { return String(title || "").replace(/\s+/g, " ").trim().slice(0, 60) || "Guest"; }
function isGuestNoteOf(name, title) {
  const pre = "Guest: " + guestLabel(title) + " @ ";
  const n = String(name || "");
  return n.startsWith(pre) && /^\d+:\d{2}$/.test(n.slice(pre.length));
}
module.exports = { sign, verify, guestLabel, isGuestNoteOf };
