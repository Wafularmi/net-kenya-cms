#!/usr/bin/env node
'use strict';

// Build-time precompression for the static JS/CSS assets. The server already
// knows how to serve a fresh .gz next to the original file and will create one
// on demand, but doing it here means the image ships ready to serve and the
// first visitor never pays the compression cost.
//
// Run from package.json:  npm run precompress
// Also executed by the Dockerfile after COPY.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['js', 'css'];
const EXTS = new Set(['.js', '.css']);
const MIN_BYTES = 512;

let written = 0;
let upToDate = 0;
let failed = 0;

function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile()) continue;
        if (!EXTS.has(path.extname(entry.name).toLowerCase())) continue;
        precompress(full);
    }
}

function precompress(file) {
    const gzPath = file + '.gz';
    try {
        const src = fs.statSync(file);
        if (src.size <= MIN_BYTES) return;
        if (fs.existsSync(gzPath)) {
            const gz = fs.statSync(gzPath);
            if (gz.mtimeMs >= src.mtimeMs) { upToDate++; return; }
        }
        const compressed = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
        fs.writeFileSync(gzPath, compressed);
        written++;
        console.log('precompress: ' + path.relative(ROOT, file) +
            ' ' + src.size + ' -> ' + compressed.length + ' bytes');
    } catch (e) {
        failed++;
        console.error('precompress failed (' + path.relative(ROOT, file) + '): ' + e.message);
    }
}

for (const dir of DIRS) walk(path.join(ROOT, dir));

console.log('precompress: ' + written + ' written, ' + upToDate + ' up to date, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
