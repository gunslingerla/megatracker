const { PASSWORD, isAuthed, setAuthCookie } = require("./_auth");

module.exports = async (req, res) => {
  if (req.method === "GET") {
    return res.status(200).json({ authed: isAuthed(req), passwordRequired: !!PASSWORD });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const password = (body && body.password) || "";

  if (!PASSWORD || password === PASSWORD) {
    setAuthCookie(res);
    return res.status(200).json({ ok: true });
  }
  return res.status(401).json({ error: "wrong password" });
};
