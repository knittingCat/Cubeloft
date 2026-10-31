#!/usr/bin/env node
// Open any diorama by id in your browser, private ones included. Needs an admin account:
//   CUBELOFT_USER=Claude CUBELOFT_PASSWORD=... node scripts/open-diorama.mjs 12
// Options: --site URL (default https://cubeloft.onrender.com), --print (show the link instead of opening it).
// The diorama opens view-only, as a shared link (#s=...), so nothing is saved or changed.
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const site = (value('--site') || 'https://cubeloft.onrender.com').replace(/\/$/, '');
const id = args.find((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--site');
const { CUBELOFT_USER: username, CUBELOFT_PASSWORD: password } = process.env;

if (!id || !username || !password) {
  console.error('Usage: CUBELOFT_USER=<admin> CUBELOFT_PASSWORD=<password> node scripts/open-diorama.mjs <id> [--site URL] [--print]');
  process.exit(1);
}

const headers = { 'content-type': 'application/json', 'x-requested-with': 'blockscape' };
const login = await fetch(`${site}/api/login`, { method: 'POST', headers, body: JSON.stringify({ username, password }) });
if (!login.ok) {
  console.error(`Sign-in failed (${login.status}): ${(await login.json().catch(() => ({}))).error || 'unknown error'}`);
  process.exit(1);
}
const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

const res = await fetch(`${site}/api/dioramas/${id}`, { headers: { ...headers, cookie } });
const d = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Could not get diorama ${id} (${res.status}): ${d.error || 'unknown error'}`);
  process.exit(1);
}

const url = `${site}/#s=${d.data}`;
console.error(`Diorama ${d.id}: "${d.title}" by ${d.owner} (${d.visibility})`);
if (flag('--print')) console.log(url);
else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
