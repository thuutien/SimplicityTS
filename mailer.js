const nodemailer = require('nodemailer');
const { db } = require('./db');

const MAX_ATTEMPTS = 5;

// Email settings can be set by an admin under Settings (stored in the settings table as "email.<name>").
// Anything not set there falls back to .env, then to a default.
const EMAIL_SETTINGS = {
  app_url: { env: 'APP_URL', default: () => `http://localhost:${process.env.PORT || 5000}` },
  app_name: { env: 'APP_NAME', default: () => 'Retail King Helpdesk' },
  mail_from: { env: 'MAIL_FROM', default: () => '' },
  smtp_host: { env: 'SMTP_HOST', default: () => '' },
  smtp_port: { env: 'SMTP_PORT', default: () => '465' },
  smtp_secure: { env: 'SMTP_SECURE', default: () => 'true' },
  smtp_user: { env: 'SMTP_USER', default: () => '' },
  smtp_pass: { env: 'SMTP_PASS', default: () => '' },
};

// Returns { values, sources } where sources[name] is 'settings', 'env' or 'default'.
function getEmailConfig() {
  const saved = Object.fromEntries(
    db.prepare("SELECT key, value FROM settings WHERE key LIKE 'email.%'").all().map(r => [r.key.slice(6), r.value])
  );
  const values = {};
  const sources = {};
  for (const [name, def] of Object.entries(EMAIL_SETTINGS)) {
    if (saved[name] != null && saved[name] !== '') [values[name], sources[name]] = [saved[name], 'settings'];
    else if (process.env[def.env]) [values[name], sources[name]] = [process.env[def.env], 'env'];
    else [values[name], sources[name]] = [def.default(), 'default'];
  }
  values.app_url = values.app_url.replace(/\/+$/, '');
  return { values, sources };
}

const getAppUrl = () => getEmailConfig().values.app_url;
const getAppName = () => getEmailConfig().values.app_name;

// The mail server connection is rebuilt whenever the settings change.
let cached = { key: null, transport: null };
function getTransport(values = getEmailConfig().values) {
  if (!values.smtp_host || !values.smtp_user || !values.smtp_pass) return null; // not configured: print emails instead
  const key = JSON.stringify([values.smtp_host, values.smtp_port, values.smtp_secure, values.smtp_user, values.smtp_pass]);
  if (cached.key !== key) {
    cached = {
      key,
      transport: nodemailer.createTransport({
        host: values.smtp_host,
        port: Number(values.smtp_port) || 465,
        secure: String(values.smtp_secure) === 'true',
        auth: { user: values.smtp_user, pass: values.smtp_pass },
      }),
    };
  }
  return cached.transport;
}

// Every email in a thread points at the same (virtual) first message, which mail apps use to group them.
function threadHeaders(thread, values) {
  if (!thread) return {};
  const domain = (fromAddress(values).address.split('@')[1] || 'simplicityts.local').toLowerCase();
  const root = `<${thread}@${domain}>`;
  return { 'In-Reply-To': root, References: root };
}

const fromAddress = values => ({ name: values.app_name, address: values.mail_from || values.smtp_user || 'helpdesk@localhost' });

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Builds a simple branded email.
// lines: paragraphs of plain text. button: { label, url }. quote: optional block of user text (e.g. a comment).
// details: optional { title, rows: [[label, value], ...] } table, e.g. the ticket's details.
// history: optional { title, items: [{ who, when, body }] }, e.g. earlier comments.
function render({ greeting, lines = [], quote, button, details, history, footer }) {
  const APP_NAME = getAppName();
  const quoteText = q => q.split('\n').map(l => `> ${l}`).join('\n');
  const text = [
    greeting,
    '',
    ...lines.flatMap(l => [l, '']),
    ...(quote ? [quoteText(quote), ''] : []),
    ...(button ? [`${button.label}: ${button.url}`, ''] : []),
    ...(details ? [`--- ${details.title} ---`, ...details.rows.map(([k, v]) => `${k}: ${v}`), ''] : []),
    ...(history?.items.length
      ? [`--- ${history.title} ---`, ...history.items.flatMap(h => [`${h.who} (${h.when}):`, quoteText(h.body), ''])]
      : []),
    footer || `— ${APP_NAME}`,
  ].join('\n');

  const sectionTitle = t =>
    `<p style="margin: 24px 0 8px; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em;">${esc(t)}</p>`;
  const detailsHtml = details ? `
    ${sectionTitle(details.title)}
    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
      ${details.rows.map(([k, v]) => `<tr>
        <td style="padding: 6px 12px 6px 0; color: #6b7280; vertical-align: top; white-space: nowrap; border-bottom: 1px solid #f3f4f6;">${esc(k)}</td>
        <td style="padding: 6px 0; vertical-align: top; white-space: pre-wrap; border-bottom: 1px solid #f3f4f6;">${esc(v)}</td>
      </tr>`).join('')}
    </table>` : '';
  const historyHtml = history?.items.length ? `
    ${sectionTitle(history.title)}
    ${history.items.map(h => `
      <div style="margin: 0 0 10px; padding: 10px 12px; background: #f9fafb; border-radius: 6px; font-size: 14px;">
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;"><strong style="color: #374151;">${esc(h.who)}</strong> · ${esc(h.when)}</div>
        <div style="white-space: pre-wrap;">${esc(h.body)}</div>
      </div>`).join('')}` : '';

  const html = `
<div style="font-family: Segoe UI, Arial, sans-serif; background: #f4f5f7; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px; color: #1f2328;">
    <p style="margin: 0 0 16px; font-weight: 600; color: #1f2937;">${esc(APP_NAME)}</p>
    <p style="margin: 0 0 12px;">${esc(greeting)}</p>
    ${lines.map(l => `<p style="margin: 0 0 12px; line-height: 1.5;">${esc(l)}</p>`).join('')}
    ${quote ? `<div style="margin: 0 0 16px; padding: 12px; background: #f9fafb; border-left: 3px solid #2563eb; white-space: pre-wrap;">${esc(quote)}</div>` : ''}
    ${button ? `<p style="margin: 20px 0;"><a href="${esc(button.url)}" style="background: #2563eb; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; display: inline-block;">${esc(button.label)}</a></p>
    <p style="margin: 0 0 12px; font-size: 12px; color: #6b7280;">Or copy this link: ${esc(button.url)}</p>` : ''}
    ${detailsHtml}
    ${historyHtml}
    <p style="margin: 16px 0 0; font-size: 12px; color: #6b7280;">${esc(footer || `This is an automated message from ${APP_NAME}.`)}</p>
  </div>
</div>`;
  return { text, html };
}

