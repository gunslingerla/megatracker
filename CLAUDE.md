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

## Hard constraints (read before adding files)

- **Max 12 serverless functions** (Vercel Hobby plan). Only files in `/api/` that do
  **not** start with `_` count. We are at exactly 12:
  `calendar.ics, create, data, delete, importdoc, login, logout, makefolders, playlist,
  update, upload, versions`.
  Shared code goes in `_`-prefixed helpers (`_airtable, _auth, _dropbox, _gcal, _share`) which
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
- `api/_gcal.js` — Google Calendar two-way sync: `cleanEvent` (event validation), `buildItems` (what Google should hold),
  `decide`/`planSync` (pure: what to push/pull/import/delete), `applyPlan`, `runSync`/`syncAll`. Triggered by
  `update.js` `entity:"gcalSync"`.
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
  **`start`** (first day; `due` is the last; optional, so a phase with no start is one day), and
  **`subtasks`** = JSON array `[{text, done, owner, note}]` where `note` is a linked
  feedback id (checking the subtask resolves that note).
- **events** — free-form calendar events (`T.events`/`F.event`): `Title`, `Date`, `End date`, `Start time`/`End time`
  (HH:MM text; blank = all-day), `Kind`, `Notes`, `Google ID` (set for events imported from Google), `Modified`
  (lastModifiedTime, for sync conflicts). Phases also have `Dates modified`, tracks `Due modified` (same purpose). CRUD via `create.js`/`update.js`/`delete.js` with `entity:"event"`
  (validated by `cleanEvent`).
- **members** — band members; `Default Phases` (which phases they own), `color`,
  `Scratchpad` (JSON `{current, history:[{t,text}]}`, per-member private notes).
- **feedback** = **notes** — timestamped comments on a song, **pinned to a bounce
  `version`** (the Dropbox bounce filename). `status` Open/Resolved, `author`,
  `Mixer Reviewed` (checkbox set by share links, distinct from Resolved), `Thread`
  (JSON `[{by, side:"band"|"share", text, at}]` — the reply conversation).
