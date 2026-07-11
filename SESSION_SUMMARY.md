# Session Summary — July 11, 2026

## What's Working
- **Live site**: https://netfoundation.ke (CNAME: hcfq1dgb.up.railway.app)
- **Backend**: Node.js via Dockerfile on Railway (spirited-enchantment)
- **Database**: 8MB server-data.json loaded from Railway volume at /data
- **Login**: admin / admin123 (from original .exe data)
- **HTTPS**: Auto-provisioned via Railway
- **www**: CNAME added in Cloudflare, needs Railway domain config

## Recent Fixes (so far)
- Dockerfile replaced Railpack/Procfile (Node wasn't installed)
- Volume DB copy runs before loadDB() on startup
- Header overlap fixed: dynamic padding via JS (adjustHeaderPadding in app.js)
- Sidebar top/height follows header dynamically
- **Logo flash fix**: server injects inline `<style>` with logo as CSS `background-image` via `{{LOGO_CSS}}` placeholder
- **Toast z-index**: raised to `10002` (above modal overlays at `10001`)
- **Registration fix**: `canAccessStore` whitelisted `studyCenters` + `regions` for unauthenticated GET (registration form)
- **Server-side branding injection**: `{{SCHOOL_NAME}}`, `{{INITIALS}}`, `{{LOGO_CSS}}` replaced at serve-time in `server.js`
- **Cloudflare override**: CSS `Cache-Control: max-age=14400` bypassed via versioned URL (`main.144.css`)
- **T&C acceptance**: localStorage key `terms_accepted_<username>`

## Features Added
### Regions & Coordinators (new)
- **New role: `coordinator`** — sub-admin permissions minus creating courses/exams/quizzes; no access to notes, settings, staff, audit, inventory, idcards, whatsapp
- **Coordinator permissions**: dashboard, students, attendance, grades, manuals, chapel, graduation, hostel, library, alumni, certificates, events, finance, portal, pending, tickets, progress, reprint, discussions
- **Region scoping**: coordinators only see students/centers within their assigned `regionId`
- **`regions` store**: CRUD via `renderRegions()`, `showRegionForm()`, `saveRegion()`, `deleteRegion()`, `editRegion()`
- **Regions overview screen**: admin nav tab "🗺 Regions" with counts (centers/coordinators/students)
- **Settings Regions card**: compact list with edit buttons
- **Study Center form**: region dropdown + `regionId` saved to DB
- **User form**: `coordinator` role option; region dropdown appears when coordinator selected; validates region selection
- **Server `canAccessStore`**: handles coordinator role — blocks settings/regions/users/counters, read-only for courses/exams/quizzes/questionBank/lessons, full CRUD for other stores

### Admission Number System
- **`/api/signup` endpoint**: generates admission numbers from `admissionLastSeq` counter in system settings
- **Registration form**: region dropdown filters study centers; sends `regionId` to signup endpoint
- **Admission number format**: `SCHOOL-INITIALS / CENTER_CODE / MONTH-YEAR / SEQ`

### Helper Functions (in bundle.js)
- `isCoordinator()` — checks current user role
- `getCoordinatorRegionId()` — returns coordinator's regionId
- `getRegionCenterIds(regionId)` — returns center IDs for a region
- `filterByRegion(arr, getCenterId)` — filters any array by coordinator's region
- `getRoleColor('coordinator')` → `'warning'`
- `getRolePermissions('coordinator')` → full screen list (see above)
- `renderRegions()` — populates both overview screen and settings card
- `showRegionDetail(regionId)` — Region drill-down: per-center KPI cards (students, avg attendance, outstanding fees, problem count), click a center to open it
- `showCenterDetail(centerId)` — Center drill-down: learner list with attendance% + balance + problem flags (low att <70%, outstanding fee, non-active status); click learner → `viewStudent()` full profile
- `_canAccessRegion(regionId)` — coordinator region-scoping guard for drill-downs
- `_attendanceRate(att, studentId)` — computes attendance % from `attendance` store
- `manageRegionCenters(regionId)` / `assignCenterToRegion` / `unassignCenterFromRegion` — assign centers to regions
- `signupFilterCenters()` — called on region change in registration form

### Data model note
- Students link to centers via `studyCenterId` (rest of app) AND legacy `campus`. Drill-downs use `studyCenterId` (fallback to `campus`). `renderRegions` student count now uses `s.studyCenterId || s.campus`.
- Coordinator scoping: `getCoordinatorRegionId()` returns `currentUser.regionId`. Drill-downs block access to other regions.

## Current State
### Committed & LIVE on Railway (commit 80bfbe9)
- All regions & coordinators features (including drill-down, center detail, problem flags)
- `dbGetBatch` hardened with 3-attempt retry
- Quiz Register/Drop buttons fixed — `_hubGetMe()` ordering, event delegation pattern
- Exam Register/Drop/Request Retake buttons fixed — same `_hubGetMe()` ordering + try/catch
- Dashboard course count fixed — removed `c.status !== 'inactive'` filter (Hub didn't filter by status; enrolled-but-inactive courses were excluded from dashboard only); card heading dynamically changed to "Your Courses"

## Credentials
- Admin: username=`admin`, password=`admin123` (SHA-256: `240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9`)
- Coordinators: create via Settings → Users → +Add User → role=Coordinator
- Other users: WAFULARMI, MANONO EZEL AFANDI, etc.

## File Locations
- Local: `C:\Users\Pastor David\Desktop\NET KENYA\`
- Source: `C:\Users\Pastor David\Desktop\NET CMS\dist\` (original .exe files)
- GitHub: https://github.com/Wafularmi/net-kenya-cms
- Railway project: `e14263ed-e2a1-4184-89ae-766d077d12e5`
- Railway service: `cfbf8757-206d-4b32-a2b1-6d6b99f4dbdf`
- Railway volume: `fe778515-088d-48e6-9b3f-b967bbaef675` at /data (41MB used)
- Railway CLI token: stored at `~/.railway/config.json`

## Shell / Terminal Status
- **Broken**: PowerShell on this Windows machine times out on every command (both direct and via subagent)
- **Workaround**: git operations done via subagent task tool; app testing must be manual via browser

## Key Architecture Notes
- **Database**: all data in `server-data.json` (single JSON file), loaded via `loadDB()`; stores: studyCenters, regions, users, students, courses, etc.
- **Auth**: SHA-256 password hashing; session in sessionStorage
- **Server**: Express on PORT env var (default 3000); Dockerfile-based deploy on Railway
- **Frontend**: Single-page app in `index.html` + `js/bundle.js` (all-in-one bundled JS); `js/utils.js` has duplicate/shared functions
- **Registration flow**: Login page has "Sign Up" link → `showSignupForm()` → region selects → center filters → submits to `/api/signup` → generates admission number → saves as pending student → admin approves in Pending screen

## Remaining
- Add `www.netfoundation.ke` as custom domain in Railway for SSL
- Switch Cloudflare proxy to orange cloud for CDN speed
- **Commit and push the uncommitted regions/coordinator changes to go live**
- Any other design/feature requests