// Queues an email. It is sent in the background so a slow mail server never delays the user.
// options.thread: emails with the same thread (e.g. "ticket-42") are grouped into one conversation by mail apps.
function queueEmail(to, subject, content, { thread = null } = {}) {
  if (!to) return;
  const { text, html } = render(content);
  db.prepare('INSERT INTO email_outbox (to_email, subject, text_body, html_body, thread) VALUES (?, ?, ?, ?, ?)')
    .run(to, subject, text, html, thread);
  setImmediate(processOutbox);
}

let processing = false;
async function processOutbox() {
  if (processing) return;
  processing = true;
  try {
    const pending = db.prepare(`
      SELECT * FROM email_outbox WHERE status = 'pending' AND attempts < ? ORDER BY id LIMIT 20
    `).all(MAX_ATTEMPTS);

    const { values } = getEmailConfig();
    const transport = getTransport(values);
    for (const email of pending) {
      try {
        if (transport) {
          await transport.sendMail({
            from: fromAddress(values), to: email.to_email, subject: email.subject, text: email.text_body, html: email.html_body,
            headers: threadHeaders(email.thread, values),
          });
        } else {
          console.log(`\n[email not sent: SMTP not configured]\nTo: ${email.to_email}\nSubject: ${email.subject}\n\n${email.text_body}\n`);
        }
        db.prepare("UPDATE email_outbox SET status = 'sent', attempts = attempts + 1, sent_at = datetime('now'), last_error = NULL WHERE id = ?")
          .run(email.id);
      } catch (err) {
        const attempts = email.attempts + 1;
        db.prepare('UPDATE email_outbox SET attempts = ?, last_error = ?, status = ? WHERE id = ?')
          .run(attempts, String(err.message).slice(0, 500), attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', email.id);
        console.error(`Email to ${email.to_email} failed (attempt ${attempts}/${MAX_ATTEMPTS}): ${err.message}`);
      }
    }
  } finally {
    processing = false;
  }
}

// Checks the connection to the mail server and logs the result. Called at startup and after settings change.
function checkConnection() {
  const { values } = getEmailConfig();
  const transport = getTransport(values);
  if (!transport) {
    console.log('Email: not configured, emails will be printed to this console instead (set it up under Settings > Email)');
    return Promise.resolve({ configured: false });
  }
  return transport.verify()
    .then(() => {
      console.log(`Email: sending via ${values.smtp_host} as ${fromAddress(values).address}`);
      return { configured: true, ok: true };
    })
    .catch(err => {
      console.error(`Email: could not connect to ${values.smtp_host}: ${err.message}`);
      return { configured: true, ok: false, error: err.message };
    });
}

// Sends a test email right away (not queued) so the admin sees any error immediately.
async function sendTestEmail(to) {
  const { values } = getEmailConfig();
  const transport = getTransport(values);
  if (!transport) throw new Error('Email is not set up yet: enter the mail server, username and password, then save.');
  await transport.verify();
  const { text, html } = render({
    greeting: 'Hello,',
    lines: [`This is a test email from ${values.app_name}. If you can read this, email is set up correctly.`],
    button: { label: 'Open the app', url: values.app_url },
  });
  await transport.sendMail({ from: fromAddress(values), to, subject: `Test email from ${values.app_name}`, text, html });
}

// Retry anything left pending (e.g. mail server was down) every minute.
function startMailer() {
  checkConnection();
  processOutbox();
  setInterval(processOutbox, 60 * 1000).unref();
}

module.exports = { queueEmail, startMailer, checkConnection, sendTestEmail, getEmailConfig, getAppUrl, getAppName, EMAIL_SETTINGS };
