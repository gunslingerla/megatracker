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

## Environment variables (set these in Vercel)

| Variable         | Required | What it is |
|------------------|----------|------------|
| `AIRTABLE_TOKEN` | yes      | Airtable Personal Access Token (see below). Never exposed to the browser. |
| `AIRTABLE_BASE`  | no       | Defaults to `app8R88gFzgjBftgo` (The Megas). |
| `APP_PASSWORD`   | yes      | The shared password band members type to sign in. If left blank, the site is open. |
| `AUTH_SECRET`    | yes      | Any long random string — signs the login cookie. |

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
    login.js      # POST /api/login, GET status
    logout.js     # POST /api/logout
  vercel.json
  package.json
```

## Theme
Matched to the Project Tracker's **dark** theme: magenta accent `#e5399f`, near-black `#0a0a0e`
base, purple-tinted panels, and the tracker's signature card treatment (top sheen + purple corner
glow + diagonal light-edge stroke via `--card-stroke-gradient`). All values live in the `:root`
block at the top of `styles.css`. Dark mode is the default and only theme.
