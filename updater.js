// Auto-Updater for NET CMS
// Checks for updates, downloads, and applies them safely
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');

const UPDATE_SERVER = process.env.UPDATE_SERVER || 'https://updates.netfoundation.com';
const CURRENT_VERSION = process.env.APP_VERSION || '1.0.0';
const ROOT = __dirname;
const DATA_ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;
const UPDATE_DIR = path.join(DATA_ROOT, 'update-temp');
const BACKUP_DIR = path.join(DATA_ROOT, 'update-backup');

function log(msg) {
    console.log(`[Updater] ${new Date().toISOString()} - ${msg}`);
}

function checkForUpdates() {
    return new Promise((resolve, reject) => {
        const url = `${UPDATE_SERVER}/version.json?v=${CURRENT_VERSION}`;
        log(`Checking for updates: ${url}`);
        
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (res.statusCode !== 200) {
                return resolve(null);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    if (info.version && info.version !== CURRENT_VERSION) {
                        resolve(info);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', (e) => {
            log(`Update check failed: ${e.message}`);
            resolve(null);
        });
    });
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(dest);
        client.get(url, (res) => {
            if (res.statusCode === 302 || res.statusCode === 301) {
                downloadFile(res.headers.location, dest).then(resolve).catch(reject);
                return;
            }
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve(dest);
            });
        }).on('error', reject);
    });
}

async function applyUpdate(updateInfo) {
    log(`Downloading update: ${updateInfo.version}`);
    
    // Create temp directory
    if (!fs.existsSync(UPDATE_DIR)) fs.mkdirSync(UPDATE_DIR, { recursive: true });
    
    const zipPath = path.join(UPDATE_DIR, 'update.zip');
    
    try {
        await downloadFile(updateInfo.downloadUrl, zipPath);
        log('Download complete, extracting...');
        
        // Extract using built-in or external tool
        const extractResult = await extractZip(zipPath, UPDATE_DIR);
        if (!extractResult) {
            log('Extraction failed');
            return false;
        }
        
        // Backup current files
        if (fs.existsSync(BACKUP_DIR)) {
            fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
        }
        copyDirSync(ROOT, BACKUP_DIR, ['node_modules', 'update-temp', 'update-backup', 'server-data.json']);
        log('Backup created');
        
        // Apply update
        copyDirSync(UPDATE_DIR, ROOT, ['update-temp', 'update-backup', 'node_modules']);
        log(`Updated to version ${updateInfo.version}`);
        
        // Clean up
        fs.rmSync(UPDATE_DIR, { recursive: true, force: true });
        
        return true;
    } catch (e) {
        log(`Update failed: ${e.message}`);
        return false;
    }
}

function extractZip(zipPath, dest) {
    return new Promise((resolve) => {
        // Try using PowerShell to extract (built into Windows)
        const ps = spawn('powershell', [
            '-Command',
            `Expand-Archive -Path '${zipPath}' -DestinationPath '${dest}' -Force`
        ]);
        ps.on('close', (code) => {
            resolve(code === 0);
        });
        ps.on('error', () => resolve(false));
    });
}

function copyDirSync(src, dest, exclude = []) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        if (exclude.includes(entry.name)) continue;
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(srcPath, destPath, exclude);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function restartServer() {
    log('Restarting server...');
    if (process.pkg) {
        const exePath = process.execPath;
        const child = spawn(exePath, [], {
            detached: true,
            stdio: 'ignore',
            cwd: DATA_ROOT
        });
        child.unref();
        process.exit(0);
    } else {
        const serverPath = path.join(ROOT, 'server.js');
        const child = spawn('node', [serverPath], {
            detached: true,
            stdio: 'ignore',
            cwd: ROOT
        });
        child.unref();
        process.exit(0);
    }
}

// Main update loop
async function runUpdateCheck() {
    try {
        const update = await checkForUpdates();
        if (update) {
            log(`New version available: ${update.version}`);
            const success = await applyUpdate(update);
            if (success) {
                log('Update applied successfully, restarting...');
                // Give time for logs to flush
                setTimeout(restartServer, 2000);
            } else {
                log('Update failed, will retry later');
            }
        } else {
            log('Already up to date');
        }
    } catch (e) {
        log(`Update check error: ${e.message}`);
    }
}

// First check after 30s (allows server to start), then every 6 hours
setTimeout(runUpdateCheck, 30000);
setInterval(runUpdateCheck, 6 * 60 * 60 * 1000);

module.exports = { checkForUpdates, applyUpdate };
