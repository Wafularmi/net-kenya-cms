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

- **GitHub**: `main` branch up to date (commit `cc11ae4`)
- **Railway**: Auto-deploys from GitHub `main` → `netfoundation.ke`
- **Deploy time**: 2–5 minutes after push

---

### Live Verification (2026-08-05) — DONE

- **Health**: `https://netfoundation.ke/api/health` → `200 {"status":"ok"}`
- **Login**: `POST /api/login` with `admin` + correct password → `200` returns admin user
  - Note: curl `-d '...@...@...'` bodies get mangled by PowerShell (invalid JSON → 500).
    Use a BOM-free body file or pass JSON via file: `curl.exe -d @body.json`.

---

### Server Access

- **Local**: `http://127.0.0.1:3000` (run `node server.js` in `C:\Users\Pastor David\Desktop\NET KENYA`)
- **Production**: `https://netfoundation.ke` (Cloudflare-proxied, Railway)
- **Admin**: username `admin`, password `@11097560@` (per operator)

---

**All systems green. Ready for live testing.**