- **shares** — one login-free link: `Title` (also tags the sharee's replies), `Tracks`
  (JSON array of track ids), `Slug` (short/custom code for the URL),
  `Links` (JSON `[{label,url}]` — stems/deliverables folders shown as buttons at the top of the share page;
  sanitised to http(s) by `cleanLinks`/`parseLinks` in `_share.js`; saved by `shareCreate/shareUpdate` in
  `update.js`, returned by `mixRead` as `links` and on the board as `shares[].links`; edited in `shareEditor` in `app.js`,
  rendered by `renderLinks` in `mix.html`).

## Key behaviors / gotchas

- **Current version of a song** = the newest audio file in that song's Dropbox
  `.../PREFIX_NN_Title/Bounces/` folder. Project folders are matched to tracks by
  normalized title, **falling back to track number** when the folder name differs
  (e.g. folder `The Belmonts_06_Bloodlines` maps to track "Opposing Bloodlines"). See
  `fetchPlaylist` in `app.js` and `mixRead` in `api/data.js` — keep both in sync.
- **Notes are version-pinned.** The board/notes views show notes for the current bounce;
  older-version notes appear under a "Previous versions" twirl-down, and a "New version
  detected" banner offers to move still-open notes to the current bounce
  (`openVersionTransfer`).
- **Volume:** both players (the app's shared `#audio` bar and `mix.html`) have a volume slider + mute. State lives
  in localStorage `megasVolume` / `megasMuted` (shared by the app and share pages, applied on load, kept in sync via
  `volumechange`). It's hidden when the browser won't let pages set `audio.volume` (iOS); detected, not UA-sniffed.
- **Loop:** both players have a loop toggle (`loopOn` / `#pLoop` in `app.js`, `#loop` in `mix.html`) that sets
  `audio.loop`. Session-only, not persisted; `playAlbum` turns it off because a looping song never fires `ended`.
- **Note markers:** the band player's seek bar shows a dot per timestamped (non-global) note on the current bounce
  (`renderMarkers`). Clicking one calls `locateNotes` (`app.js`): it finds the note rows (`.note-row`/`.fb-item`
  `[data-fb]`) in whichever list is visible, opens the notes bar if none is, scrolls to them and adds `.note-flash`;
  it does not move the playhead. `mix.html` has the same thing as a marker strip above its player
  (`renderStrip`, `.mk`, `.n.flash`). Redraws must keep scroll: `renderNotesBar` restores `.nb-list` scrollTop and
  `render()` restores window scroll when the view is unchanged.
- **Calendar / Gantt:** `calendarHTML` packs multi-day items (phase spans, multi-day events) into lanes per week row so
  bars stay level; dragging sends `kind:id:offset` so a bar moves by the day grabbed. `ganttHTML`/`wireGantt` draw one
  row per song with pointer-drag bars (move / resize start / resize due / deadline flag). Multi-select (`ganttSel`, keys `p:<phaseId>` / `t:<trackId>`; Shift/Cmd-click or a marquee) makes a drag
  move every selected item and saves them in one `update.js` `bulkdates` call. Zoom is continuous pixels-per-day
  (`ganttDW`, `setGanttZoom` keeps the day under the pointer fixed; Ctrl/Cmd+wheel and pinch).
  `ganttAutoScroll` scrolls while a drag or marquee is held near an edge (drag deltas include the scroll
  distance); the range adds 30 days before and 90 after the data, and scroll is restored by date so a range
  change after a drop doesn't jump the view. Calendar weeks start on Sunday (`calendarHTML`). `calMember`/`calSong`
  filters are shared by both views.
- **Google sync (two-way, `api/_gcal.js`):** the client triggers it (`scheduleGcalSync`, debounced, from `post()` for
  entities in `GCAL_WATCH`; also on load, every 5 min while open, and a Sync now button). Phase/deadline/app-created
  event ids derive from the Airtable record id (`eventId`); imported events keep Google's id in the event's
  `Google ID` field. Each Google event carries private props `megas=1`, `base` (the dates/title both sides agreed on),
  `sig` (hash of what we wrote) and `at` (when). A side "changed" when its semantic state (`semOf`) differs from
  `base`; one-sided changes copy across, a both-sided one is won by the later of Airtable's last-modified fields
  (`F.phase.modified`, `F.track.dueModified`, `F.event.modified`) vs Google's `updated`. Only `megas=1`/`megas...` events
  are ever deleted, with a 5-minute grace after our last write and a mass-delete guard. Free-form events missing from the
  list are looked up by id before deciding "never synced" vs "deleted in Google" (`check` action). Runs are capped by
  ops/time and report `more` so the client loops. Needs `GOOGLE_SERVICE_ACCOUNT_JSON` + `GOOGLE_CALENDAR_ID`; unset =
  feature hidden. The decision logic is tested against fake Google/Airtable stores; the HTTP calls are untested
  without real credentials.
- **Identity:** each browser picks "who am I" (stored in localStorage `megasMe`); a hard
  gate on first load (`pickIdentity(true)`) requires it before using the app.
- **Live sync (no websockets):** `app.js` polls — a 12s pass keeps an open notes bar
  current, a 60s pass refreshes the whole board. Both bail while the user is mid-edit and
  preserve scroll / drawer / in-progress note draft. Change detection via `fbSig`/`dataSig`
  (`dataSig` also covers phase start/due, song deadlines and events, so calendar/Gantt edits by others appear;
  anything new that a view shows must go in the signature or it only updates on refresh). `pollBusy` also holds
  off while a card, calendar item or Gantt bar/marquee is being dragged.
- **Share links:** `/mix?s=<slug>` (preferred; served from `mix.html` by Vercel
  `cleanUrls`) or `?t=<signed token>`. The mix page is login-free; it reads via
  `GET /api/data?mixslug=…`, checks off a note's `Mixer Reviewed`, and posts replies —
  all authorized by the slug/token resolving to a Shares record. `vercel.json` also has a
  `/s/:slug` rewrite, but links use `/mix?s=` so nothing depends on it.
- **Editing notes:** every note row has an Edit button (`editNoteBtn`/`startNoteEdit`/`wireNoteEdit` in `app.js`,
  shared by the Notes page, notes bar and modal) that edits `comment` and, for non-global notes, `timestamp` via
  `update.js` `feedback`. The server rejects empty text and bad times, and rewrites the note's `Name` when the time
  changes. Live sync (`fbSig`) hashes comment text so same-length edits sync, and polling skips while an editor is open.
- **Global notes:** a whole-song note (no timestamp). No Airtable field: it's encoded in the note's `Name`.
  All note naming lives in `_share.js` (`isGlobalName`, `guestNoteName`, `noteNameFor`, `guestNameOf`):
  band `Note @ m:ss` / global `GLOBAL_NOTE_NAME` ("Global note", in `_airtable.js`); guest
  `Guest: <title> @ m:ss` / global `Guest: <title> @ Global`. Band members tick "Global" when adding
  (`create.js` `fields.global`); guests too (`newNote` + `global`). Any note can be switched either way
  with `update.js` `feedback` + `fields.global` (rewrites only the Name; the stored timestamp is kept so
  switching back restores it; guest notes stay guest notes). `data.js` exposes `global` on the board and
  `mixRead`. The UI lists global notes first under a "Global" heading
  (`groupedNotesHTML`/`noteCmp` in `app.js`; same on `mix.html` and in the PDF), shows GLOBAL instead
  of a timecode, and skips them on the player's timeline markers. Notes stay pinned to a bounce version.
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
- **Member color on notes:** the author's name is tinted with their member `color` (hex) in note lists
  (`authorStyle` in `app.js`), on the share page (`mixRead` returns `authorColor`; `mix.html` `hexOk`), and in
  the PDF (`pdfInk` darkens it to stay readable on white). Non-hex values are ignored; guests have no color. Reply names (`th-by`) are tinted the same way: new band
  replies store `byId` (member id) in the thread entry; older ones are matched by name (display/nickname/name,
  case-insensitive). `mixRead` resolves this server-side and adds `byColor` to band thread entries.
- **Share-page PDF:** `mix.html` builds a per-song PDF client-side (`buildPdf`) with jsPDF 2.5.1,
  lazy-loaded from cdnjs with an SRI hash (`loadJsPdf`). It's the only external script in the
  standalone pages; if it fails to load we `window.print()` (there's a small `@media print` block).
  jsPDF's built-in fonts are Latin-1 only, so `pdfClean` strips emoji/other characters.
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
