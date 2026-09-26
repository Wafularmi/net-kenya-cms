# NET Kenya CMS — Session Summary

**Live site:** https://netfoundation.ke · **Repo:** Wafularmi/net-kenya-cms (`main`)
**HEAD:** `f9e5d00` strict country scoping + /api/adopt (bundle v=343) · **Assets:** `js/bundle.js?v=343` (preload + script tags), `js/student-hub.js?v=45`, `css/main.146.css?v=147`
**Deploy = `railway up --detach`** (Railway CLI v5.23.3, Hobby plan, DOCKERFILE builder) · healthcheck `/api/health` · hard-refresh (`Ctrl+Shift+R`) after client deploys. Server.js changes need a redeploy to go live.

## Session 2026-09-25 — strict country scoping (no generic fallback) + POST /api/adopt; T&C gating analysis (bundle v=343, commit `f9e5d00`, deployed `a6b87944`)

- **Removed the generic country-less fallback**: `filterStoreForUser` previously showed records with `!r.country` to everyone. Now EVERY non-exempt record must resolve to the viewer's country via `recordCountryOf` (server.js:846-878). A `GLOBAL_SHARED_STORES` whitelist keeps genuinely country-neutral content visible to all (server.js:782-805): courses, lessons, lessonFiles, exams, quizzes, questionBank, programs, feeStructure, gradRequirements, campuses, manuals, whatsappTemplates, smsTemplates, whatsappLog, smsLog, expenseCategories, incomeCategories, deductionAccounts, salaryDeductions, payslips, deductionDisbursements, events, alerts, messages, notes, meetings, books, hostels, inventory, settings. `countryExemptStores` unchanged (`users`,`counters`,`sessions`,`maintenanceBypassTokens`). Untagged rows are now **admin-only** until adopted.
- **`recordCountryOf` generalized** (replaces old `STUDENT_COUNTRY_STORES` set): explicit `country` → students: centerCountry → studyCenters: country/regionCountry → staff: `_user.country`, userId, loginUsername, phone → users.country, studyCenterId → regions: country → generic chain `studentId` → `studentPhone/phone` → `studyCenterId` → `regionId` → `''` (never a shared freebie).
- **`POST /api/adopt`** (admin-only, server.js after DELETE countries ~L2232): stamps `country` on any store; for **students** also validates country against settings `countries`, picks a study center in the target country (provided `studyCenterId` wins, else first center whose `centerCountry` matches, else `GEN`), regenerates the admission number `NF/{CENTER}/{MM}-{YY}/{SEQ}` via the per-country roll (`settings:admissionLastSeqByCountry`, max with existing), stamps `regionId`, `auditLog('adopted',…)`, deletes `db.__countryIndex`, `saveDB`, `broadcastEvent`.
- **PUT students now auto-stamp** `country`+`regionId` from the study center whenever the center resolves a country — newly saved students always "fit".
- **Client** (`js/bundle.js`): admin sees an **Adopt** button on untagged student rows → `adoptStudentModal`/`refreshAdoptCenters`/`confirmAdoptStudent` (country dropdown + center dropdown filtered by country + confirm + POST /api/adopt + re-render). "Unassigned (visible to all)" relabeled **"Unassigned (admin-only until adopted)"**.
- **Verified**: `node --check` clean (server.js, bundle.js); `test-adopt.cjs` harness (temp dir) all tests PASS; live site serves `bundle.js?v=343`; deployment `a6b87944` online.
- **Committed + pushed**: `f9e5d00` (3 files: server.js, js/bundle.js, index.html). Railway redeployed — **server.js changes are now live**.
- **Live data facts**: students 137 (136 KENYA + 1 TOGO, all tagged); payments 309 (all resolve KENYA); expenses 5 untagged (admin-only until adopted); income 0; staff 11 (1 untagged); alumni 34 (1 untagged); centers 10 KENYA + SC-TCNSC (TOGO) + SC-MRNSC (empty country, stale regionId → admin-only). Regions REG-KRM=UGANDA, REG-CT=TOGO. Admission format `NF/{center}/{MM}-{YY}/{seq}`, institute code always `NF`.
- **T&C gating analysis (in progress)** — requirement: **show T&C only on first login, or when the terms are updated** (version bump), never every login. Current client gates (bundle.js:1008-1030 initAuth / 1166-1187 login / 1909-1923 init): version-aware `currentVersion = branding.termsContent ? (termsVersion||1) : 0`; if `currentVersion>0 && user.termsVersion !== currentVersion` → force modal; else defer to localStorage `terms_accepted_<username>` + server record. Server special-cases **students only** for self-terms write (server.js:3865 `studentSelfTerms`, field whitelist `['username','termsAccepted','termsAcceptedAt','termsVersion']` at server.js:4086-4097). **Gap identified**: non-student staff/coordinators CANNOT persist `termsAccepted/termsVersion` — `canAccessStore` denies `users` writes for coordinators (server.js:990,995) and the PUT handler's self-terms branch is `role==='student'`-only — so on a fresh browser/device (no localStorage) they get re-prompted even though they already accepted at the current version. Next step: generalize self-terms acceptance write to ANY authenticated user (own record only, same field whitelist), so acceptance persists server-side per user → modal shows only on first acceptance at a version or after an admin bump (bundle.js:18856-18861 auto-increments `branding.termsVersion` when content changes).

