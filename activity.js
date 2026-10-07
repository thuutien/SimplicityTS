const { db } = require('./db');

// Records ticket activity for the "Agent activity" panel.

const label = s => String(s).replace('_', ' ').replace(/^./, c => c.toUpperCase());
const userName = id => db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name;
const deptName = id => db.prepare('SELECT name FROM departments WHERE id = ?').get(id)?.name;

function log(userId, ticket, action, details = null) {
  db.prepare('INSERT INTO activity_log (user_id, ticket_id, ticket_title, action, details) VALUES (?, ?, ?, ?, ?)')
    .run(userId, ticket.id, ticket.title, action, details);
}

function ticketCreated(ticketId, userId) {
  const t = db.prepare('SELECT id, title FROM tickets WHERE id = ?').get(ticketId);
  log(userId, t, 'created');
}

// Compares the ticket before and after an update and logs each change.
function ticketUpdated(before, userId) {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(before.id);
  if (t.status !== before.status) log(userId, t, 'status', `${label(before.status)} → ${label(t.status)}`);
  if (t.priority !== before.priority) log(userId, t, 'priority', `${label(before.priority)} → ${label(t.priority)}`);
  if (t.department_id !== before.department_id) log(userId, t, 'department', deptName(t.department_id));
  if (t.assigned_to !== before.assigned_to) {
    if (t.assigned_to === userId) log(userId, t, 'claimed');
    else if (t.assigned_to) log(userId, t, 'assigned', userName(t.assigned_to));
    else if (before.assigned_to === userId) log(userId, t, 'released');
    else log(userId, t, 'unassigned', userName(before.assigned_to));
  }
}

function commentAdded(ticket, userId, body) {
  log(userId, ticket, 'comment', body.slice(0, 200));
}

function ticketDeleted(ticket, userId) {
  log(userId, ticket, 'deleted');
}

module.exports = { ticketCreated, ticketUpdated, commentAdded, ticketDeleted };
