import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, query, T } from './db.js';
import { attachLive } from './live.js';
import { hashSecret, verifySecret, sha256, newToken, checkUsername, checkPassword, rateLimiter } from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'bs_session';
const SESSION_DAYS = 30;
const MAX_DIORAMAS_PER_USER = 50;
// maxos: its window may embed this site, and its accounts may sign in here (the token is checked against maxos itself)
const MAXOS_ORIGIN = (process.env.MAXOS_ORIGIN || 'https://maxos-1oe3.onrender.com').replace(/\/+$/, '');

const bad = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}

function publicUser(u) {
  return u && { id: u.id, username: u.username, isAdmin: u.is_admin, hasGalleryCode: !!u.gallery_code_hash };
}

// Content-Security-Policy that allows exactly the one inline <script type="importmap">
function buildCsp() {
  let hash = '';
  try {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    if (m) hash = ` 'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`;
  } catch {}
  return [
    "default-src 'self'",
    `script-src 'self'${hash}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${MAXOS_ORIGIN}`, // only the maxos window may show this site in a frame
  ].join('; ');
}

// SQL used to decide which open reports a person may review.
//   - a report assigned to them (this is how reports about an admin's diorama reach someone else), or
//   - for admins: unassigned reports (this includes old ones about an admin's diorama from before another admin existed).
// Nobody reviews a report they wrote or one about their own diorama, so the owner never sees reports about
// themselves; those wait for another admin (the Claude account).
const REVIEWABLE = (me, isAdmin) => `
  r.status = 'open' AND r.reporter_id IS DISTINCT FROM ${me} AND o.id <> ${me}
  AND (r.assigned_to = ${me} OR (${isAdmin ? 'TRUE' : 'FALSE'} AND r.assigned_to IS NULL))`;

async function countReports(user) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM ${T.reports} r JOIN ${T.dioramas} d ON d.id = r.diorama_id JOIN ${T.users} o ON o.id = d.owner_id WHERE ${REVIEWABLE(Number(user.id), !!user.is_admin)}`,
  );
  return rows[0].n;
}

// Only this one account (Claude's) can read everyone's feedback and answer it; every other account, admins included, sees only its own.
const canReadAllFeedback = (u) => !!u.is_admin && u.username.toLowerCase() === (process.env.FEEDBACK_READER || 'Claude').toLowerCase();

// Chats with something new for this person to read: replies on their own requests, plus (admins) open requests they have not read.
async function countFeedbackUnread(user) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM ${T.feedback} WHERE (user_id = $1 AND user_unread) OR ($2 AND status = 'open' AND admin_unread AND user_id IS DISTINCT FROM $1)`,
    [user.id, canReadAllFeedback(user)],
  );
  return rows[0].n;
}

// The session token comes from the cookie, or (inside the maxos window, where cookies are blocked) from an
// Authorization: Bearer header, or from ?token= on the live-editing socket.
function sessionToken(req) {
  const cookie = readCookie(req, COOKIE);
  if (cookie) return cookie;
  const bearer = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '');
  if (bearer) return bearer[1];
  try {
    const url = new URL(req.url, 'http://x');
    const t = url.pathname === '/ws' ? url.searchParams.get('token') : null;
    if (t && /^[0-9a-f]{64}$/.test(t)) return t;
  } catch {}
  return null;
}

