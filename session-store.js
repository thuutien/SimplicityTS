const session = require('express-session');
const { db } = require('./db');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Keeps login sessions in SQLite so they survive restarts, and records which user
// each session belongs to so we can sign a user out everywhere (e.g. after a password reset).
class SqliteStore extends session.Store {
  constructor() {
    super();
    // Clear out expired sessions once an hour
    setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 60 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + DEFAULT_TTL_MS;
      db.prepare(`
        INSERT INTO sessions (sid, user_id, data, expires) VALUES (?, ?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET user_id = excluded.user_id, data = excluded.data, expires = excluded.expires
      `).run(sid, sess.userId ?? null, JSON.stringify(sess), expires);
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

// Signs a user out of every session except (optionally) the current one.
function destroyUserSessions(userId, exceptSid = null) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND sid IS NOT ?').run(userId, exceptSid);
}

module.exports = { SqliteStore, destroyUserSessions };
