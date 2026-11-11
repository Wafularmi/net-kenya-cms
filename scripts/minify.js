#!/usr/bin/env node
'use strict';

// Regenerate the committed browser bundles after editing js/bundle.js or
// js/student-hub.js:
//
//     npm run minify
//
// Terser is only a development tool. It is not a runtime dependency and the
// Docker build does not run this script; it serves the committed .min.js files
// (precompress.js then creates their .gz sidecars).
//
// Top-level names are intentionally NOT mangled because many HTML onclick
// handlers call app functions by name.

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TERSER_VERSION = '5.51.2';
const TARGETS = [
    { src: 'js/bundle.js', out: 'js/bundle.min.js' },
    { src: 'js/student-hub.js', out: 'js/student-hub.min.js' }
];

function run(args) {
    const result = spawnSync('npx', ['--yes', 'terser@' + TERSER_VERSION].concat(args), {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false
    });
    if (result.error) {
        console.error('minify: could not start npx: ' + result.error.message);
        process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status || 1);
}

for (const target of TARGETS) {
    console.log('minify: ' + target.src + ' -> ' + target.out);
    run([target.src, '--compress', 'passes=2', '--mangle', '--comments', 'false', '-o', target.out]);
}

console.log('minify: done (' + TARGETS.length + ' bundles)');
