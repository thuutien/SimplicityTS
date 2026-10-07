const path = require('node:path');

// Load settings from .env (SMTP details, APP_URL, ...) before anything reads them.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // No .env file: use defaults
}

const express = require('express');
const session = require('express-session');
const crypto = require('node:crypto');
const { db, hashPassword, verifyPassword, getSetting } = require('./db');
const { SqliteStore, destroyUserSessions } = require('./session-store');
const mailer = require('./mailer');
const { queueEmail, startMailer, getAppUrl, getAppName } = mailer;
const notify = require('./notify');
const activity = require('./activity');

const app = express();
const PORT = process.env.PORT || 5000;

const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high'];
const ROLES = ['employee', 'agent', 'admin'];
const STAFF_ROLES = ['agent', 'admin'];
const ALLOWED_SIGNUP_DOMAIN = (process.env.ALLOWED_SIGNUP_DOMAIN || 'retailking.com').toLowerCase();
const MIN_PASSWORD_LENGTH = 8;
const REMEMBER_DAYS = Number(process.env.REMEMBER_DAYS || 90);

app.set('trust proxy', 'loopback');
app.use(express.json());
app.use(session({
  store: new SqliteStore(),
  // Kept in the database so logins survive restarts, unless set explicitly in .env
  secret: process.env.SESSION_SECRET || getSetting('session_secret', () => crypto.randomBytes(32).toString('hex')),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  // No maxAge here: by default the login cookie ends when the browser closes.
  // "Keep me logged in" sets a long maxAge at login (see /api/login).
  cookie: { httpOnly: true, sameSite: 'lax' },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

const isStaff = user => STAFF_ROLES.includes(user.role);
const normalizeEmail = email => String(email || '').trim().toLowerCase();
const isCompanyEmail = email => new RegExp(`^[^@\\s]+@${ALLOWED_SIGNUP_DOMAIN.replace(/\./g, '\\.')}$`).test(email);
const isValidEmail = email => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

function passwordError(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  return null;
}

function nameFields(body) {
  const first_name = String(body.first_name || '').trim().slice(0, 50);
  const last_name = String(body.last_name || '').trim().slice(0, 50);
  if (!first_name || !last_name) return { error: 'First name and last name are required' };
  return { first_name, last_name, name: `${first_name} ${last_name}` };
}

// Simple in-memory rate limiter, e.g. to slow down password guessing.
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset < now) hits.delete(key);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    if (++entry.count > max) return res.status(429).json({ error: message || 'Too many attempts. Please try again later.' });
    next();
  };
}
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many login attempts. Please wait 15 minutes and try again.' });
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

// ----- one-time email links -----

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

function createToken(userId, type, minutes, newEmail = null) {
  // Only the newest link of each type works
  db.prepare("UPDATE tokens SET used_at = datetime('now') WHERE user_id = ? AND type = ? AND used_at IS NULL").run(userId, type);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO tokens (user_id, type, token_hash, new_email, expires_at)
              VALUES (?, ?, ?, ?, datetime('now', ?))`).run(userId, type, hashToken(token), newEmail, `+${minutes} minutes`);
  return token;
}

// Returns the token row if valid (and marks it used), otherwise null.
function consumeToken(token, types) {
  const row = db.prepare(`
    SELECT * FROM tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
  `).get(hashToken(String(token || '')));
  if (!row || !types.includes(row.type)) return null;
  db.prepare("UPDATE tokens SET used_at = datetime('now') WHERE id = ?").run(row.id);
  return row;
}

function sendVerificationEmail(user) {
  const token = createToken(user.id, 'verify_email', 24 * 60);
  queueEmail(user.email, `Verify your email for ${getAppName()}`, {
    greeting: `Hi ${user.first_name},`,
    lines: ['Thanks for signing up. Please confirm your email address to activate your account. This link expires in 24 hours.'],
    button: { label: 'Verify email', url: `${getAppUrl()}/#verify/${token}` },
    footer: "If you didn't create this account, you can ignore this email.",
  });
}

function sendPasswordResetEmail(user, { requestedByAdmin = false } = {}) {
  const token = createToken(user.id, 'reset_password', 30);
  queueEmail(user.email, `Reset your ${getAppName()} password`, {
    greeting: `Hi ${user.first_name},`,
    lines: [
      requestedByAdmin
        ? 'An administrator sent you a link to set a new password.'
        : 'We received a request to reset your password.',
      'Click the button below to choose a new password. This link expires in 30 minutes and can only be used once.',
    ],
    button: { label: 'Reset password', url: `${getAppUrl()}/#reset/${token}` },
    footer: "If you didn't ask for this, you can ignore this email. Your password won't change.",
  });
}

function sendPasswordChangedEmail(user) {
  queueEmail(user.email, `Your ${getAppName()} password was changed`, {
    greeting: `Hi ${user.first_name},`,
    lines: [
      'Your password was just changed, and you have been signed out on your other devices.',
      "If you didn't do this, reset your password right away and contact an administrator.",
    ],
    button: { label: 'Reset password', url: `${getAppUrl()}/#forgot` },
  });
}

