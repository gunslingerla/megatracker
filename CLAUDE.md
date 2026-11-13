# The Megas — Album Tracker

A private web app for the band **The Megas** to track album/song production, leave
timestamped notes on song bounces, manage assignments, and share login-free review
links with outside collaborators (mixers, etc.).

## Stack & hosting

- **Frontend:** vanilla HTML/CSS/JS, no build step, no framework. `index.html` + `app.js`
  (single large file) + `styles.css`. Extra standalone pages: `login.html`, `mix.html`
  (login-free share page), `scratch.html` (pop-out scratchpad).
- **Backend:** Vercel Node serverless functions in `/api/*.js`.
- **Data:** Airtable (base `app8R88gFzgjBftgo`) via REST, server-side PAT.
- **Audio:** Dropbox (song bounces), streamed via temporary links.
- **Deploy:** push to the connected GitHub repo → Vercel auto-builds. Static files are
  served directly; `/api/*.js` become functions.

## ⚠️ Hard constraints (read before adding files)

- **Max 12 serverless functions** (Vercel Hobby plan). Only files in `/api/` that do
  **not** start with `_` count. We are at exactly 12:
  `calendar.ics, create, data, delete, importdoc, login, logout, makefolders, playlist,
  update, upload, versions`.
  Shared code goes in `_`-prefixed helpers (`_airtable, _auth, _dropbox, _share`) which
  are NOT counted. **Do not add a new non-underscore `/api` file** — fold new endpoints
  into an existing one (usually `data.js` for reads, `update.js` for writes) via an
  `entity`/action switch or a query-param branch.
- **Airtable is addressed by field ID, not name** (resilient to renames). All table and
  field IDs live in `api/_airtable.js` (the `T` and `F` maps) — that file is the schema
  source of truth. When you add an Airtable field, add its ID there.

## Environment variables (set in Vercel)

- `AIRTABLE_TOKEN` (required) — Airtable PAT, server-only.
- `AIRTABLE_BASE` (optional) — defaults to the base baked into `_airtable.js`.
- `APP_PASSWORD` (required) — shared band password for login. If blank, the app is open.
- `AUTH_SECRET` (required) — signs the login cookie AND the share-link tokens (`_share.js`).
- `DROPBOX_*` — `DROPBOX_REFRESH_TOKEN` + `DROPBOX_APP_KEY` + `DROPBOX_APP_SECRET`
  (preferred) or `DROPBOX_TOKEN`; plus folder/shared-link config. See `_dropbox.js`.
- `CAL_FEED_KEY` (optional) — guards the `calendar.ics` feed.

## File map

- `index.html` — app shell: topbar (left nav `›`, right menu `‹`), album strip, `#main`,
  drawers/modals, player bar, notes bar, scratchpad container.
- `app.js` — the whole SPA: data load, rendering per view, player, notes, drawers,
  live-sync polling, share manager, etc. (No modules; one IIFE-ish global scope.)
- `styles.css` — all styling; dark theme via CSS vars in `:root`. Mobile breakpoint
  mainly at `max-width: 760px`.
- `login.html` / `mix.html` / `scratch.html` — standalone pages (each self-contained).
- `api/_airtable.js` — table/field IDs + REST helpers (`listAll, getRecord, patch,
  create, del, uploadAttachment`) + `STAGES` + `PHASE_NAMES`.
- `api/_auth.js` — shared-password cookie auth (`requireAuth`, `isAuthed`, …).
- `api/_dropbox.js` — Dropbox access: `albumData` (per-album song folders + newest
  bounce), `projectVersions`, `tempLink`, `makeAlbumFolders`, etc.
- `api/_share.js` — HMAC sign/verify for login-free share tokens.
- `api/data.js` — returns the whole board as JSON (auth required). Also hosts the
  **login-free `mixRead`** branch (`?mixtoken=` or `?mixslug=`) for share pages.
- `api/update.js` — all writes (auth required) via `{entity, id, fields}`; plus bulk
  actions (`reassign`, `planphases`), share CRUD (`shareCreate/shareUpdate/shareDelete`),
  `noteReply`, and the **login-free** `mixReview`/`mixReply`/`mixAddNote`/`mixManage` branch (body has
  `mixtoken`/`mixslug`).
- `api/create.js` — creates tracks/albums/members/phases/feedback (+ auto-creates the
  production phases for a new track).
- `api/playlist.js` — per-album streaming URLs from Dropbox.
- `api/versions.js` — a song's bounce version history.
- `api/makefolders.js` — creates missing Dropbox project folders.
- `api/importdoc.js`, `api/upload.js` — doc import / art upload.
- `api/calendar.ics.js` — iCal feed of due dates.

## Data model (Airtable)

