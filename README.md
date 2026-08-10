# The Megas — Album Tracker

A TRACKIT-style board for the band's albums, backed by the **The Megas** Airtable base
(`app8R88gFzgjBftgo`). Deploys to Vercel; any band member opens the URL, signs in with the
shared band password, and sees live data.

## What it does

- **Tracks board** — Kanban columns for the pipeline: Idea → Writing → Demo → **Production** →
  Mixing → Mastering → Released. Drag a card to move a stage.
- **Production gate** — a track in Production shows a 5-segment meter (Drums, Bass, Guitars,
  Vocals, Synth & Sound Design). It **can't move to Mixing until all five phases are Done**
  (enforced client- and server-side).
- **Who's Up Next** — every member with their outstanding phases (the "responsible for the next
  step" view).
- **Albums board** — each album as a card with rolled-up progress.
- **Calendar** — track due dates on a month grid.
- **Detail drawer** — click a track to edit stage, BPM, key, due date, notes, and each phase's
  status + owner; view links and lyrics.
- **Inspired By** — the game/IP each song draws from, shown on every card.
- **Preview Album** — an ordered tracklist with a Play-All that runs through the whole album.
- **Timestamped feedback** — pin notes to a moment in a song (Frame.io-style), tagged to the member
  (set once via the person icon, saved on the device), toggled Open → Resolved. Click a timestamp to
  seek there. Open-note counts show on cards.
- **Version history** — reads the live Dropbox folder; the top-level file is the current bounce,
  older ones (in `PREVIOUS VERSIONS`) are listed per track with play links.
- **Lyrics editor + teleprompter** — structured sections (Verse/Chorus/Pre-Chorus/Breakdown/VO/…,
  add/reorder/rename), plus a full-screen teleprompter with adjustable font, auto-scroll speed, and
  section jumps for tracking vocals.

**Reusing the Project Tracker's Dropbox credentials:** the same `DROPBOX_APP_KEY` /
`DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` work here. The songs folder path is built in as a
fallback, so you don't even need `DROPBOX_SHARED_LINK` unless the folder moves. Required scopes:
`files.metadata.read` + `files.content.read` (the tracker already has these).

## Environment variables (set these in Vercel)

| Variable         | Required | What it is |
|------------------|----------|------------|
| `AIRTABLE_TOKEN` | yes      | Airtable Personal Access Token (see below). Never exposed to the browser. |
| `AIRTABLE_BASE`  | no       | Defaults to `app8R88gFzgjBftgo` (The Megas). |
| `APP_PASSWORD`   | yes      | The shared password band members type to sign in. If left blank, the site is open. |
| `AUTH_SECRET`    | yes      | Any long random string — signs the login cookie. |
| `DROPBOX_SHARED_LINK` | for playlist | The shared link to the "Songs in Progress" folder. |
| `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` | for playlist | Permanent Dropbox access (see Playlist setup). |
| `DROPBOX_TOKEN`  | optional | A short-lived Dropbox token for quick testing instead of the refresh-token trio (expires ~4h). |

## Playlist (Dropbox) setup

The player reads the shared folder **live** at play time, matches each file to a track by its
leading number (`02_Vampire Killer_v01.aif` → track 2), and always uses the **newest** version.
The `PREVIOUS VERSIONS` subfolder is ignored.

To let the deployed app read Dropbox, create an app + refresh token once:
1. dropbox.com/developers/apps → **Create app** → Scoped access → **Full Dropbox** (or the app folder
   that contains the songs) → name it. Copy the **App key** and **App secret**.
2. In the app's **Permissions** tab, enable: `files.metadata.read`, `files.content.read`,
   `sharing.read`. Submit.
3. Get a refresh token (one-time). In a browser, visit:
   `https://www.dropbox.com/oauth2/authorize?client_id=YOUR_APP_KEY&response_type=code&token_access_type=offline`
   Approve, copy the code, then exchange it (run in a terminal):
   ```bash
   curl https://api.dropbox.com/oauth2/token \
     -d code=PASTE_CODE -d grant_type=authorization_code \
     -u YOUR_APP_KEY:YOUR_APP_SECRET
   ```
   Copy the `refresh_token` from the response.
4. In Vercel, set `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`, and
   `DROPBOX_SHARED_LINK` (the folder link). Redeploy.

**Format note:** MP3 and WAV play in all browsers. **AIFF (`.aif`) does not play in Chrome** (it
works in Safari). For cross-browser playback, drop MP3 bounces into the folder — the app will pick
them up automatically. Tracks with no audio file simply show no play button.

### Create the Airtable token

1. Go to **airtable.com → Builder hub → Personal access tokens → Create token**.
2. Scopes: `data.records:read`, `data.records:write`, `schema.bases:read`.
3. Access: add the **The Megas** base.
4. Copy the token (starts with `pat…`) into `AIRTABLE_TOKEN`.

## Deploy to Vercel

**Option A — Git + Vercel dashboard (recommended)**
1. Push this folder to a new GitHub repo.
2. vercel.com → **Add New → Project** → import the repo.
3. Framework preset: **Other** (it's static + serverless functions, no build step).
4. Add the four env vars above → **Deploy**.
5. (Optional) add a custom domain, e.g. `music.gunslingersla.com`, under Project → Domains.

**Option B — Vercel CLI**
```bash
npm i -g vercel
cd album-tracker
vercel            # follow prompts to link/create the project
vercel env add AIRTABLE_TOKEN
vercel env add APP_PASSWORD
vercel env add AUTH_SECRET
vercel --prod
```

## Local development
```bash
npm i -g vercel
vercel dev        # serves the static files + /api functions locally
```
Create a `.env.local` with the same variables for local runs.

## Files
```
album-tracker/
  index.html      # the board UI
  login.html      # shared-password sign-in
  styles.css      # THEME — all colors/gradient/stroke live in the :root block at the top
  app.js          # all frontend logic (board, drag & drop, gate, drawer, calendar)
  api/
    _airtable.js  # Airtable REST layer + table/field IDs
    _auth.js      # shared-password cookie gate
    data.js       # GET  /api/data  → whole board as JSON
    update.js     # POST /api/update → edit track/phase/album (enforces the gate)
    create.js     # POST /api/create → new album / track (+ auto 5 phases) / member
    delete.js     # POST /api/delete → remove a track (+ phases) or empty album
    login.js      # POST /api/login, GET status
    logout.js     # POST /api/logout
    _dropbox.js   # Dropbox access (live folder read, newest version per track)
    playlist.js   # GET  /api/playlist → fresh streaming URLs matched to tracks
    versions.js   # GET  /api/versions?order=N → all versions of a track (current + previous)
  vercel.json
  package.json
```

## Theme
Matched to the Project Tracker's **dark** theme: magenta accent `#e5399f`, near-black `#0a0a0e`
base, purple-tinted panels, and the tracker's signature card treatment (top sheen + purple corner
glow + diagonal light-edge stroke via `--card-stroke-gradient`). All values live in the `:root`
block at the top of `styles.css`. Dark mode is the default and only theme.