// ----- auth middleware -----

// Reloads the user on every request so role changes and deletions take effect immediately.
function requireAuth(req, res, next) {
  const id = req.session.userId;
  const user = id && db.prepare(`
    SELECT u.id, u.first_name, u.last_name, u.name, u.email, u.role, u.department_id, d.name AS department_name
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.id = ? AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL
  `).get(id);
  if (!user) {
    return req.session.destroy(() => res.status(401).json({ error: 'Not logged in' }));
  }
  req.user = user;
  next();
}

function requireStaff(req, res, next) {
  if (!isStaff(req.user)) return res.status(403).json({ error: 'Agents and admins only' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

const displayName = alias => `CASE WHEN ${alias}.deleted_at IS NULL THEN ${alias}.name ELSE ${alias}.name || ' (deleted)' END`;

const TICKET_SELECT = `
  SELECT t.*, ${displayName('c')} AS created_by_name, ${displayName('a')} AS assigned_to_name,
         d.name AS department_name
  FROM tickets t
  JOIN users c ON c.id = t.created_by
  LEFT JOIN users a ON a.id = t.assigned_to
  LEFT JOIN departments d ON d.id = t.department_id
`;

// Admins can work on any ticket; agents only on tickets in their own department.
const canWork = (user, ticket) =>
  user.role === 'admin' ||
  (user.role === 'agent' && user.department_id != null && user.department_id === ticket.department_id);

const departmentExists = id => !!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(id);

// An assignee must be an admin, or an agent in the ticket's department.
const isValidAssignee = (userId, departmentId) => !!db.prepare(`
  SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL
    AND (role = 'admin' OR (role = 'agent' AND department_id IS NOT NULL AND department_id = ?))
`).get(userId, departmentId);

// Returns the ticket if the current user may see it, otherwise sends an error and returns null.
function loadTicket(req, res) {
  const ticket = db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(req.params.id);
  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return null;
  }
  if (!isStaff(req.user) && ticket.created_by !== req.user.id) {
    res.status(403).json({ error: 'Not your ticket' });
    return null;
  }
  return ticket;
}

const activeAdminCount = () =>
  db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND deleted_at IS NULL").get().n;

// ---------- auth ----------

app.post('/api/login', loginLimiter, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL').get(normalizeEmail(req.body.email));
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.email_verified_at) {
    return res.status(403).json({ error: 'Please verify your email address first. Check your inbox for the link.', code: 'unverified' });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user.id;
    // "Keep me logged in": stay logged in for REMEMBER_DAYS after the last visit (rolling).
    // Otherwise the cookie ends when the browser closes.
    if (req.body.remember) req.session.cookie.maxAge = REMEMBER_DAYS * 24 * 60 * 60 * 1000;
    res.json({ ok: true });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

// App version for the footer (no login needed). Bump "version" in package.json for each release.
const { version: APP_VERSION } = require('./package.json');
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));

// Self-registration: company email addresses only, always as an employee, must verify email before logging in.
app.post('/api/register', emailLimiter, (req, res) => {
  const names = nameFields(req.body);
  if (names.error) return res.status(400).json(names);
  const email = normalizeEmail(req.body.email);
  if (!isCompanyEmail(email)) {
    return res.status(400).json({ error: `Please use your @${ALLOWED_SIGNUP_DOMAIN} email address` });
  }
  const password = String(req.body.password || '');
  const pwError = passwordError(password);
  if (pwError) return res.status(400).json({ error: pwError });

  // Same response whether or not the account already exists, so this can't be used to look up who has an account.
  const done = () => res.status(201).json({ ok: true, message: `We've sent a verification link to ${email}. Click it to activate your account.` });

  const existing = db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL').get(email);
  if (existing) {
    if (!existing.email_verified_at) {
      sendVerificationEmail(existing);
    } else {
      queueEmail(existing.email, `You already have a ${getAppName()} account`, {
        greeting: `Hi ${existing.first_name},`,
        lines: ['Someone tried to create an account with this email address, but you already have one.', 'If you forgot your password, you can reset it here:'],
        button: { label: 'Reset password', url: `${getAppUrl()}/#forgot` },
      });
    }
    return done();
  }

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO users (first_name, last_name, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?, 'employee')
  `).run(names.first_name, names.last_name, names.name, email, hashPassword(password));
  sendVerificationEmail({ id: lastInsertRowid, first_name: names.first_name, email });
  done();
});

app.post('/api/resend-verification', emailLimiter, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL AND email_verified_at IS NULL')
    .get(normalizeEmail(req.body.email));
  if (user) sendVerificationEmail(user);
  res.json({ ok: true, message: 'If that account is waiting for verification, we have sent a new link.' });
});

app.post('/api/verify-email', (req, res) => {
  const row = consumeToken(req.body.token, ['verify_email']);
  if (!row) return res.status(400).json({ error: 'This link is invalid or has expired.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(row.user_id);
  if (!user) return res.status(400).json({ error: 'This link is invalid or has expired.' });

  db.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?").run(user.id);
  res.json({ ok: true, message: 'Your email is verified. You can now log in.' });
});

app.post('/api/forgot-password', emailLimiter, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL').get(normalizeEmail(req.body.email));
  if (user) sendPasswordResetEmail(user);
  // Same answer either way, so this can't be used to find out who has an account.
  res.json({ ok: true, message: 'If an account exists for that email, we have sent a link to reset the password.' });
});

app.post('/api/reset-password', emailLimiter, (req, res) => {
  const password = String(req.body.password || '');
  const pwError = passwordError(password);
  if (pwError) return res.status(400).json({ error: pwError });
  const row = consumeToken(req.body.token, ['reset_password']);
  if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(row.user_id);
  if (!user) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });

  // Clicking an emailed link proves they own the address, so this also verifies it.
  db.prepare("UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?")
    .run(hashPassword(password), user.id);
  destroyUserSessions(user.id);
  sendPasswordChangedEmail(user);
  res.json({ ok: true, message: 'Your password has been reset. You can now log in.' });
});

// ---------- my account ----------

app.patch('/api/me', requireAuth, (req, res) => {
  const names = nameFields(req.body);
  if (names.error) return res.status(400).json(names);
  db.prepare('UPDATE users SET first_name = ?, last_name = ?, name = ? WHERE id = ?')
    .run(names.first_name, names.last_name, names.name, req.user.id);
  res.json({ ok: true });
});

app.post('/api/me/password', requireAuth, loginLimiter, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(req.body.current_password || ''), user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const password = String(req.body.new_password || '');
  const pwError = passwordError(password);
  if (pwError) return res.status(400).json({ error: pwError });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
  destroyUserSessions(user.id, req.sessionID);
  sendPasswordChangedEmail(user);
  res.json({ ok: true, message: 'Password changed. You have been signed out on your other devices.' });
});

// ---------- tickets ----------

app.get('/api/tickets', requireAuth, (req, res) => {
  const where = [];
  const params = [];
  if (!isStaff(req.user)) {
    where.push('t.created_by = ?');
    params.push(req.user.id);
  }
  if (STATUSES.includes(req.query.status)) {
    where.push('t.status = ?');
    params.push(req.query.status);
  }
  // Open = anything not closed yet (open, in progress, resolved)
  if (req.query.state === 'open') where.push("t.status != 'closed'");
  if (req.query.state === 'closed') where.push("t.status = 'closed'");
  // Created between two UTC times ("YYYY-MM-DD HH:MM:SS"); the browser converts the chosen local day.
  const utcTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  if (utcTime.test(req.query.created_from || '')) {
    where.push('t.created_at >= ?');
    params.push(req.query.created_from);
  }
  if (utcTime.test(req.query.created_to || '')) {
    where.push('t.created_at < ?');
    params.push(req.query.created_to);
  }
  if (req.query.department) {
    where.push('t.department_id = ?');
    params.push(Number(req.query.department));
  }
  if (req.query.assigned === 'me') {
    where.push('t.assigned_to = ?');
    params.push(req.user.id);
  } else if (req.query.assigned === 'none') {
    where.push('t.assigned_to IS NULL');
  }
  const sql = `${TICKET_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.updated_at DESC, t.id DESC`;
  res.json(db.prepare(sql).all(...params).map(t => ({ ...t, can_work: canWork(req.user, t) })));
});

// The two request types on the New ticket form. Each goes to the department linked to it by request_key
// (set in db.js), so departments can be renamed freely.
const REQUEST_TYPES = {
  production: { label: 'Production Request' },
  it: { label: 'Report Issue to IT' },
};
const PRODUCTION_REQUESTS = ['Work Cart', 'Empty Cart', 'RMA', 'Tech Issue'];

app.post('/api/tickets', requireAuth, (req, res) => {
  const type = REQUEST_TYPES[req.body.request_type];
  if (!type) return res.status(400).json({ error: 'Please choose a request type' });
  const location = String(req.body.location || '').trim().slice(0, 100);
  const description = String(req.body.description || '').trim();
  if (!location) return res.status(400).json({ error: 'Please enter a location' });

  let title;
  let requestItem = null;
  if (req.body.request_type === 'production') {
    requestItem = req.body.request_item;
    if (!PRODUCTION_REQUESTS.includes(requestItem)) return res.status(400).json({ error: 'Please choose a request' });
    title = `${requestItem} – ${location}`;
  } else {
    if (!description) return res.status(400).json({ error: 'Please describe the issue' });
    title = `IT issue – ${location}`;
  }

  const department = db.prepare('SELECT id FROM departments WHERE request_key = ?').get(req.body.request_type);
  if (!department) return res.status(500).json({ error: `No department handles "${type.label}" requests` });

  // New tickets start at medium priority; agents can change it.
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO tickets (title, description, priority, department_id, location, request_item, created_by)
    VALUES (?, ?, 'medium', ?, ?, ?, ?)
  `).run(title, description, department.id, location, requestItem, req.user.id);
  notify.ticketCreated(lastInsertRowid, req.user.id);
  activity.ticketCreated(lastInsertRowid, req.user.id);
  res.status(201).json(db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(lastInsertRowid));
});

app.get('/api/tickets/:id', requireAuth, (req, res) => {
  const ticket = loadTicket(req, res);
  if (!ticket) return;
  ticket.comments = db.prepare(`
    SELECT cm.*, ${displayName('u')} AS user_name, u.role AS user_role
    FROM comments cm JOIN users u ON u.id = cm.user_id
    WHERE cm.ticket_id = ? ORDER BY cm.created_at, cm.id
  `).all(ticket.id);
  ticket.can_work = canWork(req.user, ticket);
  ticket.can_comment = ticket.can_work || ticket.created_by === req.user.id;
  res.json(ticket);
});

// Admins and agents in the ticket's department can change status, priority, department and assignee.
// Anyone else who created the ticket can only close it.
app.patch('/api/tickets/:id', requireAuth, (req, res) => {
  const ticket = loadTicket(req, res);
  if (!ticket) return;
  const { status, priority, assigned_to, department_id } = req.body;

  if (!canWork(req.user, ticket)) {
    const onlyClosing = status === 'closed' && priority === undefined && assigned_to === undefined && department_id === undefined;
    if (!onlyClosing || ticket.created_by !== req.user.id) {
      return res.status(403).json({
        error: isStaff(req.user)
          ? `Only ${ticket.department_name || 'this department'} agents can work on this ticket`
          : 'You can only close your own tickets',
      });
    }
  }

  const updates = {};
  if (status !== undefined) {
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    updates.status = status;
  }
  if (priority !== undefined) {
    if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
    updates.priority = priority;
  }
  if (department_id !== undefined) {
    if (!departmentExists(department_id)) return res.status(400).json({ error: 'Invalid department' });
    updates.department_id = department_id;
  }
  const finalDepartment = updates.department_id ?? ticket.department_id;
  if (assigned_to !== undefined && assigned_to !== ticket.assigned_to && req.user.role !== 'admin') {
    // Agents can't assign tickets; they can only claim an unassigned ticket for themselves,
    // or release a ticket they hold.
    const releasingOwn = assigned_to === null && ticket.assigned_to === req.user.id;
    if (assigned_to !== req.user.id && !releasingOwn) {
      return res.status(403).json({ error: 'Only admins can assign tickets to someone else. Use "Claim ticket" to take it yourself.' });
    }
    if (!releasingOwn && ticket.assigned_to) {
      return res.status(409).json({ error: `This ticket is already assigned to ${ticket.assigned_to_name}. Ask an admin to reassign it.` });
    }
  }
  if (assigned_to !== undefined) {
    if (assigned_to !== null && !isValidAssignee(assigned_to, finalDepartment)) {
      return res.status(400).json({ error: "Tickets can only be assigned to admins or agents in the ticket's department" });
    }
    updates.assigned_to = assigned_to;
  } else if (updates.department_id !== undefined && ticket.assigned_to && !isValidAssignee(ticket.assigned_to, finalDepartment)) {
    // Moved to another department: the current agent can no longer hold it.
    updates.assigned_to = null;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  let sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  // Remember when a ticket was closed (for "closed today"); clear it if the ticket is reopened.
  if (updates.status === 'closed' && ticket.status !== 'closed') sets += ", closed_at = datetime('now')";
  if (updates.status && updates.status !== 'closed') sets += ', closed_at = NULL';
  db.prepare(`UPDATE tickets SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .run(...Object.values(updates), ticket.id);
  notify.ticketUpdated(ticket, req.user.id);
  activity.ticketUpdated(ticket, req.user.id);
  res.json(db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(ticket.id));
});

app.delete('/api/tickets/:id', requireAuth, requireAdmin, (req, res) => {
  const ticket = db.prepare('SELECT id, title FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  db.prepare('DELETE FROM tickets WHERE id = ?').run(ticket.id);
  activity.ticketDeleted(ticket, req.user.id);
  res.json({ ok: true });
});

app.post('/api/tickets/:id/comments', requireAuth, (req, res) => {
  const ticket = loadTicket(req, res);
  if (!ticket) return;
  if (!canWork(req.user, ticket) && ticket.created_by !== req.user.id) {
    return res.status(403).json({ error: `Only ${ticket.department_name || 'this department'} agents can comment on this ticket` });
  }
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty' });

  const { lastInsertRowid: commentId } = db.prepare('INSERT INTO comments (ticket_id, user_id, body) VALUES (?, ?, ?)').run(ticket.id, req.user.id, body);
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);
  notify.commentAdded(ticket.id, req.user.id, body, commentId);
  activity.commentAdded(ticket, req.user.id, body);
  res.status(201).json({ ok: true });
});

// Numbers for the summary panel on the ticket list (agents and admins).
// The browser sends today's start/end as UTC ("YYYY-MM-DD HH:MM:SS") so "today" follows the viewer's local time.
app.get('/api/summary', requireAuth, requireStaff, (req, res) => {
  const utcTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const { from, to } = req.query;
  if (!utcTime.test(from || '') || !utcTime.test(to || '')) return res.status(400).json({ error: 'from and to are required' });

  const today = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tickets WHERE created_at >= ? AND created_at < ?) AS created,
      (SELECT COUNT(*) FROM tickets WHERE closed_at >= ? AND closed_at < ?) AS closed
  `).get(from, to, from, to);

  const open = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(status = 'open') AS open,
      SUM(status = 'in_progress') AS in_progress,
      SUM(status = 'resolved') AS resolved,
      SUM(assigned_to IS NULL) AS unassigned,
      SUM(assigned_to = ?) AS mine
    FROM tickets WHERE status != 'closed'
  `).get(req.user.id);
  for (const k of Object.keys(open)) open[k] = open[k] ?? 0;

  const departments = db.prepare(`
    SELECT d.id, d.name,
      SUM(t.created_at >= ? AND t.created_at < ?) AS created_today,
      SUM(t.closed_at >= ? AND t.closed_at < ?) AS closed_today,
      SUM(t.status != 'closed') AS open
    FROM departments d LEFT JOIN tickets t ON t.department_id = d.id
    GROUP BY d.id ORDER BY d.name
  `).all(from, to, from, to).map(d => ({
    ...d, created_today: d.created_today ?? 0, closed_today: d.closed_today ?? 0, open: d.open ?? 0,
  }));

  const requestsToday = db.prepare(`
    SELECT request_item AS item, COUNT(*) AS count FROM tickets
    WHERE request_item IS NOT NULL AND created_at >= ? AND created_at < ?
    GROUP BY request_item ORDER BY count DESC, request_item
  `).all(from, to);

  res.json({ today, open, departments, requests_today: requestsToday });
});

// Dashboard statistics for a date range (agents and admins).
// from/to: UTC "YYYY-MM-DD HH:MM:SS" for the viewer's local range. tz: viewer's offset from UTC in minutes
// (e.g. -300), used to group "per day" by the viewer's local date.
app.get('/api/dashboard', requireAuth, requireStaff, (req, res) => {
  const utcTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const { from, to } = req.query;
  if (!utcTime.test(from || '') || !utcTime.test(to || '')) return res.status(400).json({ error: 'from and to are required' });
  const tz = `${Math.max(-840, Math.min(840, parseInt(req.query.tz, 10) || 0))} minutes`;
  const hours = "(julianday(t.closed_at) - julianday(t.created_at)) * 24";
  const inRange = col => `${col} >= $from AND ${col} < $to`;
  const p = { from, to };

  const overview = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tickets t WHERE ${inRange('t.created_at')}) AS created,
      (SELECT COUNT(*) FROM tickets t WHERE ${inRange('t.closed_at')}) AS closed,
      (SELECT AVG(${hours}) FROM tickets t WHERE ${inRange('t.closed_at')}) AS avg_close_hours,
      (SELECT COUNT(*) FROM tickets WHERE status != 'closed') AS open_now,
      (SELECT COUNT(*) FROM tickets WHERE status != 'closed' AND assigned_to IS NULL) AS unassigned_now
  `).get(p);

  // Per local day: created and closed
  const created = db.prepare(`SELECT date(t.created_at, $tz) AS day, COUNT(*) AS n FROM tickets t WHERE ${inRange('t.created_at')} GROUP BY day`).all({ ...p, tz });
  const closed = db.prepare(`SELECT date(t.closed_at, $tz) AS day, COUNT(*) AS n FROM tickets t WHERE ${inRange('t.closed_at')} GROUP BY day`).all({ ...p, tz });
  const perDay = {};
  for (const r of created) (perDay[r.day] ??= { day: r.day, created: 0, closed: 0 }).created = r.n;
  for (const r of closed) (perDay[r.day] ??= { day: r.day, created: 0, closed: 0 }).closed = r.n;

  const departments = db.prepare(`
    SELECT d.name,
      COALESCE(SUM(${inRange('t.created_at')}), 0) AS created,
      COALESCE(SUM(${inRange('t.closed_at')}), 0) AS closed,
      COALESCE(SUM(t.status != 'closed'), 0) AS open_now,
      AVG(CASE WHEN ${inRange('t.closed_at')} THEN ${hours} END) AS avg_close_hours
    FROM departments d LEFT JOIN tickets t ON t.department_id = d.id
    GROUP BY d.id ORDER BY d.name
  `).all(p);

  const requestTypes = db.prepare(`
    SELECT CASE
             WHEN t.request_item IS NOT NULL THEN t.request_item
             WHEN d.request_key = 'it' THEN 'IT issue'
             ELSE 'Other'
           END AS type,
           COUNT(*) AS created,
           SUM(t.status != 'closed') AS open_now
    FROM tickets t LEFT JOIN departments d ON d.id = t.department_id
    WHERE ${inRange('t.created_at')}
    GROUP BY type ORDER BY created DESC, type
  `).all(p);

  // Agents and admins: what they hold now and what they did in the range (from the activity log)
  const agents = db.prepare(`
    SELECT u.id, u.name, u.role, d.name AS department,
      (SELECT COUNT(*) FROM tickets t WHERE t.assigned_to = u.id AND t.status != 'closed') AS assigned_open,
      (SELECT COUNT(*) FROM activity_log a WHERE a.user_id = u.id AND a.action = 'status'
         AND a.details LIKE '% Closed' AND ${inRange('a.created_at')}) AS closed,
      (SELECT COUNT(*) FROM activity_log a WHERE a.user_id = u.id AND a.action = 'comment' AND ${inRange('a.created_at')}) AS replies,
      (SELECT COUNT(*) FROM activity_log a WHERE a.user_id = u.id AND ${inRange('a.created_at')}) AS actions
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.role IN ('agent', 'admin') AND u.deleted_at IS NULL
    ORDER BY actions DESC, u.name
  `).all(p);

  const locations = db.prepare(`
    SELECT t.location, COUNT(*) AS created, SUM(t.status != 'closed') AS open_now
    FROM tickets t WHERE t.location IS NOT NULL AND t.location != '' AND ${inRange('t.created_at')}
    GROUP BY lower(t.location) ORDER BY created DESC, t.location LIMIT 10
  `).all(p);

  const oldestOpen = db.prepare(`
    SELECT t.id, t.title, t.status, t.created_at, d.name AS department, ${displayName('a')} AS assigned_to_name
    FROM tickets t LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN users a ON a.id = t.assigned_to
    WHERE t.status != 'closed' ORDER BY t.created_at LIMIT 10
  `).all();

  res.json({
    overview,
    per_day: Object.values(perDay).sort((a, b) => b.day.localeCompare(a.day)),
    departments,
    request_types: requestTypes,
    agents,
    locations,
    oldest_open: oldestOpen,
  });
});

// Agent activity: actions by agents and admins, newest first.
// Filters: from/to (UTC "YYYY-MM-DD HH:MM:SS", the viewer's chosen day), q (agent name), limit/offset for paging.
app.get('/api/activity', requireAuth, requireStaff, (req, res) => {
  const utcTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const where = ["u.role IN ('agent', 'admin')"];
  const params = [];
  if (utcTime.test(req.query.from || '') && utcTime.test(req.query.to || '')) {
    where.push('a.created_at >= ? AND a.created_at < ?');
    params.push(req.query.from, req.query.to);
  }
  const q = String(req.query.q || '').trim();
  if (q) {
    // "!" escapes % and _ so they match literally
    where.push("(u.name LIKE ? ESCAPE '!' OR u.email LIKE ? ESCAPE '!')");
    const like = `%${q.replace(/[!%_]/g, c => '!' + c)}%`;
    params.push(like, like);
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const from = `FROM activity_log a JOIN users u ON u.id = a.user_id WHERE ${where.join(' AND ')}`;

  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params).n;
  const items = db.prepare(`
    SELECT a.id, a.ticket_id, a.ticket_title, a.action, a.details, a.created_at,
           ${displayName('u')} AS user_name, u.role AS user_role,
           EXISTS (SELECT 1 FROM tickets t WHERE t.id = a.ticket_id) AS ticket_exists
    ${from} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset).map(i => ({ ...i, ticket_exists: !!i.ticket_exists }));
  res.json({ items, total });
});

app.get('/api/departments', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, name, request_key FROM departments ORDER BY name').all());
});

// ----- Settings: departments (admin only) -----

app.get('/api/settings/departments', requireAuth, requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT d.id, d.name, d.request_key,
      (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.role = 'agent' AND u.deleted_at IS NULL) AS agents,
      (SELECT COUNT(*) FROM tickets t WHERE t.department_id = d.id AND t.status != 'closed') AS open_tickets,
      (SELECT COUNT(*) FROM tickets t WHERE t.department_id = d.id) AS total_tickets
    FROM departments d ORDER BY d.name
  `).all().map(d => ({ ...d, request_type: REQUEST_TYPES[d.request_key]?.label || null })));
});