### TODO (next tasks, in order)
1. **T&C first-login/update-only** — server: extend the self-terms users-write beyond `studentSelfTerms` to all roles (own record, whitelist fields) so acceptance persists; evaluation order already version-aware.
2. **Verification modal: include the country the student studied from** (transcript/verification screen).
3. ~~Generate Completion / Generate Diploma buttons must work in each country~~ **DONE (2026-09-26)** — per-country admin toggle `settings:documentGenFlags` (`{ key, diploma:{COUNTRY:bool}, completion:{COUNTRY:bool} }`, flat, default ON). Server: `settingsReadExempt` extended so any certificate-capable user can GET `completionPdfConfig`/`diplomaPdfConfig`/`documentGenFlags` (root-cause fix: coordinators got 403 reading config → modal never opened); write-gate in PUT/POST/batch certificate handlers + raw template stream for `type diploma/completion` when the country flag is OFF for a country-scoped coordinator (`docTypeEnabledFor`); admins/assistants/regional/other staff never gated. Client: admin Settings card "Document Generation (per country)" with per-country ON/OFF toggles (toggle-switch pattern); `loadDocGenFlags`/`saveDocGenFlags`/`ensureDocGenFlags`/`docGenEnabledFor`/`refreshDocGenButtons`; Generate buttons (graduation L335-336, certificates L383-384) now carry `data-docgen` and hide when disabled; `showDiplomaPdfGenerator`/`showCompletionPdfGenerator` toast-block when OFF. Verified: unit test 6/6, API smoke test (server up; admin saves flags; TOGO reads configs 200; TOGO write diploma 403; TOGO write completion 200; template stream 403), `node --check` clean on server.js + bundle.js.

## Session 2026-09-23 — drip: same-lesson units unlock instantly, pace only between lessons (student-hub v=45)

- **Root cause:** in courses like **GOD'S CALL TO MINISTRY**, each video is its own lesson record. The drip engine gated EVERY consecutive step by the course pace (default 3.5 days), so VIDEO 1/2/3 each waited ~3.5 days after the previous part.
- **Change (`drip-engine.js`):** new `dripGroupOfLesson(l)` parses title prefix `^Lesson\s+(\d+)` -> group key L1; titles without a prefix stay their own unit (T{id} - unchanged). `dripSweep` + `dripNextInfo` now use gapMs=0 within a unit (`dripSameLessonUnit(prev,l)`): Notes -> VIDEO 1 -> VIDEO 2 unlock instantly AND one at a time (sequential). The 3.5-day pace applies BETWEEN lesson units only. Fee gate, weekly target, quiz gating, pace=0 unchanged.
- **Client copy (`js/student-hub.js?v=45`):** mirror helpers `hubDripGroupKey`/`hubDripSameUnit`; roadmap + locked-toast say a same-unit next part unlocks instantly once the previous part is done. Server authoritative.
- **Tests (`test-drip-engine.cjs`):** 10 new engine cases - grouping, instant within-unit unlock (sweep + dripNextInfo), cross-unit pace still enforced, pace-0 flow. PASS=38 FAIL=0; `node --check` clean on server.js, js/bundle.js, js/student-hub.js, drip-engine.js. Deployed (railway up --detach): served bundle.js?v=338 + student-hub.js?v=45 confirmed live; maintenance OFF.
- **Note:** live end-to-end drip can't be verified headlessly (needs a real student reading timer on the live site); engine unit tests are authoritative. NOT yet committed - awaiting user go-ahead for git add/commit/push.
## Session 2026-09-21/22 — country coordinator regions & study centers, unified admission numbers, signup country (bundle v=338)

- **Regions & study centers for country coordinators** (all live-verified as JAMES/TOGO): region form locks the Country select to the coordinator's own country (disabled), and `saveRegion` stamps it even when left blank; study-center form filters the Region dropdown to that country, locks Country, and when the Code field is left blank **auto-generates** a country-carrying code (`{COUNTRY-LETTERS}C{index}`, e.g. `TOGOC1` → `UNSC`-style typed codes still allowed). Both forms set `country` explicitly (`bundle.js showRegionForm/saveRegion/showStudyCenterForm/saveStudyCenter/generateCenterCode`).
- **Duplicate center-code guard**: `studyCenterCodeConflict(rec)` helper → POST **and** PUT studyCenters return 400 `Center code already in use: …` (a dup code would corrupt admission numbers across centers). Cross-country write still 403 via `scopeWrite` (verified: center with UGANDA country as TOGO coord → 403 `Outside your country scope`).
- **Unified admission format** across ALL countries = `NF/{CENTERCODE}/{MM}-{YY}/{SEQ}`: first segment is **always** the global institute code `NF` (even where brand initials differ, e.g. Togo='TG' — those stay on documents only via `applyCountryBranding`), month is **2-digit padded** (`09`, not `9`), and the sequence is the **country-wide roll** across all centers of that country (per-country counter `settings:admissionLastSeqByCountry`, no yearly reset). Reference implementation: `admissionInstituteCode(branding)` + `admissionMonthYear(d)` in `bundle.js`, and the public signup path + `applyCountryBranding` on the server.
- **Country coordinators' student enrollment**: signed-in coordinators can now register students. Fixed the **Add Student silent no-op** — root cause: `getProgramsList()` → `dbGet('settings','academic')` throws for coordinators (settings store fenced) and `dbGet` throws on non-OK (`bundle.js:66`), so the async form-open rejected before `showModal`. Fix: route-level `settingsReadExempt` now also permits GET of the `academic` key (plus `branding`), and `getProgramsList()` is hardened with try/catch. Also removed a latent ReferenceError in `canAccessStore` (`bundle.js` mirror line referencing an out-of-scope `key`). Live-verified: academic 200 (programs returned), branding 200, settings LIST 403, coordinator settings FENCE intact.
- **`quickEnrollStudent` bug fixed**: it referenced undefined `initials`/`month`/`year` (swallowed by its try/catch → "Enrollment failed") — now uses `admissionInstituteCode` + `admissionMonthYear`.
- **Signup/registration now captures Country**: the login-screen **Request Registration** modal gained a *Country\** dropdown (`#signup-country`, from `/api/countries`), regions/centers in it are filtered by selected country (and auto-derive country when a region is picked), and the POST `/api/signup` body includes `country`. Server accepts it, **rejects mismatches** (center in a different country → 400 `Selected study center is not in the chosen country`), prefers it for the country-wide admission roll, and stamps `student.country`. Live-verified: signups 200 with `NF/GEN/09-26/002 → 003` (per-country increment).
- **ADMIN-ONLY actions gated for coordinators in Regions UI**: `renderRegions` wraps `dbGetAll('users')` in `.catch(()=>[])` (users store is coordinator-fenced) and hides **Register Coordinator / Transfer** buttons unless `!viewerScope().isCoord`.
- Versioning: both index.html tags bumped `?v=337 → 338` in lockstep; deployed `railway up --detach`; probes cleaned up (no probe students/centers/regions left).

