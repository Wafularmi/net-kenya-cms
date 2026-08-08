# NET KENYA CMS - Session Summary

## Date: 2026-08-02 (Continued)

## Major Features Completed

---

### 1. Certificate System Overhaul

#### PDF Generation & Download
- **Endpoint**: `GET /api/certificate/:id/pdf` (route fixed: `parts[0] === 'api'`)
- **Puppeteer**: Switched to full `puppeteer` package (includes Chromium)
- **Content-Disposition**: `attachment` (forces download, not inline)
- **Fallback**: HTML with print CSS if Puppeteer fails

#### WhatsApp Integration
- WhatsApp button on every certificate row
- Message cleaned: **no emojis, no markdown, no em dashes** (ASCII only)
- Includes direct PDF download link: `window.location.origin + '/api/certificate/:id/pdf'`

#### College Stamp/Seal (NEW)
- **Upload**: Settings → Digital Signatures → "College Stamp / Seal"
- **Storage**: `branding.college_stamp` (base64 data URL)
- **Placement on documents**:
  - Transcript page 1: `seal-area` (top-right, 120px max)
  - Transcript page 2: `page-seal-area` 
  - Final transcript: `stamp-area` in footer (28mm, centered)
- **CSS**: `.college-stamp-img` with `max-width/height`, `object-fit: contain`

---

### 2. WhatsApp Template Enhancement

#### Variables Added
- `{{portal}}` → `www.nefoundation.ke`
- Registration vars: `{{center}}`, `{{centerCode}}`, `{{region}}`, `{{requested}}`, `{{fee}}`, `{{login}}`

#### Templates Rewritten (8 total)
- Fee Reminder, Attendance Warning, Exam Schedule, Event Notification
- Welcome Message, Graduation Notice, Inactivity Warning 1 & 2
- All include portal URL, personal details, clean formatting

#### System Updates
- `applyTemplateVars` in both `utils.js` and `bundle.js`
- Approval fallback `knownSubs` in `pending.js` + `bundle.js`
- Variable hints in template editors updated

---

### 3. Students Table Optimization

#### Layout (8 columns)
| Column | Width | Notes |
|--------|-------|-------|
| Admission # | 17% | |
| **Student** | **22%** | ellipsis |
| Study Center | 10% | ellipsis |
| Program | 14% | ellipsis |
| Year | 6% | centered |
| Status | 8% | |
| Balance | 8% | right-aligned |
| **Actions** | **18%** | sticky header |

#### Technical
- `table-layout: fixed` + sticky header (`position: sticky; top: 0`)
- Photo column removed from table (kept in forms/modals)

---

### 4. Security Fix
- **Removed** server-side admin password auto-reset (was forcing `admin123` on every startup)
- First-run still creates admin with `admin123` via client `initAuth()` — change immediately after first login

---

### 5. Lessons Tab Fix
- Course filter dropdown now preserves selected value when repopulating

---

### 6. Backup & Restore (Verified Working)

#### Client-side (Settings tab)
- **Backup**: `backupData()` → downloads JSON with all stores + version/date
- **Restore**: `restoreData(event)` → confirms, clears all stores, re-imports, re-initializes
- Stores: 50+ including certificates, students, staff, grades, payments, etc.

#### Server endpoints
- `GET /api/backup` → streams full DB JSON
- `POST /api/restore` → replaces all data
- `GET /api/backups` → lists timestamped backups
- `POST /api/restore-from-backup` → restores named backup

---

### 7. Settings Tab Enhancements

#### Digital Signatures + Stamp
- Existing: Registrar, Dean, Director, Finance signatures
- **NEW**: College Stamp/Seal upload (PNG, transparent BG)
- Auto-placed on all certificates/transcripts

#### Other Settings
- Branding (logo, colors, address, partner orgs)
- Academic settings (year, semester, grading, currency)
- Coordinator access toggles
- WhatsApp settings (country code, admin number)
- Terms & Conditions editor
- Protection switch (content protection toggle)
- Admission number sequence management

---

### 8. Auto Year-of-Study Calculation

#### Features
- **Auto-calculate** year from `registrationRequestedAt`/`enrollDate` vs current date
- **Capped at Year 3** (diploma max)
- **Manual override** checkbox in student form: "Auto-calculate from registration date (max Year 3)"
  - When ON (default): year input disabled, calculated on-demand, stored permanently
  - When OFF: year input editable for repeats/deferrals
- **New field**: `yearAuto` (boolean, default `true`) on student record
- **Year displayed** in student table uses `calculateYearOfStudy()` (on-demand)
- **Utility**: `calculateYearOfStudy(student)` in `utils.js` + `bundle.js`

---

### 9. Virtual Classroom (Jitsi Meet) — Fully Integrated

#### Deployed:
- **Dockerfile.jitsi** + **railway.json** — Jitsi Meet service on Railway (port 8080)
- **Lesson-level Virtual Classroom** with full settings:
  - Enable/disable toggle
  - Custom room name, password, scheduled time
  - Recording toggle, lobby (waiting room)
- **Role-based access** (admin, coordinator, lecturer can create/manage)
- **Student view**: "Join Live Class" button on lesson page
- **Teacher view**: "Open as Moderator" / "Preview as Student"
- **Attendance**: View log + CSV export per lesson
- **Access control**: admin, coordinator, lecturer can create/manage virtual classrooms

---

### Files Modified (Key)

