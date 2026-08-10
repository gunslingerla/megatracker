// Lightweight shared-password gate so only the band sees the board.
// Set APP_PASSWORD (what the band types) and AUTH_SECRET (any random string) in Vercel env.
const crypto = require("crypto");

const PASSWORD = process.env.APP_PASSWORD || "";
const SECRET = process.env.AUTH_SECRET || "change-me";
const COOKIE = "megas_auth";

// The value we expect the auth cookie to hold once someone has logged in.
function expectedToken() {
  return crypto.createHmac("sha256", SECRET).update("ok:" + PASSWORD).digest("hex");
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function isAuthed(req) {
  // If no password is configured, the board is open (fine for local/dev).
  if (!PASSWORD) return true;
  return parseCookies(req)[COOKIE] === expectedToken();
}

function setAuthCookie(res) {
  const thirtyDays = 60 * 60 * 24 * 30;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${expectedToken()}; Path=/; Max-Age=${thirtyDays}; HttpOnly; SameSite=Lax; Secure`
  );
}

function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
}

function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

module.exports = { PASSWORD, requireAuth, isAuthed, setAuthCookie, clearAuthCookie, expectedToken };
