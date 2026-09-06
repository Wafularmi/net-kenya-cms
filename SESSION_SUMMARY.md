# NET Kenya CMS — Session Summary

**Live site:** https://netfoundation.ke · **Repo:** Wafularmi/net-kenya-cms (`main`, Railway auto-deploy)
**HEAD:** `9afad68` · **Assets:** `js/bundle.js?v=308`, `js/student-hub.js?v=31`
**Deploy = `git push origin main`** (commits through this audit all pushed)

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
`DEPLOY_ENV.md`, `mirror-desktop.ps1`, `test-diploma-local.js`, `test-diploma-output.pdf`, `20260903-152731.pdf`, `COMPLETION CERTIFICATE.pdf`, `NET FOUNDATION SEAL2.png`, `NET LOGO0003.png`