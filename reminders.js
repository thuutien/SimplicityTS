const { db } = require('./db');
const notify = require('./notify');

// Assignees get an email reminder about each ticket they hold that is still Open or In progress:
// first after a number of days (Settings > General, default 1 = the next day), then again every that many days
// until the ticket is Resolved or Closed.

const DEFAULT_DAYS = 1;
const MAX_DAYS = 30;

// 0 = no reminders
function getReminderDays() {
  const value = db.prepare("SELECT value FROM settings WHERE key = 'tickets.reminder_days'").get()?.value;
  const days = parseInt(value, 10);
  return Number.isInteger(days) && days >= 0 && days <= MAX_DAYS ? days : DEFAULT_DAYS;
}

function setReminderDays(days) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('tickets.reminder_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(days));
}

function sendReminders() {
  const days = getReminderDays();
  if (!days) return;
  const due = db.prepare(`
    SELECT t.id FROM tickets t
    JOIN users u ON u.id = t.assigned_to AND u.deleted_at IS NULL
    WHERE t.status IN ('open', 'in_progress') AND t.assigned_at IS NOT NULL
      AND COALESCE(t.reminded_at, t.assigned_at) <= datetime('now', ?)
  `).all(`-${days} days`);
  const markReminded = db.prepare("UPDATE tickets SET reminded_at = datetime('now') WHERE id = ?");
  for (const { id } of due) {
    markReminded.run(id);
    notify.assigneeReminder(id);
  }
  if (due.length) console.log(`Sent ${due.length} assignee reminder(s)`);
}

// Check now, then every hour
function startReminders() {
  const run = () => {
    try {
      sendReminders();
    } catch (err) {
      console.error('Reminders failed:', err);
    }
  };
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = { getReminderDays, setReminderDays, sendReminders, startReminders, MAX_DAYS };