async function userFromRequest(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const { rows } = await query(
    `SELECT u.* FROM ${T.sessions} s JOIN ${T.users} u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [sha256(token)],
  );
  return rows[0] || null;
}

// Who may edit a diorama together with others: its owner, or a member of its class once the owner switched editing on.
async function canLiveEdit(userId, dioramaId) {
  const { rows } = await query(`SELECT owner_id, visibility, class_id, class_edit FROM ${T.dioramas} WHERE id = $1`, [dioramaId]);
  const d = rows[0];
  if (!d || d.visibility !== 'class' || !d.class_edit || !d.class_id) return false;
  if (d.owner_id === userId) return true;
  return (await query(`SELECT 1 FROM ${T.members} WHERE class_id = $1 AND user_id = $2`, [d.class_id, userId])).rowCount > 0;
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  const csp = buildCsp();
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    // no X-Frame-Options: it cannot name an allowed site, and the CSP frame-ancestors above does the job
    next();
  });
  app.use(express.json({ limit: '400kb' }));
  // live editing runs on the same server: wrap listen() so the socket handler is attached to whatever it starts
  let live = null;
  const listen = app.listen.bind(app);
  app.listen = (...args) => {
    const server = listen(...args);
    live = attachLive(server, { authenticate: userFromRequest, canEdit: canLiveEdit });
    return server;
  };

  // --- who is asking? ---
  app.use('/api', wrap(async (req, res, next) => {
    // Browsers can't send this header cross-site without CORS approval, which we never give.
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'blockscape') {
      return bad(res, 403, 'Forbidden');
    }
    res.setHeader('Cache-Control', 'no-store');
    req.user = null;
    req.user = await userFromRequest(req);
    next();
  }));
  const needUser = (req, res, next) => (req.user ? next() : bad(res, 401, 'Please sign in first.'));

  async function issueSession(userId) {
    const token = newToken();
    await query(`INSERT INTO ${T.sessions} (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '${SESSION_DAYS} days')`, [sha256(token), userId]);
    return token;
  }
  async function startSession(req, res, userId) {
    setSessionCookie(req, res, await issueSession(userId), SESSION_DAYS * 86400);
  }

  // A Cubeloft username for a maxos name: letters, numbers and underscores, and never one that is already someone else's.
  async function freeUsername(maxosName) {
    let base = maxosName.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 20).padEnd(3, '_');
    if (checkUsername(base)) base = `mx_${base}`.slice(0, 20);
    for (let n = 1; n < 200; n++) {
      const suffix = n === 1 ? '' : `_${n}`;
      const name = base.slice(0, 20 - suffix.length) + suffix;
      if (checkUsername(name)) continue;
      if ((await query(`SELECT 1 FROM ${T.users} WHERE LOWER(username) = LOWER($1)`, [name])).rowCount === 0) return name;
    }
    throw new Error('no free username');
  }

  // --- accounts ---
  app.get('/api/me', wrap(async (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({ user: { ...publicUser(req.user), pendingReports: await countReports(req.user), feedbackReader: canReadAllFeedback(req.user), feedbackUnread: await countFeedbackUnread(req.user) } });
  }));

  app.post('/api/signup', rateLimiter({ windowMs: 3600e3, max: 10 }), wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = req.body.password;
    const problem = checkUsername(username) || checkPassword(password);
    if (problem) return bad(res, 400, problem);
    let row;
    try {
      const { rows } = await query(`INSERT INTO ${T.users} (username, password_hash) VALUES ($1, $2) RETURNING *`, [username, await hashSecret(password)]);
      row = rows[0];
    } catch (e) {
      if (e.code === '23505') return bad(res, 409, 'That username is taken. Try another.');
      throw e;
    }
    await startSession(req, res, row.id);
    res.json({ user: publicUser(row) });
  }));

  const DUMMY = hashSecret('not-a-real-password');
  app.post('/api/login', rateLimiter({ windowMs: 600e3, max: 15 }), wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const { rows } = await query(`SELECT * FROM ${T.users} WHERE LOWER(username) = LOWER($1)`, [username]);
    const user = rows[0];
    const ok = await verifySecret(String(req.body.password || ''), user ? user.password_hash : await DUMMY);
    if (!user || !ok) return bad(res, 401, 'That username and password do not match.');
    await startSession(req, res, user.id);
    res.json({ user: publicUser(user) });
  }));

  // Sign in with a maxos account. The embedded page hands over the person's maxos token; we ask maxos who it belongs to
  // (so there is no shared secret), then link or create a Cubeloft account for that maxos name. These accounts have no
  // Cubeloft password and are never admins. The session token goes back in the body, because the maxos window blocks cookies.
  app.post('/api/sso/maxos', rateLimiter({ windowMs: 600e3, max: 150 }), wrap(async (req, res) => {
    const maxosToken = req.body.token;
    if (typeof maxosToken !== 'string' || maxosToken.length > 3000 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(maxosToken)) return bad(res, 400, 'That sign-in did not work.');
    let who;
    try {
      const r = await fetch(`${MAXOS_ORIGIN}/api/auth/me`, { headers: { authorization: `Bearer ${maxosToken}` }, signal: AbortSignal.timeout(10000) });
      if (r.status === 401 || r.status === 403) return bad(res, 401, 'Your maxos sign-in has expired. Sign in to maxos again.');
      if (!r.ok) throw new Error(`maxos answered ${r.status}`);
      who = await r.json();
    } catch (e) {
      console.error('[sso]', e.message);
      return bad(res, 502, 'Could not reach maxos to check your sign-in. Try again in a moment.');
    }
    const maxosName = typeof who?.username === 'string' ? who.username.trim().toLowerCase() : '';
    if (!maxosName || maxosName.length > 100 || who.mustVerifyEmail === true) return bad(res, 403, 'Verify your maxos account first, then open Cubeloft again.');
    let user = (await query(`SELECT * FROM ${T.users} WHERE maxos_name = $1`, [maxosName])).rows[0];
    for (let attempt = 0; !user && attempt < 3; attempt++) {
      try {
        user = (await query(`INSERT INTO ${T.users} (username, password_hash, maxos_name) VALUES ($1, NULL, $2) RETURNING *`, [await freeUsername(who.username.trim()), maxosName])).rows[0];
      } catch (e) {
        if (e.code !== '23505') throw e;
        user = (await query(`SELECT * FROM ${T.users} WHERE maxos_name = $1`, [maxosName])).rows[0]; // someone else's name was taken in the meantime, or a parallel sign-in won: look again, else retry
      }
    }
    if (!user) return bad(res, 500, 'Could not set up your account. Try again.');
    res.json({ token: await issueSession(user.id), user: publicUser(user) });
  }));

  app.post('/api/logout', wrap(async (req, res) => {
    const token = sessionToken(req);
    if (token) await query(`DELETE FROM ${T.sessions} WHERE token_hash = $1`, [sha256(token)]);
    setSessionCookie(req, res, '', 0);
    res.json({ ok: true });
  }));

  app.put('/api/me/gallery-code', needUser, wrap(async (req, res) => {
    const code = req.body.code;
    if (code === null || code === '') {
      await query(`UPDATE ${T.users} SET gallery_code_hash = NULL WHERE id = $1`, [req.user.id]);
      await query(`DELETE FROM ${T.unlocks} WHERE kind = 'gallery' AND target_id = $1`, [req.user.id]);
      return res.json({ ok: true, hasGalleryCode: false });
    }
    if (typeof code !== 'string' || code.length < 3 || code.length > 40) return bad(res, 400, 'A code is 3–40 characters.');
    await query(`UPDATE ${T.users} SET gallery_code_hash = $1 WHERE id = $2`, [await hashSecret(code), req.user.id]);
    await query(`DELETE FROM ${T.unlocks} WHERE kind = 'gallery' AND target_id = $1`, [req.user.id]); // everyone must re-enter the new code
    res.json({ ok: true, hasGalleryCode: true });
  }));

  // --- classes (helpers) ---
  const isMember = async (userId, classId) => (await query(`SELECT 1 FROM ${T.members} WHERE class_id = $1 AND user_id = $2`, [classId, userId])).rowCount > 0;

  // --- class galleries ---
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike letters or digits
  const newClassCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  const MAX_CLASSES_OWNED = 10;
  const classCard = (r) => ({ id: r.id, title: r.title, owner: r.username, thumb: r.thumb, locked: false, updatedAt: r.updated_at });
  // Returns the class (with isOwner) for a member, or sends the error and returns null.
  const needClassMember = async (req, res) => {
    const stop = (status, msg) => {
      bad(res, status, msg);
      return null;
    };
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return stop(404, 'Class not found.');
    const { rows } = await query(`SELECT c.*, u.username AS owner FROM ${T.classes} c JOIN ${T.users} u ON u.id = c.owner_id WHERE c.id = $1`, [id]);
    const c = rows[0];
    if (!c) return stop(404, 'Class not found.');
    const member = await isMember(req.user.id, id);
    if (!member && !req.user.is_admin) return stop(404, 'Class not found.');
    return { ...c, isOwner: c.owner_id === req.user.id };
  };

  app.get('/api/classes', needUser, wrap(async (req, res) => {
    const { rows } = await query(
      `SELECT c.id, c.name, c.owner_id, c.code, u.username AS owner, (SELECT COUNT(*)::int FROM ${T.members} m2 WHERE m2.class_id = c.id) AS n
       FROM ${T.classes} c JOIN ${T.members} m ON m.class_id = c.id AND m.user_id = $1 JOIN ${T.users} u ON u.id = c.owner_id ORDER BY c.name`,
      [req.user.id],
    );
    res.json({ classes: rows.map((c) => ({ id: c.id, name: c.name, owner: c.owner, isOwner: c.owner_id === req.user.id, code: c.owner_id === req.user.id ? c.code : null, members: c.n })) });
  }));

  app.post('/api/classes', needUser, rateLimiter({ windowMs: 3600e3, max: 20 }), wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name || name.length > 60) return bad(res, 400, 'Give the class a name (up to 60 characters).');
    const { rows: owned } = await query(`SELECT COUNT(*)::int AS n FROM ${T.classes} WHERE owner_id = $1`, [req.user.id]);
    if (owned[0].n >= MAX_CLASSES_OWNED) return bad(res, 400, `You can run up to ${MAX_CLASSES_OWNED} classes.`);
    let created = null;
    for (let tries = 0; tries < 8 && !created; tries++) {
      try {
        created = (await query(`INSERT INTO ${T.classes} (name, owner_id, code) VALUES ($1,$2,$3) RETURNING id, code`, [name, req.user.id, newClassCode()])).rows[0];
      } catch (e) {
        if (e.code !== '23505') throw e; // that code was taken: try another
      }
    }
    if (!created) return bad(res, 500, 'Could not make a class code. Please try again.');
    await query(`INSERT INTO ${T.members} (class_id, user_id) VALUES ($1,$2)`, [created.id, req.user.id]);
    res.json({ id: created.id, name, code: created.code });
  }));

  app.post('/api/classes/join', needUser, rateLimiter({ windowMs: 600e3, max: 20 }), wrap(async (req, res) => {
    const code = String(req.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) return bad(res, 400, 'Type the class code your teacher gave you.');
    const { rows } = await query(`SELECT id, name FROM ${T.classes} WHERE code = $1`, [code]);
    if (!rows[0]) return bad(res, 404, 'No class has that code. Check it and try again.');
    await query(`INSERT INTO ${T.members} (class_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [rows[0].id, req.user.id]);
    res.json({ id: rows[0].id, name: rows[0].name });
  }));

  app.get('/api/classes/:id', needUser, wrap(async (req, res) => {
    const c = await needClassMember(req, res);
    if (!c) return;
    const manage = c.isOwner || req.user.is_admin;
    const members = await query(`SELECT u.username, (u.id = $2) AS is_owner FROM ${T.members} m JOIN ${T.users} u ON u.id = m.user_id WHERE m.class_id = $1 ORDER BY u.username`, [c.id, c.owner_id]);
    const dioramas = await query(
      `SELECT d.id, d.title, d.thumb, d.updated_at, u.username FROM ${T.dioramas} d JOIN ${T.users} u ON u.id = d.owner_id WHERE d.class_id = $1 AND d.visibility = 'class' ORDER BY d.updated_at DESC`,
      [c.id],
    );
    res.json({
      id: c.id,
      name: c.name,
      owner: c.owner,
      isOwner: c.isOwner,
      manage,
      code: manage ? c.code : null,
      members: members.rows.map((m) => ({ username: m.username, isOwner: m.is_owner })),
      dioramas: dioramas.rows.map(classCard),
    });
  }));

  // leaving, being removed or deleting a class takes that person's dioramas out of it (they keep them, privately)
  const pullOut = (classId, userId) =>
    query(`UPDATE ${T.dioramas} SET visibility = 'private', class_id = NULL WHERE class_id = $1 AND ($2::int IS NULL OR owner_id = $2)`, [classId, userId]);

  app.post('/api/classes/:id/leave', needUser, wrap(async (req, res) => {
    const c = await needClassMember(req, res);
    if (!c) return;
    if (c.isOwner) return bad(res, 400, 'You run this class. Delete it instead.');
    await query(`DELETE FROM ${T.members} WHERE class_id = $1 AND user_id = $2`, [c.id, req.user.id]);
    await pullOut(c.id, req.user.id);
    res.json({ ok: true });
  }));

  app.delete('/api/classes/:id', needUser, wrap(async (req, res) => {
    const c = await needClassMember(req, res);
    if (!c) return;
    if (!c.isOwner && !req.user.is_admin) return bad(res, 403, 'Only the person who runs the class can delete it.');
    await pullOut(c.id, null);
    await query(`DELETE FROM ${T.classes} WHERE id = $1`, [c.id]);
    res.json({ ok: true });
  }));

  app.post('/api/classes/:id/code', needUser, wrap(async (req, res) => {
    const c = await needClassMember(req, res);
    if (!c) return;
    if (!c.isOwner && !req.user.is_admin) return bad(res, 403, 'Only the person who runs the class can change the code.');
    for (let tries = 0; tries < 8; tries++) {
      try {
        const code = newClassCode();
        await query(`UPDATE ${T.classes} SET code = $1 WHERE id = $2`, [code, c.id]);
        return res.json({ code });
      } catch (e) {
        if (e.code !== '23505') throw e;
      }
    }
    return bad(res, 500, 'Could not make a new code. Please try again.');
  }));

  app.post('/api/classes/:id/remove', needUser, wrap(async (req, res) => {
    const c = await needClassMember(req, res);
    if (!c) return;
    if (!c.isOwner && !req.user.is_admin) return bad(res, 403, 'Only the person who runs the class can remove people.');
    const { rows } = await query(`SELECT id FROM ${T.users} WHERE LOWER(username) = LOWER($1)`, [String(req.body.username || '')]);
    if (!rows[0] || rows[0].id === c.owner_id) return bad(res, 400, 'That person cannot be removed.');
    await query(`DELETE FROM ${T.members} WHERE class_id = $1 AND user_id = $2`, [c.id, rows[0].id]);
    await pullOut(c.id, rows[0].id);
    res.json({ ok: true });
  }));

  // hand the class to another member; the old teacher stays in the class as a member
  app.post('/api/classes/:id/transfer', needUser, wrap(async (req, res) => {
    const c = await needClassMember(req, res);
    if (!c) return;
    if (!c.isOwner && !req.user.is_admin) return bad(res, 403, 'Only the person who runs the class can hand it over.');
    const { rows } = await query(
      `SELECT u.id, u.username FROM ${T.users} u JOIN ${T.members} m ON m.user_id = u.id AND m.class_id = $2 WHERE LOWER(u.username) = LOWER($1)`,
      [String(req.body.username || ''), c.id],
    );
    if (!rows[0] || rows[0].id === c.owner_id) return bad(res, 400, 'Pick someone else who is in the class.');
    const { rows: owned } = await query(`SELECT COUNT(*)::int AS n FROM ${T.classes} WHERE owner_id = $1`, [rows[0].id]);
    if (owned[0].n >= MAX_CLASSES_OWNED) return bad(res, 400, `${rows[0].username} already runs ${MAX_CLASSES_OWNED} classes.`);
    await query(`UPDATE ${T.classes} SET owner_id = $1 WHERE id = $2`, [rows[0].id, c.id]);
    res.json({ ok: true, owner: rows[0].username });
  }));

  app.post('/api/classes/:id/takedown', needUser, wrap(async (req, res) => {
    const c = await needClassMember(req, res);
    if (!c) return;
    if (!c.isOwner && !req.user.is_admin) return bad(res, 403, 'Only the person who runs the class can take a diorama down.');
    await query(`UPDATE ${T.dioramas} SET visibility = 'private', class_id = NULL WHERE id = $1 AND class_id = $2`, [Number(req.body.dioramaId), c.id]);
    if (live) live.recheck(Number(req.body.dioramaId));
    res.json({ ok: true });
  }));

  // --- dioramas ---
  const DATA_RE = /^[zr][A-Za-z0-9_-]+$/;
  app.post('/api/dioramas', needUser, wrap(async (req, res) => {
    const { id, data, thumb } = req.body;
    let { visibility } = req.body;
    const title = String(req.body.title || '').trim();
    if (!title || title.length > 80) return bad(res, 400, 'Give your diorama a title (up to 80 characters).');
    if (typeof data !== 'string' || data.length > 250000 || !DATA_RE.test(data)) return bad(res, 400, 'That diorama could not be saved.');
    if (thumb != null && (typeof thumb !== 'string' || thumb.length > 90000 || !thumb.startsWith('data:image/jpeg;base64,'))) return bad(res, 400, 'Bad picture.');
    let classId = null;
    let classEdit = false;
    let collaborator = false;
    let current = null;
    if (id != null) {
      const { rows: cur } = await query(`SELECT owner_id, visibility, class_id, class_edit FROM ${T.dioramas} WHERE id = $1`, [id]);
      current = cur[0];
      if (!current) return bad(res, 404, 'Diorama not found.');
      if (current.owner_id !== req.user.id) {
        // not the owner: allowed only while it is shared with a class the person is in, with editing switched on
        const canEdit = current.class_edit && current.visibility === 'class' && current.class_id && (await isMember(req.user.id, current.class_id));
        if (!canEdit) return bad(res, 404, 'Diorama not found.');
        collaborator = true;
      }
    }
    if (current && (collaborator || req.body.explicit !== true)) {
      // autosave (or a classmate's save): keep whoever it is shared with (a teacher may have taken it down, or the author left the class)
      visibility = current.visibility;
      classId = current.class_id;
      classEdit = current.class_edit;
    } else {
      if (!['private', 'gallery', 'class'].includes(visibility)) return bad(res, 400, 'Choose private, gallery or a class.');
      if (visibility === 'class') {
        classId = Number(req.body.classId);
        if (!Number.isInteger(classId) || !(await isMember(req.user.id, classId))) return bad(res, 400, 'Choose one of your classes.');
        classEdit = req.body.classEdit === true;
      }
    }
    const code = req.body.code;
    if (code != null && code !== '' && (typeof code !== 'string' || code.length < 3 || code.length > 40)) return bad(res, 400, 'A code is 3–40 characters.');

    if (id != null && collaborator) {
      // classmates change the picture only: sharing and codes stay with the owner
      await query(`UPDATE ${T.dioramas} SET title = $1, data = $2, thumb = $3, updated_at = NOW() WHERE id = $4`, [title, data, thumb || null, id]);
      return res.json({ id });
    }
    if (id != null) {
      const sets = ['title = $1', 'data = $2', 'thumb = $3', 'visibility = $4', 'updated_at = NOW()'];
      const params = [title, data, thumb || null, visibility];
      params.push(classId);
      sets.push(`class_id = $${params.length}`);
      params.push(classEdit);
      sets.push(`class_edit = $${params.length}`);
      if (code === '' || code === null) sets.push('code_hash = NULL');
      else if (code !== undefined) {
        params.push(await hashSecret(code));
        sets.push(`code_hash = $${params.length}`);
      }
      params.push(id);
      await query(`UPDATE ${T.dioramas} SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      if (live) live.recheck(id);
      if (code !== undefined) await query(`DELETE FROM ${T.unlocks} WHERE kind = 'diorama' AND target_id = $1`, [id]);
      return res.json({ id });
    }
    const { rows: cnt } = await query(`SELECT COUNT(*)::int AS n FROM ${T.dioramas} WHERE owner_id = $1`, [req.user.id]);
    if (cnt[0].n >= MAX_DIORAMAS_PER_USER) return bad(res, 400, `You can keep up to ${MAX_DIORAMAS_PER_USER} dioramas. Delete one first.`);
    const codeHash = code ? await hashSecret(code) : null;
    const { rows } = await query(
      `INSERT INTO ${T.dioramas} (owner_id, title, data, thumb, visibility, code_hash, class_id, class_edit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.user.id, title, data, thumb || null, visibility, codeHash, classId, classEdit],
    );
    res.json({ id: rows[0].id });
  }));

  app.get('/api/dioramas/mine', needUser, wrap(async (req, res) => {
    const { rows } = await query(
      `SELECT d.id, d.title, d.thumb, d.visibility, d.class_id, d.class_edit, c.name AS class_name, (d.code_hash IS NOT NULL) AS has_code, d.updated_at FROM ${T.dioramas} d LEFT JOIN ${T.classes} c ON c.id = d.class_id WHERE d.owner_id = $1 ORDER BY d.updated_at DESC`,
      [req.user.id],
    );
    res.json({ dioramas: rows.map((r) => ({ id: r.id, title: r.title, thumb: r.thumb, visibility: r.visibility, classId: r.class_id, classEdit: r.class_edit, className: r.class_name, hasCode: r.has_code, updatedAt: r.updated_at })) });
  }));

  const unlocked = async (userId, kind, target) =>
    (await query(`SELECT 1 FROM ${T.unlocks} WHERE user_id = $1 AND kind = $2 AND target_id = $3`, [userId, kind, target])).rowCount > 0;

  // A link to a saved diorama that anyone can open without signing in. Only dioramas published to the gallery
  // and not protected by a code qualify (private ones, and ones behind a code, still need the normal route).
  app.get('/api/dioramas/:id/public', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return bad(res, 404, 'Diorama not found.');
    const { rows } = await query(
      `SELECT d.id, d.title, d.data, d.owner_id, d.visibility, d.code_hash, u.username, u.gallery_code_hash AS gallery_hash FROM ${T.dioramas} d JOIN ${T.users} u ON u.id = d.owner_id WHERE d.id = $1`,
      [id],
    );
    const d = rows[0];
    if (!d || d.visibility !== 'gallery' || d.code_hash || d.gallery_hash) return bad(res, 404, 'That diorama is not shared with a link. Ask the owner to share it.');
    res.json({ id: d.id, title: d.title, data: d.data, owner: d.username, visibility: d.visibility, mine: !!req.user && d.owner_id === req.user.id });
  }));

  app.get('/api/dioramas/:id', needUser, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return bad(res, 404, 'Diorama not found.');
    const { rows } = await query(
      `SELECT d.*, u.username, u.gallery_code_hash AS gallery_hash, u.id AS uid FROM ${T.dioramas} d JOIN ${T.users} u ON u.id = d.owner_id WHERE d.id = $1`,
      [id],
    );
    const d = rows[0];
    if (!d) return bad(res, 404, 'Diorama not found.');
    const mine = d.owner_id === req.user.id;
    let reviewer = false;
    if (!mine && !req.user.is_admin) {
      const r = await query(`SELECT 1 FROM ${T.reports} WHERE diorama_id = $1 AND assigned_to = $2 AND status = 'open'`, [id, req.user.id]);
      reviewer = r.rowCount > 0;
    }
    let classMember = false;
    if (!mine && d.visibility === 'class' && d.class_id) classMember = await isMember(req.user.id, d.class_id);
    if (!mine && !req.user.is_admin && !reviewer && !classMember) {
      if (d.visibility !== 'gallery') return bad(res, 404, 'Diorama not found.');
      if (d.gallery_hash && !(await unlocked(req.user.id, 'gallery', d.owner_id))) return bad(res, 403, 'This gallery needs a code.', { locked: 'gallery', ownerId: d.owner_id, owner: d.username });
      if (d.code_hash && !(await unlocked(req.user.id, 'diorama', d.id))) return bad(res, 403, 'This diorama needs a code.', { locked: 'diorama', id: d.id, owner: d.username });
    }
    // classmates can edit when the owner switched that on; `mine` means "you can edit and autosave it"
    const editable = !mine && classMember && d.class_edit;
    res.json({ id: d.id, title: d.title, data: d.data, owner: d.username, visibility: d.visibility, classId: d.class_id, classEdit: d.class_edit, mine: mine || editable, isOwner: mine });
  }));

  app.delete('/api/dioramas/:id', needUser, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await query(`SELECT owner_id FROM ${T.dioramas} WHERE id = $1`, [id]);
    if (!rows[0]) return bad(res, 404, 'Diorama not found.');
    if (rows[0].owner_id !== req.user.id && !req.user.is_admin) return bad(res, 403, 'That is not your diorama.');
    await query(`DELETE FROM ${T.dioramas} WHERE id = $1`, [id]);
    res.json({ ok: true });
  }));

  // --- codes ---
  app.post('/api/unlock', needUser, rateLimiter({ windowMs: 600e3, max: 20 }), wrap(async (req, res) => {
    const { kind, id, code } = req.body;
    if (!['gallery', 'diorama'].includes(kind) || !Number.isInteger(id) || typeof code !== 'string') return bad(res, 400, 'Bad request.');
    const { rows } = kind === 'gallery'
      ? await query(`SELECT gallery_code_hash AS h FROM ${T.users} WHERE id = $1`, [id])
      : await query(`SELECT code_hash AS h FROM ${T.dioramas} WHERE id = $1 AND visibility = 'gallery'`, [id]);
    if (!rows[0]) return bad(res, 404, 'Not found.');
    if (rows[0].h && !(await verifySecret(code, rows[0].h))) return bad(res, 403, 'That code is not right.');
    await query(`INSERT INTO ${T.unlocks} (user_id, kind, target_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.user.id, kind, id]);
    res.json({ ok: true });
  }));

  // --- gallery ---
  const card = (r, lockedForViewer) => ({
    id: r.id,
    title: r.title,
    owner: r.username,
    thumb: lockedForViewer ? null : r.thumb,
    locked: lockedForViewer,
    updatedAt: r.updated_at,
  });

  app.get('/api/gallery', needUser, wrap(async (req, res) => {
    const members = await query(
      `SELECT u.id, u.username, COUNT(d.id)::int AS n, (u.gallery_code_hash IS NOT NULL) AS has_code
       FROM ${T.users} u JOIN ${T.dioramas} d ON d.owner_id = u.id AND d.visibility = 'gallery'
       GROUP BY u.id ORDER BY MAX(d.updated_at) DESC LIMIT 100`,
    );
    const unlockedRows = await query(`SELECT kind, target_id FROM ${T.unlocks} WHERE user_id = $1`, [req.user.id]);
    const open = new Set(unlockedRows.rows.map((r) => `${r.kind}:${r.target_id}`));
    const recent = await query(
      `SELECT d.id, d.title, d.thumb, d.updated_at, d.owner_id, u.username, (d.code_hash IS NOT NULL) AS dcode, (u.gallery_code_hash IS NOT NULL) AS gcode
       FROM ${T.dioramas} d JOIN ${T.users} u ON u.id = d.owner_id WHERE d.visibility = 'gallery' ORDER BY d.updated_at DESC LIMIT 24`,
    );
    res.json({
      members: members.rows.map((m) => ({ username: m.username, count: m.n, locked: m.has_code && m.id !== req.user.id && !open.has(`gallery:${m.id}`) })),
      recent: recent.rows.map((r) => card(r, r.owner_id !== req.user.id && ((r.gcode && !open.has(`gallery:${r.owner_id}`)) || (r.dcode && !open.has(`diorama:${r.id}`))))),
    });
  }));

  app.get('/api/gallery/:username', needUser, wrap(async (req, res) => {
    const { rows: u } = await query(`SELECT id, username, (gallery_code_hash IS NOT NULL) AS has_code FROM ${T.users} WHERE LOWER(username) = LOWER($1)`, [String(req.params.username)]);
    if (!u[0]) return bad(res, 404, 'No one has that username.');
    const own = u[0].id === req.user.id || req.user.is_admin;
    if (u[0].has_code && !own && !(await unlocked(req.user.id, 'gallery', u[0].id))) return res.json({ owner: u[0].username, ownerId: u[0].id, locked: 'gallery' });
    const { rows } = await query(
      `SELECT d.id, d.title, d.thumb, d.updated_at, (d.code_hash IS NOT NULL) AS dcode, u.username FROM ${T.dioramas} d JOIN ${T.users} u ON u.id = d.owner_id
       WHERE d.owner_id = $1 AND d.visibility = 'gallery' ORDER BY d.updated_at DESC`,
      [u[0].id],
    );
    const unlockedRows = await query(`SELECT target_id FROM ${T.unlocks} WHERE user_id = $1 AND kind = 'diorama'`, [req.user.id]);
    const open = new Set(unlockedRows.rows.map((r) => r.target_id));
    res.json({ owner: u[0].username, ownerId: u[0].id, locked: null, dioramas: rows.map((r) => card(r, r.dcode && !own && !open.has(r.id))) });
  }));

  // Anyone can report, signed in or not. People who are not signed in are limited more strictly.
  const anonReportLimit = rateLimiter({ windowMs: 3600e3, max: 5 });
  app.post('/api/report', rateLimiter({ windowMs: 600e3, max: 20 }), (req, res, next) => (req.user ? next() : anonReportLimit(req, res, next)), wrap(async (req, res) => {
    const id = Number(req.body.dioramaId);
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (!Number.isInteger(id) || !reason) return bad(res, 400, 'Tell us briefly what is wrong.');
    const { rows } = await query(
      `SELECT d.owner_id, d.visibility, d.class_id, u.is_admin AS owner_admin FROM ${T.dioramas} d JOIN ${T.users} u ON u.id = d.owner_id WHERE d.id = $1 AND d.visibility IN ('gallery', 'class')`,
      [id],
    );
    if (!rows[0]) return bad(res, 404, 'Diorama not found.');
    let classOwner = null;
    if (rows[0].visibility === 'class') {
      // a diorama shared with a class can only be reported by someone in that class; the teacher reviews it
      if (!req.user || !(await isMember(req.user.id, rows[0].class_id))) return bad(res, 404, 'Diorama not found.');
      classOwner = (await query(`SELECT owner_id FROM ${T.classes} WHERE id = $1`, [rows[0].class_id])).rows[0]?.owner_id ?? null;
    }
    const me = req.user ? req.user.id : 0; // 0 = not signed in (no user has id 0)
    if (rows[0].owner_id === me) return bad(res, 400, 'That is your own diorama.');
    // A report about an admin's diorama goes to a different admin; if there is none, to a random other person.
    let assignedTo = null;
    if (classOwner && classOwner !== rows[0].owner_id && classOwner !== me) assignedTo = classOwner;
    else if (rows[0].owner_admin) {
      const admin = await query(`SELECT id FROM ${T.users} WHERE is_admin = TRUE AND id <> $1 AND id <> $2 ORDER BY random() LIMIT 1`, [rows[0].owner_id, me]);
      if (admin.rows[0]) assignedTo = admin.rows[0].id;
      else {
        const anyone = await query(`SELECT id FROM ${T.users} WHERE id <> $1 AND id <> $2 ORDER BY random() LIMIT 1`, [rows[0].owner_id, me]);
        assignedTo = anyone.rows[0] ? anyone.rows[0].id : null;
      }
    }
    const ipHash = req.user ? null : sha256(`report:${req.ip}`);
    await query(`INSERT INTO ${T.reports} (diorama_id, reporter_id, reporter_ip, reason, assigned_to) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [id, req.user ? req.user.id : null, ipHash, reason, assignedTo]);
    res.json({ ok: true });
  }));

  // --- feature requests and error reports: each one is a chat between the sender and the admins (Claude) until it is closed ---
  // Unread flags: user_unread = the sender has something new to read, admin_unread = the admins do.
  const feedbackThread = async (req, res) => {
    const { rows } = await query(`SELECT f.*, u.username FROM ${T.feedback} f LEFT JOIN ${T.users} u ON u.id = f.user_id WHERE f.id = $1`, [Number(req.params.id) || 0]);
    const f = rows[0];
    const mine = !!f && f.user_id === req.user.id;
    if (!f || !(mine || canReadAllFeedback(req.user))) return bad(res, 404, 'Not found.'), null;
    return { f, mine };
  };

  app.post('/api/feedback', needUser, rateLimiter({ windowMs: 3600e3, max: 10 }), wrap(async (req, res) => {
    const kind = req.body.kind;
    const message = String(req.body.message || '').trim().slice(0, 1000);
    if (!['feature', 'error'].includes(kind)) return bad(res, 400, 'Choose feature request or error.');
    if (!message) return bad(res, 400, 'Please write a few words.');
    // one conversation at a time: finish (close) the open one before starting another
    const open = await query(`SELECT id FROM ${T.feedback} WHERE user_id = $1 AND status = 'open' LIMIT 1`, [req.user.id]);
    if (open.rows[0]) return bad(res, 409, 'You already have an open conversation. Close it before starting a new one.', { id: open.rows[0].id });
    const { rows } = await query(`INSERT INTO ${T.feedback} (kind, message, user_id) VALUES ($1,$2,$3) RETURNING id`, [kind, message, req.user.id]);
    res.json({ ok: true, id: rows[0].id });
  }));

  // Admins see every open request (add ?mine=1 for only their own); everyone else sees their own, open and closed.
  app.get('/api/feedback', needUser, wrap(async (req, res) => {
    const all = canReadAllFeedback(req.user) && req.query.mine !== '1';
    const { rows } = await query(
      `SELECT f.id, f.kind, f.message, f.status, f.created_at, f.updated_at, f.user_id, f.user_unread, f.admin_unread, u.username,
         (SELECT COUNT(*)::int FROM ${T.feedbackMessages} m WHERE m.feedback_id = f.id) AS replies
       FROM ${T.feedback} f LEFT JOIN ${T.users} u ON u.id = f.user_id
       WHERE ${all ? "f.status = 'open'" : 'f.user_id = $1'}
       ORDER BY ${all ? 'f.created_at' : "f.status = 'open' DESC, f.updated_at DESC"}`,
      all ? [] : [req.user.id],
    );
    res.json({
      feedback: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        message: r.message,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        from: r.username || 'a deleted account',
        replies: r.replies,
        unread: r.user_id === req.user.id ? r.user_unread : r.admin_unread,
      })),
    });
  }));

  // The whole chat. Opening it marks it read for whoever opened it.
  app.get('/api/feedback/:id', needUser, wrap(async (req, res) => {
    const th = await feedbackThread(req, res);
    if (!th) return;
    const { f, mine } = th;
    const msgs = await query(
      `SELECT m.id, m.message, m.from_dev, m.created_at, u.username FROM ${T.feedbackMessages} m LEFT JOIN ${T.users} u ON u.id = m.user_id WHERE m.feedback_id = $1 ORDER BY m.id`,
      [f.id],
    );
    await query(`UPDATE ${T.feedback} SET ${mine ? 'user_unread' : 'admin_unread'} = FALSE WHERE id = $1`, [f.id]);
    res.json({
      id: f.id,
      kind: f.kind,
      status: f.status,
      from: f.username || 'a deleted account',
      mine,
      messages: [
        { id: 0, from: f.username || 'a deleted account', fromDev: false, mine, text: f.message, createdAt: f.created_at },
        ...msgs.rows.map((m) => ({ id: m.id, from: m.username || 'a deleted account', fromDev: m.from_dev, mine: m.from_dev === !mine, text: m.message, createdAt: m.created_at })),
      ],
    });
  }));

  app.post('/api/feedback/:id/messages', needUser, rateLimiter({ windowMs: 600e3, max: 60 }), wrap(async (req, res) => {
    const th = await feedbackThread(req, res);
    if (!th) return;
    const { f, mine } = th;
    const message = String(req.body.message || '').trim().slice(0, 1000);
    if (!message) return bad(res, 400, 'Please write a few words.');
    if (f.status !== 'open') return bad(res, 409, 'This conversation is closed.');
    await query(`INSERT INTO ${T.feedbackMessages} (feedback_id, user_id, from_dev, message) VALUES ($1,$2,$3,$4)`, [f.id, req.user.id, !mine, message]);
    await query(`UPDATE ${T.feedback} SET updated_at = NOW(), ${mine ? 'admin_unread = TRUE' : 'user_unread = TRUE'} WHERE id = $1`, [f.id]);
    res.json({ ok: true });
  }));

  // Close the chat: the admins can, and so can the person who sent it.
  app.post('/api/feedback/:id/done', needUser, wrap(async (req, res) => {
    const th = await feedbackThread(req, res);
    if (!th) return;
    const { f, mine } = th;
    if (f.status !== 'open') return bad(res, 404, 'Not found.');
    await query(`UPDATE ${T.feedback} SET status = 'done', handled_at = NOW(), updated_at = NOW(), ${mine ? 'admin_unread = FALSE' : 'user_unread = TRUE, admin_unread = FALSE'} WHERE id = $1`, [f.id]);
    res.json({ ok: true });
  }));

  // --- reviewing reports ---
  app.get('/api/reports', needUser, wrap(async (req, res) => {
    const me = Number(req.user.id);
    const { rows } = await query(
      `SELECT r.id, r.reason, r.created_at, r.assigned_to, d.id AS diorama_id, d.title, d.visibility, o.id AS owner_id, o.username AS owner, p.username AS reporter
       FROM ${T.reports} r JOIN ${T.dioramas} d ON d.id = r.diorama_id JOIN ${T.users} o ON o.id = d.owner_id LEFT JOIN ${T.users} p ON p.id = r.reporter_id
       WHERE ${REVIEWABLE(me, !!req.user.is_admin)} ORDER BY r.created_at`,
    );
    res.json({
      reports: rows.map((r) => ({
        id: r.id,
        reason: r.reason,
        createdAt: r.created_at,
        dioramaId: r.diorama_id,
        title: r.title,
        visibility: r.visibility,
        owner: r.owner,
        reporter: req.user.is_admin ? r.reporter || 'someone not signed in' : null, // only admins see who reported
        pickedForYou: r.assigned_to === me,
      })),
    });
  }));

  app.post('/api/reports/:id/action', needUser, wrap(async (req, res) => {
    const reportId = Number(req.params.id);
    const action = req.body.action;
    if (!Number.isInteger(reportId) || !['dismiss', 'hide', 'delete'].includes(action)) return bad(res, 400, 'Bad request.');
    const me = Number(req.user.id);
    const { rows } = await query(
      `SELECT r.id, r.diorama_id FROM ${T.reports} r JOIN ${T.dioramas} d ON d.id = r.diorama_id JOIN ${T.users} o ON o.id = d.owner_id
       WHERE r.id = $1 AND ${REVIEWABLE(me, !!req.user.is_admin)}`,
      [reportId],
    );
    if (!rows[0]) return bad(res, 404, 'That report is not waiting for you.');
    const dioramaId = rows[0].diorama_id;
    if (action === 'delete') {
      await query(`DELETE FROM ${T.dioramas} WHERE id = $1`, [dioramaId]); // its reports go with it
    } else if (action === 'hide') {
      await query(`UPDATE ${T.dioramas} SET visibility = 'private' WHERE id = $1`, [dioramaId]);
      await query(`UPDATE ${T.reports} SET status = 'actioned', handled_by = $2, handled_at = NOW() WHERE diorama_id = $1 AND status = 'open'`, [dioramaId, me]);
    } else {
      await query(`UPDATE ${T.reports} SET status = 'dismissed', handled_by = $2, handled_at = NOW() WHERE id = $1`, [reportId, me]);
    }
    res.json({ ok: true });
  }));

  app.use('/api', (req, res) => bad(res, 404, 'Not found'));

  // --- the website itself (explicit allow-list, so server code and .env are never served) ---
  const send = (file) => (req, res) => res.sendFile(path.join(ROOT, file));
  app.get('/', send('index.html'));
  app.get('/index.html', send('index.html'));
  app.get('/style.css', send('style.css'));
  // no-cache = the browser re-checks (cheap ETag request) so a deploy shows up on the next refresh, not 5 minutes later
  app.use('/src', express.static(path.join(ROOT, 'src'), { dotfiles: 'deny', etag: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  app.use('/img', express.static(path.join(ROOT, 'img'), { dotfiles: 'deny', maxAge: '1d' })); // pictures of the starting scenes
  app.use('/vendor', express.static(path.join(ROOT, 'vendor'), { dotfiles: 'deny', maxAge: '7d' }));

  app.use((err, req, res, next) => {
    console.error('[error]', req.method, req.path, err.message);
    if (res.headersSent) return next(err);
    res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.status && err.status < 500 ? err.message : 'Something went wrong on our side. Please try again.' });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await initDb();
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Cubeloft running at http://localhost:${port}`));
}
