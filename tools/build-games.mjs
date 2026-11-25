#!/usr/bin/env node
/**
 * Builds the password-gated games area.
 *
 * A Godot web export is ten files, but only one of them is the game:
 * index.pck holds every scene, script and asset. index.wasm and index.js
 * are the stock engine, identical to anyone else's export of the same
 * Godot version, so there is nothing to hide there.
 *
 * So: encrypt the .pck, copy the engine as-is, and ship no artwork.
 * The gate page decrypts the .pck in the browser and hands the bytes to
 * the engine, which means the game never exists in readable form on a
 * public server.
 *
 * Usage:  DYE_GAME_PASSWORD=... node tools/build-games.mjs
 *         (or put DYE_GAME_PASSWORD=... in .env, which is gitignored)
 */

import { webcrypto as crypto } from 'node:crypto';
import { readFile, writeFile, copyFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Games to build: source export directory -> published directory.
 *
 * The published name is deliberately generic. It appears in the URL, which
 * is public whether or not the game behind it is, so it should not give
 * away a title that is still under wraps.
 */
export const GAMES = [
  { name: 'calendar', src: 'games-src/calendar', out: 'games/calendar' },
];

/**
 * Files that are safe to publish in the clear. The engine is stock Godot,
 * and the splash and icons are the studio logo, which is already on the
 * landing page — so they give nothing away, and keeping them means the
 * boot screen in loading.css still works.
 *
 * If a game ever ships a splash made of its own art, drop it from this
 * list: anything here is served to anyone who guesses the URL.
 *
 * index.pck is the game itself and is never copied — it gets encrypted.
 */
const PUBLIC_ENGINE_FILES = [
  'index.js',
  'index.wasm',
  'index.audio.worklet.js',
  'index.audio.position.worklet.js',
  'loading.css',
  'index.png',
  'index.icon.png',
  'index.apple-touch-icon.png',
];

/**
 * 600k rounds matches what StatiCrypt uses, and is the point of the
 * exercise: the ciphertext is public, so an attacker can guess offline at
 * full speed. Stretching the key is the only thing standing between a
 * weak password and the game. Changing this number invalidates every
 * previously built file and every saved "remember me".
 */
export const PBKDF2_ITERATIONS = 600_000;
export const MAGIC = 'DYEPCK1\0';

/** Reads .env without pulling in a dependency. Only KEY=value lines. */
export async function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const text = await readFile(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^['"]|['"]$/g, '');
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
}

/**
 * Layout of the .enc file, all little-endian:
 *   magic (8 bytes) | salt (16) | iv (12) | iterations (uint32) | ciphertext+tag
 * The salt and iv are not secret; they have to travel with the file so the
 * browser can derive the same key.
 */
async function encryptPck(password, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );

  const header = new Uint8Array(8 + 16 + 12 + 4);
  header.set(new TextEncoder().encode(MAGIC), 0);
  header.set(salt, 8);
  header.set(iv, 24);
  new DataView(header.buffer).setUint32(36, PBKDF2_ITERATIONS, true);

  const out = new Uint8Array(header.length + ciphertext.length);
  out.set(header, 0);
  out.set(ciphertext, header.length);
  return out;
}

export function human(bytes) {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.round(bytes / 1024)}KB`;
}

async function buildGame(game, password) {
  const srcDir = path.join(ROOT, game.src);
  const outDir = path.join(ROOT, game.out);

  if (!existsSync(srcDir)) {
    throw new Error(
      `No export found at ${game.src}. Export the Godot project to that folder first.`,
    );
  }
  await mkdir(outDir, { recursive: true });

  const present = await readdir(srcDir);

  // Debug exports are slower and expose a remote-debug console, so it is
  // worth saying out loud when one is about to be published.
  //
  // Do NOT test for "template_debug": release builds carry that string too,
  // in the table of feature names the engine can be asked about, so it is
  // present either way and always cried wolf. What actually differs is the
  // literal the engine appends to the window title, which only the debug
  // template contains.
  if (present.includes("index.wasm")) {
    const wasm = await readFile(path.join(srcDir, "index.wasm"));
    if (wasm.includes("(DEBUG)")) {
      console.warn("  ! This is a DEBUG export. Re-export as Release before sharing it.");
    } else if (!wasm.includes("template_release")) {
      console.warn("  ! Could not tell whether this is a Release export. Check the export dialog.");
    }
  }

  for (const file of PUBLIC_ENGINE_FILES) {
    if (!present.includes(file)) {
      throw new Error(`Export is missing ${file} — is ${game.src} a Godot web export?`);
    }
    await copyFile(path.join(srcDir, file), path.join(outDir, file));
  }

  const pck = await readFile(path.join(srcDir, 'index.pck'));
  const encrypted = await encryptPck(password, pck);
  await writeFile(path.join(outDir, 'index.pck.enc'), encrypted);

  console.log(`  ${game.name}: encrypted index.pck (${human(pck.length)}), copied ${PUBLIC_ENGINE_FILES.length} engine files`);
}

async function main() {
  await loadDotEnv();
  const password = process.env.DYE_GAME_PASSWORD;

  if (!password) {
    console.error('DYE_GAME_PASSWORD is not set. Put it in .env (gitignored) or pass it inline.');
    process.exit(1);
  }
  if (password.length < 16) {
    console.warn(
      `  ! Password is ${password.length} characters. The encrypted file is public, so it can be\n` +
      '    attacked offline at full speed. Fine for keeping a prototype off the open web;\n' +
      '    not enough if the contents ever actually matter.',
    );
  }

  console.log('Building games:');
  for (const game of GAMES) await buildGame(game, password);
  console.log('Done. Commit the games/ directory; games-src/ stays local.');
}

// Only build when run directly. verify-games.mjs imports the constants above
// so the two scripts can never disagree about the container format.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nBuild failed: ${err.message}`);
    process.exit(1);
  });
}
