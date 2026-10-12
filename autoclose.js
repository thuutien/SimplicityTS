const { db } = require('./db');
const notify = require('./notify');
const activity = require('./activity');
const events = require('./events');

// Resolved tickets close by themselves after a number of days (Settings > General).
// The countdown starts when a ticket is marked Resolved and restarts when its creator replies.

const DEFAULT_DAYS = 3;
const MAX_DAYS = 365;

// 0 = never close automatically
function getAutoCloseDays() {
  const value = db.prepare("SELECT value FROM settings WHERE key = 'tickets.auto_close_days'").get()?.value;
  const days = parseInt(value, 10);
  return Number.isInteger(days) && days >= 0 && days <= MAX_DAYS ? days : DEFAULT_DAYS;
}

function setAutoCloseDays(days) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('tickets.auto_close_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(days));
}

// The person who marked the ticket Resolved (the activity log needs a user), or its creator
function resolvedBy(ticket) {
  return db.prepare(`
    SELECT user_id FROM activity_log WHERE ticket_id = ? AND action = 'status' AND details LIKE '% Resolved'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(ticket.id)?.user_id ?? ticket.created_by;
}

function closeResolvedTickets() {
  const days = getAutoCloseDays();
  if (!days) return;
  const due = db.prepare(`
    SELECT id, title, created_by FROM tickets
    WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at <= datetime('now', ?)
  `).all(`-${days} days`);
  for (const ticket of due) {
    const { changes } = db.prepare(`
      UPDATE tickets SET status = 'closed', closed_at = datetime('now'), resolved_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status = 'resolved'
    `).run(ticket.id);
    if (!changes) continue;
    activity.autoClosed(ticket, resolvedBy(ticket), days);
    notify.ticketAutoClosed(ticket.id, days);
    events.ticketChanged('updated', ticket);
  }
  if (due.length) console.log(`Closed ${due.length} resolved ticket(s) after ${days} day(s)`);
}

// Check now, then every hour
function startAutoClose() {
  const run = () => {
    try {
      closeResolvedTickets();
    } catch (err) {
      console.error('Auto-close failed:', err);
    }
  };
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = { getAutoCloseDays, setAutoCloseDays, closeResolvedTickets, startAutoClose, MAX_DAYS };