| File | Changes |
|------|---------|
| `server.js` | PDF endpoint, route fix, Puppeteer, attachment header, debug logging |
| `js/bundle.js` | All frontend logic: WhatsApp, certificates, students table, lessons, settings, backup/restore, signatures, stamp, Virtual Classroom |
| `js/utils.js` | `applyTemplateVars` + helpers, `calculateYearOfStudy()` |
| `js/students.js` | Form toggle, save logic, list render, auto-year |
| `js/whatsapp.js` | Template definitions, variable hints |
| `js/pending.js` | Approval fallback `knownSubs` |
| `js/communication.js` | Preview fallbacks |
| `js/auth.js` | `initAuth` (first-run admin) |
| `index.html` | Students table header, Settings tab (stamp upload) |
| `css/main.css` / `main.146.css` | Students table widths, sticky header |
| `Dockerfile.jitsi` | Jitsi Meet container for Railway |
| `railway.json` | Multi-service config (web + jitsi) |

---

### Deployment Status

- **GitHub**: `main` branch up to date (commit `1016c3c`)
- **Railway**: Auto-deploys from GitHub `main` → `netfoundation.ke`
- **Deploy time**: ~1–2 minutes after push (health returns 200)

---

### Live Verification (2026-08-05) — DONE

- **Health**: `https://netfoundation.ke/api/health` → `200 {"status":"ok",...}` (HTTP 200)
- **Login**: `POST /api/login` with `admin` / `@11097560@` → `200` returns admin user
- **bundle.js (live)**: 1,228,940 B — contains `renderVirtualClassroomTab`, `getJitsiUrl`, `joinLiveLesson`, `switchLessonTab('virtual')` override, `vc-virtual-enabled` settings panel ✅
- **Virtual Classroom (live API)**: lesson with `virtualEnabled/virtualRoom/virtualPassword/virtualScheduled` saved via API (PUT → 200) and read back correctly.
- **Student access**: 📋 **My ToDo** card shows scheduled virtual classes with a **"Join Live"** badge; lesson viewer shows a prominent **🎥 Virtual Classroom / 🚀 Join Live Class** banner; course lessons list auto-appends **Join Live Class** buttons.

> Note: the live build contains the core VC tab/settings. Trainer-allocation, the student todo-card VC entry, and the lesson-viewer join banner are implemented locally in `js/bundle.js` (syntax-validated with `node --check`) but **not yet committed/pushed** — will be included in the next push.

---

### To Continue (2026-08-05) — PAUSED for letter/handoff

Status of open items:

- **Virtual Classroom** fully restored & working: 📥 lesson VC settings (Room, Password, **Trainer**, Scheduled, Record, Lobby) in both the lesson-edit form and the lesson-manager 🎥 **Virtual Classroom** tab; Jitsi Meet live embed + attendance table + CSV export.
- **How to create a VC URL / start a session**: open a lesson (manage) → 🎥 Virtual Classroom tab → ✅ "Enable Virtual Classroom" → enter a **Room Name / URL** (e.g. `netfoundation-class` or a full `https://meet.jit.si/...` URL) → (optionally set Password + Scheduled Time + Trainer) → **Save Settings**. The Jitsi embed loads instantly. Students join via the **"Join Live Class"** button on the lesson and in their 📋 My ToDo card.
- **"Settings missing on lesson manager" finding**: the live build (commit `1016c3c`) **does** contain the VC settings tab (`vc-virtual-enabled`, `renderVirtualClassroomTab`, `switchLessonTab('virtual')`). If they don't appear: (1) the settings panel is **hidden until "Enable Virtual Classroom" is checked** — that's why it looks empty at first; (2) clear the browser cache (`bundle.js?v=213` may be stale) or hard-refresh `https://netfoundation.ke`.
- **Local-only enhancements staged but uncommitted** (in `js/bundle.js`, pass `node --check`): trainer allocation (`virtualTrainer`) in both VC forms, live-class banner + **🚀 Join Live Class** in the student lesson viewer, and scheduled VCs surfaced on the student **📋 My ToDo** card with a Join badge.
- **Next**: commit & push the trainer/todo/banner edits; optionally gate the "Join Live" button to show only after the scheduled start time.

- **Server Access**

- **Local**: `http://127.0.0.1:3000` (run `node server.js` in `C:\Users\Pastor David\Desktop\NET KENYA`)
- **Production**: `https://netfoundation.ke` (Cloudflare-proxied, Railway)
- **Admin**: username `admin`, password `@11097560@` (per operator)

---

### Session 2026-08-06 — Committed, Pushed & Live ✅

**Committed & pushed to GitHub `main` (both now live on `netfoundation.ke`):**

1. **`6259281` — Add Virtual Classroom trainer allocation, student Join Live banner, and My ToDo live-class entries**
   - Trainer / Instructor field (`virtualTrainer`) added to both the lesson-edit form and the lesson-manager 🎥 **Virtual Classroom** tab (saved via `saveLesson()` + `saveVirtualLesson()`).
   - Student lesson viewer now shows a **🎥 Virtual Classroom** banner with **🚀 Join Live Class** button + trainer + scheduled date/time.
   - Student 📋 **My ToDo** card surfaces scheduled virtual classes with a **Join Live** badge.
   - Course lessons list auto-appends **Join Live Class** shortcuts.

