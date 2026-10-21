import 'dotenv/config';
import pg from 'pg';

// TABLE_PREFIX lets the automated tests use their own throw-away tables in the same database.
export const PREFIX = process.env.TABLE_PREFIX || '';
const t = (name) => `${PREFIX}${name}`;
export const T = { users: t('users'), sessions: t('sessions'), dioramas: t('dioramas'), unlocks: t('unlocks'), reports: t('reports'), classes: t('classes'), members: t('class_members'), feedback: t('feedback'), feedbackMessages: t('feedback_messages') };

function connectionString() {
  const raw = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set (see README: Running the server)');
  // pg treats sslmode itself; we set ssl explicitly below
  const u = new URL(raw);
  u.searchParams.delete('sslmode');
  u.searchParams.delete('channel_binding');
  return u.toString();
}

export const pool = new pg.Pool({
  connectionString: connectionString(),
  ssl: { rejectUnauthorized: true },
  max: 4,
  idleTimeoutMillis: 5000, // let connections close quickly so Neon can scale to zero
  connectionTimeoutMillis: 15000,
});
pool.on('error', (err) => console.error('[db]', err.message));

export const query = (text, params) => pool.query(text, params);

export async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS ${T.users} (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      gallery_code_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${T.sessions} (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${T.dioramas} (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      data TEXT NOT NULL,
      thumb TEXT,
      visibility TEXT NOT NULL DEFAULT 'private',
      code_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ${T.dioramas}_owner ON ${T.dioramas}(owner_id);
    CREATE TABLE IF NOT EXISTS ${T.unlocks} (
      user_id INTEGER NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind, target_id)
    );
    CREATE TABLE IF NOT EXISTS ${T.reports} (
      id SERIAL PRIMARY KEY,
      diorama_id INTEGER NOT NULL REFERENCES ${T.dioramas}(id) ON DELETE CASCADE,
      reporter_id INTEGER NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (diorama_id, reporter_id)
    );
  `);

  // Report review: who is asked to look at it, and what happened to it.
  await query(`
    ALTER TABLE ${T.reports} ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES ${T.users}(id) ON DELETE SET NULL;
    ALTER TABLE ${T.reports} ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
    ALTER TABLE ${T.reports} ADD COLUMN IF NOT EXISTS handled_by INTEGER REFERENCES ${T.users}(id) ON DELETE SET NULL;
    ALTER TABLE ${T.reports} ADD COLUMN IF NOT EXISTS handled_at TIMESTAMPTZ;
    -- reports can be sent without signing in: no reporter, and a hash of the sender's address so one address can only report a diorama once
    ALTER TABLE ${T.reports} ALTER COLUMN reporter_id DROP NOT NULL;
    ALTER TABLE ${T.reports} ADD COLUMN IF NOT EXISTS reporter_ip TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS ${t('reports_anon_once')} ON ${T.reports} (diorama_id, reporter_ip) WHERE reporter_id IS NULL;
  `);

  // Class galleries: a class has an owner (the teacher) and members who joined with the class code. A diorama
  // can be published to one class (visibility 'class'); only members can open it.
  await query(`
    CREATE TABLE IF NOT EXISTS ${T.classes} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      code TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${T.members} (
      class_id INTEGER NOT NULL REFERENCES ${T.classes}(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (class_id, user_id)
    );
    ALTER TABLE ${T.dioramas} ADD COLUMN IF NOT EXISTS class_id INTEGER REFERENCES ${T.classes}(id) ON DELETE SET NULL;
    -- the owner can let everyone in the class edit a diorama shared with that class
    ALTER TABLE ${T.dioramas} ADD COLUMN IF NOT EXISTS class_edit BOOLEAN NOT NULL DEFAULT FALSE;
    -- feature requests and error reports sent from the gallery; admins (the Claude account) read them
    CREATE TABLE IF NOT EXISTS ${T.feedback} (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      user_id INTEGER REFERENCES ${T.users}(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      handled_at TIMESTAMPTZ
    );
    -- each request is a chat: the first message is feedback.message, the replies (from either side) live here until it is closed
    ALTER TABLE ${T.feedback} ADD COLUMN IF NOT EXISTS user_unread BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE ${T.feedback} ADD COLUMN IF NOT EXISTS admin_unread BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE ${T.feedback} ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE TABLE IF NOT EXISTS ${T.feedbackMessages} (
      id SERIAL PRIMARY KEY,
      feedback_id INTEGER NOT NULL REFERENCES ${T.feedback}(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES ${T.users}(id) ON DELETE SET NULL,
      from_dev BOOLEAN NOT NULL DEFAULT FALSE,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Case-insensitive uniqueness ("Ann" and "ann" are the same person). Not fatal if old data already clashes.
  try {
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS ${t('users_username_lower')} ON ${T.users} (LOWER(username))`);
  } catch (e) {
    console.error('[db] could not create the case-insensitive username index:', e.message);
  }
}

export async function dropAll() {
  if (!PREFIX) throw new Error('refusing to drop tables without TABLE_PREFIX');
  await query(`DROP TABLE IF EXISTS ${T.feedbackMessages}, ${T.feedback}, ${T.reports}, ${T.unlocks}, ${T.members}, ${T.dioramas}, ${T.classes}, ${T.sessions}, ${T.users} CASCADE`);
}
