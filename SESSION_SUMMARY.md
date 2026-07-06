# Session Summary — July 5, 2026

## What's Working
- **Live site**: https://netfoundation.ke (CNAME: hcfq1dgb.up.railway.app)
- **Backend**: Node.js via Dockerfile on Railway (spirited-enchantment)
- **Database**: 8MB server-data.json loaded from Railway volume at /data
- **Login**: admin / admin123 (from original .exe data)
- **HTTPS**: Auto-provisioned via Railway
- **www**: CNAME added in Cloudflare, needs Railway domain config

## Recent Fixes
- Dockerfile replaced Railpack/Procfile (Node wasn't installed)
- Volume DB copy runs before loadDB() on startup
- Header overlap fixed: dynamic padding via JS (adjustHeaderPadding in app.js)
- Sidebar top/height follows header dynamically

## Credentials
- Admin: username=`admin`, password=`admin123` (SHA-256: `240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9`)
- Other users: WAFULARMI, MANONO EZEL AFANDI, etc.

## File Locations
- Local: `C:\Users\Pastor David\Desktop\NET KENYA\`
- Source: `C:\Users\Pastor David\Desktop\NET CMS\dist\` (original .exe files)
- GitHub: https://github.com/Wafularmi/net-kenya-cms
- Railway project: `e14263ed-e2a1-4184-89ae-766d077d12e5`
- Railway service: `cfbf8757-206d-4b32-a2b1-6d6b99f4dbdf`
- Railway volume: `fe778515-088d-48e6-9b3f-b967bbaef675` at /data (41MB used)
- Railway CLI token: stored at `~/.railway/config.json`

## Remaining
- Add `www.netfoundation.ke` as custom domain in Railway for SSL
- Switch Cloudflare proxy to orange cloud for CDN speed
- Any other design/feature requests
