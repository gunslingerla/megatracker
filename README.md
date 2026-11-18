# The Megas — Album Tracker

A private web app for the band **The Megas** to track album and song production, leave
timestamped notes on song bounces, manage assignments, and share login-free review links with
outside collaborators (mixers, etc.). Backed by the **The Megas** Airtable base, with song
bounces streamed from Dropbox. Deploys to Vercel; band members open the URL, sign in with the
shared band password, and pick who they are.

> Developer/AI-assistant notes (architecture, hard constraints, gotchas) live in
> [`CLAUDE.md`](CLAUDE.md). Read that before changing the code.

## What it does

Views (top tabs / side nav): **Dashboard · Preview Albums · Assignments · Notes · Band · Calendar**.

- **Dashboard** — Kanban board of the pipeline: Idea → Writing → Demo → **Production** → Mixing →
  Mastering → Released. Drag a card to change its stage. An album strip filters by album, and
  albums have their own cards with rolled-up progress.
- **Production gate** — a track in Production has one phase per instrument/role: Drums, Bass,
  Eric Guitar, Josh Guitar, Eric Vocals, Josh Vocals, Backing Vocals, Synth, Sound Design.
  It **can't move to Mixing until every phase is Done** (enforced client- and server-side;
  the server returns a `gate` error unless forced).
