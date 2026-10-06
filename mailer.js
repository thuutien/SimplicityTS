const nodemailer = require('nodemailer');
const { db } = require('./db');

const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const APP_NAME = process.env.APP_NAME || 'Retail King Helpdesk';
const MAX_ATTEMPTS = 5;

// If SMTP isn't configured, emails are printed to the console instead of sent.
const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const transport = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: (process.env.SMTP_SECURE || 'true') === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;
const from = { name: APP_NAME, address: process.env.MAIL_FROM || process.env.SMTP_USER || 'helpdesk@localhost' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Builds a simple branded email.
// lines: paragraphs of plain text. button: { label, url }. quote: optional block of user text (e.g. a comment).
// details: optional { title, rows: [[label, value], ...] } table, e.g. the ticket's details.
// history: optional { title, items: [{ who, when, body }] }, e.g. earlier comments.
function render({ greeting, lines = [], quote, button, details, history, footer }) {
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
function queueEmail(to, subject, content) {
  if (!to) return;
  const { text, html } = render(content);
  db.prepare('INSERT INTO email_outbox (to_email, subject, text_body, html_body) VALUES (?, ?, ?, ?)')
    .run(to, subject, text, html);
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

    for (const email of pending) {
      try {
        if (transport) {
          await transport.sendMail({ from, to: email.to_email, subject: email.subject, text: email.text_body, html: email.html_body });
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

// Retry anything left pending (e.g. mail server was down) every minute.
function startMailer() {
  if (transport) {
    transport.verify()
      .then(() => console.log(`Email: sending via ${process.env.SMTP_HOST} as ${from.address}`))
      .catch(err => console.error(`Email: could not connect to ${process.env.SMTP_HOST}: ${err.message}`));
  } else {
    console.log('Email: SMTP not configured, emails will be printed to this console instead (see .env.example)');
  }
  processOutbox();
  setInterval(processOutbox, 60 * 1000).unref();
}

module.exports = { queueEmail, startMailer, APP_URL, APP_NAME };
