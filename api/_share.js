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
module.exports = { sign, verify };