## Session 2026-09-19 — doc-freeze fix deployed & verified (railway up cutover)

- **Doc-freeze root cause**: cert PDF bodies (base64, up to 2.4MB) lived inline in `server-data.json`; every save pretty-printed + re-read the whole ~23MB DB, freezing the event loop. Fix (`6546e3d`, server-only — client tags unchanged): `stripStoredInlineBlobs()` externalizes PDF bodies to `/data/docs` + sets `contentPath`, **gated on `volumeAvailable()`** (`server.js:251`; local dev keeps inline copies for easy testing); strips only PDF magic (`JVBERi0`/`%PDF-`, lines 258-259) so 7 HTML cert bodies stay inline by design; `safeWriteJSON` now writes compact without verify re-read (`server.js:357`) → fast, non-blocking saves; boot copies DB off the volume (`server.js:445`), restores `docs/` then strips inline (`server.js:965-998`). `DOC_STRIP_INLINE=1` env still opt-in extra.
- **Data campaign (zero-loss migration seed)**: UI backup export is the strict **superset** (13 certs, 10 with bodies: 3 base64 PDFs + 7 HTML that the volume DB was MISSING) → export used as seed, not the volume file. `System backups\check-backup.cjs` validator; `rehearse-migrate.cjs` proved byte-for-byte round-trip (3 PDFs externalized + re-served identical, DB compact 22.86→20.50MB). Fresh export `server-data-backups\college_backup_2026-09-19.json` uploaded as `/data/server-data.json` on the volume.
- **Cutover**: trial-expired block → user picked Railway **Hobby plan** (dashboard-only, no CLI cmd) → `railway up --detach` → deployment `b193c936-5742-437d-9320-38a6b36cb052` **SUCCESS**.
- **Verified LIVE (via admin session token → `GET /api/backup`; volume CLI download caps ~18MiB so don't use it for the DB)**: `/api/health` 200; students 136 / users 123 / courses 13 / enrollments 660 / attendance 880 / payments 308; 13 certs → **0 inline PDF + 7 inline HTML + 3 `contentPath`** with `CERT-1788858350374.pdf` (796,029 B), `CERT-1789371321738.pdf` (796,020 B), `CERT-1789728605544.pdf` (260,228 B) on `/data/docs`; templates intact inline (diplomaPdfConfig 1,065,304 chars, completionPdfConfig 347,508). Validation snapshot: `System backups\livedb-verified.json`.
- **Env vault `DEPLOY_ENV.md` (gitignored)**: live has NO `DATA_ENCRYPTION_KEY` / `MPESA_*` / `SMS_*` env vars — M-Pesa/SMS creds live PLAINTEXT in settings; needed vars = Azure + JaaS/JITSI only. `System backups\railway-vars.json` + `write-deploy-env.cjs`.
- **Oracle migration shelved** (signup stuck at email/phone verify) → user chose paying Railway. SSH keypair `deploy-ssh\id_netcms.pub` + `MIGRATION_RUNBOOK.md` kept if resumed.
- **Pending**: live UI test by user (Generate Diploma PDF modal); re-run **Compute Weighted** live so binary attendance + 20/20/50/10 apply on generated sets; optional: refresh local dev DB to live export (currently 77-student snapshot).

## Session 2026-09-20 — "Drip" jargon removal, Finance balance filter, country infrastructure (Option A)

- **Finance tab balance filter**: `renderBalances()` in `js/bundle.js` rewritten to show ALL students (removed `.filter(s => s.balance > 0)`). Added status computation (`statusOf`: balance/paid/sponsored), filter buttons (All/Balance/Fully Paid/Sponsored) with counts, `_balancesFilter` global + `setBalancesFilter()`, status badges, outstanding total, and a filter bar rendered into `#balances-list` (search-free filtering).
- **"Drip" jargon removal** (across all files):
  - `js/bundle.js`: "Drip Pacing"→"Lesson pacing", drip release option→"Sequenced — unlocks per learner (prev complete + course pacing + fees)", mode badge "DRIP"→"SEQUENCED", save toast "Drip mode"→"Sequenced", tab "🔗 Drip"→"🔗 Sequenced", staff "Drip Chain"→"Lesson Sequence", course form hint updated, added `updateLessonDripHint()` (async, fetches course pacing via `dbGet('courses', ...)`) + `hubPaceText()` helper, wired into lesson-course-select `onchange` and form-open timeout.
  - `js/student-hub.js`: "Course Content Drip"→"Lesson Roadmap", lock toast made fully context-aware (computes exact reason: fee target / prev-lesson-not-complete / pacing gap with dynamic days), reason strings use `paceLabel` dynamically.
  - `index.html`: `<option value="drip">Drip Only 🔗</option>`→`Sequenced Only 🔗`.
- **Country infrastructure (Option A)**: Single instance with per-country data partitioning. `server.js` changes: `filterStoreForUser` now filters rows by `user.user.country` for all authenticated users (exempt: `users`, `counters`, `sessions`, `maintenanceBypassTokens`). Added `/api/countries` GET (public, returns `{countries:[]}`), POST (admin-only, adds `{name, code, brandName, initials}` to `db.settings` key `countries`), DELETE (admin-only, removes by name). Login endpoint validates `country` against the configured list and stores it on the user record (`if (!user.country) user.country = country`). `js/bundle.js`: added `loadCountries()` function, modified `login()` to read `#login-country` dropdown and send `{input, password, country}`. `index.html`: added `<select id="login-country">` dropdown and inline DOMContentLoaded script to populate it via `/api/countries` before bundle.js loads.
- **Chicken-and-egg bug fix**: Login was rejecting all users when `countriesList.length === 0` (no countries configured yet). Fixed: `if (countriesList.length > 0 && (!country || !Array.isArray(countriesList) || !countriesList.includes(country)))` — validation skipped when no countries exist, allowing first-time admin login to add countries.
- **Tags bumped**: bundle `?v=331`, student-hub `?v=41`; deployed via `railway up --detach --yes`.
- **`node --check` passes** for `js/bundle.js`, `js/student-hub.js`, `server.js`.
- **Verified LIVE**: `/api/countries` returns `{"countries":[]}` (empty = first-time setup); login with empty country now passes validation (was returning "Please select a valid country" — now returns "Login failed" due to wrong password, not the country gate).
- **Country coordinator access model** (`server.js:836-840`, `scopeWrite:784`): Country coordinators now get near-admin access scoped to their country. They can access everything EXCEPT `settings` and `audit` (both 403). `canAccessStore` changed from `return true` (all stores) → `return false` only for global admin stores + settings + audit. `scopeWrite` removed `regions` from the blocked list so country coordinators can create regions/study centers for their country. `filterStoreForUser` continues to filter all rows by `user.user.country`. Created `JAMES` as TOGO country coordinator with `admin@TOGO2026` password for testing. Verified: JAMES can access courses, lessons, quizzes, students, staff, certificates, idCards, regions, attendance, finance, inventory, WhatsApp, alumni — all scoped to TOGO. Only Settings and Audit blocked.
- **Country coordinator creation fixed in both forms** (`bundle.js`): `saveUser()` previously required a region for coordinators (line 19781), making country coordinator creation impossible. Fixed: if region is left blank, `regionId: undefined` (country coordinator). `saveStaff()` previously forced `regionId` and derived country from region, also blocking country coordinators. Fixed: `regionId` only set when a region is selected; country comes from `#staff-country` dropdown directly. Region dropdown labels updated to indicate "leave blank for country coordinator" in both forms.
- **JAMES login outage root cause = maintenance mode was ON**: `GET /api/maintenance-status` returned `{"active":true}` — all non-admin logins got 503, so JAMES (coordinator) could never sign in. Admin never notices because of the bypass cookie (documented footgun). Turned maintenance OFF via `PUT /api/db/settings` (`{key:'maintenance', value:{...active:false}}` — note: settings PUT needs `key` inside `value`, flat body gets "Record missing key field"). Also reset JAMES password to simple `togo2026` (was `admin@TOGO2026`, to rule out `@` entry issues). Verified live: JAMES login 200, `coordinator @ TOGO`.
- **JAMES second outage = password overwritten by record edit**: audit showed live `login-failed` entries for JAMES, and the stored hash no longer matched either known password — the record had been edited/recreated in the UI (name now "JAMES AMAH"), which re-hashed an unknown password into the account. Fix: PUT full record with `password=sha256('togo2026')`, `status='active'`, `country='TOGO'`, no `regionId`. Verified live twice (upper + lowercase username): 200 OK. Lesson: editing a coordinator in Staff/Users form rewrites the login password from the form's password field — always re-confirm the password after editing. Same generic flow verified for other countries (UGANDA via KOTTO test).

## Session 2026-09-09 (this conversation — start here)

## Session 2026-09-09 (this conversation — start here)

### `9da39f2` — "Start Assessment" did nothing
- Root cause: the language-modal confirm (`showLangSelectionModal`, `bundle.js:14703`) saved `langPref` first — any failure (network/503/slow PUT) killed the handler silently: modal stuck, quiz never launched, no message.
- Fix: language save is now non-blocking (always launches); `startQuiz` hardened end-to-end with error toasts (load paper, resolve student, submissions, open quiz). Same modal serves exams, so both paths fixed.

### `f22057e` — Documents almost instant + auto-generate assessment set (ONE push)
- Speed: letters 3 sequential fetches → 1 parallel batch; transcripts 8 (incl. a duplicate full grades download, removed) → 1 batch; diploma/completion PDFs fetch config+student in parallel + **template bytes session-cached** (no re-download/re-decode; auto-clears on template save, 10-min TTL); history refresh 4 fetches → 2 shared with duplicate detector. Server save path untouched (crash-safe).
- Auto-gen (Quizzes → ⚡ Auto-Generate Set): per course creates **Quiz (15 Qs)** + **Mid-Semester CAT (30)** + **Final Exam (50)** from the bank — stratified across lessons, **no reuse** (Final → Mid → Quiz priority), pass 50, Quiz 20min/2 retakes, Mid 60/1, Final 120/1, papers live; Final also lands in Examinations as Draft linked via `quizId`, and `startExam` bridges to `startQuiz` so scores flow into the 50% weight. Short banks → partials + reported shortfall; re-run replaces only the previous auto set.
- Weights auto-applied per course: **Quiz 20 / Mid(CAT) 20 / Final(Exam) 50 / Attendance 10** (=100).
- **Attendance award is binary** (`computeWeightedGrade`, `ATT_AWARD_MIN = 80`): ≥80% → full attendance weight, below → 0 (measured % still displayed; re-run Compute Weighted to apply).

### `7992aaf` — Fill-in-the-blank made easy
- Create: ＋ Insert-blank button, `___` auto-converts to `{b}`, **live preview** with numbered chips, rows rebuild only on count change (typed choices no longer wiped), **pick-correct dropdown** fed from choices (typos impossible), ≥2 choices required.
- Take: choices **shuffled**, bigger selects, **forgiving marking** (case/space-insensitive); result breakdown shows per-blank you-chose vs correct.

### `6fd30f3` — Filters/drop-downs audit (49 selects + all dynamic)
- 🔴 **Everyone was running stale code**: executing tag stuck at `bundle.js?v=312` while only the preload tag was bumped. Both tags now bumped in lockstep every release; `main.146.css` got its first cache-buster (`v=147`).
- Fixed: `qb-type` missing Fill-in option; Quiz Results filters never stuck (selection wiped on re-render); Question Bank course/type filters had no wiring; `updateCourseDropdowns()` wiped the Chapel Service option (+ selections); M-Pesa/fee-statement/payroll selects hid non-active people (now all statuses, tagged); exam fill-in icon; currency decimals +1.

### `f4cfccb` — Drip release mode (per-lesson Immediate / Set-date / Drip)
- Lesson form 🚦 mode; `publishAt` picker for dates; drip = sequential per-learner unlock (chain + 3.5-day pace + weekly fee gate incl. Lesson 1), max 2/week. Server stores `lessonUnlocks`/`lessonCompletions` (cross-device).
- Completion = **timed reading** (active tab time ≥ read time, video locked until done: lesson → video) + **≥50% on linked quizzes** (best of submissions/grades; essays on grading). Fail → repeat (timer reset, video re-locked). Pass → personal congrats modal naming learner + next-lesson invite.
- Quizzes/exams progress-gated everywhere (hub lists, registration, `startQuiz`/`startExam`); staff Manage Lesson → 🔗 Drip tab per-learner Unlock/✓ Complete/Reset.

### `d631055` + `ac861a1` — Maintenance portal flip
- Admin keeps bypass cookie by design (never sees portal on own browser — verify incognito). Flip sped to ~2s (poll 5s→2s, SSE retry 8s→3s both directions); toggle paints **optimistically** (instant ON/OFF, reverts + errors on save failure).

### `1320f1f` — Scheduled lessons (`publishAt`, auto-publish on time; Scheduled ⏳ filter/badge)

### `d2dff36` — Login crash: `showApp` wrote to removed badge nodes → froze post-login on admin dashboard (that's how Quick Enroll leaked to students). Guarded + students get dashboard actions hidden.

### Header/logo series (`b4c316d` → `0a7e257`)
- Final state: rectangular interface logo 1.6× (`main.146.css:53`), rectangular notes-PDF logo (`downloadNote`, `v318`), 📘 removed, single red **✕ Exit** top-right on one row with 🔔💬❓ (`header-right: nowrap/wrap`, `flex-shrink:0`), `user-badge` removed, mobile no-spill (`100vw` + ellipsis). Logo mapping stands: `receiptLogo`→login, `logo`→header/docs.

## Standing rules (learned this session)
- **Bump BOTH bundle tags** (`<link rel=preload>` line 14 AND `<script>` line ~1331) + `student-hub.js` tag + CSS `?v=` on every release — or users run stale code and report fixed bugs as broken.
- PowerShell 5.1: no `&&`/`head`; long `node -e` times out — write `.cjs` files; byte-level edits (emoji/`\u` escapes) need script files.
- Never commit: `DEPLOY_ENV.md` (live creds), proposal PDF/.md, `NET LOGO*.png`, `docs/`, test scripts. Live admin `admin` / local `admin123`.
- Plan-before-code for new behavior; user okays direct fixes ("proceed and fix it"). Big features end with `node --check` + logic test + single push + hard-refresh note.

## Open / suggested next
- Re-run **Compute Weighted** to apply binary attendance + 20/20/50/10 on courses with generated sets.
- Confirm assistant-admin password reset end-to-end (GATIMU `staff-STF-0010` vs LAZARUS/ADMIN1) if re-raised.
- Unify restored-name dropdowns (diploma ↔ completion); bulk fee reminders.

## Latest batch (v=318) — Notes: revert to gated, rectify logo

- **Notes gating reverted** `js/student-hub.js:582` `myNotes` now filtered by `ok.has(n.courseId)` again (gated) — per your "revert to gated notes" and "filter was on different course" clarification; notes for locked courses correctly hidden until unlocked, while course management (admin) still shows all.
- **Logo on notes** `js/bundle.js: downloadNote()` `logoUrl = branding.logo` already correct — `branding.logo` is the documents/system header logo per your mapping (`receiptLogo → login`, `logo → header/docs/notes PDFs`). No change needed; verified `server.js:3508` and `js/bundle.js:17563` mapping.

## Previous batch (v=317) — Attendance: Moi's Bridge missing (Damaris Wamboi)

- **Attendance roster** `js/bundle.js: attendanceRoster()` now includes `inactive` / `on-leave` (excludes only `graduated|dropped|alumni|suspended`) — fixes `STU-MP2HGL9POLS0` **DAMARIS WAMBOI** `SC-MNSC` (Moi's Bridge, `status:inactive`) not appearing when recording attendance for **Moi's Bridge Study Center**. Replicated check: 73 other `s.status === 'active'` filters remain correct for graduation/fees, but attendance system-wide now shows blocked students.
- **Students table search** `js/bundle.js:2141` — when searching by name/admission (e.g., "Damaris") the `statusFilter` is now ignored (`if (statusFilter && !search)`), so blocked/inactive matches are found even when filter is `Active`.
- **Previous** `v316` emergency lessons & videos kept.

## Previous batch (v=316) — Emergency: lessons & videos "Lesson not found"

- **Student Hub** `js/student-hub.js:1874` `viewHubLessonNote()` and `js/bundle.js:3247` `viewStudentLesson()` now resilient: if the 60s `loadStudentHubData()` cache or content-gating filtered the lesson, they fallback to `dbGet('lessons', id)` then `dbGetAll('lessons')` before showing the toast — emergency `showToast('Lesson not found')` no longer blocks videos/notes. Video source now checks `videoUrl||video||videoLink` (`js/bundle.js:3257`, `js/student-hub.js:1901`) and badge uses `_videoSrcHub`, so **all video lessons open** after `📖 Read notes first` gate passes.
- **Previous** `v315` graduation pagination kept.

## Previous batch (v=315) — Graduation list pagination

- **Graduation list** `js/bundle.js:7047` `generateGraduationList()` no longer hard-codes `Page 1 of 1` (`js/bundle.js:7123`). Now paginates at 28 rows/page, computes `totalPages = ceil(eligible/28)` and renders each page as `.grad-page` with `page-break-after:always` and footer `Page X of Y` + header `Page X of Y` — both screen and `js/bundle.js:7202` `printGraduationList()` now show correct numbering (was world-class blocker: last page read "1 of 1").

## Previous batch (v=314) — Staff table + password, banner, logos

- **Staff & Faculty table** `index.html:185` header now `Photo | ID | Name | Role | Department | Campus | Contact | Status | Actions` — matches `js/bundle.js:2824` `renderStaff()` 9-column row (photo + ID + name + role + dept + campus + contact + status + actions). Empty state `colspan` `8→9`.
- **Staff password via Staff & Faculty** `js/bundle.js:2892` — robust lookup (`phone|email|loginUsername` + name fallback), clash check excludes the resolved account, new `hashPassword()` applied, and if username (phone) changed the orphaned old `users` entry is deleted (`js/bundle.js:2929`). Previously editing staff whose login was email-based left the old account untouched, so new password appeared not to take. Admin can also reset anywhere via **Settings → Users → 🔑 Pwd** `js/bundle.js:18836` / `DELETE users` and directly via `PUT users` (`server.js:665` allows `admin`).
- **Preview modal** no longer shows "Flagged" badge — `js/bundle.js:11382` `certStatusBadge()` now returns `''` for active/flagged docs (keeps `Revoked`/`Acknowledged`); the yellow "Flagged" pill in `viewCertificate()` (`js/bundle.js:11569`) is gone.
- **Logo mapping** per request: `receiptLogo` → login screen, `logo` → every document + system header/interface. `server.js:3508` now injects `receiptLogo || logo` for `#login-logo` and `logo` for `#header-logo-img`/`.terms-logo`; `js/bundle.js:17563` `loadBranding()` mirrors it (header `settings.logo`, login `settings.receiptLogo || settings.logo`).

## Previous batch (v=312+) — Documents fully working (e7a193c → 82d5211)

The 20,000-char DB field cap was the recurring villain. It silently truncated:
(a) the diploma/completion **PDF template** base64 (fixed in `d7eb721`: templates externalize to disk BEFORE the cap + `%PDF-` magic validation; live templates re-uploaded byte-exact — diploma 798,977 B, completion 260,629 B), and
(b) every **generated letter/transcript** HTML (embedding the logo + signatures as base64 data-URIs, they routinely exceed 20KB) — content was chopped mid-image-tag, so documents saved broken ("Generate Document not working as before").
(c) **Branding logos** — `branding.logo` / `receiptLogo` / `sig_*` (368k PNGs) were also capped to 20k → only the top half of the logo rendered on letters. Fixed by preserving all logo/sig/template keys from the cap.

- **`sanitizeBodyFields(obj, maxLen, preserve)`** now takes a `preserve` list and propagates it recursively; certificate/`idCards` `content` is never length-capped (PUT, POST, `POST /api/db/batch` all updated). Branding path uses `brandingImageKeys()` (`logo|logoDark|receiptLogo|sig*|template`) — `server.js:1261,3037,3192,3236`.
- **Large HTML archived to disk** (`cert-html-<key>.html`, threshold 60KB) and transparently re-injected on read (`externalizeStoreRecords` + batch GET now run `backfillCertIdentifiers`/`externalizeStoreRecords` too) — `server-data.json` stays small, all client viewers work unchanged.
- Certificate PDF content externalized **before** the cap in every write path.
- **`renderPdfOnCanvas`** no longer reassigns `const crosshair` (was throwing `TypeError`, aborting the diploma template designer field overlay).
- **Ephemeral-disk fix** (`82d5211`): `externalizeSettingsRecord()` no longer nulls `template` after writing to disk — Railway restarts previously wiped `docs/settings-*` and `loadGeneratorTemplateBytes()` (`bundle.js:10633`) fell through to the "Please upload and save a PDF template" toast even after a successful save. Templates now persist in DB (also preserved from the cap) and remain usable after restarts; `GET /api/settings-template/:key` still serves the disk copy when present.
- Preview CSP already shipped (`d4ba880`: `frame-src 'self' https: blob:` etc.) — in-app PDF previews render.
- **Verified**: headless local run of all 5 letter types → complete HTML (`</style></div>`), transcript 137KB auto-archived + re-injected, all previews modal-ok; live round-trip of a 50KB transcript → saved byte-exact then deleted; live `branding.logo` restored from `NET LOGO0003.png` (368,042 b64, was 20,000) and `receiptLogo` likewise; fresh `PUT /api/db/certificates` with full logo (368,342) round-trips correctly; 4 live PDF certs (2 completions, 2 diplomas) remain and preview correctly; `Generate Document` (letters) now embeds the full logo.

## Earlier batch (v=310 / student-hub v=32)

### Security & integrity watch (server)
- **SHA-256 baseline** of all served code (`index.html`, manuals, `css/*.css`, `js/*.js`) taken at every boot; 15-min watchdog re-hashes.
- Any file modified while running → **blocked from serving (HTTP 403)** + **danger alert** (ruleId `sec-file-tamper`) + audit + **WhatsApp push** to the configured admin number (wa.me deep link) until the admin **rebaselines** (`/api/security/rebaseline`).
- Cross-restart file changes logged (non-blocking) as `baseline-changed` audit entries.
- **Security headers** on every response: CSP (inline + same-origin + https), HSTS, Referrer-Policy, Permissions-Policy, X-Permitted-Cross-Domain-Policies, Cross-Origin-*.
- **Input sanitization** on all DB writes (control chars stripped, field length capped).
- Endpoints: `GET|POST /api/security/status|check|rebaseline|cleanup` (admin; assistant sees status only).

### Cleanup with per-item consensus
- Routine (every 30 min + on demand) gathers candidates: **resolved/old alerts**, **responded or 30-day-old read messages**, **closed tickets >14 days**. Nothing deletes automatically.
- Client: bell dropdown **🧹 Cleanup** + floating chip → modal with **per-item Confirm/Skip**; only confirmed rows are deleted (`POST /api/security/cleanup`).
- Dismissing an alert now **resolves** it (status `resolved`) instead of deleting; resolved alerts enter the cleanup queue.

### Notification/message fixes
- **`#msg-badge` now actually shows the unread message count** on the 💬 icon (was stuck hidden by the `display:none` + `display:flex` conflict; also dropped the 24h window).
- SSE events `cleanup-candidates` and `security-push` handled (WhatsApp admin deep-link fires once per alert).

### Also in this batch
- Change-Password button no longer stretches full-width on ≤768px (`.hub-account-row`, CSS main + main.146).
- Student Dashboard removed (landing = student-hub; `renderStudentDashboard` deleted).
- Coverage tab includes **inactive/unassigned students** (status badges + "Unassigned (no study center)" group).
- Document verifier shows pretty doc-type labels (Diploma/Completion/Transcript/etc., server + client).
- Hub fee card waiver-aware: shows 🎁 waiver line, "Paid so far (incl. waiver)", and ✓ covered (incl. waiver) instead of a bogus weekly balance.
- `.gitignore`: `integrity.json`, `sessions.json` (runtime-generated).

### Student Hub usability (no version bump; v=310/v=32)
- **Notes tab defaults to a specific course** (first enrolled / last used, persisted per student via `hub-notes-filter-<id>`); selecting a course in the dropdown shows **only that course's lessons**; "View Notes" on a course card jumps into that course.
- Student Hub header: **Refresh button moved onto the same row** as Student Manual + Change Password; its countdown timer removed (the welcome-card `Live … ago` pill is now the only timer); refresh button now shows a **continuous green blinking dot** (`hub-live-blink`) as the live indicator.

## Committed this session (after previous summary @ `07f2fb4`)

### Fee-gated learning (per-student)
- Master toggle + **weekly target** + deadline + per-tab locks + scope (all/selected/except) + per-student custom target/exempt + **regional mode** (coordinators manage own region only).
- Instant unlock toast the moment target is met; hub shows fee breakdown + "Covered until … / ran out on …" with top-up deadline.
- **Overflow model**: cumulative target from each student's **enrollment week** (week 1 = join week), capped at program fee — hub fee card shows exact math.

### Content access gate
- **Course sequencing** (transcript order + continuing numbers; no more `#99` ties) + **unique transcript numbering**.
- Per global / per-region / per-center / per-student modes; **explicit Auto/Locked/Unlocked** per course + **Reset to Auto** + lossless scope switching.
- Scope-mismatch warnings; hub shows lock reason ("Locked by administrator" vs "Locked — complete earlier courses first").

### Coverage screen + finance PDFs
- 📊 Coverage screen with **PDF exports** (Coverage, Contacts, Center Finance, Region Finance) via print-window; manual override pills toggle `courseCompletions`.
- **Graduation coverage gate**: "Minimum Course Coverage %" requirement; coverage met **waives attendance**; shared `gradIssuesFor()` helper across eligibility preview, final list, migration, and seating loops.

### Fee agreements
- `feeAgreements` store (installment/deferral, optional evidence ≤2MB file), approve/pending/reject statuses; approved+in-date **bypasses the fee lock** with banner "Access on agreement until …"; expiry re-locks.

### Role manuals
- `admin-manual.html`, `assistant-admin-manual.html`, `staff-manual.html`, `coordinator-manual.html` (verbatim Acknowledgments; 📥 Download PDF buttons); student manual updated (M-Pesa, targets, content locks, password).
- **Role-aware 📘 header button** auto-maps admin→admin, assistant→assistant, coordinator→coordinator, lecturer/registrar/finance→staff, student→student.

### Maintenance live push (instant flip)
- Live via public `/api/maintenance-events` SSE + `/api/maintenance-status` 5s fallback; login, app, and hub flip instantly on toggle; maintenance page reloads back to app when turned off.
- Fixed broadcast hook missing in PUT/POST (was the reason pushes never fired); stop login autofill leaking demo phone.

### Boardroom & Virtual Hall
- `meetings` store: staff **Boardroom** with categories + **Virtual Hall** (by region/center); `/api/jitsi-token?meeting=id` enforces audience + moderator roles server-side (`meetingVisibleTo`).
- Meeting screen in sidebar for staff; **Virtual Hall cards in student hub Live tab**; permissions added to admin/registrar/finance/lecturer/coordinator/assistant.

### M-Pesa button toggle + fee waivers
- Settings → M-Pesa → **"Show Pay via M-Pesa button to students"** (default OFF). Non-admin mpesa reads return only `payButtonEnabled` (secrets stripped server-side on every read path).
- `waivers` store: reason + staff picker; waived amounts **zero balances everywhere** (hub Fees card, weekly-target math, M-Pesa cap, coverage finance reports); history + delete.

### Speed / stability pass (project-wide rule)
- PDF **templates externalized to disk** (`diplomaPdfConfig`/`completionPdfConfig` → `docs/`, re-injected on read, `backfillSettingsBlobs()` at boot) — shrinks the ~9MB `server-data.json`.
- **Video-safe hub re-renders** (`hubVideoPlaying()` defers DOM rebuild while media plays).
- SSE ~400ms broadcasts; hub cache 60s, poll 30s.

### Bug audit round (this week's blockers)
- **Attendance saving**: "select course and date" misfire was the post-save refresh re-reading cleared filters — now filters are stashed & restored, so Save always works and keeps your selection.
- **Attendance print**: preview status column empties — now reads the **live sheet first** (what you just marked), lenient ID/date matching, DB fallback.
- **Staff logins broken**: root cause = the staff form only created login accounts for **coordinators**; lecturer/assistant/admin/etc. got a directory record with **no credentials**. Staff form now has Username + Password for EVERY role, creates/updates the login account, blocks duplicate usernames, shows "Login: <user>" in the table, cascades delete.
- **User creation**: duplicate-username overwrite blocked; min password length; `status:'active'` forced; login is **case-insensitive** on both sides.
- **Login error text**: generic "Login failed" now surfaces the real reason (503 maintenance / 429 rate-limit / 500).
- **Slow login**: server was doing a **synchronous 9MB≤ JSON rewrite** per login (pretty-print, write, re-read, rename, + volume copy). Now `lastLogin` uses the debounced writer and all DB files are written **compact**.
- **Assistant dashboard "Error loading"**: assistant with no access config was denied financial stores → one 403 killed the whole dashboard batch. Now no config = **all tabs open**, and the dashboard fetches each store independently so a locked tab renders zeros instead of blanking.
- **Kitalale attendance count bug**: per-center roll call was using the **enrollments-only** roster, so students with no enrollment record were unreachable for marking. Roster now comes from a shared `attendanceRoster()` helper — center selected = **all active students of that center**; "All Centers" = **course-enrolled only** (and falls back to all active students when a course has no enrollments at all). Prints sheet with "(N officially enrolled)" header.
- **Client sync**: new `dbPutBatch()` + `POST /api/db/batch` (one SSE broadcast + one debounced write per batch).

### Audit round 2 (server security + speed)
- **Discussions were unauthenticated & trusted client `userRole`** — anyone could pin/lock/delete anyone's posts. Now server-requires a session, derives role/identity from the session (never the body), blocks students outside their enrolled courses, and moderating (pin/lock/delete) requires admin/lecturer/registrar/coordinator/assistant. `flushDB()` → `saveDB()` (debounced).
- **`/api/send-sms` had NO auth** (critical — anyone could send paid bulk SMS). Now requires auth + `canAccessStore('sms')`, and sends in **waves of 10** instead of one huge blocking loop.
- **`/api/db-size` leaked DB stats without auth** → now requires a session.
- **`canAccessStore` catch-all let unknown/legacy roles (e.g. `librarian`) edit ANY store.** Now librarian = library/books/borrows only (+ students read); staff/teacher/trainer and unknown roles = read-only non-financial.
- **Speed**: backup/restore & sessions files are now **compact JSON** (was pretty, 2× weight); login auto-create & pw-upgrade use debounced `saveDB()`; missing SSE broadcasts added for **fee-gate save** (admin + coordinator region), **M-Pesa settings/STK records**, and **prune-audit**; M-Pesa token fetch now **shares in-flight requests** (no duplicate overlapping OAuth calls).

### Audit round 3 (client integrity)
- **Finance gates got client/server mismatch**: `requireFinanceRole` + dashboard/finance quick-action `canManageFinance` listed only admin/finance/registrar and **omitted coordinator** and **assistant-with-finance-tab** (server allows both) → they saw "Access denied". Fixed with a shared `hasFinanceManage()`; waiver/agreement gates now match the stricter server rule via `canGrantWaiversOrAgreements()` (assistant without the Finance tab is properly denied instead of failing at 403).
- **Startup renders unguarded**: `showApp` fired ~20 async `renderX()` calls with no error handling — one store perms denial (e.g. `tickets`) rejected the whole dashboard. All now `.catch(() => {})`; ticket fetches (`renderTickets` → single `dbGetBatch`, `renderDashboard`, badge, ticket-form count) tolerate perms with `[]` fallback.
- **Coordinator nav rebuilt after access-cache load** (was assistant-only), so coordinator tabs reflect `coordinatorAccess` immediately.
- **Duplicate `updateTicketBadge`** (dead override) removed; live one (16646) hardened.
- **Student T&C persistence fixed**: accepting terms did `dbPut('users', …)` which the server **denied** (403, silently swallowed) → students re-prompted every login. Server now special-cases a student PUTting **only their own username's terms fields** (gate + ownership + field whitelist).

### Audit round 4 (dead-file triage — user: "remove if not needed, plug in if needed")
- `index.html` loads only `bundle.js`, `student-hub.js`, `discussions.js`, `help.js`; the 10 legacy "split-source" files (`app.js`, `auth.js`, `dashboard.js`, `exams.js`, `whatsapp.js`, `communication.js`, `pending.js`, `students.js`, `utils.js`, `virtual-classroom.js`) were unloaded leftovers from the 2026-08-05 merge. Identifier diff + feature-by-feature check: `app`, `communication`, `pending`, `utils`, `virtual-classroom` were pure duplicates; `auth`/`dashboard`/`students` were superseded by later bundle logic (year auto-calc via `calculateYearOfStudy`/`student-year-auto`, admin enroll buttons, hub-based student flows, terms handling).
- **Plugged in (were genuinely missing from the live app, ported from sources then deleted):**
  - WhatsApp template cards now have **✏ Edit / 🗑 Delete** (`editTemplate`, `saveTemplateEdit`, `deleteTemplate`).
  - WhatsApp send log now has **↻ Resend** per entry (`retryWhatsAppLog`).
  - **Retake / missed-exam workflow completed**: staff Exam tab now lists pending requests (auto-created container) with **✓ Approve / ✗ Reject** — approval schedules a supplementary exam and auto-registers + allocates the student. (`renderRetakeRequests`, `approveRetake`, `confirmApproveRetake`, `rejectRetake`, `confirmRejectRetake`; previously students could request but staff had no screen to resolve them.)
- All 10 files **deleted** (history preserved in git); `bundle.js?v=308`.

## Objectives / project-wide defaults
- **Push, don't poll**: SSE ~400ms; ≤5s timers; 60s caches; small payloads; debounced atomic writes.
- Externalize remaining PDF blobs out of `server-data.json`.
- Explain changes before coding is preferred; always confirm when finished.

## Open / suggested next steps
- Unify restored-name dropdowns (diploma ↔ completion).
- Bulk fee reminders (WhatsApp/SMS to debtors).
- Report cards, QR attendance, offline hub, audit dashboard.
- `DOC_STRIP_INLINE=1` phase-2 still opt-in.

## Scratch files (do NOT commit)
`DEPLOY_ENV.md`, `mirror-desktop.ps1`, `test-diploma-local.js`, `test-diploma-output.pdf`, `20260903-152731.pdf`, `COMPLETION CERTIFICATE.pdf`, `NET FOUNDATION SEAL2.png`, `NET LOGO0003.png`, `System backups/` (whole folder), `server-data-backups/` (whole folder), `deploy-ssh/` (whole folder), `docs/` — all covered by `.gitignore` (hardened this session: adds `/*.pdf`, `/*.png`, `System backups/`, `server-data-backups/`, `deploy-ssh/`, `DEPLOY_ENV.md`, `live-pw.txt`).