#!/usr/bin/env node
/**
 * Serves this repo over HTTPS on the local network, for trying the gated
 * game on a phone.
 *
 * It has to be HTTPS. The gate derives its key with WebCrypto, and browsers
 * only expose crypto.subtle in a secure context: https, or localhost. Over
 * plain http on a LAN address the gate cannot work at all, and says so.
 *
 * So this generates a self-signed certificate with the machine's current LAN
 * address in the SAN — the phone needs the IP in there, and the address
 * changes with the network, so it is regenerated when it no longer matches.
 * Safari will still warn, since nothing has signed it: Show Details ->
 * visit this website. Once past the warning the origin is https and the
 * gate works.
 *
 * Usage:  node tools/serve-local.mjs [--port 8443]
 */

import { createServer } from 'node:https';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = path.join(ROOT, 'certs');
const portArg = process.argv.indexOf('--port');
const PORT = portArg === -1 ? 8443 : Number(process.argv[portArg + 1]);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.enc': 'application/octet-stream',
};

/** The address the phone will dial. Wi-Fi first, then wired. */
function lanAddress() {
  const nets = networkInterfaces();
  for (const name of ['en0', 'en1', ...Object.keys(nets)]) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

/** One certificate per address, regenerated when the network changes. */
function ensureCert(ip) {
  const crt = path.join(CERT_DIR, 'dev.crt');
  const key = path.join(CERT_DIR, 'dev.key');

  const current = existsSync(crt) && (() => {
    try {
      const text = execFileSync('openssl', ['x509', '-in', crt, '-noout', '-text'],
        { encoding: 'utf8' });
      return text.includes(`IP Address:${ip}`);
    } catch { return false; }
  })();

  if (!current) {
    console.log(`Making a certificate for ${ip} …`);
    execFileSync('mkdir', ['-p', CERT_DIR]);
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', crt, '-days', '825',
      '-subj', `/CN=${ip}`,
      '-addext', `subjectAltName=IP:${ip},DNS:localhost`,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
  }
  return { crt, key };
}

const ip = lanAddress();
if (!ip) {
  console.error('No network address found. Are you on Wi-Fi?');
  process.exit(1);
}

const { crt, key } = ensureCert(ip);

createServer({
  cert: await readFile(crt),
  key: await readFile(key),
}, async (req, res) => {
  try {
    const rel = decodeURIComponent(new URL(req.url, 'https://localhost').pathname);
    let file = path.join(ROOT, rel);

    // Nothing outside the repo, and never the certificate or the password.
    if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
      res.writeHead(403).end('no'); return;
    }
    if (rel.startsWith('/certs') || rel.startsWith('/.env')) {
      res.writeHead(403).end('no'); return;
    }

    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = path.join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info) { res.writeHead(404).end('not found'); return; }

    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
    console.log(`  ${res.statusCode} ${rel}`);
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`\nServing ${ROOT}\n`);
  console.log(`  this machine:  https://localhost:${PORT}/games/calendar/`);
  console.log(`  the phone:     https://${ip}:${PORT}/games/calendar/`);
  console.log('\nSame Wi-Fi on both. Safari will warn about the certificate:');
  console.log('Show Details -> visit this website. Ctrl-C stops the server.\n');
});
