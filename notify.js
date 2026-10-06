const { db } = require('./db');
const { queueEmail, APP_URL } = require('./mailer');

const ticketUrl = id => `${APP_URL}/#ticket/${id}`;
const label = s => String(s).replace('_', ' ').replace(/^./, c => c.toUpperCase());

const getUser = id => id && db.prepare('SELECT id, first_name, name, email FROM users WHERE id = ? AND deleted_at IS NULL').get(id);

const getTicket = id => db.prepare(`
  SELECT t.*, d.name AS department_name FROM tickets t
  LEFT JOIN departments d ON d.id = t.department_id WHERE t.id = ?
`).get(id);

// Agents in the department; falls back to admins if the department has no agents, so tickets are never missed.
function departmentRecipients(departmentId) {
  const agents = db.prepare(`
    SELECT id, first_name, name, email FROM users
    WHERE role = 'agent' AND department_id = ? AND deleted_at IS NULL AND email_verified_at IS NOT NULL
  `).all(departmentId);
  if (agents.length) return agents;
  return db.prepare(`
    SELECT id, first_name, name, email FROM users
    WHERE role = 'admin' AND deleted_at IS NULL AND email_verified_at IS NOT NULL
  `).all();
}

// Sends to each recipient once, never to the person who made the change.
function send(recipients, actorId, subject, build) {
  const seen = new Set([actorId]);
  for (const user of recipients) {
    if (!user || seen.has(user.id)) continue;
    seen.add(user.id);
    queueEmail(user.email, subject, build(user));
  }
}

// Request details shown in emails (older tickets may not have location/request)
const ticketDetails = t => [
  ...(t.request_item ? [`Request: ${t.request_item}`] : []),
  ...(t.location ? [`Location: ${t.location}`] : []),
  ...(!t.request_item && !t.location ? [`Title: ${t.title}`] : []),
];

const subjectFor = (t, suffix) => `[#${t.id}] ${t.title} – ${suffix}`;

function ticketCreated(ticketId, actorId) {
  const t = getTicket(ticketId);
  const creator = getUser(t.created_by);
  send(departmentRecipients(t.department_id), actorId, subjectFor(t, 'New ticket'), user => ({
    greeting: `Hi ${user.first_name},`,
    lines: [
      `${creator.name} created a new ticket for ${t.department_name}.`,
      ...ticketDetails(t),
    ],
    quote: t.description || undefined,
    button: { label: 'View ticket', url: ticketUrl(t.id) },
  }));
}

// Called after a ticket update with the ticket as it was before the change.
function ticketUpdated(before, actorId) {
  const t = getTicket(before.id);
  const actor = getUser(actorId);
  const creator = getUser(t.created_by);

  // Status change -> the person who raised the ticket
  if (t.status !== before.status) {
    send([creator], actorId, subjectFor(t, `Status: ${label(t.status)}`), user => ({
      greeting: `Hi ${user.first_name},`,
      lines: [
        `${actor.name} changed the status of your ticket from ${label(before.status)} to ${label(t.status)}.`,
        ...(t.status === 'resolved' ? ['If the problem is not fixed, reply with a comment on the ticket and we will take another look.'] : []),
      ],
      button: { label: 'View ticket', url: ticketUrl(t.id) },
    }));
  }

  // Moved department -> the new department's agents
  if (t.department_id !== before.department_id) {
    send(departmentRecipients(t.department_id), actorId, subjectFor(t, `Moved to ${t.department_name}`), user => ({
      greeting: `Hi ${user.first_name},`,
      lines: [`${actor.name} moved this ticket to ${t.department_name}.`, ...ticketDetails(t)],
      quote: t.description || undefined,
      button: { label: 'View ticket', url: ticketUrl(t.id) },
    }));
  }

  // Newly assigned -> the assignee
  if (t.assigned_to && t.assigned_to !== before.assigned_to) {
    send([getUser(t.assigned_to)], actorId, subjectFor(t, 'Assigned to you'), user => ({
      greeting: `Hi ${user.first_name},`,
      lines: [`${actor.name} assigned this ticket to you.`, ...ticketDetails(t), `Priority: ${label(t.priority)}`],
      quote: t.description || undefined,
      button: { label: 'View ticket', url: ticketUrl(t.id) },
    }));
  }
}

// Database times are UTC ("YYYY-MM-DD HH:MM:SS"); show them in the server's local time.
const fmtDate = s => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

const REQUEST_TYPE_NAMES = { Production: 'Production Request', 'IT Support': 'Report Issue to IT' };

// Everything about the ticket, so the email can be read on its own.
function fullTicketDetails(t) {
  const name = id => db.prepare("SELECT name || CASE WHEN deleted_at IS NULL THEN '' ELSE ' (deleted)' END AS name FROM users WHERE id = ?").get(id)?.name;
  const rows = [
    ['Ticket', `#${t.id}`],
    ['Request type', REQUEST_TYPE_NAMES[t.department_name] || t.department_name || 'None'],
    ...(t.request_item ? [['Request', t.request_item]] : []),
    ...(t.location ? [['Location', t.location]] : []),
    ...(!t.request_item && !t.location ? [['Title', t.title]] : []),
    ...(t.description ? [[t.request_item ? 'Additional info' : 'Issue description', t.description]] : []),
    ['Status', label(t.status)],
    ['Priority', label(t.priority)],
    ['Assigned to', name(t.assigned_to) || 'Unassigned'],
    ['Created by', name(t.created_by)],
    ['Created', fmtDate(t.created_at)],
  ];
  return { title: 'Ticket details', rows };
}

// Earlier comments on the ticket, newest first (excluding the one just added).
function earlierComments(ticketId, excludeCommentId, limit = 10) {
  const items = db.prepare(`
    SELECT c.body, c.created_at, u.name || CASE WHEN u.deleted_at IS NULL THEN '' ELSE ' (deleted)' END AS who
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.ticket_id = ? AND c.id != ? ORDER BY c.id DESC LIMIT ?
  `).all(ticketId, excludeCommentId, limit).map(c => ({ who: c.who, when: fmtDate(c.created_at), body: c.body }));
  const total = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE ticket_id = ? AND id != ?').get(ticketId, excludeCommentId).n;
  const title = total > limit ? `Earlier replies (latest ${limit} of ${total})` : 'Earlier replies';
  return { title, items };
}

function commentAdded(ticketId, actorId, body, commentId) {
  const t = getTicket(ticketId);
  const actor = getUser(actorId);

  // Creator commented -> assigned agent, or the department if nobody is assigned.
  // Anyone else commented -> the creator (and the assignee, if it wasn't them).
  const recipients = actorId === t.created_by
    ? (t.assigned_to ? [getUser(t.assigned_to)] : departmentRecipients(t.department_id))
    : [getUser(t.created_by), getUser(t.assigned_to)];

  const details = fullTicketDetails(t);
  const history = earlierComments(t.id, commentId);
  send(recipients, actorId, subjectFor(t, 'New reply'), user => ({
    greeting: `Hi ${user.first_name},`,
    lines: [`${actor.name} replied on ticket #${t.id}:`],
    quote: body,
    button: { label: 'View and reply', url: ticketUrl(t.id) },
    details,
    history,
  }));
}

module.exports = { ticketCreated, ticketUpdated, commentAdded };
