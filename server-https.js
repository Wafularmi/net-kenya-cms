// HTTPS Server for NET CMS
// Wraps the existing server.js with TLS support
const https = require('https');
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

const CERTS_DIR = path.join(__dirname, 'certs');
const CERT_FILE = path.join(CERTS_DIR, 'server.crt');
const KEY_FILE = path.join(CERTS_DIR, 'server.key');

function log(msg) {
    console.log(`[HTTPS] ${new Date().toISOString()} - ${msg}`);
}

function generateSelfSignedCerts() {
    if (!fs.existsSync(CERTS_DIR)) {
        fs.mkdirSync(CERTS_DIR, { recursive: true });
    }

    if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
        const c = fs.readFileSync(CERT_FILE, 'utf8').trim();
        const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
        if (c && k) {
            log('Certificates already exist');
            return Promise.resolve();
        }
    }

    log('Generating self-signed certificates...');
    try {
        const keys = forge.pki.rsa.generateKeyPair(2048);
        const cert = forge.pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = Date.now().toString(16);
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date();
        cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);

        const attrs = [
            { name: 'countryName', value: 'KE' },
            { name: 'stateOrProvinceName', value: 'Nairobi' },
            { name: 'localityName', value: 'Nairobi' },
            { name: 'organizationName', value: 'NET Foundation Kenya' },
            { name: 'commonName', value: 'localhost' }
        ];
        cert.setSubject(attrs);
        cert.setIssuer(attrs);

        cert.setExtensions([
            { name: 'basicConstraints', cA: false },
            { name: 'keyUsage', keyCertSign: false, digitalSignature: true, keyEncipherment: true },
            { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
            { name: 'subjectAltName', altNames: [
                { type: 2, value: 'localhost' },
                { type: 7, ip: '127.0.0.1' }
            ]}
        ]);

        cert.sign(keys.privateKey, forge.md.sha256.create());

        const certPem = forge.pki.certificateToPem(cert);
        const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

        fs.writeFileSync(CERT_FILE, certPem, 'utf8');
        fs.writeFileSync(KEY_FILE, keyPem, 'utf8');
        log('Certificates generated successfully via node-forge');
    } catch (err) {
        log('Certificate generation failed: ' + err.message);
        fs.writeFileSync(CERT_FILE, '');
        fs.writeFileSync(KEY_FILE, '');
    }
    return Promise.resolve();
}

function createHttpsServer(originalServer) {
    return new Promise(async (resolve) => {
        await generateSelfSignedCerts();

        if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE) || 
            fs.readFileSync(CERT_FILE).length === 0) {
            log('WARNING: No valid certificates found, HTTPS disabled');
            resolve(null);
            return;
        }

        const options = {
            key: fs.readFileSync(KEY_FILE),
            cert: fs.readFileSync(CERT_FILE)
        };

        const HTTPS_PORT = parseInt(process.env.HTTPS_PORT) || 3443;

        const httpsServer = https.createServer(options, originalServer.listeners('request')[0]);

        httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
            log(`HTTPS server running on port ${HTTPS_PORT}`);
            resolve(httpsServer);
        });

        httpsServer.on('error', (e) => {
            if (e.code === 'EADDRINUSE') {
                const alt = HTTPS_PORT + 1;
                log(`Port ${HTTPS_PORT} in use, trying ${alt}`);
                httpsServer.listen(alt, '0.0.0.0', () => {
                    log(`HTTPS server running on port ${alt}`);
                    resolve(httpsServer);
                });
            } else {
                log(`HTTPS error: ${e.message}`);
                resolve(null);
            }
        });
    });
}

module.exports = { createHttpsServer, generateSelfSignedCerts };