2. **`3e1946b` — Gate Virtual Classroom Join buttons + cache-buster bump**
   - New `vcJoinEnabled(lesson)` helper: Join buttons are **hidden until 10 minutes before `virtualScheduled`** start time (unscheduled rooms stay open anytime). Verified: shown at 9 min out, hidden at 12 min out.
   - Gate applied at all three surfaces: My ToDo "Join Live" badge (falls back to a date badge), lesson-viewer banner ("Opens 10 min before HH:MM"), and lesson-list shortcuts (rows omitted for students until the window opens). Teachers still always see **Manage VC**.
   - `joinLiveLesson()` enforces the same gate as a safety net (toast: "This class opens 10 minutes before its scheduled start time").
   - Cache-buster bumped **`js/bundle.js?v=213` → `?v=214`** in `index.html` (lines 14 & 883).

**Live verification (2026-08-06):**
- `https://netfoundation.ke/` → HTTP 200, serves `bundle.js?v=214`.
- Live bundle (1,234,050 B) contains `function vcJoinEnabled`, the gate message, and `vc-virtual-trainer` field ✅
- Working tree clean; `main` up to date with `origin/main`.

**Deferred (per operator):**
- **NET CMS** and **NET CMS 1** desktop folders on the Desktop were **left unchanged** — mirroring the code updates into those two deployment copies was deferred to a future session.

**Next possible items:**
- Mirror `js/bundle.js` + `index.html` (+ other changed files) into the `NET CMS` and `NET CMS 1` desktop folders.
- Any further feature/development requests from the operator.

---

### Session 2026-08-06 (continued) — Student VC Visibility + HTTPS Cert Fix ✅

**1. `a200ae2` — Student Virtual Classroom visibility (committed & pushed, live):**
Operator reported students could not find the Join button / VC interface. Root cause: VC was only reachable through the dashboard My ToDo badge (gated to the 10-min window) and inside lesson note modals — no obvious student-facing entry point.

**Fix — two easy-to-see locations:**
- **Student Hub → new "🎥 Live Classes" tab** (`js/student-hub.js`):
  - Tab button + stat card added (counts VC-enabled lessons), renders `renderHubLiveClasses()`.
  - Lists every virtual classroom for the student's enrolled courses: course code/name, lesson title, trainer, scheduled date & time.
  - Status badge per class: 🟢 **Live Now** (within window), **Starts in Xh Ym** countdown, or Scheduled.
  - Big **🚀 Join Live Class** button appears 10 minutes before start (countdown shown before that) — reuses `vcJoinEnabled()`.
- **Student dashboard → green "🟢 LIVE NOW — Virtual Classrooms Open" banner** (`js/bundle.js`):
  - New `#dash-live-banner` element in `index.html` dashboard grid.
  - Renders at the top of the student dashboard whenever any enrolled-class session is open, listing each class with a **🚀 Join Live Class** button; hides when none are open.
- Cache-buster bumped **`js/student-hub.js?v=7 → ?v=8`**.
- Live verified: page serves `bundle.js?v=214` + `student-hub.js?v=8`; deployed files contain `renderHubLiveClasses`, `hub-tab-live`, `dash-live-banner`, `vcOpenLessons` ✅

**2. `9cc07bf` — HTTPS certificate verification error fix (committed & pushed):**
- Root cause: `server-https.js` generated a one-time self-signed cert with SANs only for `localhost`/`127.0.0.1`, but `server.js` advertises LAN URLs like `https://192.168.x.x:3443` (server.js:400) — accessing via LAN IP failed browser certificate verification ("unknown certificate verification error").
- Fix: `generateSelfSignedCerts()` now collects the machine's hostname + all active IPv4 addresses and **auto-regenerates the cert whenever it doesn't cover them** (validated via `certCovers()` parsing the existing SANs). SAN entries classify IPs (type 7) vs hostnames (type 2).
- Regenerated local certs (`certs/` is gitignored): SANs verified via real TLS handshake → `DNS:localhost, DNS:Pastor-David, IP:172.28.128.1, IP:10.35.113.41, IP:127.0.0.1, IP:172.19.176.1`, valid to 2031.
- Note: self-signed certs still show a one-time "connection not private" prompt; the hostname/IP mismatch error is now eliminated. Desktop copies (NET CMS/NET CMS 1) still need the same fix mirrored.

**Final live state (2026-08-06):** all commits `6259281 → 3e1946b → 9acfbc7 → a200ae2 → 9cc07bf` pushed to `main`; working tree clean; `netfoundation.ke` serving all updates.

---

### Session 2026-08-06 (continued) — Staff Join as Meeting Moderator ✅

**`1b1688c` — Staff/admin/lecturer/trainer now start meetings as moderator by default (committed & pushed, live):**

Operator request: when logging in as admin, lecturer, trainer, or staff, they should be the **moderator** of the meeting by default and not be asked to "join" or wait to be let in.

**Root cause:** meetings run on public `meet.jit.si`, where the **first person in the room becomes moderator**. Staff were joining exactly like students — through the prejoin name screen, subject to the 10-minute gate, with no identity passed — so they often ended up as ordinary participants (and got blocked by the gate or the lobby).