function departmentNameError(name, excludeId = null) {
  if (!name) return 'Please enter a department name';
  if (name.length > 50) return 'Department names can be at most 50 characters';
  if (db.prepare('SELECT 1 FROM departments WHERE lower(name) = lower(?) AND id IS NOT ?').get(name, excludeId)) {
    return 'A department with that name already exists';
  }
  return null;
}

app.post('/api/settings/departments', requireAuth, requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const error = departmentNameError(name);
  if (error) return res.status(400).json({ error });
  const { lastInsertRowid } = db.prepare('INSERT INTO departments (name) VALUES (?)').run(name);
  res.status(201).json({ id: lastInsertRowid, name });
});

// ----- Settings: email (admin only) -----

// Current email settings. The password is never sent back, only whether one is set.
function emailSettingsResponse() {
  const { values, sources } = mailer.getEmailConfig();
  const { smtp_pass, ...rest } = values;
  return { ...rest, smtp_secure: String(values.smtp_secure) === 'true', password_set: !!smtp_pass, sources };
}

app.get('/api/settings/email', requireAuth, requireAdmin, (req, res) => res.json(emailSettingsResponse()));

// Saves email settings. An empty field falls back to .env; a blank password keeps the current one.
app.put('/api/settings/email', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body;
  const clean = v => String(v ?? '').trim();
  const updates = {
    app_url: clean(b.app_url).replace(/\/+$/, ''),
    app_name: clean(b.app_name).slice(0, 80),
    mail_from: clean(b.mail_from).toLowerCase(),
    smtp_host: clean(b.smtp_host),
    smtp_port: clean(b.smtp_port),
    smtp_secure: b.smtp_secure ? 'true' : 'false',
    smtp_user: clean(b.smtp_user),
  };
  if (updates.app_url && !/^https?:\/\/[^\s/]+/i.test(updates.app_url)) {
    return res.status(400).json({ error: 'The app address must start with http:// or https://, for example http://192.168.1.50:5000' });
  }
  if (updates.smtp_port && !(Number(updates.smtp_port) >= 1 && Number(updates.smtp_port) <= 65535)) {
    return res.status(400).json({ error: 'The port must be a number between 1 and 65535' });
  }
  if (updates.mail_from && !isValidEmail(updates.mail_from)) {
    return res.status(400).json({ error: 'The "from" address is not a valid email address' });
  }

  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const remove = db.prepare('DELETE FROM settings WHERE key = ?');
  db.exec('BEGIN');
  try {
    for (const [name, value] of Object.entries(updates)) {
      if (value) set.run(`email.${name}`, value);
      else remove.run(`email.${name}`);
    }
    if (b.smtp_pass) set.run('email.smtp_pass', String(b.smtp_pass));
    if (b.clear_password) remove.run('email.smtp_pass');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const connection = await mailer.checkConnection();
  res.json({ ...emailSettingsResponse(), connection });
});

