async function init() {
    try {
        await openDB();
        try { await loadBranding(); } catch (e) { console.error('init loadBranding:', e); }
        try {
            const [cMap, rMap] = await Promise.all([dbGetAll('studyCenters'), dbGetAll('regions')]);
            window.__centerMap = {}; cMap.forEach(c => { window.__centerMap[c.id] = c; });
            window.__regionMap = {}; rMap.forEach(r => { window.__regionMap[r.id] = r.name; });
            window._allCentersCache = cMap;
        } catch (e) { console.error('init ref maps:', e); }
        if (sessionStorage.getItem('currentUser') && isSessionExpired()) {
            sessionStorage.removeItem('currentUser');
            showToast('Session expired. Please login again.', { type: 'warning', duration: 5000 });
        }
        const session = sessionStorage.getItem('currentUser');
        if (session) {
            const user = JSON.parse(session);
            const dbUser = await dbGet('users', user.username);
            if (dbUser && dbUser.status !== 'locked') {
                sessionStorage.setItem('currentUser', JSON.stringify(dbUser));
                const key = 'terms_accepted_' + (dbUser.username || dbUser.id);
                if (localStorage.getItem(key) !== 'true') {
                    try {
                        const existing = await dbGet('users', dbUser.username || dbUser.id);
                        if (existing && existing.termsAccepted) {
                            localStorage.setItem(key, 'true');
                        } else {
                            showTermsModalApp(dbUser);
                            return;
                        }
                    } catch {
                        showTermsModalApp(dbUser);
                        return;
                    }
                }
                await initAuth();
                startAutoRefresh();
            } else {
                document.getElementById('login-screen').style.display = 'flex';
                document.getElementById('app').style.display = 'none';
            }
        } else {
            document.getElementById('login-screen').style.display = 'flex';
            document.getElementById('app').style.display = 'none';
        }
    } catch (err) {
        console.error('App initialization failed:', err);
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;"><div style="text-align:center;padding:40px;"><h2 style="color:var(--danger);">Failed to Load Application</h2><p style="font-size:12px;color:var(--text-muted);margin-top:4px;">Please clear your browser data (IndexedDB) and refresh the page.</p><button onclick="location.reload()" style="padding:8px 24px;margin-top:12px;cursor:pointer;">Refresh</button></div></div>';
    }
}