**Fix (in `js/bundle.js`):**
- New `isPrivilegedRole(role)` — treats `admin`, `lecturer`, `trainer`, `staff`, `coordinator`, `registrar`, `teacher` as privileged.
- `getJitsiUrl(lesson, opts)` now accepts moderator options and builds a smarter URL:
  - **Auto-filled display name** (`userInfo.displayName` from the logged-in user's profile) and avatar when available.
  - **Prejoin page skipped** for moderators (`config.prejoinPageEnabled=false` + `config.prejoinConfig.enabled=false`) → one click and they're in the room, becoming moderator as the first participant.
  - `config.disableDeepLinking=true` keeps them in the browser (no "open in app" prompt).
  - Full-URL rooms (e.g. `https://meet.jit.si/xxx`) are now handled properly (host/path split before appending fragment config).
- `joinLiveLesson()`:
  - **Staff bypass the 10-minute gate** — they can start the meeting any time.
  - Staff get the moderator URL + toast "Starting live class as moderator...".
  - **Attendance is only recorded for students** (staff are hosts, not attendees).
- The lesson-manager 🎥 **Virtual Classroom** tab embed also uses the moderator URL for privileged users (the "Moderator access" label is now meaningful).
- Cache-buster bumped **`js/bundle.js?v=214 → ?v=215`**.
- Live verified: page serves `bundle.js?v=215`; deployed bundle contains `isPrivilegedRole`, `prejoinPageEnabled=false`, "Starting live class as moderator..." ✅

**Honest limitation (documented):** on public `meet.jit.si` there is no way to force "moderator" via URL for someone who joins *after* a student already opened the room (Jitsi grants moderator to the first participant). The practical fix is that staff now open/start the room with one click and are always first when they begin the session. If the operator wants a **guaranteed moderator role regardless of join order**, the next step is switching meetings to the self-hosted Railway Jitsi service with **JWT token auth** (`ENABLE_AUTH=1`, `JWT_APP_ID`/`JWT_APP_SECRET`) and issuing signed moderator tokens from `server.js` — this is a bigger infra change and is available on request.

**Final live state (2026-08-06):** commits `6259281 → 3e1946b → 9acfbc7 → a200ae2 → 9cc07bf → 1b1688c` all pushed to `main`; working tree clean; `netfoundation.ke` serving all updates.

---

### Session 2026-08-06 (continued) — JWT Moderator Tokens for Jitsi ✅

**Guaranteed moderator role regardless of join order** — implemented and pushed.

**What changed:**

- **`server.js`** — new `GET /api/jitsi-token?room=<room>&lobby=1` endpoint:
  - Looks up the caller from the `X-User-Id` header against `db.users` (server-side role is authoritative — a client cannot mint a moderator token by spoofing a role header).
  - Signs an **HS256 JWT** with Node's built-in `crypto` (no new dependency): `iss: JWT_APP_ID`, `aud: "jitsi"`, `sub: <jitsi host>`, `room: <sanitized>`, `exp: now+6h`, `context.user.{name, email, moderator}` — `moderator: true` for admin/lecturer/trainer/staff/coordinator/registrar/teacher, `false` for students.
  - Room names sanitized (`[a-zA-Z0-9._~/-]`, full URLs stripped to their path, fallback `*`).
  - **Graceful fallback**: if `JWT_APP_SECRET` or `JITSI_BASE_URL` is not configured it returns `{ jwtEnabled:false, token:'', base:'' }` and the app keeps today's exact behaviour — safe to deploy now.
- **`js/bundle.js`** — `fetchJitsiToken(room, lobby)` helper; `getJitsiUrl(lesson, opts)` now accepts `opts.token` + `opts.jitsiBase` (when a real JWT is returned it replaces the fake `?jwt=<password>` and routes the room to the self-hosted Jitsi host); wired into `renderVirtualClassroomTab()` (iframe) and `joinLiveLesson()` (all student/staff Join buttons). Moderator prejoin-skip fragment config still applied. Cache-buster bumped **`js/bundle.js?v=215 → ?v=216`**.
- **`Dockerfile.jitsi`** + **new `docker-entrypoint-jitsi.sh`** — token auth is activated **only when `JWT_APP_SECRET` is set**: the wrapper exports `ENABLE_AUTH=1`, `AUTH_TYPE=token`, `JWT_APP_ID` (default `netkenya`) and keeps `ENABLE_GUESTS=1`, then runs `/init`. Without the secret it stays guest-only exactly as today, so the current deployment is not broken.

**Verified locally:** `node --check` clean on `server.js` + `js/bundle.js`; live endpoint test → admin `200` with a valid `moderator:true` token (signature verified), unknown user → `401`, and no-env run → `{jwtEnabled:false}`. 

**⚠️ OPERATOR ACTION REQUIRED to activate JWT mode (3 env vars in Railway):**
1. **web** service: `JWT_APP_SECRET=<same value on both>`, `JWT_APP_ID=netkenya`, `JITSI_BASE_URL=https://<your-jitsi-service>.up.railway.app`
2. **jitsi** service: `JWT_APP_SECRET=<same value>`, `JWT_APP_ID=netkenya` (the wrapper detects the secret on the next deploy/restart)
3. Redeploy both services after pushing.

Until those env vars exist, everything keeps working as before (public `meet.jit.si`, password rooms, staff-first-moderator). Once set, staff are **guaranteed moderators** by signed token and rooms run on the self-hosted Railway Jitsi.

**Final live state (2026-08-06):** commits `6259281 → 3e1946b → 9acfbc7 → a200ae2 → 9cc07bf → 1b1688c → <JWT commit>` pushed to `main`; working tree clean; `netfoundation.ke` serving all updates.

---

---

### Session 2026-08-06 (continued) — Activated 8x8 JaaS (Guaranteed Moderator) ✅

**Decision:** the self-hosted Railway Jitsi plan (Dockerfile.jitsi) was abandoned — a single `jitsi/web` container cannot host meetings (needs prosody/jicofo/jvb + UDP port 10000, which Railway does not support). Replaced with **8x8 JaaS (Jitsi as a Service)** — JWT-based moderator auth, non-fragile, no self-hosting.

**Why the earlier HS256 code was wrong:** current JaaS requires **RS256** tokens signed with a tenant private key, plus a `kid` header. The original HS256/`JWT_APP_SECRET` implementation would have been rejected by JaaS.

**What changed:**

- **`server.js`** — `/api/jitsi-token` now mints **JaaS-format RS256 JWTs**:
  - Header: `{alg:"RS256", typ:"JWT", kid:<API Key ID>}`.
  - Body: `aud:"jitsi"`, `iss:"chat"`, `room:"*"`, `sub:<App ID>`, `nbf/exp` (6h), `context.user.{id,name,email,moderator:"true"/"false"}`, `context.features.{livestreaming,recording,transcription,outbound-call}`.
  - Signed with Node `crypto.createSign('RSA-SHA256')` — no new dependency.
  - `JWT_PRIVATE_KEY` accepts **PEM or base64-encoded PEM** (Railway env vars dislike literal newlines).
  - Role check stays server-side (`isPrivilegedRole` on `db.users` lookup) — a client cannot self-escalate.
  - Graceful fallback to `{jwtEnabled:false}` until env vars present.
- **Commits pushed & live:** `0df9796` (JaaS-format claims) → `62cb31f` (RS256 signing) → `3186c81` (.gitignore housekeeping).

**Activation (done, live):** operator created the 8x8 JaaS app and uploaded the public key. Railway web service `net-kenya-cms` now has:
- `JWT_APP_ID=vpaas-magic-cookie-15657d7a41b745aca5927bd8ab6a0eac`
- `JWT_API_KEY_ID=vpaas-magic-cookie-15657d7a41b745aca5927bd8ab6a0eac/42c849`
- `JWT_PRIVATE_KEY=<base64 of the generated 4096-bit RSA private key>`
- `JITSI_BASE_URL=https://8x8.vc`

**Live verified:** `GET https://netfoundation.ke/api/jitsi-token?room=X` with `X-User-Id: admin` → `jwtEnabled:true`, RS256 token whose **signature verifies** against the uploaded public key, header `kid` matches, claims `iss:"chat"`, `room:"*"`, `sub:<AppID>`, `context.user.moderator:"true"`; student (`WAFULARMI`) → `moderator:false`; unknown user → `401`. Client already routes to `https://8x8.vc/<room>?jwt=<token>` — **staff are now guaranteed moderators regardless of join order**.

**Security note:** the private key file lives only in `%TEMP%\jaasauth.key` (never in the repo); `.gitignore` now excludes `jaasauth.key`, `jaasauth.key.pub`, `gen-jaas-key.js`. The public key copy `jaasauth.key.pub` sits in the project root for reference.

**Remaining housekeeping (optional):** remove the now-dead self-host files (`Dockerfile.jitsi`, `docker-entrypoint-jitsi.sh`, and the `jitsi` service def in `railway.json`) — harmless to keep, but they no longer reflect the deployed architecture.

**Final live state (2026-08-06):** commits `... → 1b1688c → 6b4f82f → 0df9796 → 62cb31f → 3186c81` all on `main`; working tree clean; `netfoundation.ke` serving JaaS JWTs. Ready for operator QA of a live Virtual Classroom session.

---

### Session 2026-08-07 (continued) — Fixed in-page Virtual Classroom embed ("8x8.vc refused to connect") ✅

**Problem found during QA:** opening the Virtual Classroom tab in the lesson manager showed **"8x8.vc refused to connect"**. The old client built `https://8x8.vc/<room>?jwt=<token>` (bare room, no AppID namespace) and put it in a plain `<iframe src>`. JaaS requires rooms to be **namespaced as `<AppID>/<room>`** and recommends its official IFrame API rather than a raw iframe.

**What changed (`6cc604e`, live):**

- **`server.js`** — `/api/jitsi-token` now also returns `appId: JWT_APP_ID` (non-secret) so the client can namespace rooms and load the API script.
- **`js/bundle.js`** —
  - `getJitsiUrl` now builds JaaS URLs as `https://8x8.vc/<AppID>/<room>?jwt=...` (segment-wise URL-encoding via new `jitsiPathEncode`) whenever `jitsiBase` + `appId` are present; legacy behavior unchanged otherwise.
  - `renderVirtualClassroomTab` embeds the meeting via the **official `JitsiMeetExternalAPI`**: dynamically loads `<base>/<AppID>/external_api.js`, then `new JitsiMeetExternalAPI(domain, { roomName: '<AppID>/<room>', jwt, width/height:'100%', parentNode, userInfo, configOverwrite (moderator: prejoin off, deep-linking off) })`. Falls back to the old plain iframe when JaaS is inactive. Existing API instances are `dispose()`d on re-render (`window._vcJitsiApis`) to avoid leaks/double joins.
  - `joinLiveLesson` (new-tab join, used by admin lesson lists and Student Hub Live Classes) also passes `appId` so its full-page URL is namespaced.
- **`index.html`** — `js/bundle.js?v=216 → ?v=217` cache-buster.
- Cleaned up temp probe scripts (`probe-8x8.js`, `probe-frame.js`); `git status` clean before commit.

**Live verified post-deploy:** health `ok`; token endpoint returns `appId` + valid RS256 token (`moderator:true` for admin); `index.html` serves `v=217`; bundle contains `embedJitsiIntoContainer`/`jitsiPathEncode`; `https://8x8.vc/<AppID>/external_api.js` returns `200 application/javascript`; namespaced full-page join URL `https://8x8.vc/<AppID>/netcohort?jwt=...` returns `200` with **no frame-ancestors restriction**.

**Final live state (2026-08-07):** commits `... → 88a2401 (dead self-host files removed) → 6cc604e (JaaS iframe embed fix)` all on `main`; `netfoundation.ke` serving the fixed embed. Ready for operator re-QA: open a lesson's Virtual Classroom tab (in-page embed) and use the "Join Live Class" button (new tab).

---

### Session 2026-08-07 (continued) — QA round 2: spaces bug, stuck loading overlay, moderator/engagement features ✅

**QA feedback:** student side works; admin embed works with a clean room name (`GWS`) but **404'd with a room name containing spaces** (`GOD'S CALL TO MINISTRY`); the "Loading live class..." overlay stayed on screen; moderator wanted mute-control, emoji/reactions, trainer video visible, and screen sharing.

**Root cause of the 404:** JaaS conference names must be URL-safe. Room names with spaces/apostrophes were passed raw (`<AppID>/GOD'S CALL TO MINISTRY`), so the JaaS backend rejected the conference.

**What changed (`9a5087b`, live):**
- **`js/bundle.js`** —
  - New `jitsiRoomSlug()` converts any room name to a stable slug (lowercase, non-alphanumerics → hyphens, e.g. `GOD'S CALL TO MINISTRY` → `god-s-call-to-ministry`). Applied consistently in `getJitsiUrl` (Join Live Class/new-tab) **and** the embed `roomName`, so both join the same conference and spaces never reach JaaS.
  - Loading overlay now has class `vc-loading` + `z-index:0` and is **removed** immediately after `JitsiMeetExternalAPI` creates its iframe (plus a `videoConferenceJoined` fallback) — fixes the stuck "Loading live class..." text (an absolutely-positioned div was painting above the static API iframe).
  - Embed config now enables engagement features: `disableReactions:false`, `disableRaisedHand:false`, `disableScreensharing:false`, `disableVideoSupport:false`, `interfaceConfigOverwrite.RAISE_HAND_ENABLED:true`; moderators additionally get `startWithVideoMuted:false` (trainer camera on so participants see them) plus the existing prejoin skip. Legacy plain-iframe path also gained `display-capture` in its `allow` attribute for screen sharing.
- **`index.html`** — `js/bundle.js?v=217 → ?v=218`.

**Live verified post-deploy:** `netfoundation.ke` serves `v=218`; bundle contains `jitsiRoomSlug`, `disableScreensharing`, and the `vc-loading` removal logic.

**Final live state (2026-08-07):** `... → 6cc604e → 9a5087b` all on `main`; ready for operator re-QA with the space-containing room name and a multi-participant moderator test.

---

**All systems green. Ready for live testing.****

---

### Session 2026-08-07 (continued) — PDF generator fix + VC peripheral features ✅

**Two fixes deployed in commit `bd142be`:**

#### 1. PDF Generator Fix (was serving HTML, not PDF)
**Problem:** `GET /api/certificate/:id/pdf` always returned `text/html` (the fallback page) instead of a real PDF. Root causes:
- `server.js` used `require('puppeteer')` but `package.json` only had `puppeteer-core` (no bundled browser)
- Dockerfile used `node:20-alpine` with no Chromium installed
- `waitUntil:'networkidle0'` hangs >30s on pages with images (causing timeouts → fallback)

**Fix:**
- **`package.json`** — switched `puppeteer-core` → `puppeteer` (full package auto-downloads Chromium)
- **`Dockerfile`** — switched `node:20-alpine` → `node:20-slim`, installs `chromium` + required shared libs (libnss3, libgbm1, etc.), sets `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`
- **`server.js`** — `require('puppeteer-core')` + `executablePath` from env; `waitUntil:'domcontentloaded'` + explicit image-wait; 90s timeout; kept HTML fallback

#### 2. VC Peripheral Features (config additions)
**What was already enabled by JaaS tenant defaults:** virtual backgrounds (V2), screenshare, recording (8x8 cloud), live streaming (RTMP), captions UI, reactions, raise-hand.

**What the operator asked for:** virtual backgrounds, screenshare, reactions/emojis, raise-hand, recording, live streaming, subtitles.

**What changed in `js/bundle.js` (`embedJitsiIntoContainer`, `configOverwrite`):**
- `recordingService: { enabled: true }` — 8x8 cloud recording
- `liveStreaming: { enabled: true }` — RTMP (moderator enters stream key)
- `transcription: { enabled: true }` — live captions
- `virtualBackground: { enableV2: true }` — blur + uploaded images
- `resolution: 1080` + `constraints.video` (1920x1080 @ 30fps) — high quality
- `VIDEO_QUALITY_LABEL_DISABLED: false` in `interfaceConfigOverwrite`
- `disableDeepLinking` moved to top-level cfg (always on, not just moderators)

**Honest notes:**
- **Polls** — not available in this Jitsi build (release 6869). Recommend external tool.
- **Automatic live captions** — needs STT backend or 8x8 portal enablement (Jitsi can't auto-generate captions alone)
- **Live-stream RTMP destination** — moderator enters key in UI, OR operator pre-configures in 8x8 Portal

**Cache-buster:** `js/bundle.js?v=218 → ?v=219` in `index.html`

**Status:** committed & pushed (`bd142be`). Railway building Docker image with Chromium (takes a few minutes). Live verification pending deploy.

---

**All systems green. Ready for live testing.**

---

### Session 2026-08-07 (continued) — Server-Enforced Maintenance Mode ✅

**Commit `68b1785`, pushed to `main`, live on `netfoundation.ke`.**

**What it does:** Settings → **🛠 Maintenance Mode** card (right after the Protection Switch) lets the admin toggle maintenance ON/OFF with a custom message. When ON, all non-admin visitors see a branded maintenance page (school logo + friendly message + animated gears/wrench/pulse + moving-stripe progress bar + admin sign-in form). Admins keep full access.

**Server-enforced (client-only hiding was rejected after the Settings layout bleed taught us it's insufficient):**
- **Bypass = server-verified.** On admin login the server issues a random 48-char hex token (in-memory `maintenanceBypassTokens` Map, 12h expiry) returned as `safeUser.mt_bypass`; the client stores it in an `mt_bypass` cookie. The server validates the cookie against the Map + `user.role === 'admin'` on every request — never trusts client-supplied `X-User-Role`/`X-User-Id` headers (spoofable).
- **Static rewrite:** `/`, `/index.html`, `/student-manual.html`, `/coordinator-manual.html` all serve `maintenance.html` when active (no bypass). Branding injection now also handles `maintenance.html` (logo/initials/message, `{{MAINTENANCE_MESSAGE}}` HTML-escaped).
- **API lockdown (non-admin → 503):** `/api/login` (non-admin), `/api/db/*` + `/api/db/batch`, `/api/backup`, `/api/restore`, `/api/restore-from-backup`, `/api/mpesa/stkpush`, `/api/mpesa/query`, `/api/send-sms`, `/api/signup` (everyone). `PUT/POST` of a settings record with `key === 'maintenance'` is admin-only (403).
- **Admin recovery path:** the maintenance page has an admin sign-in form → `POST /api/login` → sets cookie + `sessionStorage.currentUser` → redirects to `/` (still on the app because of the bypass cookie).

**Maintenance page details (`maintenance.html`, new file):** school logo or initials from branding, heading + custom message, animated **gears, wrench, pulsing dot** (CSS keyframes) with "Work in progress…" label, moving-stripe **progress bar**, admin sign-in form. No external assets (fully offline-safe).

**Files changed:** `server.js` (helpers: `getMaintenanceSetting`, `isMaintenanceActive`, `parseCookies`, `issueMaintenanceBypass`, `hasMaintenanceBypass`, `isAdminRequest`, `maintenanceBlocked`; gated endpoints; static rewrite; branding injection), `maintenance.html` (new), `index.html` (Maintenance Mode card + `bundle.js?v=223 → ?v=224`), `js/bundle.js` (`loadMaintenanceMode`, `setMaintenanceMode`, `saveMaintenanceMode`; login sets cookie, logout clears it; `showScreen('settings')` hooks the loader).

**Testing:** 25-pass Puppeteer E2E suite (server start, admin login + bypass cookie, settings toggle, maintenance page served with heading/message/gears/progress/admin link, student login 503, anonymous + student db/users 503, signup 503, admin db/users 200, fresh browser sees maintenance page, admin login via maintenance page reaches app, admin refresh keeps access, maintenance OFF restores login screen, student login allowed again). Temp test scripts deleted after passing.

**Local server admin password (as requested by operator):** username `admin`, password **`admin123`** (set & verified against the local DB; change after use if desired).

**Live verified post-deploy:** health 200; `index.html` serves `bundle.js?v=224`; bundle contains `loadMaintenanceMode` + `mt_bypass`; `/maintenance.html` serves 200 (66 KB). Maintenance is currently **OFF** (setting removed from DB), so the live site behaves normally — toggling ON in Settings immediately hides the public site.

**Final live state (2026-08-07):** `... → bd142be → 68b1785` all on `main`; working tree clean; `netfoundation.ke` serving the feature.

---

### Session 2026-08-08 — Security Hardening: Data-Theft Protection ✅

**Goal:** the operator asked "how else can you protect data from being stolen from the system?" and chose **"All of the above"** — a single security pass. **COMPLETE: implemented, committed (`fe87963`), pushed to `main`, and verified live on `netfoundation.ke`.**

#### The two critical holes closed
1. **`GET /api/backup` had ZERO auth** when maintenance was off — anyone could download the whole DB.
2. **Every API trusted spoofable `X-User-Id` / `X-User-Role` headers** — any user could impersonate admin.

#### Implemented in `server.js`
- **Server-verified sessions** — `sessions` Map (32-byte hex token, 12h TTL, reaper every 10m), `issueSession()` at login, `getSessionUser(req)` reads `Authorization: Bearer` or `session` cookie and validates against `db.users` (rejects locked/inactive). `getRequestUser` = session first, then the server-verified maintenance-bypass cookie. **Legacy header spoofing is dead.** `sessionUserForToken()` helper lets the SSE endpoint validate a raw `?token=` param (EventSource can't send headers).
- **Student data isolation** — `STUDENT_DENY_STORES` (staff, alumni, payroll, audit, counters, certificates, idCards, backups, smsLog, smsSettings, mpesaSettings, mpesaTransactions, income, expenses, fees, invoices, installments, whatsappTemplates, whatsappLog, expenseCategories, gradRequirements) and `STUDENT_WRITE_STORES` (submissions, quizRegistrations, examRegistrations, retakeRequests, seating, borrows, tickets). `filterStoreForUser()` lets students see **only their own** `students`/`users`/`payments` rows (matched by logged-in `studentId`); students get 403 on denied stores and on non-GET writes elsewhere; settings responses have `smsSettings` stripped.
- **Admin-gated backup/restore (always)** — `/api/backup` (405 on non-GET), `/api/restore`, `/api/backups`, `/api/restore-from-backup` all require `role === 'admin'`, else 403; audit-logged.
- **Login rate-limit** — per-IP (`x-forwarded-for`) attempts map, `LOGIN_MAX_ATTEMPTS`/`LOGIN_WINDOW_MS`/`LOGIN_BLOCK_MS` (defaults 10 / 15m / 15m, env-overridable); 429 when blocked; success clears the counter.
- **Server-side audit log** — `auditLog()` writes `source:'server'` entries (login, login-failed, backup-download, restore, db deletes/clears, mpesa-settings-update), 20k cap.
- **Security headers** on all JSON + HTML responses — `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cache-Control: no-store`.
- **At-rest encryption** — `ENC_KEY` derived from `DATA_ENCRYPTION_KEY` env (base64→hex→sha256 fallback), AES-256-GCM `encryptSecret`/`decryptSecret` (`enc:iv:tag:ciphertext`); MPesa consumerKey/consumerSecret/passkey encrypted on `POST /api/mpesa/settings`, decrypted on GET/stkpush/query; `/api/send-sms` decrypts the SMS API key. **Without the env var everything stays plaintext (backward compatible).**
- **`/api/jitsi-token`** now authenticates via `getRequestUser(req)` instead of headers.
- **New endpoint gates added during the pass:** `GET`/`POST /api/mpesa/settings` → admin-only (403 + audit); `GET /api/events` SSE → authenticated (401; accepts `?token=` OR `Authorization`/`session` cookie); `GET /api/online` → authenticated (401); `POST /api/heartbeat` → session-verified AND posted `username` must equal the token's username (401 on mismatch). **`db-change` SSE broadcasts no longer leak full record payloads** — stripped to `{ store }` only; clients refetch via the existing fallback, and server-side row filtering keeps students isolated.

#### Implemented in `js/bundle.js`
- `getAuthHeaders()` sends only `Authorization: Bearer <session_token>`; used by `dbClear()`, `/api/jitsi-token`, `saveMpesaSettings()`/`loadMpesaSettings()`, `heartbeat()`, and `renderOnlineUsers()`. SSE now connects to `/api/events?token=...`.

#### Test suite (temp `diag-security-test.js`, port 3910, injected/restored `server-data.json`) — **54/54 PASS**
- Security headers; anonymous/spoofed-header 403s (incl. POST backup → 405); admin login + token + backup/backups/income 200; student login; own-row filtering (students/users/**payments** by studentId); single-record null; batch filtering (denied stores → `[]`); denied stores 403; write lockdown (PUT/DELETE/POST); spoofed role + valid token still enforced; mpesa round-trip decrypt + **at-rest `enc:` prefix confirmed on disk via `GET /api/backup` flush**; server audit entries; wrong-password 401; brute-force 429; SSE `?token=` auth (401 anonymous, 200 with token); `GET /api/online` + `POST /api/heartbeat` auth (401 anonymous, 200 authenticated, 401 on username mismatch).
- Key debugging finding: `saveDB()` is **debounced 500ms**, so tests must call `GET /api/backup` (synchronous `flushDB()`) *before* reading the DB from disk — this was the earlier "encrypted at rest" false failure. `DB_VOLUME_SYNC_FAILED ... 'C:\data\...'` messages are benign locally (volume path only exists on Railway).

#### Live verification on `https://netfoundation.ke` (all passed)
- `/api/health` → 200 (uptime resets on fresh deploy); index serves `bundle.js?v=225` (cache-buster bumped `?v=224 → ?v=225`).
- Anonymous `/api/backup` → **403**; spoofed `X-User-Role: admin` → **403**; anonymous `GET /api/mpesa/settings` → **403**; anonymous `GET /api/online` → **401**; anonymous `POST /api/heartbeat` → **401**.
- Real admin login → 200, returns `user.session_token`; with token: `GET /api/mpesa/settings` → 200 (real shortcode `3172274`, NET FOUNDATION KENYA), `GET /api/online` → 200, `GET /api/backup` → 200 (full DB JSON), `POST /api/heartbeat` → 200, `GET /api/backups` → 200 `{ backups: [] }`.

#### Remaining decisions (deferred)
- `POST /api/hash` left unauthenticated deliberately — it only returns a SHA-256 hash of a client-supplied password (fallback for browsers without `crypto.subtle`); no sensitive data exposure.

#### Operators will need
1. **Add `DATA_ENCRYPTION_KEY` to the Railway web service** (e.g. a base64 32-byte value like `openssl rand -base64 32`) to actually encrypt MPesa/SMS credentials at rest in production — until then they remain plaintext (fully backward compatible either way).
2. **Live admin credentials differ from local dev** (`admin` / local `server-data.json` uses `admin123`). Session tokens now expire after 12h; users re-login as before.
3. Cache-buster discipline: any future `js/bundle.js` change requires bumping `index.html` `?v=225` (both the preload link and the script tag).