const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'tickets.db'));
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'agent', 'employee')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    priority    TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    created_by  INTEGER NOT NULL REFERENCES users(id),
    assigned_to INTEGER REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One-time links sent by email (verify address, reset password, confirm new email).
  -- Only a hash of the token is stored.
  CREATE TABLE IF NOT EXISTS tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    type       TEXT NOT NULL CHECK (type IN ('verify_email', 'reset_password', 'change_email')),
    token_hash TEXT NOT NULL UNIQUE,
    new_email  TEXT,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  );

  -- Emails waiting to be sent, and a log of what was sent.
  CREATE TABLE IF NOT EXISTS email_outbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    to_email   TEXT NOT NULL,
    subject    TEXT NOT NULL,
    text_body  TEXT NOT NULL,
    html_body  TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    user_id INTEGER,
    data    TEXT NOT NULL,
    expires INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Migration: databases created before the 'agent' role existed need the users table rebuilt,
// because SQLite can't alter a CHECK constraint in place.
const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().sql;
if (!usersSql.includes("'agent'")) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE users_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('admin', 'agent', 'employee')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at    TEXT
    );
    INSERT INTO users_new (id, name, email, password_hash, role, created_at)
      SELECT id, name, email, password_hash, role, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
  console.log('Migrated users table: added agent role and soft delete');
}

// Departments: tickets belong to one, agents can belong to one.
db.exec(`
  CREATE TABLE IF NOT EXISTS departments (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
`);
// request_key links a department to a request type on the New ticket form ('production' / 'it'),
// so departments can be renamed without breaking ticket routing.
if (addColumnIfMissing('departments', 'request_key', 'TEXT')) {
  db.exec(`
    UPDATE departments SET request_key = 'it' WHERE name = 'IT Support';
    UPDATE departments SET request_key = 'production' WHERE name = 'Production';
  `);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_request_key ON departments(request_key)');
// Default departments, only on a brand-new database (so renamed departments don't come back)
if (db.prepare('SELECT COUNT(*) AS n FROM departments').get().n === 0) {
  const insert = db.prepare('INSERT INTO departments (name, request_key) VALUES (?, ?)');
  insert.run('IT Support', 'it');
  insert.run('Production', 'production');
}

// Returns true if the column was added.
function addColumnIfMissing(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return !exists;
}
addColumnIfMissing('users', 'department_id', 'INTEGER REFERENCES departments(id)');
addColumnIfMissing('tickets', 'department_id', 'INTEGER REFERENCES departments(id)');
// Request form fields: where the problem is, and (for production requests) what is being requested
addColumnIfMissing('tickets', 'location', 'TEXT');
addColumnIfMissing('tickets', 'request_item', 'TEXT');
// When the ticket was closed. Tickets closed before this existed use their last update time.
if (addColumnIfMissing('tickets', 'closed_at', 'TEXT')) {
  db.exec("UPDATE tickets SET closed_at = updated_at WHERE status = 'closed'");
}

// First and last name. `name` is kept as the full display name ("First Last").
if (addColumnIfMissing('users', 'first_name', "TEXT NOT NULL DEFAULT ''")) {
  addColumnIfMissing('users', 'last_name', "TEXT NOT NULL DEFAULT ''");
  const { changes } = db.prepare(`
    UPDATE users SET
      first_name = CASE WHEN instr(name, ' ') > 0 THEN substr(name, 1, instr(name, ' ') - 1) ELSE name END,
      last_name  = CASE WHEN instr(name, ' ') > 0 THEN trim(substr(name, instr(name, ' ') + 1)) ELSE '' END
  `).run();
  if (changes) console.log('Migrated users: split name into first and last name');
}

// Accounts that existed before email verification was added were created by an admin, so trust them.
if (addColumnIfMissing('users', 'email_verified_at', 'TEXT')) {
  db.exec('UPDATE users SET email_verified_at = created_at');
}

// Who did what to which ticket. ticket_id has no foreign key so entries survive ticket deletion;
// ticket_title keeps the title as it was.
const activityExisted = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activity_log'").get();
db.exec(`
  CREATE TABLE IF NOT EXISTS activity_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    ticket_id    INTEGER,
    ticket_title TEXT,
    action       TEXT NOT NULL,
    details      TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
`);
if (!activityExisted) {
  // Fill in what history we have: tickets created and comments written before the log existed.
  db.exec(`
    INSERT INTO activity_log (user_id, ticket_id, ticket_title, action, details, created_at)
      SELECT t.created_by, t.id, t.title, 'created', NULL, t.created_at FROM tickets t;
    INSERT INTO activity_log (user_id, ticket_id, ticket_title, action, details, created_at)
      SELECT c.user_id, c.ticket_id, t.title, 'comment', substr(c.body, 1, 200), c.created_at
      FROM comments c JOIN tickets t ON t.id = c.ticket_id;
  `);
}

function getSetting(key, createValue) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value;
  const value = createValue();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
  return value;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

// The main admin (from ADMIN_EMAIL in .env) is protected: it can't be deleted or lose its admin role,
// and other admins can't change its email or password.
addColumnIfMissing('users', 'is_protected', 'INTEGER NOT NULL DEFAULT 0');
// Appearance: 'system' (follow the device), 'light' or 'dark'
addColumnIfMissing('users', 'theme', "TEXT NOT NULL DEFAULT 'system'");

// On first run, create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD in .env.
// If no password is set, a random one is generated and printed once to the console.
const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
if (count === 0) {
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare(`
    INSERT INTO users (first_name, last_name, name, email, password_hash, role, email_verified_at, is_protected)
    VALUES ('Admin', 'User', 'Admin User', ?, ?, 'admin', datetime('now'), 1)
  `).run(email, hashPassword(password));
  console.log(process.env.ADMIN_PASSWORD
    ? `Created first admin account: ${email} (password from ADMIN_PASSWORD in .env)`
    : `Created first admin account: ${email} / ${password}  <-- write this down and change it after logging in`);
}

// Existing databases: the admin whose email matches ADMIN_EMAIL becomes the protected main admin.
if (process.env.ADMIN_EMAIL) {
  const { changes } = db.prepare(`
    UPDATE users SET is_protected = 1
    WHERE email = ? AND role = 'admin' AND deleted_at IS NULL AND is_protected = 0
  `).run(process.env.ADMIN_EMAIL.trim().toLowerCase());
  if (changes) console.log(`Protected main admin: ${process.env.ADMIN_EMAIL.trim().toLowerCase()} (from ADMIN_EMAIL in .env)`);
}

module.exports = { db, hashPassword, verifyPassword, getSetting };
