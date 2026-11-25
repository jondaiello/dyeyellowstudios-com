# Publishing a password-protected game

GitHub Pages has no server, so it cannot check a password. What it *can* do is
serve a file nobody can read without one.

A Godot web export is ten files, but only `index.pck` is the game — every
scene, script and asset. `index.wasm` and `index.js` are the stock engine,
byte-identical to anyone else's export of the same Godot version. So the build
encrypts the `.pck`, publishes the engine in the clear, and ships no artwork.
The gate page decrypts the pack in the browser (AES-256-GCM, key stretched from
the password with 600,000 rounds of PBKDF2-SHA256) and hands the bytes straight
to the engine, which never asks the server for them.

## One-time setup

Put the password in `.env` at the repo root. That file is gitignored.

```
DYE_GAME_PASSWORD=some-long-unusual-password
```

Longer is better. The encrypted file is public, so an attacker can guess
against it offline at full speed; the key stretching buys time, but a short
password loses anyway. The build warns under 16 characters and carries on —
fine for keeping a prototype off the open web, not enough if the contents
ever actually matter.

## Publishing a new build

1. Export the Godot project to `games-src/<game>/` — **Release**, not Debug.
   (Debug exports are ~36MB, slower, and announce themselves in the window
   title. The build script warns if it spots one.)
2. `node tools/build-games.mjs`
3. `node tools/verify-games.mjs --worktree`
4. Commit `games/`. Never commit `games-src/` — it holds the readable `.pck`,
   and this repository is public.
5. `node tools/verify-games.mjs`, which checks what you actually committed,
   then push.

Adding a second game means a new entry in the `GAMES` array in
`tools/build-games.mjs`, a copy of `games/calendar/index.html` with
its title changed, and a card on `games/index.html`.

Keep the published folder name generic. It shows up in the URL, which is
public even when the game behind it isn't — as are this repository's file
names and commit messages, so a title you want kept quiet shouldn't appear
in any of them.

## Testing locally

WebCrypto only works in a secure context, so `file://` will not do:

```bash
cd /Users/jondaiello/Documents/dye-yellow-website && python3 -m http.server 8788
```

Then open http://localhost:8788/games/calendar/ .

## Changing the password

Edit `.env`, then **re-run the build** — changing the password alone does
nothing, because the published file is still encrypted with the old one. That
failure is silent: the gate answers a correct new password with "Wrong
password.", which reads like a typo rather than a stale build. So:

```bash
node tools/build-games.mjs && node tools/verify-games.mjs --worktree
```

Everyone's saved "remember me" key stops working the moment the file is
re-encrypted, because the salt and key change with it — which is also how you
revoke access.

Visiting `/games/calendar/?logout` clears a saved key on that device.

## What this does and doesn't protect

It protects the game. Without the password, `index.pck.enc` is noise, and the
engine files give away nothing a Godot download doesn't.

It is still one shared password with no accounts, so you cannot revoke one
person without changing it for everyone, and whoever has it can pass it on.
"Remember me" stores the derived key in that browser's localStorage, which
decrypts the game on its own — a convenience, not a second factor.

If this ever needs real per-person access, the move is to put the domain behind
Cloudflare and gate `/games/*` with Cloudflare Access, which authenticates
every file instead of just this one.

## Checking a build

`node tools/verify-games.mjs` decrypts the published pack with the password in
`.env` and confirms it is a real Godot pack, byte-identical to the local
export. It reads the password from `.env` and never prints it.

By default it checks the files **as git has them at HEAD** — what GitHub Pages
will serve. Pass `--worktree` to check what you just built instead. It exits
non-zero if anything is off, so it is worth running before every push.
