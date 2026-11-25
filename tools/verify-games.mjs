#!/usr/bin/env node
/**
 * Checks that what is published still opens with the password in .env.
 *
 * This exists because the failure mode is silent. Change DYE_GAME_PASSWORD
 * without rebuilding and the published game stays on the old password; the
 * gate just says "Wrong password.", which looks like a typo rather than a
 * stale build. Run this after any password change, and before pushing.
 *
 * By default it checks the files as git has them at HEAD, which is what
 * GitHub Pages will actually serve. Pass --worktree to check the files on
 * disk instead, which is what you just built.
 *
 * The password is read from .env and never printed.
 *
 * Usage:  node tools/verify-games.mjs [--worktree]
 */

import { webcrypto as crypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';

import { ROOT, GAMES, MAGIC, loadDotEnv, human } from './build-games.mjs';

const run = promisify(execFile);
const HEADER_BYTES = 8 + 16 + 12 + 4;
const fromWorktree = process.argv.includes('--worktree');

/** The published file, either as git has it at HEAD or as it sits on disk. */
async function readPublished(game) {
  const rel = `${game.out}/index.pck.enc`;
  if (fromWorktree) {
    if (!existsSync(path.join(ROOT, rel))) {
      throw new Error(`${rel} is not on disk. Run the build first.`);
    }
    return new Uint8Array(await readFile(path.join(ROOT, rel)));
  }
  const { stdout } = await run('git', ['show', `HEAD:${rel}`], {
    cwd: ROOT, maxBuffer: 1 << 28, encoding: 'buffer',
  }).catch(() => {
    throw new Error(`${rel} is not committed at HEAD. Commit it, or pass --worktree.`);
  });
  return new Uint8Array(stdout);
}

async function verify(game, password) {
  const buf = await readPublished(game);

  if (buf.length < HEADER_BYTES) throw new Error('File is too short to be a container.');
  const magic = new TextDecoder().decode(buf.slice(0, 8));
  if (magic !== MAGIC) {
    throw new Error(`Not one of our containers (magic ${JSON.stringify(magic)}).`);
  }

  const salt = buf.slice(8, 24);
  const iv = buf.slice(24, 36);
  const iterations = new DataView(buf.buffer, buf.byteOffset).getUint32(36, true);
  const body = buf.slice(HEADER_BYTES);

  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );

  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body));
  } catch {
    // AES-GCM surfaces a tag mismatch as a bare OperationError, so this is
    // the only thing it can mean: the file was built with another password.
    throw new Error(
      'does NOT open with the password in .env — it was built with an older one.\n' +
      '    Re-run: node tools/build-games.mjs',
    );
  }

  // A Godot pack starts with GDPC. Proof we decrypted the real thing and not
  // 1.4MB of plausible-looking noise.
  const header = new TextDecoder().decode(plain.slice(0, 4));
  if (header !== 'GDPC') {
    throw new Error(`decrypted, but this is not a Godot pack (header ${JSON.stringify(header)}).`);
  }

  // Only possible while the local export is still around; after a fresh
  // clone there is nothing to compare against, which is not a failure.
  const srcPath = path.join(ROOT, game.src, 'index.pck');
  let matches = null;
  if (existsSync(srcPath)) {
    const src = new Uint8Array(await readFile(srcPath));
    matches = src.length === plain.length && src.every((b, i) => b === plain[i]);
  }

  return { size: plain.length, iterations, matches };
}

async function main() {
  await loadDotEnv();
  const password = process.env.DYE_GAME_PASSWORD;
  if (!password) {
    console.error('DYE_GAME_PASSWORD is not set. Put it in .env (gitignored).');
    process.exit(1);
  }

  console.log(
    `Checking ${fromWorktree ? 'the files on disk' : 'the files committed at HEAD'} ` +
    `against the password in .env (${password.length} characters):`,
  );

  let failed = 0;
  for (const game of GAMES) {
    try {
      const { size, iterations, matches } = await verify(game, password);
      const note = matches === false
        ? ' — but it does NOT match the local export, so the build is behind'
        : matches === true ? ', identical to the local export' : '';
      console.log(
        `  ${game.name}: opens, ${human(size)} Godot pack ` +
        `(${iterations.toLocaleString()} rounds)${note}`,
      );
      if (matches === false) failed++;
    } catch (err) {
      console.error(`  ${game.name}: ${err.message}`);
      failed++;
    }
  }

  if (failed) {
    console.error(`\n${failed} of ${GAMES.length} failed. Do not push this.`);
    process.exit(1);
  }
  console.log('\nAll good.');
}

main();