- **Assignments** — every member with their outstanding phases (who's up next). Members'
  **Default Phases** decide who owns which phase on new tracks, and a bulk "reassign" re-derives
  owners from that mapping. Phases have due dates and **subtasks**; a subtask can be linked to a
  note, and checking it resolves that note.
- **Notes (timestamped feedback)** — pin comments to a moment in a song (Frame.io-style), tagged
  to the member (the author's name is tinted with their member color, here, on share links and in the PDF), Open → Resolved. Click a timestamp to seek. Notes are **pinned to a bounce
  version** (the Dropbox filename): the current bounce's notes show by default, older versions sit
  under "Previous versions", and a "New version detected" banner offers to move still-open notes to
  the newest bounce. Notes also have a reply **thread** (band and share-link guests).
- **Editing notes** — every note (Notes page, notes bar, notes modal) has an **Edit** button: fix the wording
  and, for timestamped notes, the time. Handy for cleaning notes up before sending a link; the share page
  shows the change on its next refresh.
- **Global notes** — tick **Global** when adding a note (notes bar or the notes modal) to make it apply to
  the whole song instead of a moment in it. It ignores timestamps and is listed first, under its own
  "Global" heading, with a GLOBAL tag in place of a timecode. Global notes also appear
  that way on share links and in the PDF, and guests can add them too (Global checkbox next to
  "Add your own note"). Any existing note can be switched with its **→ Global** / **→ Timed** button;
  switching to global keeps the original time, so switching back restores it.
- **Preview Albums** — an ordered tracklist with Play-All through the whole album and a player
  bar with version history per track. Every player, in the app and on share links,
  has a volume slider with mute (remembered per browser; hidden on iPhones, which only allow hardware volume)
  and a loop button that repeats the current song until switched off (not remembered; "Play album" turns it off).
- **Share links** — create a titled, login-free link for a chosen set of songs
  (`/mix?s=<slug>`). The page always shows each song's *current* bounce and its notes (click a
  timecode to play from an adjustable pre-roll before it — default 3s, remembered per link in
  that browser); the guest
  can check off **Mixer Reviewed** (separate from the band's Resolved), reply on a note, and
  **add their own notes** at a timestamp (the time box follows the player). Replies and guest
  notes are tagged with the link's title; the band sees guest notes as "<title> (guest)".
  Guests can **edit or delete their own** replies and notes (not the band's, and a note
  the band has replied to can't be deleted). The band can delete any reply and edit band replies.
  Each song has a **Download PDF** button: a printable copy of that song's notes (checkbox,
  timecode, member name, comment and replies) for guests who prefer pen and paper. The PDF is
  built in the browser with jsPDF, loaded on demand from cdnjs (pinned version + integrity hash);
  if it can't load, the page falls back to the browser's Print dialog.
  Manage links from the share manager in the app.
- **Calendar** — track and phase due dates on a month grid, plus a read-only iCal feed to
  subscribe to from Google/Apple Calendar.
- **Detail drawer** — edit stage, BPM, key, due date, notes, owners, each phase's status/owner,
  reference/song links, art, and on-hold state.
- **Lyrics editor + teleprompter** — structured sections (Verse/Chorus/…), highlight ranges, and a
  full-screen teleprompter with adjustable font, auto-scroll speed, and section jumps.
- **Scratchpad** — a private per-member notepad with history (also available as a pop-out window).
- **Live sync** — no websockets; the app polls (12s for an open notes bar, 60s for the whole
  board) and skips refreshing while you're mid-edit.
- **Identity** — each browser picks "who am I" once (stored in `localStorage` as `megasMe`).
  There is only one shared password; identity is for attribution, not security.

## Environment variables (set in Vercel)

| Variable | Required | What it is |
|----------|----------|------------|
| `AIRTABLE_TOKEN` | yes | Airtable Personal Access Token (see below). Server-only, never sent to the browser. |
| `AIRTABLE_BASE` | no | Airtable base ID. Defaults to the base baked into `api/_airtable.js`. |
| `APP_PASSWORD` | yes | Shared band password. **If blank, the whole app is open.** |
| `AUTH_SECRET` | yes | Long random string. Signs the login cookie **and** the share-link tokens. If unset it falls back to a known default, which would let anyone forge cookies/tokens — always set it. |
| `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` | for audio | Permanent Dropbox access (preferred). See Dropbox setup. |
| `DROPBOX_TOKEN` | optional | A short-lived (~4h) Dropbox token for quick testing instead of the trio above. |
| `DROPBOX_SHARED_LINK` / `DROPBOX_FOLDER_PATH` | optional | Legacy single-folder config. Albums now carry their own Dropbox folder, so these are only a fallback (see `api/_dropbox.js`). |
| `CAL_FEED_KEY` | optional | If set, the `.ics` feed only responds to `/api/calendar.ics?key=THISVALUE`. If unset, the feed is reachable by anyone with the URL. |

Copy `.env.example` to `.env.local` for local runs. Never commit real values.

## Dropbox setup (song bounces)

Each **album** points at its own Dropbox folder (set on the album's panel: **Dropbox album folder**
+ **Project folder prefix**). Inside it, each song is a project folder named `PREFIX_NN_Name`
(e.g. `The Belmonts_01_Prologue`). The song's **current version** is the newest audio file in that
project's **`Bounces`** subfolder. Folders are matched to tracks by normalized title, falling back
to track number when the folder name differs. Folders that don't match the prefix/number pattern
are ignored. A track's detail drawer has a **Create this song's folder** button that makes the
`PREFIX_NN_Name/Bounces` folders for you (the API can also create all missing folders for an album).

To let the deployed app read Dropbox, create an app + refresh token once:
1. dropbox.com/developers/apps → **Create app** → Scoped access → **Full Dropbox** (or the app
   folder containing the songs) → name it. Copy the **App key** and **App secret**.
2. In the app's **Permissions** tab enable `files.metadata.read`, `files.content.read`,
   `sharing.read`, and `files.content.write` (only needed for creating song folders).
   Submit.
3. Get a refresh token (one-time). Visit in a browser:
   `https://www.dropbox.com/oauth2/authorize?client_id=YOUR_APP_KEY&response_type=code&token_access_type=offline`
   Approve, copy the code, then exchange it:
   ```bash
   curl https://api.dropbox.com/oauth2/token \
     -d code=PASTE_CODE -d grant_type=authorization_code \
     -u YOUR_APP_KEY:YOUR_APP_SECRET
   ```
   Copy the `refresh_token` from the response.
4. In Vercel, set `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`. Redeploy.

**Format note:** MP3 and WAV play in all browsers. **AIFF (`.aif`) does not play in Chrome**
(it works in Safari). For cross-browser playback, drop MP3 bounces into the folder — the app picks
them up automatically. Tracks with no audio file simply show no play button.

## Airtable token

1. **airtable.com → Builder hub → Personal access tokens → Create token**.
2. Scopes: `data.records:read`, `data.records:write`, `schema.bases:read`.
3. Access: add the **The Megas** base.
4. Copy the token (starts with `pat…`) into `AIRTABLE_TOKEN`.

The app addresses tables and fields by **ID**, not name, so renaming a field in Airtable won't
break it. All IDs live in `api/_airtable.js`; add new Airtable fields there.

## Google Calendar sync (one-way)

The Calendar view has a **Sync to Google Calendar** button that shows a subscribe URL
(`/api/calendar.ics`). In Google Calendar: **Other calendars → + → From URL**, paste it, Add
calendar. Due dates then appear as their own read-only calendar (Google refreshes every few
hours). Set `CAL_FEED_KEY` to keep the link private.

## Deploy to Vercel

1. Push to the connected GitHub repo — Vercel auto-builds. Static files are served directly and
   each `/api/*.js` becomes a serverless function. Framework preset: **Other** (no build step).
2. Set the environment variables above in Project → Settings → Environment Variables.
3. (Optional) add a custom domain under Project → Domains.

> **Function limit:** the Vercel Hobby plan allows 12 serverless functions and the project is at
> exactly 12. Files in `api/` starting with `_` don't count. Don't add a new non-underscore file in
> `api/` — fold new endpoints into an existing one (see `CLAUDE.md`).

## Local development

```bash
npm i -g vercel
vercel dev        # serves the static files + /api functions locally
```

Create `.env.local` with the variables above. There is no build step, bundler, or test suite.

## Files

```
index.html        # app shell: topbar, album strip, #main, drawers/modals, player + notes bars
app.js            # the whole SPA (data load, views, player, notes, drawers, live sync, share manager)
styles.css        # all styling; dark theme via CSS variables in :root
login.html        # shared-password sign-in
mix.html          # login-free share page (self-contained; served at /mix)
scratch.html      # pop-out scratchpad (self-contained)
vercel.json       # cleanUrls + /s/:slug rewrite
api/
  _airtable.js    # Airtable REST helpers + table/field IDs + STAGES + PHASE_NAMES (schema source of truth)
  _auth.js        # shared-password cookie auth
  _dropbox.js     # Dropbox access (album folders, newest bounce, version history, folder creation)
  _share.js       # HMAC sign/verify for share tokens
  data.js         # GET  /api/data      → whole board (also the login-free share read: ?mixslug= / ?mixtoken=)
  update.js       # POST /api/update    → all edits, bulk actions, share-link CRUD, note replies, login-free share review/reply
  create.js       # POST /api/create    → album / track (+ auto-creates all phases) / member / phase / feedback
  delete.js       # POST /api/delete    → track (+ its phases), phase, feedback, or an empty album
  login.js        # GET status / POST sign in
  logout.js       # POST sign out
  playlist.js     # GET  /api/playlist  → streaming URLs for an album's songs
  versions.js     # GET  /api/versions  → one song's bounce version history
  makefolders.js  # POST /api/makefolders → create missing Dropbox project folders
  importdoc.js    # GET  /api/importdoc → import lyrics from a link-shared Google Doc
  upload.js       # POST /api/upload    → album/track art into Airtable
  calendar.ics.js # GET  /api/calendar.ics → iCal feed of due dates
```

## Theme

Dark theme only. Magenta accent `#e5399f`, near-black base, purple-tinted panels. All colors live
in the `:root` block at the top of `styles.css`.
