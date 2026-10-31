// Runs the real server against throw-away tables (zz_test_*) in the Neon database from .env, then drops them.
process.env.TABLE_PREFIX = 'zz_test_';
process.env.FEEDBACK_READER = 'dee_admin'; // stands in for the Claude account
import assert from 'node:assert/strict';
import http from 'node:http';

// A stand-in for maxos: answers /api/auth/me for a few made-up tokens.
const maxosStub = http.createServer((req, res) => {
  const t = (req.headers.authorization || '').split(' ')[1] || '';
  const who = { 'aaa.bbb.ann': { username: 'ann' }, 'aaa.bbb.zed': { username: 'Zed.Q' }, 'aaa.bbb.unverified': { username: 'newbie', mustVerifyEmail: true } }[t];
  res.writeHead(who ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(who || { error: 'Invalid or expired token' }));
});
await new Promise((r) => maxosStub.listen(0, '127.0.0.1', r));
process.env.MAXOS_ORIGIN = `http://127.0.0.1:${maxosStub.address().port}`;

const { createApp } = await import('../server/index.js');
const { initDb, dropAll, query, T, pool } = await import('../server/db.js');

await dropAll();
await initDb();
const server = createApp().listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

let n = 0;
const test = async (name, fn) => {
  await fn();
  n++;
  console.log('ok -', name);
};

class Client {
  constructor() {
    this.cookie = '';
  }
  async call(method, path, body, { csrf = true } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (csrf) headers['x-requested-with'] = 'blockscape';
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(base + path, { method, headers, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json, headers: res.headers };
  }
}
const DATA = 'zAAAAAAAAAAAAAAAAAAAAAA';

try {
  const ann = new Client();
  const ben = new Client();
  const cat = new Client();

  await test('static site is served and server files are not', async () => {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/style.css')).status, 200);
    assert.equal((await fetch(base + '/src/world.js')).status, 200);
    for (const p of ['/.env', '/server/index.js', '/package.json', '/src/../.env', '/server/db.js']) {
      const r = await fetch(base + p);
      assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
    }
    const csp = (await fetch(base + '/')).headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' 'sha256-/);
  });

