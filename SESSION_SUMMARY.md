# Session Summary — July 16, 2026

## What's Working
- **Live site**: https://netfoundation.ke (via Cloudflare proxy, orange cloud)
- **www**: https://www.netfoundation.ke (CNAME to 1r96dr77.up.railway.app, proxied, SSL valid)
- **Backend**: Node.js via Dockerfile on Railway (spirited-enchantment)
- **Database**: ~59MB server-data.json loaded from Railway volume at /data (92 students, 12 courses, 9 staff, 107 users, 286 payments, 8 regions, 9 centers)
- **Login**: admin / admin123
- **HTTPS**: Auto-provisioned via Railway for both root and www domains
- **Cloudflare DNS**: @ CNAME → hcfq1dgb.up.railway.app (proxied), www CNAME → 1r96dr77.up.railway.app (proxied), TXT _railway-verify.www added

## July 16 Fixes
- **Admin password reset**: server.js now forces admin password hash at startup (`ADMIN_PASSWORD_RESET` log), fixing password mismatch between volume DB and known credentials
- **Cloudflare Rocket Loader fix**: added `data-cfasync="false"` to all `<script>` tags in index.html — Rocket Loader was deferring bundle.js, causing the inline fallback login to run instead (which called `location.reload()` → infinite refresh loop)
- **Fallback login fix**: changed `location.reload()` to `window.location.href = window.location.pathname + '?_=' + Date.now()` (cache-busting redirect)
- **`async` bug fix (critical)**: `updateAdmissionPreview()` in bundle.js line 1955 was missing `async` keyword but used `await` inside — this caused a SyntaxError that killed the ENTIRE bundle.js execution, leaving `login` undefined (triggered the fallback loop)
- **Cache-control for HTML**: added `<meta http-equiv="Cache-Control">` tags and server-side `Cache-Control: no-cache, no-store` headers for index.html to prevent browser caching of stale pages
- **Cloudflare cache purged**: for all domain URLs

## July 11 Fixes (carried over)
- Dockerfile replaced Railpack/Procfile (Node wasn't installed)
- Volume DB copy runs before loadDB() on startup
- Header overlap fixed: dynamic padding via JS (adjustHeaderPadding in app.js)
- Sidebar top/height follows header dynamically
- Logo flash fix: server injects inline `<style>` with logo via `{{LOGO_CSS}}` placeholder
- Toast z-index raised to `10002`
- Registration fix: `canAccessStore` whitelisted `studyCenters` + `regions` for unauthenticated GET
- Server-side branding injection: `{{SCHOOL_NAME}}`, `{{INITIALS}}`, `{{LOGO_CSS}}`
- Cloudflare CSS cache bypass via versioned URL (`main.144.css`)
- T&C acceptance via localStorage `terms_accepted_<username>`

## Features Added (previous session)
### Regions & Coordinators
- `coordinator` role — sub-admin scoped to region
- Region drill-down dashboard with KPI cards
- Center drill-down with learner problem flags (attendance <70%, outstanding fees, inactive status)

### Admission Number System
- `/api/signup` endpoint with sequential admission numbers
- Format: `SCHOOL-INITIALS / CENTER_CODE / MONTH-YEAR / SEQ`

## Credentials
- Admin: username=`admin`, password=`admin123` (SHA-256: `240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9`)
- Coordinators: create via Settings → Users → +Add User → role=Coordinator

## File Locations
- Working copy: `C:\Users\Pastor David\Desktop\NET KENYA\`
- Source (original .exe): `C:\Users\Pastor David\Desktop\NET CMS\dist\`
- GitHub: https://github.com/Wafularmi/net-kenya-cms
- Railway project: `e14263ed-e2a1-4184-89ae-766d077d12e5`
- Railway service: `cfbf8757-206d-4b32-a2b1-6d6b99f4dbdf`
- Railway volume: `fe778515-088d-48e6-9b3f-b967bbaef675` at /data (59MB/500MB used)

## Key Architecture Notes
- **Database**: single `server-data.json`, loaded via `loadDB()`; all CRUD via REST API (`/api/db/:store/:key`)
- **Auth**: SHA-256 password hashing; session in sessionStorage; IndexedDB not used (all data via server API)
- **Server**: Node.js on PORT env var (8080 on Railway); Dockerfile-based deploy
- **Frontend**: Single-page app in `index.html` + `js/bundle.js?v=213` (all-in-one, 16k+ lines)
- **Rocket Loader**: Cloudflare feature that defers JS — must use `data-cfasync="false"` on all critical scripts
- **Fallback login**: inline script in index.html activates if bundle.js fails to load; avoids `location.reload()` by using cache-busting redirect

## Remaining / Future
- All domains configured and working — no remaining items