- **tracks** — song; `stage` (one of `STAGES`), `order` (track number), `album` link,
  `lyricsData` (JSON sections w/ optional highlight ranges), `onHold`, `art`, etc.
- **albums** — `dropboxFolder` (a Dropbox shared link or path) + `trackPrefix`
  (e.g. `The Belmonts`), `current` (is the active album).
- **phases** — production phases per track (`PHASE_NAMES`: Drums, Bass, Eric/Josh Guitar,
  Eric/Josh Vocals, Backing Vocals, Synth, Sound Design). `owner`, `due`, and
  **`subtasks`** = JSON array `[{text, done, owner, note}]` where `note` is a linked
  feedback id (checking the subtask resolves that note).
- **members** — band members; `Default Phases` (which phases they own), `color`,
  `Scratchpad` (JSON `{current, history:[{t,text}]}`, per-member private notes).
- **feedback** = **notes** — timestamped comments on a song, **pinned to a bounce
  `version`** (the Dropbox bounce filename). `status` Open/Resolved, `author`,
  `Mixer Reviewed` (checkbox set by share links, distinct from Resolved), `Thread`
  (JSON `[{by, side:"band"|"share", text, at}]` — the reply conversation).
- **shares** — one login-free link: `Title` (also tags the sharee's replies), `Tracks`
  (JSON array of track ids), `Slug` (short/custom code for the URL).

## Key behaviors / gotchas

- **Current version of a song** = the newest audio file in that song's Dropbox
  `.../PREFIX_NN_Title/Bounces/` folder. Project folders are matched to tracks by
  normalized title, **falling back to track number** when the folder name differs
  (e.g. folder `The Belmonts_06_Bloodlines` ↔ track "Opposing Bloodlines"). See
  `fetchPlaylist` in `app.js` and `mixRead` in `api/data.js` — keep both in sync.
- **Notes are version-pinned.** The board/notes views show notes for the current bounce;
  older-version notes appear under a "Previous versions" twirl-down, and a "New version
  detected" banner offers to move still-open notes to the current bounce
  (`openVersionTransfer`).
- **Identity:** each browser picks "who am I" (stored in localStorage `megasMe`); a hard
  gate on first load (`pickIdentity(true)`) requires it before using the app.
- **Live sync (no websockets):** `app.js` polls — a 12s pass keeps an open notes bar
  current, a 60s pass refreshes the whole board. Both bail while the user is mid-edit and
  preserve scroll / drawer / in-progress note draft. Change detection via `fbSig`/`dataSig`.
- **Share links:** `/mix?s=<slug>` (preferred; served from `mix.html` by Vercel
  `cleanUrls`) or `?t=<signed token>`. The mix page is login-free; it reads via
  `GET /api/data?mixslug=…`, checks off a note's `Mixer Reviewed`, and posts replies —
  all authorized by the slug/token resolving to a Shares record. `vercel.json` also has a
  `/s/:slug` rewrite, but links use `/mix?s=` so nothing depends on it.
- **Guest notes:** a sharee can also add brand-new notes (`mixAddNote` in `update.js`,
  body has `newNote: true, trackId, timestamp, text, version`). There's no member to link as
  author, so the note's `Name` field is set to `Guest: <share title> @ m:ss` and `data.js`
  (`guestOf`) reads that back as the author (the band sees "<title> (guest)"). The `version`
  is whatever bounce the guest's page was showing.
- **Editing/deleting mix comments:** a guest can edit/delete their *own* replies and guest notes
  (`op: editReply|deleteReply|editNote|deleteNote` → `mixManage` in `update.js`). "Own" = a thread
  entry with `side:"share"` and `by` equal to the link title (entries are identified by their `at`
  timestamp), or a note whose Name matches `isGuestNoteOf` (`_share.js`). A guest can't touch band
  replies, other links' replies, or band-authored notes, and can't delete a note anyone else has
  replied to. The band can delete any reply and edit band replies (`threadEdit`/`threadDelete`).
- **Auth bypass is deliberate and scoped:** the `mixRead`/`mixReview`/`mixReply`/`mixAddNote`/`mixManage`
  paths skip `requireAuth` ONLY when a valid share slug/token is present, and only ever touch
  (or create notes on) that share's tracks. Don't widen this.

## Conventions

- Prefer editing the existing files over adding new ones (function cap).
- Reference Airtable fields through `F.*`/`T.*` in `_airtable.js`, never by literal name.
- Frontend has no bundler: plain `<script src>` and global functions; keep it that way.
- `scratch.html`/`mix.html` are intentionally self-contained (inline CSS + JS) so they work
  standalone; they share localStorage keys (e.g. `megasMe`, `megasScratch:<id>`) with the app.
- Note: this project was built in chat and delivered as versioned zips (`album-tracker-vNN.zip`).
  In Claude Code just use git; ignore the version-zip workflow.
