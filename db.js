'use strict';

const path = require('path');
const fs   = require('fs');

const dbDir  = path.join(__dirname, '..', 'db');
const dbFile = path.join(dbDir, 'margin.sqlite');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const state = { db: null };

const dbReady = require('sql.js')().then(SQL => {
  const sqlDb = fs.existsSync(dbFile)
    ? new SQL.Database(fs.readFileSync(dbFile))
    : new SQL.Database();

  function persist() {
    fs.writeFileSync(dbFile, Buffer.from(sqlDb.export()));
  }

  // sql.js exec() does not handle null/undefined params well.
  // This wrapper converts null → the string 'NULL' is wrong too.
  // Instead we use the binding array and replace JS null with sql.js null (which it accepts as null in array).
  function safeExec(sql, params) {
    if (!params || params.length === 0) {
      return sqlDb.exec(sql);
    }
    // sql.js accepts null in param arrays as SQL NULL
    return sqlDb.exec(sql, params);
  }

  // ─── SCHEMA ────────────────────────────────────────────────────────────────
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL, password TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`,
    `CREATE TABLE IF NOT EXISTS otps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE,
      code TEXT NOT NULL, expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      read_time INTEGER NOT NULL DEFAULT 3,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`,
    `CREATE TABLE IF NOT EXISTS post_likes (
      post_id INTEGER NOT NULL,
      user_email TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (post_id, user_email))`,
    `CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL, author TEXT NOT NULL,
      author_email TEXT NOT NULL COLLATE NOCASE,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`,
    `CREATE TABLE IF NOT EXISTS discussions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL, author_email TEXT NOT NULL COLLATE NOCASE,
      tags TEXT NOT NULL DEFAULT '[]', is_open INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`,
    `CREATE TABLE IF NOT EXISTS discussion_likes (
      discussion_id INTEGER NOT NULL,
      user_email TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (discussion_id, user_email))`,
    `CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discussion_id INTEGER NOT NULL, parent_id INTEGER,
      author TEXT NOT NULL, author_email TEXT NOT NULL COLLATE NOCASE,
      text TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'branch',
      depth INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`,
    `CREATE TABLE IF NOT EXISTS leaves (
      branch_id INTEGER NOT NULL, user_name TEXT NOT NULL,
      user_email TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (branch_id, user_email))`,
    `CREATE TABLE IF NOT EXISTS merge_votes (
      branch_id INTEGER NOT NULL,
      user_email TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (branch_id, user_email))`,
    `CREATE TABLE IF NOT EXISTS points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_name TEXT NOT NULL, amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`
  ];
  tables.forEach(t => sqlDb.exec(t));

  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_otps_email      ON otps(email)`,
    `CREATE INDEX IF NOT EXISTS idx_post_likes_post ON post_likes(post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_post   ON comments(post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_disc_likes      ON discussion_likes(discussion_id)`,
    `CREATE INDEX IF NOT EXISTS idx_branches_disc   ON branches(discussion_id)`,
    `CREATE INDEX IF NOT EXISTS idx_branches_parent ON branches(parent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_leaves_branch   ON leaves(branch_id)`,
    `CREATE INDEX IF NOT EXISTS idx_merge_branch    ON merge_votes(branch_id)`,
    `CREATE INDEX IF NOT EXISTS idx_points_user     ON points(user_name)`
  ];
  indexes.forEach(i => sqlDb.exec(i));
  persist();

  // ─── prepare() shim ────────────────────────────────────────────────────────
  function prepare(sql) {
    return {
      get(...args) {
        try {
          const params = args.flat();
          const results = safeExec(sql, params.length ? params : null);
          if (!results || !results.length || !results[0].values.length) return undefined;
          const { columns, values } = results[0];
          return Object.fromEntries(columns.map((c, i) => [c, values[0][i]]));
        } catch(e) {
          console.error('[db.get] SQL:', sql, 'ERR:', e.message);
          throw e;
        }
      },
      all(...args) {
        try {
          const params = args.flat();
          const results = safeExec(sql, params.length ? params : null);
          if (!results || !results.length) return [];
          const { columns, values } = results[0];
          return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
        } catch(e) {
          console.error('[db.all] SQL:', sql, 'ERR:', e.message);
          throw e;
        }
      },
      run(...args) {
        try {
          const params = args.flat();
          // Use sqlDb.run() not exec() — and read rowid BEFORE persist()
          // because persist() (sqlDb.export()) resets last_insert_rowid() to 0
          sqlDb.run(sql, params.length ? params : undefined);
          const rid = sqlDb.exec('SELECT last_insert_rowid()')[0].values[0][0];
          const chg = sqlDb.getRowsModified();
          persist();
          return { lastInsertRowid: rid, changes: chg };
        } catch(e) {
          console.error('[db.run] SQL:', sql, 'ERR:', e.message);
          throw e;
        }
      }
    };
  }

  state.db = { prepare };

  // ─── SEED ──────────────────────────────────────────────────────────────────
  const count = prepare('SELECT COUNT(*) AS n FROM posts').get().n;
  if (count === 0) {
    console.log('[db] Seeding initial posts…');
    const now = Math.floor(Date.now() / 1000);
    const ins = prepare(`INSERT INTO posts (title,excerpt,content,tags,read_time,created_at) VALUES (?,?,?,?,?,?)`);
    ins.run('Welcome to The Margin', 'A space for ideas that live between disciplines.',
      '<p>Welcome to <strong>The Margin</strong> — a place for ideas that do not fit neatly anywhere else.</p>',
      JSON.stringify(['welcome','meta']), 2, now - 172800);
    ins.run('The Attention Economy and Why You Feel Exhausted', 'Every app is optimised to capture your attention.',
      '<p>Your attention is finite. Every platform is optimised to take as much of it as possible.</p>',
      JSON.stringify(['technology','culture']), 4, now - 86400);
    ins.run('On Slowness as a Competitive Advantage', 'In a world optimised for speed, moving deliberately has become rare.',
      '<p>Speed is celebrated everywhere. But the most durable work is built slowly.</p>',
      JSON.stringify(['philosophy','productivity']), 3, now - 43200);
    console.log('[db] Seed complete — 3 posts added.');
  }

  return state.db;
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getUserPoints(userName) {
  const row = state.db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM points WHERE user_name=?`).get(userName);
  return row ? row.total : 0;
}
function addPoints(userName, amount, reason) {
  if (!userName || userName === 'Admin' || amount === 0) return;
  state.db.prepare(`INSERT INTO points (user_name,amount,reason) VALUES (?,?,?)`).run(userName, amount, reason);
}
function getLeafEmails(branchId) {
  return state.db.prepare(`SELECT user_email FROM leaves WHERE branch_id=?`).all(branchId).map(r => r.user_email);
}
function getMergeVoters(branchId) {
  return state.db.prepare(`SELECT user_email FROM merge_votes WHERE branch_id=?`).all(branchId).map(r => r.user_email);
}
function buildBranchTree(discussionId, parentId) {
  // Use IS NULL / IS ? carefully — pass null directly
  const rows = parentId == null
    ? state.db.prepare(`SELECT * FROM branches WHERE discussion_id=? AND parent_id IS NULL ORDER BY created_at ASC`).all(discussionId)
    : state.db.prepare(`SELECT * FROM branches WHERE discussion_id=? AND parent_id=? ORDER BY created_at ASC`).all(discussionId, parentId);
  return rows.map(b => ({
    ...b,
    leaves:     getLeafEmails(b.id),
    mergeVotes: getMergeVoters(b.id),
    children:   buildBranchTree(b.discussion_id, b.id)
  }));
}
function getLeaderboard() {
  return state.db.prepare(`SELECT user_name AS name, SUM(amount) AS total FROM points GROUP BY user_name ORDER BY total DESC LIMIT 10`).all();
}

module.exports = {
  get db() { return state.db; },
  dbReady,
  getUserPoints,
  addPoints,
  buildBranchTree,
  getLeaderboard
};