app.post('/api/settings/email/test', requireAuth, requireAdmin, emailLimiter, async (req, res) => {
  const to = normalizeEmail(req.body.to || req.user.email);
  if (!isValidEmail(to)) return res.status(400).json({ error: 'Please enter a valid email address to send the test to' });
  try {
    await mailer.sendTestEmail(to);
    res.json({ ok: true, message: `Test email sent to ${to}. Check that inbox (and the spam folder).` });
  } catch (err) {
    res.status(400).json({ error: `Could not send: ${err.message}` });
  }
});

app.patch('/api/settings/departments/:id', requireAuth, requireAdmin, (req, res) => {
  const department = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (!department) return res.status(404).json({ error: 'Department not found' });
  const name = String(req.body.name || '').trim();
  const error = departmentNameError(name, department.id);
  if (error) return res.status(400).json({ error });
  db.prepare('UPDATE departments SET name = ? WHERE id = ?').run(name, department.id);
  res.json({ id: department.id, name });
});

// People a ticket can be assigned to (the client filters agents by the ticket's department)
app.get('/api/assignees', requireAuth, requireStaff, (req, res) => {
  res.json(db.prepare(
    "SELECT id, name, role, department_id FROM users WHERE role IN ('agent', 'admin') AND deleted_at IS NULL ORDER BY name"
  ).all());
});

