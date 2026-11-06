# NKCMS / NET Foundation System Snapshot

**Date:** 2026-11-06  
**Repo:** `Wafularmi/net-kenya-cms` (workspace: `/tmp/opencode/nkcms`)  
**Branch:** `main`  
**Reference commit:** `bc40533` (`Fix Courses tab 'mode of null' error (guard access/gate mode and recompute)`)

This document is a **reference snapshot** for future development. Treat it as the known-good baseline for the behaviors described below.

## Development rule (important)
- **No regressions. Only improvements.** Before changing login, exam access/submission, Student Hub rendering, permissions, or data integrity paths, verify the behaviors in this snapshot still hold.

## Current confirmed state
- **Student Hub is working** (header, stat cards, navigation tabs, overview, **Courses** tab, **Exams** tab, and section loading). Users should hard-refresh (Ctrl+F5 / clear site data) after frontend deploys.

## Key behaviors

### Authentication & login security
- Login works for genuine users (confirmed). Server-side brute-force protection is layered:
  - Proxy-aware client IP (`X-Forwarded-For` first IP, `X-Real-IP` fallback).
  - Per-IP and per-IP+identifier attempt limiting (env-configurable: `LOGIN_MAX_ATTEMPTS`, `LOGIN_ID_MAX_ATTEMPTS`, `LOGIN_WINDOW_MS`, `LOGIN_BLOCK_MS`).
  - Successful login clears relevant counters.
  - Admin/owner endpoints: `GET /api/owner/login-rate`, `POST /api/owner/login-rate/reset`.
- Relevant file: `server.js`.

### Exams / assessments
- **Open-ended exams** (`openWindow` truthy: `true/"true"/1/"1"`) must not be treated as closed/not-yet-open.
  - Client: `assessmentWindow` / display logic respects `openWindow` (`js/bundle.js`).
  - Server: `assessmentWindowServer` respects `openWindow` for submission/access validation (`server.js`).
  - Student Hub status logic respects `openWindow` (`js/student-hub.js`).
- **Exam access (course-level, non-supplementary):** students can access when course coverage shows relevant lessons covered (`isCourseCovered`), or when manually allowed (**Ungated**), or when already registered/submitted as permitted by existing rules. Do not regress lesson-coverage gating or ungated override.
- **Supplementary exams** remain restricted to approved/targeted retake cases (do not broaden access).
- **“GOD’S WAY OF SALVATION”** open-ended access/ended-permission issue was fixed by the open-window handling above; ensure exam is **Published** and **Open-ended** is saved, then students hard-refresh.
- Relevant files: `server.js`, `js/bundle.js`, `js/student-hub.js`, `index.html` (exam settings UI).

### Student Hub
- Default render shows the **full Student Hub overview** (header, stat cards, tab bar, overview content/cards/tabs visible).
- Tab rendering is resilient: safe fallbacks for missing computed data, guarded gate/alumni `mode` access, safe `examRegIds` derivation in `renderHubExams`, and render errors show actionable messages/retry instead of hiding navigation.
- Relevant file: `js/student-hub.js`.

### Student Hub course actions
- **Drop course** must use flexible student/course matching and only report success when the server actually deletes records (`dbDelete` returns parsed response; server DELETE returns `{ ok, deleted }`). Handles alumni/regular enrollment cases.

### Permissions / owner access
- Owner should have full system/admin access including tabs/audit visibility; client/server fallbacks exist (`canAccessStore` and sidebar/admin behavior).

### Android deployment (mixed)
- System runs on **both BYOD and school-managed Android devices**.
- A web app **cannot fully prevent** another Android app from taking the OS hostage on unmanaged devices.
- **Managed devices (dominance path):** Android Enterprise/MDM, app allowlisting, restricted Accessibility/overlay/install sources, enforced updates, and **kiosk/Lock Task** for `https://www.netfoundation.ke` (Chrome managed or TWA/single-purpose app) as appropriate.
- **BYOD:** rely on server-authoritative validation, strong sessions/audit, HTTPS/security headers, and exam integrity signals (detect/warn on visibility/focus loss) — not OS-level prevention.
- PWA manifest added for installability/managed deployment consistency: `manifest.webmanifest`, `index.html` theme-color/manifest link (**`bb87997`**). Additive only.

## Important files (quick reference)
- `server.js` — API/server authority, auth/rate limiting, assessment window validation, permissions, DB/delete behavior.
- `js/bundle.js` — core client logic, exam access/window helpers, admin UI behavior, exam start/flows.
- `js/student-hub.js` — Student Hub rendering, tabs, course/exam/quiz/notes/live/discussions views, gating/access helpers.
- `index.html` — main UI shell, exam settings controls, asset/manifest links.
- `manifest.webmanifest` — PWA manifest (additive).
- `SYSTEM_SNAPSHOT_2026-11-06.md` — this snapshot.

## Recent fix commits (selected)
- `bc40533` — Fix Courses tab `mode of null` error (guard access/gate mode and recompute).
- `77fb7dc` — Fix Student Hub tabs: guard `gate.mode` null and define `examRegIds` in `renderHubExams`.
- `7c26b98` — Fix Student Hub tabs (courses/exams) failing to render; safe fallbacks and retry.
- `6f215cd` — Emergency: restore Student Hub cards/tabs with resilient render fallback.
- `c31d832` — Default Student Hub to full overview on render.
- `bb87997` — Add web app manifest and theme color (installability).
- `ebf507f` — Fix open-ended exam access: server window + hub status (no false ended/closed).
- `8ff8a47` — Fix open-ended exams showing/treated as closed.
- `4097ebd` — Allow exam access when course coverage shows lessons covered.
- `a939623` — Improve login brute-force protection (IP+identifier limits, proxy IP handling, admin reset).

## Pre-change checklist (future)
1. Confirm no regression to **Student Hub** cards/tabs/overview/courses/exams.
2. Confirm **login** still works for genuine users; rate limiting changes must not lock out normal use.
3. Confirm **open-ended exams** remain accessible when published/openWindow; timed exams still respect windows.
4. Confirm **coverage/ungated/registration/supplementary** rules remain correct.
5. Confirm **server-authoritative** checks still enforce exam/submission/permission rules.
6. After frontend changes, require **hard refresh** / cache busting as needed; test on Android (BYOD/managed where applicable).