  await test('sign up validation and duplicates', async () => {
    assert.equal((await ann.call('POST', '/api/signup', { username: 'a', password: 'longenough1' })).status, 400);
    assert.equal((await ann.call('POST', '/api/signup', { username: 'ann', password: 'short' })).status, 400);
    assert.equal((await ann.call('POST', '/api/signup', { username: 'admin', password: 'longenough1' })).status, 400);
    const ok = await ann.call('POST', '/api/signup', { username: 'Ann', password: 'longenough1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.username, 'Ann'); // capitalization is kept
    assert.equal((await new Client().call('POST', '/api/signup', { username: 'ANN', password: 'longenough1' })).status, 409); // same name, different case
    assert.equal((await new Client().call('POST', '/api/signup', { username: 'aNn', password: 'longenough1' })).status, 409);
  });

  await test('session cookie works, logout and login', async () => {
    const me = await ann.call('GET', '/api/me');
    assert.equal(me.json.user.username, 'Ann');
    assert.equal(me.json.user.isAdmin, false);
    assert.equal((await new Client().call('GET', '/api/me')).json.user, null);
    assert.equal((await ann.call('POST', '/api/logout', {})).status, 200);
    assert.equal((await ann.call('GET', '/api/me')).json.user, null);
    assert.equal((await ann.call('POST', '/api/login', { username: 'ann', password: 'wrong-password' })).status, 401);
    assert.equal((await ann.call('POST', '/api/login', { username: 'nobody', password: 'wrong-password' })).status, 401);
    assert.equal((await ann.call('POST', '/api/login', { username: 'ANN', password: 'longenough1' })).status, 200);
    assert.equal((await ann.call('GET', '/api/me')).json.user.username, 'Ann'); // logging in with ANN still shows Ann
  });

  await test('passwords are stored hashed, tokens are stored hashed', async () => {
    const { rows } = await query(`SELECT password_hash FROM ${T.users} WHERE username = 'Ann'`);
    assert.match(rows[0].password_hash, /^s1:[0-9a-f]+:[0-9a-f]+$/);
    assert.ok(!rows[0].password_hash.includes('longenough1'));
    const s = await query(`SELECT token_hash FROM ${T.sessions}`);
    assert.ok(s.rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
  });

  await test('requests without the CSRF header are refused', async () => {
    assert.equal((await ann.call('POST', '/api/logout', {}, { csrf: false })).status, 403);
    assert.equal((await ann.call('GET', '/api/me')).json.user.username, 'Ann'); // logging in with ANN still shows Ann // still signed in
  });

  await test('everything needs a session', async () => {
    const anon = new Client();
    for (const [m, p] of [['GET', '/api/dioramas/mine'], ['POST', '/api/dioramas'], ['GET', '/api/classes']]) {
      assert.equal((await anon.call(m, p, {})).status, 401, `${m} ${p}`);
    }
  });

  await test('the gallery and feedback need no session', async () => {
    const anon = new Client();
    assert.equal((await anon.call('GET', '/api/gallery')).status, 200);
    assert.equal((await anon.call('GET', '/api/dioramas/1')).status, 404); // not in the gallery (or missing): nothing leaks
  });

  let privateId;
  await test('save a private diorama; nobody else can see it', async () => {
    assert.equal((await ann.call('POST', '/api/dioramas', { title: '', data: DATA, visibility: 'private' })).status, 400);
    assert.equal((await ann.call('POST', '/api/dioramas', { title: 'x', data: '<script>', visibility: 'private' })).status, 400);
    assert.equal((await ann.call('POST', '/api/dioramas', { title: 'x', data: DATA, visibility: 'public' })).status, 400);
    assert.equal((await ann.call('POST', '/api/dioramas', { title: 'x', data: DATA, visibility: 'private', thumb: 'javascript:alert(1)' })).status, 400);
    const made = await ann.call('POST', '/api/dioramas', { title: 'My secret', data: DATA, visibility: 'private' });
    assert.equal(made.status, 200);
    privateId = made.json.id;
    assert.equal((await ben.call('POST', '/api/signup', { username: 'ben', password: 'longenough2' })).status, 200);
    assert.equal((await ben.call('GET', `/api/dioramas/${privateId}`)).status, 404);
    const mine = await ann.call('GET', '/api/dioramas/mine');
    assert.equal(mine.json.dioramas.length, 1);
    assert.equal((await ann.call('GET', `/api/dioramas/${privateId}`)).json.data, DATA);
    const gal = await ben.call('GET', '/api/gallery');
    assert.deepEqual(gal.json.recent, []);
  });

  let galleryId;
  await test('publish to the gallery; other users can open it', async () => {
    const made = await ann.call('POST', '/api/dioramas', { title: 'The Little House', data: DATA, visibility: 'gallery', thumb: 'data:image/jpeg;base64,AAAA' });
    galleryId = made.json.id;
    const gal = await ben.call('GET', '/api/gallery');
    assert.equal(gal.json.members[0].username, 'Ann');
    assert.equal(gal.json.recent.length, 1);
    assert.equal(gal.json.recent[0].locked, false);
    const open = await ben.call('GET', `/api/dioramas/${galleryId}`);
    assert.equal(open.status, 200);
    assert.equal(open.json.owner, 'Ann');
    assert.equal(open.json.mine, false);
    const anon = new Client(); // not signed in: can look too
    assert.equal((await anon.call('GET', '/api/gallery')).json.recent.length, 1);
    assert.equal((await anon.call('GET', `/api/dioramas/${galleryId}`)).json.mine, false);
    assert.equal((await anon.call('GET', '/api/gallery/ann')).json.dioramas.length, 1);
    const user = await ben.call('GET', '/api/gallery/ann');
    assert.equal(user.json.dioramas.length, 1);
  });

  await test('update only by the owner; limits on password-less edits', async () => {
    assert.equal((await ben.call('POST', '/api/dioramas', { id: galleryId, title: 'hijack', data: DATA, visibility: 'gallery' })).status, 404);
    assert.equal((await ann.call('POST', '/api/dioramas', { id: galleryId, title: 'The Little House v2', data: DATA, visibility: 'gallery' })).status, 200);
    assert.equal((await ann.call('GET', `/api/dioramas/${galleryId}`)).json.title, 'The Little House v2');
  });

  await test('gallery code: locked until the right code is entered', async () => {
    assert.equal((await ann.call('PUT', '/api/me/gallery-code', { code: 'ab' })).status, 400);
    assert.equal((await ann.call('PUT', '/api/me/gallery-code', { code: 'sesame' })).json.hasGalleryCode, true);
    const gal = await ben.call('GET', '/api/gallery');
    assert.equal(gal.json.members[0].locked, true);
    assert.equal(gal.json.recent[0].locked, true);
    assert.equal(gal.json.recent[0].thumb, null);
    const blocked = await ben.call('GET', `/api/dioramas/${galleryId}`);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.locked, 'gallery');
    const user = await ben.call('GET', '/api/gallery/ann');
    assert.equal(user.json.locked, 'gallery');
    assert.equal(user.json.dioramas, undefined);
    const ownerId = blocked.json.ownerId;
    assert.equal((await ben.call('POST', '/api/unlock', { kind: 'gallery', id: ownerId, code: 'nope' })).status, 403);
    assert.equal((await ben.call('POST', '/api/unlock', { kind: 'gallery', id: ownerId, code: 'sesame' })).status, 200);
    assert.equal((await ben.call('GET', `/api/dioramas/${galleryId}`)).status, 200);
    assert.equal((await ann.call('GET', '/api/gallery/ann')).json.dioramas.length, 1); // owner never locked out
  });

  await test('changing the code locks people out again; clearing it opens the gallery', async () => {
    await ann.call('PUT', '/api/me/gallery-code', { code: 'new-code' });
    assert.equal((await ben.call('GET', `/api/dioramas/${galleryId}`)).status, 403);
    await ann.call('PUT', '/api/me/gallery-code', { code: null });
    assert.equal((await ben.call('GET', `/api/dioramas/${galleryId}`)).status, 200);
  });

  await test('diorama code works on one diorama only', async () => {
    const coded = await ann.call('POST', '/api/dioramas', { title: 'Secret door', data: DATA, visibility: 'gallery', code: 'knock' });
    const id = coded.json.id;
    const r = await ben.call('GET', `/api/dioramas/${id}`);
    assert.equal(r.status, 403);
    assert.equal(r.json.locked, 'diorama');
    const list = await ben.call('GET', '/api/gallery/ann');
    const item = list.json.dioramas.find((d) => d.id === id);
    assert.equal(item.locked, true);
    assert.equal(list.json.dioramas.find((d) => d.id === galleryId).locked, false);
    assert.equal((await ben.call('POST', '/api/unlock', { kind: 'diorama', id, code: 'bad' })).status, 403);
    assert.equal((await ben.call('POST', '/api/unlock', { kind: 'diorama', id, code: 'knock' })).status, 200);
    assert.equal((await ben.call('GET', `/api/dioramas/${id}`)).status, 200);
    assert.equal((await ann.call('POST', '/api/dioramas', { id, title: 'Secret door', data: DATA, visibility: 'gallery', code: '' })).status, 200);
  });

  await test('reports', async () => {
    assert.equal((await ben.call('POST', '/api/report', { dioramaId: galleryId, reason: '' })).status, 400);
    assert.equal((await ben.call('POST', '/api/report', { dioramaId: galleryId, reason: 'Rude sign' })).status, 200);
    assert.equal((await ben.call('POST', '/api/report', { dioramaId: galleryId, reason: 'Rude sign again' })).status, 200); // duplicate is ignored
    assert.equal((await ann.call('POST', '/api/report', { dioramaId: galleryId, reason: 'mine' })).status, 400);
    assert.equal((await ben.call('POST', '/api/report', { dioramaId: privateId, reason: 'x' })).status, 404); // can't even see private ones
    const { rows } = await query(`SELECT reason FROM ${T.reports}`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'Rude sign');
  });

  await test('delete: owner yes, stranger no, admin yes', async () => {
    assert.equal((await ben.call('DELETE', `/api/dioramas/${galleryId}`)).status, 403);
    assert.equal((await cat.call('POST', '/api/signup', { username: 'cat_mod', password: 'longenough3' })).status, 200);
    await query(`UPDATE ${T.users} SET is_admin = TRUE WHERE username = 'cat_mod'`);
    assert.equal((await cat.call('GET', '/api/me')).json.user.isAdmin, true);
    assert.equal((await cat.call('DELETE', `/api/dioramas/${galleryId}`)).status, 200);
    assert.equal((await ann.call('GET', `/api/dioramas/${galleryId}`)).status, 404);
    assert.equal((await ann.call('DELETE', `/api/dioramas/${privateId}`)).status, 200);
    const left = await query(`SELECT COUNT(*)::int AS n FROM ${T.reports}`);
    assert.equal(left.rows[0].n, 0); // reports go away with the diorama
  });

  await test('reports about a non-admin go to admins; admins review them in the app', async () => {
    // cat_mod is an admin (from the test above). ann (not admin) owns the gallery diorama made earlier? it was deleted, so make one.
    const made = await ann.call('POST', '/api/dioramas', { title: 'Ann scene', data: DATA, visibility: 'gallery' });
    assert.equal(made.status, 200);
    assert.equal((await ben.call('POST', '/api/report', { dioramaId: made.json.id, reason: 'Odd sign' })).status, 200);
    const mod = await cat.call('GET', '/api/reports');
    assert.equal(mod.json.reports.length, 1);
    assert.equal(mod.json.reports[0].title, 'Ann scene');
    assert.equal(mod.json.reports[0].reporter, 'ben'); // admins see who reported
    assert.equal((await cat.call('GET', '/api/me')).json.user.pendingReports, 1);
    assert.equal((await ann.call('GET', '/api/reports')).json.reports.length, 0); // the owner never sees reports about herself
    assert.equal((await ben.call('GET', '/api/reports')).json.reports.length, 0); // not an admin, not assigned
    const rid = mod.json.reports[0].id;
    assert.equal((await ben.call('POST', `/api/reports/${rid}/action`, { action: 'dismiss' })).status, 404);
    assert.equal((await cat.call('POST', `/api/reports/${rid}/action`, { action: 'hide' })).status, 200);
    assert.equal((await cat.call('GET', '/api/reports')).json.reports.length, 0);
    assert.equal((await ben.call('GET', `/api/dioramas/${made.json.id}`)).status, 404); // hidden from the gallery now
    assert.equal((await ann.call('GET', `/api/dioramas/${made.json.id}`)).json.visibility, 'private');
    assert.equal((await cat.call('GET', '/api/me')).json.user.pendingReports, 0);
  });

  await test('a report about an admin goes to ANOTHER admin, never the owner or the reporter', async () => {
    const dee = new Client();
    await dee.call('POST', '/api/signup', { username: 'dee_admin', password: 'longenough4' });
    await query(`UPDATE ${T.users} SET is_admin = TRUE WHERE username = 'dee_admin'`);
    const made = await dee.call('POST', '/api/dioramas', { title: 'Dee scene', data: DATA, visibility: 'gallery' });
    assert.equal((await ben.call('POST', '/api/report', { dioramaId: made.json.id, reason: 'Bad word' })).status, 200);
    const { rows } = await query(`SELECT r.id, u.username FROM ${T.reports} r JOIN ${T.users} u ON u.id = r.assigned_to WHERE r.diorama_id = $1`, [made.json.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].username, 'cat_mod'); // the only other admin
    assert.equal((await dee.call('GET', '/api/reports')).json.reports.length, 0); // dee never sees reports about her own diorama
    const seen = await cat.call('GET', '/api/reports');
    assert.equal(seen.json.reports.length, 1);
    assert.equal(seen.json.reports[0].pickedForYou, true);
    assert.equal((await cat.call('POST', `/api/reports/${rows[0].id}/action`, { action: 'dismiss' })).status, 200);
    assert.equal((await cat.call('GET', '/api/reports')).json.reports.length, 0);
    const done = await query(`SELECT status, handled_by FROM ${T.reports} WHERE id = $1`, [rows[0].id]);
    assert.equal(done.rows[0].status, 'dismissed');
    assert.ok(done.rows[0].handled_by);
  });

  await test('with no other admin, the report goes to a random other person who can review it', async () => {
    await query(`UPDATE ${T.users} SET is_admin = FALSE WHERE username = 'cat_mod'`); // dee is now the only admin
    const dee = new Client();
    assert.equal((await dee.call('POST', '/api/login', { username: 'dee_admin', password: 'longenough4' })).status, 200);
    const made = await dee.call('POST', '/api/dioramas', { title: 'Dee second', data: DATA, visibility: 'gallery' });
    assert.equal((await ann.call('POST', '/api/report', { dioramaId: made.json.id, reason: 'Not nice' })).status, 200);
    const { rows } = await query(`SELECT r.id, u.username FROM ${T.reports} r JOIN ${T.users} u ON u.id = r.assigned_to WHERE r.diorama_id = $1`, [made.json.id]);
    assert.equal(rows.length, 1);
    assert.ok(['ben', 'cat_mod'].includes(rows[0].username), `picked ${rows[0].username}`); // not dee (owner), not Ann (reporter)
    const reviewer = rows[0].username === 'ben' ? ben : cat;
    const other = rows[0].username === 'ben' ? cat : ben;
    const list = await reviewer.call('GET', '/api/reports');
    assert.equal(list.json.reports.length, 1);
    assert.equal(list.json.reports[0].reporter, null); // a picked person does not see who reported
    assert.equal((await other.call('GET', '/api/reports')).json.reports.length, 0);
    // the picked person may open it even though they are not an admin; hide it first so only reviewers can
    await query(`UPDATE ${T.dioramas} SET visibility = 'private' WHERE id = $1`, [made.json.id]);
    assert.equal((await reviewer.call('GET', `/api/dioramas/${made.json.id}`)).status, 200);
    assert.equal((await other.call('GET', `/api/dioramas/${made.json.id}`)).status, 404);
    assert.equal((await reviewer.call('POST', `/api/reports/${rows[0].id}/action`, { action: 'delete' })).status, 200);
    assert.equal((await dee.call('GET', `/api/dioramas/${made.json.id}`)).status, 404); // gone
  });

  await test('if nobody else can be picked, the report stays unassigned (for Claude), not with the owner', async () => {
    const dee = new Client();
    assert.equal((await dee.call('POST', '/api/login', { username: 'dee_admin', password: 'longenough4' })).status, 200);
    const made = await dee.call('POST', '/api/dioramas', { title: 'Dee third', data: DATA, visibility: 'gallery' });
    // as if Ann reported it when she was the only other person: nobody was picked
    const who = await query(`SELECT id FROM ${T.users} WHERE LOWER(username) = 'ann'`);
    await query(`INSERT INTO ${T.reports} (diorama_id, reporter_id, reason) VALUES ($1,$2,'Only one')`, [made.json.id, who.rows[0].id]);
    const list = await dee.call('GET', '/api/reports');
    assert.equal(list.json.reports.length, 0); // not the owner
    assert.equal((await ann.call('GET', '/api/reports')).json.reports.length, 0); // not the reporter
    assert.equal((await ben.call('GET', '/api/reports')).json.reports.length, 0);
    assert.equal((await dee.call('GET', '/api/me')).json.user.pendingReports, 0);
    const left = await query(`SELECT status, assigned_to FROM ${T.reports} WHERE diorama_id = $1`, [made.json.id]);
    assert.deepEqual(left.rows, [{ status: 'open', assigned_to: null }]); // waiting for Claude in the database
  });

  await test('a saved gallery diorama opens by link without signing in; private and code-protected ones do not', async () => {
    const anon = new Client();
    const pub = await ann.call('POST', '/api/dioramas', { title: 'Link me', data: DATA, visibility: 'gallery' });
    const ok = await anon.call('GET', `/api/dioramas/${pub.json.id}/public`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.title, 'Link me');
    assert.equal(ok.json.mine, false);
    assert.equal((await ann.call('GET', `/api/dioramas/${pub.json.id}/public`)).json.mine, true);
    const priv = await ann.call('POST', '/api/dioramas', { title: 'Hidden', data: DATA, visibility: 'private' });
    assert.equal((await anon.call('GET', `/api/dioramas/${priv.json.id}/public`)).status, 404);
    const coded = await ann.call('POST', '/api/dioramas', { title: 'Coded', data: DATA, visibility: 'gallery', code: 'secret1' });
    assert.equal((await anon.call('GET', `/api/dioramas/${coded.json.id}/public`)).status, 404);
    assert.equal((await anon.call('GET', '/api/dioramas/99999/public')).status, 404);
    assert.equal((await anon.call('GET', '/api/dioramas/abc/public')).status, 404);
  });

  await test('reports can be sent without signing in (once per address), and admins see them', async () => {
    const anon = new Client();
    const pub = await ann.call('POST', '/api/dioramas', { title: 'Anon target', data: DATA, visibility: 'gallery' });
    assert.equal((await anon.call('POST', '/api/report', { dioramaId: pub.json.id, reason: '' })).status, 400);
    assert.equal((await anon.call('POST', '/api/report', { dioramaId: 999999, reason: 'x' })).status, 404);
    const priv = await ann.call('POST', '/api/dioramas', { title: 'Anon private', data: DATA, visibility: 'private' });
    assert.equal((await anon.call('POST', '/api/report', { dioramaId: priv.json.id, reason: 'x' })).status, 404);
    assert.equal((await anon.call('POST', '/api/report', { dioramaId: pub.json.id, reason: 'Rude title' })).status, 200);
    assert.equal((await anon.call('POST', '/api/report', { dioramaId: pub.json.id, reason: 'Again' })).status, 200); // accepted but not stored twice
    const { rows } = await query(`SELECT reporter_id, reporter_ip, reason FROM ${T.reports} WHERE diorama_id = $1`, [pub.json.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reporter_id, null);
    assert.ok(rows[0].reporter_ip && !rows[0].reporter_ip.includes('127.0.0.1')); // only a hash is kept
    const dee = new Client();
    assert.equal((await dee.call('POST', '/api/login', { username: 'dee_admin', password: 'longenough4' })).status, 200);
    const list = await dee.call('GET', '/api/reports');
    const mine = list.json.reports.find((r) => r.dioramaId === pub.json.id);
    assert.ok(mine, 'an admin sees the anonymous report');
    assert.equal(mine.reporter, 'someone not signed in');
    assert.equal((await ben.call('GET', '/api/reports')).json.reports.length, 0); // non-admins see nothing
  });

  await test('feedback: one open conversation each; only the reader account (dee_admin here) sees everyone\'s', async () => {
    assert.equal((await new Client().call('POST', '/api/feedback', { kind: 'bogus', message: 'x' })).status, 400); // signed out is allowed, but still validated
    assert.equal((await new Client().call('GET', '/api/feedback')).status, 401); // reading is not
    assert.equal((await ben.call('POST', '/api/feedback', { kind: 'bogus', message: 'x' })).status, 400);
    assert.equal((await ben.call('POST', '/api/feedback', { kind: 'error', message: '  ' })).status, 400);
    const first = await ben.call('POST', '/api/feedback', { kind: 'feature', message: 'Add doors' });
    assert.equal(first.status, 200);
    const second = await ben.call('POST', '/api/feedback', { kind: 'error', message: 'Save failed' });
    assert.equal(second.status, 409); // only one at a time
    assert.equal(second.json.id, first.json.id);
    assert.equal((await ben.call('GET', '/api/feedback')).json.feedback.length, 1); // everyone sees their own
    assert.equal((await ann.call('GET', '/api/feedback')).json.feedback.length, 0); // but not other people's
    const cat = new Client(); // an admin, but not the reader account
    assert.equal((await cat.call('POST', '/api/login', { username: 'cat_mod', password: 'longenough3' })).status, 200);
    assert.equal((await cat.call('GET', '/api/feedback')).json.feedback.length, 0);
    assert.equal((await cat.call('GET', `/api/feedback/${first.json.id}`)).status, 404);
    assert.equal((await cat.call('GET', '/api/me')).json.user.feedbackReader, false);
    const dee = new Client();
    assert.equal((await dee.call('POST', '/api/login', { username: 'dee_admin', password: 'longenough4' })).status, 200);
    assert.equal((await dee.call('GET', '/api/me')).json.user.feedbackReader, true);
    const list = await dee.call('GET', '/api/feedback');
    assert.deepEqual(list.json.feedback.map((f) => f.kind), ['feature']);
    assert.equal((await ann.call('POST', `/api/feedback/${first.json.id}/done`)).status, 404); // a stranger cannot even see it
    assert.equal((await dee.call('POST', `/api/feedback/${first.json.id}/done`)).status, 200);
    assert.equal((await dee.call('GET', '/api/feedback')).json.feedback.length, 0);
    assert.equal((await ben.call('POST', '/api/feedback', { kind: 'error', message: 'Save failed' })).status, 200); // closed, so a new one is fine
  });

  await test('feedback chat: sender and admins reply to each other until it is closed; unread counts follow', async () => {
    const mine = (await ben.call('GET', '/api/feedback')).json.feedback;
    const id = mine.find((f) => f.status === 'open').id;
    const closed = mine.find((f) => f.status === 'done');
    assert.equal(closed.unread, true); // an admin closing it is news for the sender
    await ben.call('GET', `/api/feedback/${closed.id}`);
    const dee = new Client();
    assert.equal((await dee.call('POST', '/api/login', { username: 'dee_admin', password: 'longenough4' })).status, 200);
    assert.equal((await ann.call('GET', `/api/feedback/${id}`)).status, 404);
    assert.equal((await ann.call('POST', `/api/feedback/${id}/messages`, { message: 'hi' })).status, 404);
    assert.equal((await ben.call('POST', `/api/feedback/${id}/messages`, { message: '  ' })).status, 400);
    assert.equal((await dee.call('GET', '/api/me')).json.user.feedbackUnread, 1); // the new request waits for the admin
    assert.equal((await dee.call('GET', `/api/feedback/${id}`)).status, 200);
    assert.equal((await dee.call('GET', '/api/me')).json.user.feedbackUnread, 0); // reading it clears that
    assert.equal((await dee.call('POST', `/api/feedback/${id}/messages`, { message: 'Which save failed?' })).status, 200);
    assert.equal((await ben.call('GET', '/api/me')).json.user.feedbackUnread, 1); // the sender has a reply
    const chat = (await ben.call('GET', `/api/feedback/${id}`)).json;
    assert.deepEqual(chat.messages.map((m) => [m.text, m.mine, m.fromDev]), [['Save failed', true, false], ['Which save failed?', false, true]]);
    assert.equal((await ben.call('GET', '/api/me')).json.user.feedbackUnread, 0);
    assert.equal((await ben.call('POST', `/api/feedback/${id}/messages`, { message: 'The gallery one' })).status, 200);
    assert.equal((await dee.call('GET', '/api/me')).json.user.feedbackUnread, 1);
    const seen = (await dee.call('GET', `/api/feedback/${id}`)).json;
    assert.deepEqual(seen.messages.map((m) => [m.mine, m.fromDev]), [[false, false], [true, true], [false, false]]); // from the admin's side
    assert.equal((await ben.call('POST', `/api/feedback/${id}/done`)).status, 200); // the sender closes it
    assert.equal((await dee.call('POST', `/api/feedback/${id}/messages`, { message: 'late' })).status, 409); // closed: no more replies
    assert.equal((await ben.call('GET', '/api/feedback')).json.feedback.find((f) => f.id === id).status, 'done');
    assert.equal((await dee.call('GET', '/api/feedback')).json.feedback.some((f) => f.id === id), false);
  });

  await test('class galleries: create, join with the code, share to a class, members only, teacher reviews and takes down', async () => {
    const made = await ann.call('POST', '/api/classes', { name: 'Period 3 English' });
    assert.equal(made.status, 200);
    assert.match(made.json.code, /^[A-Z0-9]{6}$/);
    assert.equal((await ann.call('POST', '/api/classes', { name: '' })).status, 400);
    // joining
    assert.equal((await ben.call('POST', '/api/classes/join', { code: 'NOPE99' })).status, 404);
    const joined = await ben.call('POST', '/api/classes/join', { code: ' ' + made.json.code.toLowerCase().slice(0, 3) + '-' + made.json.code.toLowerCase().slice(3) });
    assert.equal(joined.status, 200);
    assert.equal(joined.json.id, made.json.id);
    // only members can look
    const classId = made.json.id;
    assert.equal((await cat.call('GET', `/api/classes/${classId}`)).status, 404);
    const view = await ben.call('GET', `/api/classes/${classId}`);
    assert.equal(view.status, 200);
    assert.equal(view.json.code, null); // only the owner sees the code
    assert.deepEqual(view.json.members.map((m) => m.username).sort(), ['Ann', 'ben'].sort().map((n) => view.json.members.find((m) => m.username.toLowerCase() === n.toLowerCase()).username));
    assert.equal((await ann.call('GET', `/api/classes/${classId}`)).json.code, made.json.code);
    assert.equal((await ben.call('GET', '/api/classes')).json.classes.length, 1);
    // sharing: you must be in the class
    assert.equal((await cat.call('POST', '/api/dioramas', { title: 'Nope', data: DATA, visibility: 'class', classId })).status, 400);
    assert.equal((await ben.call('POST', '/api/dioramas', { title: 'Nope', data: DATA, visibility: 'class' })).status, 400);
    const shared = await ben.call('POST', '/api/dioramas', { title: 'Class project', data: DATA, visibility: 'class', classId });
    assert.equal(shared.status, 200);
    assert.equal((await cat.call('GET', `/api/dioramas/${shared.json.id}`)).status, 404); // not in the class
    assert.equal((await ann.call('GET', `/api/dioramas/${shared.json.id}`)).status, 200); // teacher
    assert.equal((await new Client().call('GET', `/api/dioramas/${shared.json.id}/public`)).status, 404); // never a public link
    assert.equal((await ann.call('GET', `/api/classes/${classId}`)).json.dioramas.length, 1);
    assert.equal((await cat.call('GET', '/api/gallery')).json.recent.some((d) => d.id === shared.json.id), false); // not in the everyone gallery
    // reporting goes to the teacher, and only class members can report it
    assert.equal((await cat.call('POST', '/api/report', { dioramaId: shared.json.id, reason: 'x' })).status, 404);
    assert.equal((await ann.call('POST', '/api/report', { dioramaId: shared.json.id, reason: 'Not okay' })).status, 200);
    const { rows } = await query(`SELECT assigned_to FROM ${T.reports} WHERE diorama_id = $1`, [shared.json.id]);
    assert.equal(rows.length, 1);
    // (Ann is the teacher, so her own report is not assigned to herself)
    assert.equal(rows[0].assigned_to, null);
    // only the teacher manages
    assert.equal((await ben.call('POST', `/api/classes/${classId}/takedown`, { dioramaId: shared.json.id })).status, 403);
    assert.equal((await ben.call('POST', `/api/classes/${classId}/code`, {})).status, 403);
    const newCode = await ann.call('POST', `/api/classes/${classId}/code`, {});
    assert.notEqual(newCode.json.code, made.json.code);
    assert.equal((await ann.call('POST', `/api/classes/${classId}/takedown`, { dioramaId: shared.json.id })).status, 200);
    assert.equal((await ann.call('GET', `/api/classes/${classId}`)).json.dioramas.length, 0);
    assert.equal((await ben.call('GET', `/api/dioramas/${shared.json.id}`)).json.visibility, 'private'); // still Ben's
    // autosave (no `explicit`) never re-shares a diorama the teacher took down
    assert.equal((await ben.call('POST', '/api/dioramas', { id: shared.json.id, title: 'Class project', data: DATA, visibility: 'class', classId })).status, 200);
    assert.equal((await ann.call('GET', `/api/classes/${classId}`)).json.dioramas.length, 0);
    assert.equal((await ben.call('GET', `/api/dioramas/${shared.json.id}`)).json.visibility, 'private');
    // but choosing it again in the Save window (explicit) does
    assert.equal((await ben.call('POST', '/api/dioramas', { id: shared.json.id, title: 'Class project', data: DATA, visibility: 'class', classId, explicit: true })).status, 200);
    assert.equal((await ann.call('GET', `/api/classes/${classId}`)).json.dioramas.length, 1);
    // handing the class over: only the teacher, only to another member
    assert.equal((await ben.call('POST', `/api/classes/${classId}/transfer`, { username: 'ben' })).status, 403);
    assert.equal((await ann.call('POST', `/api/classes/${classId}/transfer`, { username: 'ann' })).status, 400); // already the teacher
    assert.equal((await ann.call('POST', `/api/classes/${classId}/transfer`, { username: 'nobody' })).status, 400);
    assert.equal((await ann.call('POST', `/api/classes/${classId}/transfer`, { username: 'cat' })).status, 400); // not in the class
    assert.equal((await ann.call('POST', `/api/classes/${classId}/transfer`, { username: 'BEN' })).status, 200);
    assert.equal((await ben.call('GET', `/api/classes/${classId}`)).json.isOwner, true);
    assert.equal((await ann.call('GET', `/api/classes/${classId}`)).json.code, null); // Ann is now just a member
    assert.equal((await ann.call('POST', `/api/classes/${classId}/code`, {})).status, 403);
    assert.equal((await ben.call('POST', `/api/classes/${classId}/transfer`, { username: 'ann' })).status, 200); // and back
    // leaving, and deleting the class
    assert.equal((await ann.call('POST', `/api/classes/${classId}/leave`, {})).status, 400); // the teacher cannot leave
    assert.equal((await ben.call('POST', `/api/classes/${classId}/leave`, {})).status, 200);
    assert.equal((await ben.call('GET', `/api/classes/${classId}`)).status, 404);
    assert.equal((await ben.call('DELETE', `/api/classes/${classId}`)).status, 404);
    assert.equal((await ann.call('DELETE', `/api/classes/${classId}`)).status, 200);
    assert.equal((await ann.call('GET', '/api/classes')).json.classes.length, 0);
  });

  await test('class editing: owner can let classmates edit; they change the scene only, and only while it stays shared', async () => {
    const cls = (await ann.call('POST', '/api/classes', { name: 'Edit club' })).json;
    await ben.call('POST', '/api/classes/join', { code: cls.code });
    const made = await ann.call('POST', '/api/dioramas', { title: 'Shared build', data: DATA, visibility: 'class', classId: cls.id });
    const id = made.json.id;
    // editing is off by default: Ben can look but not save
    const before = await ben.call('GET', `/api/dioramas/${id}`);
    assert.equal(before.json.mine, false);
    assert.equal((await ben.call('POST', '/api/dioramas', { id, title: 'Ben edit', data: DATA })).status, 404);
    // Ann switches it on
    assert.equal((await ann.call('POST', '/api/dioramas', { id, title: 'Shared build', data: DATA, visibility: 'class', classId: cls.id, classEdit: true, explicit: true })).status, 200);
    const open = await ben.call('GET', `/api/dioramas/${id}`);
    assert.equal(open.json.mine, true);
    assert.equal(open.json.isOwner, false);
    // Ben saves; trying to change sharing is ignored
    assert.equal((await ben.call('POST', '/api/dioramas', { id, title: 'Ben edit', data: DATA, visibility: 'gallery', explicit: true, code: 'steal' })).status, 200);
    const after = await ann.call('GET', `/api/dioramas/${id}`);
    assert.equal(after.json.title, 'Ben edit');
    assert.equal(after.json.visibility, 'class');
    assert.equal(after.json.classEdit, true);
    assert.equal(after.json.isOwner, true);
    // someone outside the class cannot
    assert.equal((await cat.call('POST', '/api/dioramas', { id, title: 'Cat edit', data: DATA })).status, 404);
    // Ann's own autosave keeps the setting; moving it out of the class turns editing off
    assert.equal((await ann.call('POST', '/api/dioramas', { id, title: 'Ben edit', data: DATA })).status, 200);
    assert.equal((await ben.call('POST', '/api/dioramas', { id, title: 'again', data: DATA })).status, 200);
    assert.equal((await ann.call('POST', '/api/dioramas', { id, title: 'Ben edit', data: DATA, visibility: 'private', explicit: true })).status, 200);
    assert.equal((await ben.call('POST', '/api/dioramas', { id, title: 'late', data: DATA })).status, 404);
    await ann.call('DELETE', `/api/classes/${cls.id}`);
  });

  await test('live editing: only people allowed to edit join; edits are passed on; access loss disconnects', async () => {
    const { default: WebSocket } = await import('ws');
    const port = server.address().port;
    const until = async (fn) => {
      for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 30));
      assert.ok(fn(), 'timed out waiting');
    };
    const join = (client, id) =>
      new Promise((resolve, reject) => {
        const w = new WebSocket(`ws://127.0.0.1:${port}/ws?d=${id}`, { headers: { cookie: client.cookie } });
        w.msgs = [];
        w.on('message', (m) => w.msgs.push(JSON.parse(m)));
        w.on('open', () => resolve(w));
        w.on('error', reject);
        w.on('unexpected-response', (_, res) => reject(new Error('status ' + res.statusCode)));
      });
    const cls = (await ann.call('POST', '/api/classes', { name: 'Live club' })).json;
    await ben.call('POST', '/api/classes/join', { code: cls.code });
    const id = (await ann.call('POST', '/api/dioramas', { title: 'Live build', data: DATA, visibility: 'class', classId: cls.id })).json.id;
    // editing switched off: nobody joins, not even the owner
    await assert.rejects(join(ann, id), /403/);
    await ann.call('POST', '/api/dioramas', { id, title: 'Live build', data: DATA, visibility: 'class', classId: cls.id, classEdit: true, explicit: true });
    await assert.rejects(join(new Client(), id), /403/); // not signed in
    await assert.rejects(join(cat, id), /403/); // not in the class
    const a = await join(ann, id);
    const b = await join(ben, id);
    await until(() => b.msgs.some((m) => m.t === 'peers' && m.names.length === 2));
    // a newcomer is offered the longest-present person's copy
    await until(() => a.msgs.some((m) => m.t === 'want'));
    // edits reach the others, not the sender
    a.send(JSON.stringify({ t: 'cells', c: [[5, 3]] }));
    await until(() => b.msgs.some((m) => m.t === 'cells' && m.c[0][1] === 3));
    assert.equal(a.msgs.some((m) => m.t === 'cells'), false);
    // junk is dropped
    a.send('not json');
    a.send(JSON.stringify({ t: 'bogus' }));
    b.send(JSON.stringify({ t: 'labels', labels: [] }));
    await until(() => a.msgs.some((m) => m.t === 'labels'));
    // the owner turns editing off: Ben is disconnected
    const closed = new Promise((r) => b.on('close', r));
    await ann.call('POST', '/api/dioramas', { id, title: 'Live build', data: DATA, visibility: 'private', explicit: true });
    assert.equal(await closed, 4403);
    a.close();
    await ann.call('DELETE', `/api/classes/${cls.id}`);
  });

  await test('maxos sign-in: the token is checked with maxos, accounts are linked, no cookie and no password', async () => {
    const call = async (method, path, body, token) => {
      const headers = { 'content-type': 'application/json', 'x-requested-with': 'blockscape' };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null), cookie: res.headers.get('set-cookie') };
    };
    // the page may be framed by maxos only
    const home = await fetch(base + '/');
    assert.match(home.headers.get('content-security-policy'), new RegExp(`frame-ancestors ${process.env.MAXOS_ORIGIN.replace(/[.]/g, '\\.')}(;|$)`));
    assert.equal(home.headers.get('x-frame-options'), null);
    // bad tokens
    assert.equal((await call('POST', '/api/sso/maxos', { token: 'not a token' })).status, 400);
    assert.equal((await call('POST', '/api/sso/maxos', { token: 'aaa.bbb.expired' })).status, 401);
    assert.equal((await call('POST', '/api/sso/maxos', { token: 'aaa.bbb.unverified' })).status, 403);
    // 'ann' already exists here as a different person, so the maxos 'ann' gets a different Cubeloft name and a separate account
    const first = await call('POST', '/api/sso/maxos', { token: 'aaa.bbb.ann' });
    assert.equal(first.status, 200);
    assert.equal(first.cookie, null);
    assert.match(first.json.token, /^[0-9a-f]{64}$/);
    assert.equal(first.json.user.username, 'ann_2');
    assert.equal(first.json.user.isAdmin, false);
    // the same maxos person comes back to the same account
    const again = await call('POST', '/api/sso/maxos', { token: 'aaa.bbb.ann' });
    assert.equal(again.json.user.id, first.json.user.id);
    // odd characters in the maxos name become underscores
    const zed = await call('POST', '/api/sso/maxos', { token: 'aaa.bbb.zed' });
    assert.equal(zed.json.user.username, 'Zed_Q');
    // the session token works as a bearer token, and logs out
    const me = await call('GET', '/api/me', undefined, first.json.token);
    assert.equal(me.json.user.username, 'ann_2');
    assert.equal((await call('GET', '/api/me')).json.user, null);
    // no Cubeloft password exists for these accounts
    assert.equal((await new Client().call('POST', '/api/login', { username: 'ann_2', password: '' })).status, 401);
    await call('POST', '/api/logout', {}, first.json.token);
    assert.equal((await call('GET', '/api/me', undefined, first.json.token)).json.user, null);
    // and a made-up bearer token is just nobody
    assert.equal((await call('GET', '/api/me', undefined, 'f'.repeat(64))).json.user, null);
  });

  await test('sharing a diorama with named people: look only, look and edit, and taking it back', async () => {
    const made = await ann.call('POST', '/api/dioramas', { title: 'Just for Ben', data: DATA, visibility: 'private' });
    const id = made.json.id;
    assert.equal((await ben.call('GET', `/api/dioramas/${id}`)).status, 404); // private: nobody else sees it
    assert.equal((await ben.call('GET', `/api/dioramas/${id}/shares`)).status, 404); // only the owner reads the list
    assert.equal((await ben.call('POST', `/api/dioramas/${id}/shares`, { username: 'cat' })).status, 404); // or changes it
    assert.equal((await ann.call('POST', `/api/dioramas/${id}/shares`, { username: 'nobody-here' })).status, 404);
    assert.equal((await ann.call('POST', `/api/dioramas/${id}/shares`, { username: 'ANN' })).status, 400); // not with yourself
    assert.equal((await ann.call('POST', `/api/dioramas/${id}/shares`, { username: '' })).status, 400);
    // look only
    const shared = await ann.call('POST', `/api/dioramas/${id}/shares`, { username: 'BEN' }); // any capitalization
    assert.equal(shared.status, 200);
    assert.deepEqual(shared.json.shares, [{ username: 'ben', canEdit: false }]);
    const look = await ben.call('GET', `/api/dioramas/${id}`);
    assert.equal(look.status, 200);
    assert.equal(look.json.mine, false);
    assert.equal(look.json.shareEdit, false);
    assert.equal((await ben.call('POST', '/api/dioramas', { id, title: 'Ben edit', data: DATA })).status, 404);
    assert.equal((await cat.call('GET', `/api/dioramas/${id}`)).status, 404); // nobody else got it
    const list = await ben.call('GET', '/api/dioramas/shared');
    assert.deepEqual(list.json.dioramas.map((d) => [d.id, d.owner, d.canEdit]), [[id, 'Ann', false]]);
    assert.equal((await ann.call('GET', '/api/dioramas/mine')).json.dioramas.find((d) => d.id === id).sharedWith, 1);
    // look and edit
    assert.equal((await ann.call('POST', `/api/dioramas/${id}/shares`, { username: 'ben', canEdit: true })).json.shares[0].canEdit, true);
    const edit = await ben.call('GET', `/api/dioramas/${id}`);
    assert.equal(edit.json.mine, true);
    assert.equal(edit.json.isOwner, false);
    assert.equal(edit.json.shareEdit, true);
    assert.equal((await ann.call('GET', `/api/dioramas/${id}`)).json.shareEdit, true); // the owner is told people can edit too (live editing)
    assert.equal((await ben.call('POST', '/api/dioramas', { id, title: 'Ben edit', data: DATA })).status, 200);
    const after = await ann.call('GET', `/api/dioramas/${id}`);
    assert.equal(after.json.title, 'Ben edit');
    assert.equal(after.json.visibility, 'private'); // a collaborator cannot change who can see it
    assert.equal((await ben.call('POST', '/api/dioramas', { id, title: 'Ben edit', data: DATA, visibility: 'gallery', explicit: true })).json.id, id);
    assert.equal((await ann.call('GET', `/api/dioramas/${id}`)).json.visibility, 'private');
    assert.equal((await ann.call('GET', `/api/dioramas/${id}/shares`)).json.shares.length, 1);
    assert.equal((await cat.call('DELETE', `/api/dioramas/${id}/shares/ben`)).status, 404); // a stranger cannot take it away
    // taking it back: the owner can, and so can the person it was shared with
    assert.equal((await ann.call('DELETE', `/api/dioramas/${id}/shares/ben`)).json.shares.length, 0);
    assert.equal((await ben.call('GET', `/api/dioramas/${id}`)).status, 404);
    await ann.call('POST', `/api/dioramas/${id}/shares`, { username: 'ben' });
    assert.equal((await ben.call('DELETE', `/api/dioramas/${id}/shares/ben`)).status, 200);
    assert.equal((await ben.call('GET', `/api/dioramas/${id}`)).status, 404);
    // deleting the diorama removes the shares with it
    await ann.call('POST', `/api/dioramas/${id}/shares`, { username: 'ben' });
    await ann.call('DELETE', `/api/dioramas/${id}`);
    assert.equal((await ben.call('GET', '/api/dioramas/shared')).json.dioramas.length, 0);
  });

  await test('brute-force protection on login', async () => {
    const attacker = new Client();
    let last;
    for (let i = 0; i < 17; i++) last = await attacker.call('POST', '/api/login', { username: 'ann', password: 'guess' + i });
    assert.equal(last.status, 429);
  });
} finally {
  maxosStub.close();
  server.close();
  await dropAll();
  await pool.end();
}
console.log(`${n} server tests passed`);