// ---------- users (admin only) ----------

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json(db.prepare(
    `SELECT u.id, u.first_name, u.last_name, u.name, u.email, u.role, u.department_id, d.name AS department_name,
            u.created_at, u.email_verified_at IS NOT NULL AS verified, u.is_protected
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.deleted_at IS NULL ORDER BY u.first_name, u.last_name`
  ).all().map(u => ({ ...u, verified: !!u.verified, is_protected: !!u.is_protected })));
});

function validateUserInput(body, { passwordRequired }) {
  const names = nameFields(body);
  if (names.error) return names;
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const role = body.role;
  if (!isValidEmail(email)) return { error: 'Please enter a valid email address' };
  if (!ROLES.includes(role)) return { error: 'Invalid role' };
  if (passwordRequired || password) {
    const pwError = passwordError(password);
    if (pwError) return { error: pwError };
  }
  // Only agents belong to a department
  let department_id = null;
  if (role === 'agent' && body.department_id) {
    department_id = Number(body.department_id);
    if (!departmentExists(department_id)) return { error: 'Invalid department' };
  }
  return { ...names, email, password, role, department_id };
}

// Accounts created by an admin are trusted (no verification email) and may use any email domain.
app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const input = validateUserInput(req.body, { passwordRequired: true });
  if (input.error) return res.status(400).json(input);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(input.email)) {
    return res.status(409).json({ error: 'Email already in use' });
  }
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO users (first_name, last_name, name, email, password_hash, role, department_id, email_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(input.first_name, input.last_name, input.name, input.email, hashPassword(input.password), input.role, input.department_id);
  res.status(201).json({ id: lastInsertRowid });
});

