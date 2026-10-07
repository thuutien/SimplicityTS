// Live updates: browsers keep one open connection (Server-Sent Events) and are told when tickets change,
// so the ticket list refreshes without reloading the page.

const clients = new Set(); // { res, user }

// GET /api/events handler. The user must already be loaded by requireAuth.
function subscribe(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let a reverse proxy hold the messages back
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n'); // browser reconnects after 5 s if the connection drops

  const client = { res, user: req.user };
  clients.add(client);
  // A comment line every 25 s keeps the connection open through proxies and firewalls
  const ping = setInterval(() => res.write(': ping\n\n'), 25 * 1000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

const isStaff = user => user.role === 'agent' || user.role === 'admin';

// Tells agents/admins (they see all tickets) and the ticket's creator that a ticket changed.
// type: 'created' | 'updated' | 'deleted'
function ticketChanged(type, ticket) {
  const message = `event: ticket\ndata: ${JSON.stringify({ type, id: ticket.id })}\n\n`;
  for (const { res, user } of clients) {
    if (isStaff(user) || user.id === ticket.created_by) res.write(message);
  }
}

// Closes a user's live connections (e.g. after they are deleted).
function disconnectUser(userId) {
  for (const client of clients) {
    if (client.user.id === userId) {
      client.res.end();
      clients.delete(client);
    }
  }
}

module.exports = { subscribe, ticketChanged, disconnectUser };