app.patch('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const input = validateUserInput(req.body, { passwordRequired: false });
  if (input.error) return res.status(400).json(input);

  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(input.email, user.id)) {
    return res.status(409).json({ error: 'Email already in use' });
  }
  // The main admin (ADMIN_EMAIL in .env) always stays an admin, and only they can change their own email or password.
  if (user.is_protected) {
    if (input.role !== 'admin') return res.status(403).json({ error: 'The main admin account must stay an admin' });
    if (user.id !== req.user.id && input.email !== user.email) {
      return res.status(403).json({ error: 'Only the main admin can change their own email address' });
    }
    if (user.id !== req.user.id && input.password) {
      return res.status(403).json({ error: 'Only the main admin can change their own password. Use "Send reset link" instead.' });
    }
  }
  if (user.role === 'admin' && input.role !== 'admin') {
    if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own admin role' });
    if (activeAdminCount() <= 1) return res.status(400).json({ error: 'There must be at least one admin' });
  }

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET first_name = ?, last_name = ?, name = ?, email = ?, role = ?, department_id = ? WHERE id = ?')
      .run(input.first_name, input.last_name, input.name, input.email, input.role, input.department_id, user.id);
    if (input.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(input.password), user.id);
    }
    // Employees can't hold tickets, so release anything assigned to them.
    if (input.role === 'employee') {
      db.prepare("UPDATE tickets SET assigned_to = NULL, updated_at = datetime('now') WHERE assigned_to = ?").run(user.id);
    }
    // Agents can only hold tickets in their own department.
    if (input.role === 'agent') {
      db.prepare(`UPDATE tickets SET assigned_to = NULL, updated_at = datetime('now')
                  WHERE assigned_to = ? AND (? IS NULL OR department_id IS NOT ?)`)
        .run(user.id, input.department_id, input.department_id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // A password set by an admin signs the user out everywhere else
  if (input.password) destroyUserSessions(user.id, user.id === req.user.id ? req.sessionID : null);
  if (input.email !== user.email) sendEmailChangedEmails(user.email, input.email, input.first_name, req.user.name, !!input.password);
  res.json({ ok: true });
});

// The email is also the login, so tell both the old and the new address when an admin changes it.
function sendEmailChangedEmails(oldEmail, newEmail, firstName, adminName, passwordChanged) {
  queueEmail(oldEmail, `Your ${getAppName()} email address was changed`, {
    greeting: `Hi ${firstName},`,
    lines: [
      `${adminName} (administrator) changed the email address on your account from ${oldEmail} to ${newEmail}.`,
      `From now on, log in with ${newEmail}. Ticket updates will be sent there and no longer to this address.`,
      "If you didn't expect this change, contact an administrator.",
    ],
  });
  queueEmail(newEmail, `Your ${getAppName()} account now uses this email`, {
    greeting: `Hi ${firstName},`,
    lines: [
      `${adminName} (administrator) changed the email address on your account to ${newEmail} (previously ${oldEmail}).`,
      passwordChanged
        ? 'Use this address to log in from now on. Your password was also changed; ask your administrator for it, or use "Forgot password" on the login page.'
        : 'Use this address to log in from now on. Your password has not changed.',
    ],
    button: { label: 'Log in', url: getAppUrl() },
  });
}

app.post('/api/users/:id/send-reset', requireAuth, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  sendPasswordResetEmail(user, { requestedByAdmin: true });
  res.json({ ok: true, message: `Password reset link sent to ${user.email}` });
});

// Soft delete: the user can no longer log in, but their tickets and comments stay
// (shown as "Name (deleted)"). Their email is freed so it can be reused.
app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (user.is_protected) return res.status(403).json({ error: 'This is the main admin account (set in .env) and cannot be deleted' });
  if (user.role === 'admin' && activeAdminCount() <= 1) {
    return res.status(400).json({ error: 'There must be at least one admin' });
  }

  db.exec('BEGIN');
  try {
    db.prepare("UPDATE users SET deleted_at = datetime('now'), email = ? WHERE id = ?")
      .run(`deleted-${user.id}-${user.email}`, user.id);
    db.prepare("UPDATE tickets SET assigned_to = NULL, updated_at = datetime('now') WHERE assigned_to = ?").run(user.id);
    db.prepare("UPDATE tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(user.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  destroyUserSessions(user.id);
  res.json({ ok: true });
});

// Users can no longer change their own email, so retire any old confirmation links.
db.prepare("UPDATE tokens SET used_at = datetime('now') WHERE type = 'change_email' AND used_at IS NULL").run();

app.listen(PORT, () => {
  console.log(`Ticket system running at http://localhost:${PORT} (links in emails use ${getAppUrl()})`);
  startMailer();
});
