let me = null;
let currentTicketId = null;
let departments = [];
let pendingTicketId = null; // ticket to open after logging in (from an email link)

const isStaff = () => me && (me.role === 'agent' || me.role === 'admin');
const $ = sel => document.querySelector(sel);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = s => String(s).replace('_', ' ').replace(/^./, c => c.toUpperCase());
const badge = s => `<span class="badge ${esc(s)}">${esc(label(s))}</span>`;
const fmtDate = s => new Date(s.replace(' ', 'T') + 'Z').toLocaleString();

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login' && me) showAuth('login');
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { code: data.code });
  return data;
}

function showNotice(sel, message) {
  $(sel).textContent = message;
  $(sel).classList.toggle('hidden', !message);
}

// Clears the address bar hash without triggering navigation (so one-time links aren't reused).
const clearHash = () => history.replaceState(null, '', location.pathname);

// ---------- logged-out screens ----------

function showAuth(card) {
  me = null;
  stopLiveUpdates();
  $('#app-view').classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
  document.querySelectorAll('[data-auth-card]').forEach(el => el.classList.toggle('active', el.dataset.authCard === card));
  document.querySelectorAll('#auth-view .error').forEach(el => (el.textContent = ''));
  $('#resend-verification').classList.add('hidden');
  // Keep the address bar in sync so the #login / #register / #forgot links always trigger a change
  history.replaceState(null, '', ['register', 'forgot'].includes(card) ? `#${card}` : location.pathname);
  $(`[data-auth-card="${card}"] input`)?.focus();
}

function showMessage(title, body) {
  showAuth('message');
  $('#message-title').textContent = title;
  $('#message-body').textContent = body;
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = new FormData(e.target);
  $('#resend-verification').classList.add('hidden');
  try {
    await api('POST', '/api/login', { email: form.get('email'), password: form.get('password'), remember: form.get('remember') === 'on' });
    e.target.reset();
    showNotice('#login-notice', '');
    me = await api('GET', '/api/me');
    showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
    if (err.code === 'unverified') $('#resend-verification').classList.remove('hidden');
  }
});

$('#resend-verification').addEventListener('click', async () => {
  try {
    const { message } = await api('POST', '/api/resend-verification', { email: $('#login-form').elements.email.value });
    $('#login-error').textContent = '';
    showNotice('#login-notice', message);
    $('#resend-verification').classList.add('hidden');
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#register-form').addEventListener('submit', async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  if (data.password !== data.confirm) return ($('#register-error').textContent = 'Passwords do not match');
  try {
    const { message } = await api('POST', '/api/register', data);
    e.target.reset();
    showMessage('Check your email', message);
  } catch (err) {
    $('#register-error').textContent = err.message;
  }
});

$('#forgot-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const { message } = await api('POST', '/api/forgot-password', { email: e.target.elements.email.value });
    e.target.reset();
    showMessage('Check your email', message);
  } catch (err) {
    $('#forgot-error').textContent = err.message;
  }
});

let resetToken = null;
$('#reset-form').addEventListener('submit', async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  if (data.password !== data.confirm) return ($('#reset-error').textContent = 'Passwords do not match');
  try {
    const { message } = await api('POST', '/api/reset-password', { token: resetToken, password: data.password });
    e.target.reset();
    resetToken = null;
    showAuth('login');
    showNotice('#login-notice', message);
  } catch (err) {
    $('#reset-error').textContent = err.message;
  }
});

// ---------- app shell ----------

async function showApp() {
  startLiveUpdates();
  await refreshDepartments();
  resetTicketFilters();
  renderMe();
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', me.role !== 'admin'));
  document.querySelectorAll('.staff-only').forEach(el => el.classList.toggle('hidden', !isStaff()));
  $('#tickets-heading').textContent = isStaff() ? 'All tickets' : 'My tickets';

  if (pendingTicketId) {
    const id = pendingTicketId;
    pendingTicketId = null;
    openTicket(id);
  } else {
    navigate('tickets');
  }
}

// Loads the department list and fills every department dropdown (keeps each dropdown's selection)
async function refreshDepartments() {
  departments = await api('GET', '/api/departments');
  document.querySelectorAll('.department-select').forEach(sel => {
    const selected = sel.value;
    sel.querySelectorAll('option:not([value=""])').forEach(o => o.remove());
    sel.insertAdjacentHTML('beforeend', departments.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join(''));
    sel.value = selected;
  });
}

// Color dot class for a department (by name): the two built-in departments have their own colors
function deptColorClass(name) {
  const key = departments.find(d => d.name === name)?.request_key;
  return { it: 'dept-it', production: 'dept-prod' }[key] || 'dept-other';
}

// ---------- theme ----------
// Preference is 'system', 'light' or 'dark'. It is saved to the user's account, and in this browser
// so the login page (and the first paint, see index.html) uses it too.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let themePref = 'system';
try {
  themePref = localStorage.getItem('theme') || 'system';
} catch {
  // storage unavailable: follow the system
}

const resolvedTheme = () => (themePref === 'dark' || (themePref === 'system' && darkQuery.matches) ? 'dark' : 'light');

function applyTheme(pref) {
  themePref = ['system', 'light', 'dark'].includes(pref) ? pref : 'system';
  try {
    localStorage.setItem('theme', themePref);
  } catch {
    // not remembered in this browser; still applied now
  }
  const dark = resolvedTheme() === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const toggle = $('#theme-toggle');
  toggle.textContent = dark ? '☀' : '🌙';
  toggle.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  toggle.setAttribute('aria-label', toggle.title);
  $('#theme-select').value = themePref;
}

async function setTheme(pref) {
  applyTheme(pref);
  if (me) {
    try {
      await api('PATCH', '/api/me/theme', { theme: themePref });
      me.theme = themePref;
    } catch {
      // applied here anyway; the account keeps the old choice
    }
  }
}

darkQuery.addEventListener('change', () => {
  if (themePref === 'system') applyTheme('system');
});
$('#theme-toggle').addEventListener('click', () => setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark'));
$('#theme-select').addEventListener('change', e => setTheme(e.target.value));
applyTheme(themePref);

function renderMe() {
  // An explicit Light/Dark choice on the account wins after login; "system" keeps this browser's choice
  if (me.theme && me.theme !== 'system' && me.theme !== themePref) applyTheme(me.theme);
  $('#me-name').textContent = me.name;
  $('#me-role').textContent = label(me.role);
  $('#me-role').className = `badge ${me.role}`;
  $('#me-dept').textContent = me.department_name || '';
  $('#me-dept').classList.toggle('hidden', !me.department_name);
}

function navigate(page) {
  if (page === 'dashboard' && !isStaff()) page = 'tickets';
  if (page === 'settings' && me.role !== 'admin') page = 'tickets';
  clearHash();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $(`#${page}-page`).classList.add('active');
  document.querySelectorAll('header nav button').forEach(b => b.classList.toggle('active', b.dataset.nav === page));
  if (page === 'dashboard') loadDashboard();
  if (page === 'tickets') loadTickets();
  if (page === 'users') loadUsers();
  if (page === 'settings') loadSettings();
  if (page === 'account') loadAccount();
}

document.addEventListener('click', e => {
  const nav = e.target.closest('[data-nav]');
  if (!nav) return;
  if (nav.dataset.nav === 'tickets' && !nav.hasAttribute('data-keep-filters')) resetTicketFilters();
  navigate(nav.dataset.nav);
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  showAuth('login');
});

// ---------- tickets ----------

let ticketState = 'open'; // Open / Closed buttons

// Default ticket list filters: Open, all dates, all departments, anyone, all open statuses
function resetTicketFilters() {
  ticketState = 'open';
  document.querySelectorAll('.segmented [data-state]').forEach(b => b.classList.toggle('active', b.dataset.state === 'open'));
  $('#date-filter').value = '';
  $('#department-filter').value = '';
  $('#assigned-filter').value = '';
  $('#status-filter').value = '';
  $('#status-filter').classList.remove('hidden');
}

// Local date as YYYY-MM-DD (for the date picker)
const localDateString = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// A Date as the database's UTC format "YYYY-MM-DD HH:MM:SS"
const toDbTime = d => d.toISOString().slice(0, 19).replace('T', ' ');

// ----- summary panel (agents and admins) -----

async function loadSummary() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  let s;
  try {
    s = await api('GET', `/api/summary?${new URLSearchParams({ from: toDbTime(start), to: toDbTime(end) })}`);
  } catch {
    return; // keep the last numbers if a refresh fails
  }
  // tone: colored accent for the tile (see .tile.* in style.css)
  const tile = (num, lbl, tone) => `<div class="tile ${tone}"><div class="num">${num}</div><div class="lbl">${esc(lbl)}</div></div>`;
  const dot = cls => `<span class="dot ${cls}" aria-hidden="true"></span>`;
  const row = (lbl, val, dotCls) => `<li><span>${dotCls ? dot(dotCls) : ''}${esc(lbl)}</span><span class="val">${val}</span></li>`;
  const todayLabel = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  // Open tickets split by status, as one stacked bar
  const statuses = [['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved']];
  const statusBar = s.open.total
    ? `<div class="stack-bar" role="img" aria-label="${statuses.map(([k, l]) => `${l} ${s.open[k]}`).join(', ')}">
        ${statuses.filter(([k]) => s.open[k]).map(([k, l]) =>
          `<span class="seg st-${k}" style="flex: ${s.open[k]}" title="${l}: ${s.open[k]}"></span>`).join('')}
      </div>`
    : '';

  const deptClass = deptColorClass;
  const maxRequest = Math.max(1, ...s.requests_today.map(r => r.count));

  $('#summary-panel').innerHTML = `
    <div class="card">
      <h3>Today <span class="muted">· ${esc(todayLabel)}</span></h3>
      <div class="tiles">
        ${tile(s.today.created, 'New tickets', 'tone-blue')}
        ${tile(s.today.closed, 'Closed', 'tone-green')}
      </div>
    </div>

    <div class="card">
      <h3>Open now</h3>
      <div class="tiles">
        ${tile(s.open.total, 'Open tickets', 'tone-blue')}
        ${tile(s.open.unassigned, s.open.unassigned ? '⚠ Unassigned' : 'Unassigned', s.open.unassigned ? 'tone-amber' : 'tone-gray')}
      </div>
      ${statusBar}
      <ul class="stat-rows">
        ${row('Open', s.open.open, 'st-open')}
        ${row('In progress', s.open.in_progress, 'st-in_progress')}
        ${row('Resolved', s.open.resolved, 'st-resolved')}
        ${row('Assigned to me', s.open.mine)}
      </ul>
    </div>

    <div class="card">
      <h3>By department <span class="muted">· new &amp; closed today</span></h3>
      <table class="dept-table">
        <thead><tr><th>Department</th><th class="n" title="Created today">New</th><th class="n" title="Closed today">Closed</th><th class="n" title="Open right now">Open</th></tr></thead>
        <tbody>
          ${s.departments.map(d => `<tr>
            <td>${dot(deptClass(d.name))}${esc(d.name)}</td><td class="n">${d.created_today}</td><td class="n">${d.closed_today}</td><td class="n">${d.open}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>${dot('dept-prod')}Production requests today</h3>
      ${s.requests_today.length
        ? `<ul class="bar-rows">${s.requests_today.map(r => `
            <li title="${esc(r.item)}: ${r.count}">
              <div class="bar-label"><span>${esc(r.item)}</span><span class="val">${r.count}</span></div>
              <div class="bar-track"><div class="bar-fill" style="width: ${(r.count / maxRequest) * 100}%"></div></div>
            </li>`).join('')}</ul>`
        : '<p class="muted" style="margin: 0; font-size: 14px;">None yet today.</p>'}
    </div>`;
}

// ----- agent activity (agents and admins) -----

// Query params for "created on this local day" (date input value YYYY-MM-DD), or {} for all dates
function dayRangeParams(day) {
  if (!day) return {};
  const [y, m, d] = day.split('-').map(Number);
  return { from: toDbTime(new Date(y, m - 1, d)), to: toDbTime(new Date(y, m - 1, d + 1)) };
}

function timeAgo(s) {
  const date = new Date(s.replace(' ', 'T') + 'Z');
  const mins = Math.round((Date.now() - date) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// "changed status Open → In progress", etc. quoteLength limits how much of a reply is shown.
function activityText(a, quoteLength) {
  const quote = a.details && a.details.length > quoteLength ? a.details.slice(0, quoteLength) + '…' : a.details;
  switch (a.action) {
    case 'created': return 'created a ticket';
    case 'status': return `changed status <strong>${esc(a.details)}</strong>`;
    case 'priority': return `changed priority <strong>${esc(a.details)}</strong>`;
    case 'department': return `moved ticket to <strong>${esc(a.details)}</strong>`;
    case 'assigned': return `assigned ticket to <strong>${esc(a.details)}</strong>`;
    case 'unassigned': return `unassigned <strong>${esc(a.details)}</strong>`;
    case 'claimed': return 'claimed the ticket';
    case 'released': return 'released the ticket';
    case 'comment': return `replied <span class="quote">“${esc(quote)}”</span>`;
    case 'deleted': return 'deleted a ticket';
    default: return esc(a.action);
  }
}

const ticketRef = a => `<span class="ticket-ref ${a.ticket_exists ? '' : 'gone'}" title="${a.ticket_exists ? '' : 'Ticket deleted'}">#${a.ticket_id} ${esc(a.ticket_title || '')}</span>`;

function activityQuery(dateInput, searchInput, extra) {
  return new URLSearchParams({ ...dayRangeParams($(dateInput).value), q: $(searchInput).value.trim(), ...extra });
}

// Side panel: the 20 latest
async function loadActivity() {
  let data;
  try {
    data = await api('GET', '/api/activity?' + activityQuery('#activity-date', '#activity-search', { limit: 20 }));
  } catch {
    return;
  }
  $('#activity-list').innerHTML = data.items.length
    ? data.items.map(a => `
        <li class="${a.ticket_exists ? 'clickable' : ''}" data-ticket="${a.ticket_exists ? a.ticket_id : ''}">
          <div><strong>${esc(a.user_name)}</strong> <span class="what">${activityText(a, 60)}</span></div>
          <div>${ticketRef(a)} <span class="when" title="${esc(fmtDate(a.created_at))}">· ${timeAgo(a.created_at)}</span></div>
        </li>`).join('')
    : '<li class="muted">No activity found.</li>';
  $('#activity-count').textContent = data.total > data.items.length
    ? `Showing ${data.items.length} of ${data.total}. Click "View all" to see everything.`
    : '';
}

// "View all" window, loaded 50 at a time
let activityOffset = 0;
async function loadAllActivity(reset) {
  if (reset) {
    activityOffset = 0;
    $('#activity-all-rows').innerHTML = '';
  }
  let data;
  try {
    data = await api('GET', '/api/activity?' + activityQuery('#activity-all-date', '#activity-all-search', { limit: 50, offset: activityOffset }));
  } catch {
    return;
  }
  activityOffset += data.items.length;
  $('#activity-all-rows').insertAdjacentHTML('beforeend', data.items.map(a => `
    <tr class="${a.ticket_exists ? 'clickable' : ''}" data-ticket="${a.ticket_exists ? a.ticket_id : ''}">
      <td title="${esc(timeAgo(a.created_at))}">${esc(fmtDate(a.created_at))}</td>
      <td><strong>${esc(a.user_name)}</strong> ${badge(a.user_role)}</td>
      <td>${activityText(a, 200)}</td>
      <td>${ticketRef(a)}</td>
    </tr>`).join(''));
  $('#activity-all-empty').classList.toggle('hidden', data.total > 0);
  $('#activity-more').classList.toggle('hidden', activityOffset >= data.total);
  $('#activity-all-count').textContent = `${data.total} ${data.total === 1 ? 'activity' : 'activities'}`;
}

function openActivityModal() {
  // Start with the same filters as the side panel
  $('#activity-all-date').value = $('#activity-date').value;
  $('#activity-all-search').value = $('#activity-search').value;
  $('#activity-modal').classList.remove('hidden');
  document.body.classList.add('modal-open');
  loadAllActivity(true);
  $('#activity-close').focus();
}

function closeActivityModal() {
  $('#activity-modal').classList.add('hidden');
  document.body.classList.remove('modal-open');
}

// Wait until typing pauses before searching
const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

$('#activity-date').addEventListener('change', loadActivity);
$('#activity-search').addEventListener('input', debounce(loadActivity, 300));
$('#activity-expand').addEventListener('click', openActivityModal);
$('#activity-all-date').addEventListener('change', () => loadAllActivity(true));
$('#activity-all-search').addEventListener('input', debounce(() => loadAllActivity(true), 300));
$('#activity-more').addEventListener('click', () => loadAllActivity(false));
$('#activity-close').addEventListener('click', closeActivityModal);
$('#activity-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeActivityModal(); // click outside the box
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#activity-modal').classList.contains('hidden')) closeActivityModal();
});
// Click an activity to open its ticket
for (const sel of ['#activity-list', '#activity-all-rows']) {
  $(sel).addEventListener('click', e => {
    const item = e.target.closest('[data-ticket]');
    if (!item || !item.dataset.ticket) return;
    closeActivityModal();
    openTicket(item.dataset.ticket);
  });
}

// ----- dashboard (agents and admins) -----

// Range presets: "today", or the last N days including today
function setDashboardRange(preset) {
  const today = new Date();
  const start = new Date(today);
  if (preset !== 'today') start.setDate(start.getDate() - (Number(preset) - 1));
  $('#dash-from').value = localDateString(start);
  $('#dash-to').value = localDateString(today);
  document.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('active', b.dataset.range === preset));
}
setDashboardRange('30');

document.querySelectorAll('[data-range]').forEach(btn => btn.addEventListener('click', () => {
  setDashboardRange(btn.dataset.range);
  loadDashboard();
}));
for (const sel of ['#dash-from', '#dash-to']) {
  $(sel).addEventListener('change', () => {
    document.querySelectorAll('[data-range]').forEach(b => b.classList.remove('active')); // custom range
    loadDashboard();
  });
}

function formatHours(h) {
  if (h == null) return '–';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}
const ageHours = s => (Date.now() - new Date(s.replace(' ', 'T') + 'Z')) / 3600000;

async function loadDashboard() {
  let fromDay = $('#dash-from').value;
  let toDay = $('#dash-to').value;
  if (!fromDay || !toDay) return;
  if (fromDay > toDay) [fromDay, toDay] = [toDay, fromDay];
  const [fy, fm, fd] = fromDay.split('-').map(Number);
  const [ty, tm, td] = toDay.split('-').map(Number);
  const query = new URLSearchParams({
    from: toDbTime(new Date(fy, fm - 1, fd)),
    to: toDbTime(new Date(ty, tm - 1, td + 1)),
    tz: -new Date().getTimezoneOffset(),
  });

  let d;
  try {
    d = await api('GET', '/api/dashboard?' + query);
  } catch (err) {
    $('#dashboard-content').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }

  const tile = (num, lbl, tone) => `<div class="tile ${tone}"><div class="num">${num}</div><div class="lbl">${esc(lbl)}</div></div>`;
  const deptDot = name => `<span class="dot ${deptColorClass(name)}" aria-hidden="true"></span>`;
  const empty = (cols, text = 'No tickets in this range.') => `<tr><td colspan="${cols}" class="muted">${text}</td></tr>`;
  const totalTypes = d.request_types.reduce((sum, r) => sum + r.created, 0) || 1;
  const fmtDay = day => new Date(day + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const o = d.overview;

  $('#dashboard-content').innerHTML = `
    <div class="dash-kpis">
      ${tile(o.created, 'Tickets created', 'tone-blue')}
      ${tile(o.closed, 'Tickets closed', 'tone-green')}
      ${tile(formatHours(o.avg_close_hours), 'Average time to close', 'tone-gray')}
      ${tile(o.open_now, 'Open right now', 'tone-blue')}
      ${tile(o.unassigned_now, o.unassigned_now ? '⚠ Unassigned right now' : 'Unassigned right now', o.unassigned_now ? 'tone-amber' : 'tone-gray')}
    </div>

    <div class="dash-grid">
      <div class="card dash-card">
        <h3>By department</h3>
        <table class="dash-table">
          <thead><tr><th>Department</th><th class="n">Created</th><th class="n">Closed</th><th class="n">Open now</th><th class="n">Avg. time to close</th></tr></thead>
          <tbody>${d.departments.map(r => `<tr>
            <td>${deptDot(r.name)}${esc(r.name)}</td><td class="n">${r.created}</td><td class="n">${r.closed}</td>
            <td class="n">${r.open_now}</td><td class="n">${formatHours(r.avg_close_hours)}</td></tr>`).join('')}</tbody>
        </table>
      </div>

      <div class="card dash-card">
        <h3>By request type</h3>
        <table class="dash-table">
          <thead><tr><th>Request</th><th class="n">Created</th><th class="n">Still open</th><th class="n">Share</th></tr></thead>
          <tbody>${d.request_types.length ? d.request_types.map(r => {
            const pct = Math.round((r.created / totalTypes) * 100);
            return `<tr><td>${esc(r.type)}</td><td class="n">${r.created}</td><td class="n">${r.open_now}</td>
              <td class="n"><div class="share"><div class="bar-track"><div class="bar-fill blue" style="width: ${pct}%"></div></div>${pct}%</div></td></tr>`;
          }).join('') : empty(4)}</tbody>
        </table>
      </div>

      <div class="card dash-card wide">
        <h3>Agent performance</h3>
        <table class="dash-table">
          <thead><tr><th>Agent</th><th>Department</th><th class="n" title="Open tickets assigned to them right now">Open assigned</th>
            <th class="n" title="Tickets they closed in this range">Closed</th><th class="n" title="Replies they wrote in this range">Replies</th>
            <th class="n" title="All their ticket actions in this range">Total actions</th></tr></thead>
          <tbody>${d.agents.length ? d.agents.map(a => `<tr>
            <td><strong>${esc(a.name)}</strong> ${badge(a.role)}</td>
            <td>${a.department ? deptDot(a.department) + esc(a.department) : '<span class="muted">–</span>'}</td>
            <td class="n">${a.assigned_open}</td><td class="n">${a.closed}</td><td class="n">${a.replies}</td><td class="n">${a.actions}</td></tr>`).join('')
            : empty(6, 'No agents yet.')}</tbody>
        </table>
      </div>

      <div class="card dash-card">
        <h3>Tickets per day</h3>
        <div class="dash-scroll">
          <table class="dash-table">
            <thead><tr><th>Date</th><th class="n">Created</th><th class="n">Closed</th></tr></thead>
            <tbody>${d.per_day.length ? d.per_day.map(r => `<tr><td>${esc(fmtDay(r.day))}</td><td class="n">${r.created}</td><td class="n">${r.closed}</td></tr>`).join('')
              : empty(3)}</tbody>
          </table>
        </div>
      </div>

      <div class="card dash-card">
        <h3>Top locations</h3>
        <table class="dash-table">
          <thead><tr><th>Location</th><th class="n">Created</th><th class="n">Still open</th></tr></thead>
          <tbody>${d.locations.length ? d.locations.map(r => `<tr><td>${esc(r.location)}</td><td class="n">${r.created}</td><td class="n">${r.open_now}</td></tr>`).join('')
            : empty(3)}</tbody>
        </table>
      </div>

      <div class="card dash-card wide">
        <h3>Oldest open tickets</h3>
        <table class="dash-table">
          <thead><tr><th>#</th><th>Ticket</th><th>Department</th><th>Status</th><th>Assigned to</th><th class="n">Open for</th></tr></thead>
          <tbody id="dash-oldest">${d.oldest_open.length ? d.oldest_open.map(t => `<tr class="clickable" data-ticket="${t.id}">
            <td>${t.id}</td><td>${esc(t.title)}</td><td>${t.department ? deptDot(t.department) + esc(t.department) : '–'}</td>
            <td>${badge(t.status)}</td><td>${esc(t.assigned_to_name) || '<span class="muted">Unassigned</span>'}</td>
            <td class="n">${formatHours(ageHours(t.created_at))}</td></tr>`).join('')
            : empty(6, 'No open tickets.')}</tbody>
        </table>
      </div>
    </div>`;
}

$('#dashboard-content').addEventListener('click', e => {
  const row = e.target.closest('[data-ticket]');
  if (row) openTicket(row.dataset.ticket);
});

// ----- Live updates -----
// The server tells this browser when a ticket is created, updated or deleted (see events.js),
// and the ticket list / dashboard on screen refresh straight away.
let liveSource = null;
const newTicketIds = new Set(); // briefly highlighted in the list
let liveRefreshTimer = null;

function startLiveUpdates() {
  if (liveSource || !window.EventSource) return;
  liveSource = new EventSource('/api/events');
  liveSource.addEventListener('ticket', e => {
    const { type, id } = JSON.parse(e.data);
    if (type === 'created') {
      newTicketIds.add(id);
      setTimeout(() => {
        newTicketIds.delete(id);
        document.querySelector(`#ticket-rows tr[data-id="${id}"]`)?.classList.remove('new-row');
      }, 8000);
    }
    // Several changes in a row (e.g. a status change and a reply) trigger one refresh
    clearTimeout(liveRefreshTimer);
    liveRefreshTimer = setTimeout(refreshVisibleLists, 400);
  });
}

function stopLiveUpdates() {
  liveSource?.close();
  liveSource = null;
}

// Refreshes whatever list is on screen. An open ticket page is left alone so nobody loses what they are typing.
function refreshVisibleLists() {
  if (!me) return;
  if ($('#tickets-page').classList.contains('active')) loadTickets();
  if (isStaff() && $('#dashboard-page').classList.contains('active')) loadDashboard();
}

// Keep the panels and dashboard current while they are on screen
setInterval(() => {
  if (!isStaff() || document.hidden) return;
  if ($('#tickets-page').classList.contains('active')) {
    loadSummary();
    loadActivity();
  }
  if ($('#dashboard-page').classList.contains('active')) loadDashboard();
}, 60 * 1000);

async function loadTickets() {
  if (isStaff()) {
    loadSummary();
    loadActivity();
  }
  const query = new URLSearchParams({ state: ticketState });
  if (ticketState === 'open' && $('#status-filter').value) query.set('status', $('#status-filter').value);
  // Tickets created on the chosen day, in the viewer's local time
  const day = $('#date-filter').value;
  if (day) {
    const [y, m, d] = day.split('-').map(Number);
    query.set('created_from', toDbTime(new Date(y, m - 1, d)));
    query.set('created_to', toDbTime(new Date(y, m - 1, d + 1)));
  }
  if ($('#department-filter').value) query.set('department', $('#department-filter').value);
  if (isStaff() && $('#assigned-filter').value) query.set('assigned', $('#assigned-filter').value);
  const tickets = await api('GET', '/api/tickets?' + query);
  const staff = isStaff();
  $('#ticket-rows').innerHTML = tickets.map(t => `
    <tr class="clickable${newTicketIds.has(t.id) ? ' new-row' : ''}" data-id="${t.id}">
      <td>${t.id}</td>
      <td>${esc(t.title)}</td>
      <td>${esc(t.department_name) || '<span class="muted">None</span>'}</td>
      <td>${badge(t.priority)}</td>
      <td>${badge(t.status)}</td>
      ${staff ? `<td>${esc(t.created_by_name)}</td>` : ''}
      <td>${esc(t.assigned_to_name) || '<span class="muted">Unassigned</span>'}</td>
      <td>${fmtDate(t.updated_at)}</td>
    </tr>`).join('');
  $('#no-tickets').classList.toggle('hidden', tickets.length > 0);
  $('#no-tickets').textContent = `No ${ticketState} tickets${day
    ? ` created on ${new Date(day + 'T00:00').toLocaleDateString(undefined, { dateStyle: 'medium' })}. Click "All dates" to see older tickets.`
    : '.'}`;
}

document.querySelectorAll('.segmented [data-state]').forEach(btn => btn.addEventListener('click', () => {
  ticketState = btn.dataset.state;
  document.querySelectorAll('.segmented [data-state]').forEach(b => b.classList.toggle('active', b === btn));
  $('#status-filter').classList.toggle('hidden', ticketState === 'closed'); // status choices only apply to open tickets
  loadTickets();
}));
$('#date-filter').addEventListener('change', loadTickets);
$('#date-today').addEventListener('click', () => {
  $('#date-filter').value = localDateString(new Date());
  loadTickets();
});
$('#date-all').addEventListener('click', () => {
  $('#date-filter').value = '';
  loadTickets();
});
$('#status-filter').addEventListener('change', loadTickets);
$('#assigned-filter').addEventListener('change', loadTickets);
$('#department-filter').addEventListener('change', loadTickets);

$('#ticket-rows').addEventListener('click', e => {
  const row = e.target.closest('tr[data-id]');
  if (row) openTicket(row.dataset.id);
});

// Show only the fields for the chosen request type
function showRequestFields() {
  const type = $('#request-type').value;
  document.querySelectorAll('.request-fields').forEach(fs => {
    const active = fs.dataset.requestType === type;
    fs.classList.toggle('hidden', !active);
    fs.disabled = !active;
  });
}
$('#request-type').addEventListener('change', showRequestFields);
showRequestFields(); // show the default (Production Request) fields on load

$('#new-ticket-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    const ticket = await api('POST', '/api/tickets', Object.fromEntries(form));
    e.target.reset();
    showRequestFields();
    $('#new-ticket-error').textContent = '';
    openTicket(ticket.id);
  } catch (err) {
    $('#new-ticket-error').textContent = err.message;
  }
});

async function openTicket(id) {
  currentTicketId = id;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('header nav button').forEach(b => b.classList.remove('active'));
  $('#detail-page').classList.add('active');
  history.replaceState(null, '', `#ticket/${id}`);

  let t;
  try {
    t = await api('GET', `/api/tickets/${id}`);
  } catch (err) {
    $('#ticket-detail').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    $('#comments').innerHTML = '';
    $('#comment-form').classList.add('hidden');
    return;
  }
  const assignees = isStaff() ? await api('GET', '/api/assignees') : [];
  const opts = (values, selected) => values.map(v => `<option value="${v}" ${v === selected ? 'selected' : ''}>${label(v)}</option>`).join('');

  let controls = '';
  const isAdmin = me.role === 'admin';
  // Claim = assign to yourself. Agents can only claim unassigned tickets; admins can take any ticket.
  const canClaim = t.can_work && t.status !== 'closed' && t.assigned_to !== me.id && (isAdmin || !t.assigned_to);
  // Release = give back a ticket you hold, so it's unassigned again
  const canRelease = t.can_work && t.status !== 'closed' && t.assigned_to === me.id;
  if (t.can_work) {
    controls = `
      <div class="admin-controls">
        <label>Status <select id="ctl-status">${opts(['open', 'in_progress', 'resolved', 'closed'], t.status)}</select></label>
        <label>Priority <select id="ctl-priority">${opts(['low', 'medium', 'high'], t.priority)}</select></label>
        <label>Department
          <select id="ctl-department">
            ${t.department_id ? '' : '<option value="">None</option>'}
            ${departments.map(d => `<option value="${d.id}" ${d.id === t.department_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
          </select>
        </label>
        ${isAdmin ? '<label>Assigned to <select id="ctl-assignee"></select></label>' : ''}
        ${canClaim ? '<button id="ctl-claim" class="success">Claim ticket</button>' : ''}
        ${canRelease ? '<button id="ctl-release" class="secondary" title="Unassign yourself so someone else can claim it">Release</button>' : ''}
        <span id="ctl-save-status" class="save-status" role="status" aria-live="polite"></span>
        ${isAdmin ? `
          <div class="ticket-actions">
            <button id="ctl-delete" class="danger">Delete ticket</button>
          </div>` : ''}
      </div>`;
  } else {
    if (t.created_by === me.id && t.status !== 'closed') {
      controls = `<div class="admin-controls"><button id="ctl-close" class="secondary">Close ticket</button></div>`;
    }
    if (isStaff()) {
      controls += `<p class="readonly-note">Read only: only ${esc(t.department_name || 'the assigned department')} agents can work on this ticket.</p>`;
    }
  }

  $('#ticket-detail').innerHTML = `
    <h2>#${t.id} &middot; ${esc(t.title)}</h2>
    <div class="meta">
      <span>Status: ${badge(t.status)}</span>
      <span>Department: ${esc(t.department_name) || 'None'}</span>
      <span>Priority: ${badge(t.priority)}</span>
      <span>Created by: ${esc(t.created_by_name)}</span>
      <span>Assigned to: ${esc(t.assigned_to_name) || 'Unassigned'}</span>
      <span>Created: ${fmtDate(t.created_at)}</span>
    </div>
    ${t.location || t.request_item ? `
      <div class="request-details">
        ${t.request_item ? `<div><span class="muted">Request</span><strong>${esc(t.request_item)}</strong></div>` : ''}
        ${t.location ? `<div><span class="muted">Location</span><strong>${esc(t.location)}</strong></div>` : ''}
      </div>` : ''}
    ${t.description ? `
      <div class="info-callout">
        ${t.location ? `<div class="info-callout-label">${t.request_item ? 'Additional info' : 'Issue description'}</div>` : ''}
        <div class="description">${esc(t.description)}</div>
      </div>` : ''}
    ${controls}
    <p class="error" id="detail-error"></p>`;

  $('#comments').innerHTML = t.comments.length
    ? t.comments.map(c => `
        <div class="comment">
          <div class="who"><strong>${esc(c.user_name)}</strong> ${badge(c.user_role)} &middot; ${fmtDate(c.created_at)}</div>
          <div class="body">${esc(c.body)}</div>
        </div>`).join('')
    : '<p class="muted">No comments yet.</p>';

  $('#comment-form').classList.toggle('hidden', !t.can_comment);
  $('#comment-readonly').classList.toggle('hidden', t.can_comment);
  $('#comment-readonly').textContent = `Only ${t.department_name || 'the assigned department'} agents can comment on this ticket.`;

  // Assignee options: admins, plus agents in the selected department
  const fillAssignees = () => {
    const deptId = Number($('#ctl-department').value) || null;
    const current = $('#ctl-assignee').options.length ? Number($('#ctl-assignee').value) : t.assigned_to;
    const eligible = assignees.filter(a => a.role === 'admin' || (deptId && a.department_id === deptId));
    $('#ctl-assignee').innerHTML = '<option value="">Unassigned</option>' + eligible.map(a =>
      `<option value="${a.id}" ${a.id === current ? 'selected' : ''}>${esc(a.name)} (${label(a.role)})</option>`).join('');
  };
  if (t.can_work && isAdmin) fillAssignees();

  // Changing a dropdown saves that field right away (no Save button)
  if (t.can_work) {
    $('#ctl-status').addEventListener('change', e => autoSave({ status: e.target.value }));
    $('#ctl-priority').addEventListener('change', e => autoSave({ priority: e.target.value }));
    $('#ctl-department').addEventListener('change', e => {
      if (e.target.value) autoSave({ department_id: Number(e.target.value) });
    });
    // Only admins choose the assignee; agents use "Claim ticket"
    $('#ctl-assignee')?.addEventListener('change', e => autoSave({ assigned_to: e.target.value ? Number(e.target.value) : null }));
  }
  if (pendingSaveMessage) {
    $('#ctl-save-status').textContent = pendingSaveMessage;
    pendingSaveMessage = '';
    setTimeout(() => {
      if ($('#ctl-save-status')) $('#ctl-save-status').textContent = '';
    }, 2500);
  }
  $('#ctl-claim')?.addEventListener('click', () => updateTicket({ assigned_to: me.id }));
  $('#ctl-release')?.addEventListener('click', () => updateTicket({ assigned_to: null }));
  $('#ctl-close')?.addEventListener('click', () => updateTicket({ status: 'closed' }));
  $('#ctl-delete')?.addEventListener('click', async () => {
    if (!confirm(`Delete ticket #${t.id}? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/api/tickets/${t.id}`);
      navigate('tickets');
    } catch (err) {
      $('#detail-error').textContent = err.message;
    }
  });
}

// Saves one dropdown change, then reloads the ticket (status, assignee, buttons and emails all update).
// On failure the ticket is reloaded so the dropdown shows the saved value again.
let pendingSaveMessage = '';
async function autoSave(changes) {
  const controls = document.querySelectorAll('#ticket-detail .admin-controls select');
  controls.forEach(el => (el.disabled = true));
  $('#ctl-save-status').textContent = 'Saving…';
  try {
    await api('PATCH', `/api/tickets/${currentTicketId}`, changes);
    pendingSaveMessage = '✓ Saved';
    await openTicket(currentTicketId);
  } catch (err) {
    await openTicket(currentTicketId);
    $('#detail-error').textContent = err.message;
  }
}

async function updateTicket(changes) {
  try {
    await api('PATCH', `/api/tickets/${currentTicketId}`, changes);
    openTicket(currentTicketId);
  } catch (err) {
    $('#detail-error').textContent = err.message;
  }
}

$('#comment-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api('POST', `/api/tickets/${currentTicketId}/comments`, { body: form.get('body') });
    e.target.reset();
    openTicket(currentTicketId);
  } catch (err) {
    $('#detail-error').textContent = err.message;
  }
});

// ---------- my account ----------

function loadAccount() {
  const form = $('#profile-form');
  form.elements.first_name.value = me.first_name;
  form.elements.last_name.value = me.last_name;
  $('#account-summary').textContent =
    `${me.email} · ${label(me.role)}${me.department_name ? ` · ${me.department_name}` : ''}`;
  for (const id of ['profile', 'password']) {
    showNotice(`#${id}-notice`, '');
    $(`#${id}-error`).textContent = '';
  }
}

$('#profile-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#profile-error').textContent = '';
  try {
    await api('PATCH', '/api/me', Object.fromEntries(new FormData(e.target)));
    me = await api('GET', '/api/me');
    renderMe();
    loadAccount();
    showNotice('#profile-notice', 'Your name has been updated.');
  } catch (err) {
    showNotice('#profile-notice', '');
    $('#profile-error').textContent = err.message;
  }
});

$('#password-form').addEventListener('submit', async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  showNotice('#password-notice', '');
  $('#password-error').textContent = '';
  if (data.new_password !== data.confirm) return ($('#password-error').textContent = 'New passwords do not match');
  try {
    const { message } = await api('POST', '/api/me/password', data);
    e.target.reset();
    showNotice('#password-notice', message);
  } catch (err) {
    $('#password-error').textContent = err.message;
  }
});

// ---------- users (admin) ----------

let usersById = {};

// Users page: one table per role. Each is sorted by name; clicking "Name" reverses all three.
let userSortDir = 1; // 1 = A–Z, -1 = Z–A
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const USER_GROUPS = [
  { role: 'admin', title: 'Admins' },
  { role: 'agent', title: 'Agents' },
  { role: 'employee', title: 'Employees' },
];

let loadedUsers = [];
async function loadUsers() {
  loadedUsers = await api('GET', '/api/users');
  usersById = Object.fromEntries(loadedUsers.map(u => [u.id, u]));
  renderUserRows();
  resetUserForm();
}

function renderUserRows() {
  const arrow = userSortDir === 1 ? '▲' : '▼';
  const ariaSort = userSortDir === 1 ? 'ascending' : 'descending';
  $('#user-rows').innerHTML = USER_GROUPS.map(({ role, title }) => {
    const users = loadedUsers.filter(u => u.role === role).sort((a, b) => byName(a, b) * userSortDir);
    const showDept = role === 'agent';
    return `
      <section class="user-group" data-role="${role}">
        <h3>${title} <span class="count">${users.length}</span></h3>
        <table class="card">
          <thead><tr>
            <th aria-sort="${ariaSort}"><button type="button" class="sort-header" data-sort="name">Name <span class="sort-arrow">${arrow}</span></button></th>
            <th>Email</th>
            ${showDept ? '<th>Department</th>' : ''}
            <th>Created</th><th></th>
          </tr></thead>
          <tbody>
            ${users.length ? users.map(u => `
              <tr>
                <td>${esc(u.name)}${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}${u.is_protected ? ' <span class="badge main-admin" title="Set in .env. Cannot be deleted.">Main admin</span>' : ''}</td>
                <td>${esc(u.email)} ${u.verified ? '' : '<span class="badge unverified" title="Has not clicked the verification link yet">Unverified</span>'}</td>
                ${showDept ? `<td>${esc(u.department_name) || '<span class="muted">None</span>'}</td>` : ''}
                <td>${fmtDate(u.created_at)}</td>
                <td class="row-actions">
                  <button class="secondary" data-edit-user="${u.id}">Edit</button>
                  <button class="secondary" data-reset-user="${u.id}" title="Email this user a link to set a new password">Send reset link</button>
                  ${u.id === me.id || u.is_protected ? '' : `<button class="danger" data-delete-user="${u.id}">Delete</button>`}
                </td>
              </tr>`).join('') : `<tr><td colspan="${showDept ? 5 : 4}" class="muted">No ${title.toLowerCase()} yet.</td></tr>`}
          </tbody>
        </table>
      </section>`;
  }).join('');
}

// Clicking any "Name" heading flips the order in all three tables
$('#user-rows').addEventListener('click', e => {
  if (!e.target.closest('.sort-header')) return;
  userSortDir = -userSortDir;
  renderUserRows();
});

function resetUserForm() {
  const form = $('#user-form');
  form.reset();
  lockMainAdminFields(form, false, false);
  form.elements.id.value = '';
  form.elements.password.required = true;
  $('#user-form-title').textContent = 'Add user';
  $('#password-label').textContent = 'Password';
  $('#user-form-submit').textContent = 'Create user';
  $('#user-form-cancel').classList.add('hidden');
  $('#user-form-error').textContent = '';
  toggleDepartmentField();
}

function toggleDepartmentField() {
  $('#user-department-field').classList.toggle('hidden', $('#user-form').elements.role.value !== 'agent');
}
$('#user-form').elements.role.addEventListener('change', toggleDepartmentField);

// The main admin (from .env) always stays an admin; only they can change their own email and password.
function lockMainAdminFields(form, isProtected, isSelf) {
  form.elements.role.disabled = isProtected;
  form.elements.email.disabled = isProtected && !isSelf;
  form.elements.password.disabled = isProtected && !isSelf;
  $('#main-admin-note').classList.toggle('hidden', !isProtected);
  $('#main-admin-note').textContent = isSelf
    ? 'You are the main admin (set in .env): your account always stays an admin and cannot be deleted.'
    : 'This is the main admin (set in .env): it cannot be deleted or lose its admin role, and only they can change its email or password. Use "Send reset link" if they forgot their password.';
}

function editUser(user) {
  const form = $('#user-form');
  form.elements.id.value = user.id;
  form.elements.first_name.value = user.first_name;
  form.elements.last_name.value = user.last_name;
  form.elements.email.value = user.email;
  form.elements.role.value = user.role;
  form.elements.department_id.value = user.department_id ?? '';
  toggleDepartmentField();
  form.elements.password.value = '';
  form.elements.password.required = false;
  lockMainAdminFields(form, user.is_protected, user.id === me.id);
  $('#user-form-title').textContent = `Edit ${user.name}`;
  $('#password-label').textContent = 'New password (leave blank to keep current)';
  $('#user-form-submit').textContent = 'Save changes';
  $('#user-form-cancel').classList.remove('hidden');
  $('#user-form-error').textContent = '';
  form.scrollIntoView({ behavior: 'smooth' });
}

$('#user-rows').addEventListener('click', async e => {
  showNotice('#user-list-notice', '');
  $('#user-list-error').textContent = '';

  const editBtn = e.target.closest('[data-edit-user]');
  if (editBtn) return editUser(usersById[editBtn.dataset.editUser]);

  const resetBtn = e.target.closest('[data-reset-user]');
  if (resetBtn) {
    try {
      const { message } = await api('POST', `/api/users/${resetBtn.dataset.resetUser}/send-reset`);
      showNotice('#user-list-notice', message);
    } catch (err) {
      $('#user-list-error').textContent = err.message;
    }
    return;
  }

  const deleteBtn = e.target.closest('[data-delete-user]');
  if (deleteBtn) {
    const user = usersById[deleteBtn.dataset.deleteUser];
    if (!confirm(`Delete ${user.name}? They will no longer be able to log in. Their tickets and comments are kept.`)) return;
    try {
      await api('DELETE', `/api/users/${user.id}`);
      loadUsers();
    } catch (err) {
      $('#user-list-error').textContent = err.message;
    }
  }
});

$('#user-form-cancel').addEventListener('click', resetUserForm);

$('#user-form').addEventListener('submit', async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  for (const el of e.target.elements) if (el.disabled && el.name) data[el.name] = el.type === 'password' ? '' : el.value;
  const id = data.id;
  delete data.id;
  try {
    if (id) {
      await api('PATCH', `/api/users/${id}`, data);
      if (Number(id) === me.id) {
        me = await api('GET', '/api/me');
        renderMe();
      }
    } else {
      await api('POST', '/api/users', data);
    }
    loadUsers();
  } catch (err) {
    $('#user-form-error').textContent = err.message;
  }
});

// ---------- settings (admin) ----------

async function loadSettings() {
  loadGeneralSettings();
  loadEmailSettings();
  showNotice('#dept-notice', '');
  $('#dept-error').textContent = '';
  const rows = await api('GET', '/api/settings/departments');
  $('#dept-rows').innerHTML = rows.map(d => `
    <tr data-dept="${d.id}">
      <td class="dept-name"><span class="dot ${deptColorClass(d.name)}" aria-hidden="true"></span><span>${esc(d.name)}</span></td>
      <td>${d.request_type ? esc(d.request_type) : '<span class="muted">Not on the form</span>'}</td>
      <td class="n">${d.agents}</td>
      <td class="n">${d.open_tickets}</td>
      <td class="n">${d.total_tickets}</td>
      <td class="row-actions"><button type="button" class="secondary" data-rename="${d.id}">Rename</button></td>
    </tr>`).join('');
}

// Rename: swap the name for an input with Save / Cancel
$('#dept-rows').addEventListener('click', async e => {
  const row = e.target.closest('tr[data-dept]');
  if (!row) return;
  const id = row.dataset.dept;
  const nameCell = row.querySelector('.dept-name');

  if (e.target.closest('[data-rename]')) {
    const current = departments.find(d => String(d.id) === id)?.name || '';
    nameCell.innerHTML = `<input class="rename-input" maxlength="50" value="${esc(current)}" aria-label="Department name">`;
    e.target.closest('td').innerHTML = '<button type="button" data-save>Save</button> <button type="button" class="secondary" data-cancel>Cancel</button>';
    nameCell.querySelector('input').focus();
    nameCell.querySelector('input').select();
    return;
  }
  if (e.target.closest('[data-cancel]')) return loadSettings();
  if (e.target.closest('[data-save]')) {
    try {
      const name = nameCell.querySelector('input').value;
      await api('PATCH', `/api/settings/departments/${id}`, { name });
      await refreshDepartments();
      await loadSettings();
      showNotice('#dept-notice', `Department renamed to "${name.trim()}".`);
    } catch (err) {
      $('#dept-error').textContent = err.message;
    }
  }
});

// Enter saves, Escape cancels while renaming
$('#dept-rows').addEventListener('keydown', e => {
  if (!e.target.classList.contains('rename-input')) return;
  if (e.key === 'Enter') e.target.closest('tr').querySelector('[data-save]').click();
  if (e.key === 'Escape') loadSettings();
});

$('#dept-add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = e.target.elements.name.value;
  try {
    await api('POST', '/api/settings/departments', { name });
    e.target.reset();
    await refreshDepartments();
    await loadSettings();
    showNotice('#dept-notice', `Department "${name.trim()}" added. You can now put agents in it on the Users page.`);
  } catch (err) {
    showNotice('#dept-notice', '');
    $('#dept-error').textContent = err.message;
  }
});

// Collapsible settings sections: remember which ones this browser left open.
// localStorage can be unavailable (private mode, blocked storage), so failures are ignored.
const OPEN_SECTIONS_KEY = 'settings.openSections';
function readOpenSections() {
  try {
    return JSON.parse(localStorage.getItem(OPEN_SECTIONS_KEY)) || [];
  } catch {
    return [];
  }
}
document.querySelectorAll('.settings-section').forEach(section => {
  section.open = readOpenSections().includes(section.dataset.section);
  section.addEventListener('toggle', () => {
    const open = new Set(readOpenSections());
    if (section.open) open.add(section.dataset.section);
    else open.delete(section.dataset.section);
    try {
      localStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify([...open]));
    } catch {
      // not saved; the section still opens and closes
    }
  });
});

// ----- Email settings -----

async function loadEmailSettings() {
  for (const id of ['email-settings', 'email-test']) {
    showNotice(`#${id}-notice`, '');
    $(`#${id}-error`).textContent = '';
  }
  const s = await api('GET', '/api/settings/email');
  const form = $('#email-settings-form');
  for (const name of ['app_url', 'app_name', 'mail_from', 'smtp_host', 'smtp_port', 'smtp_user']) {
    // Show the value only if it was saved here; .env values show as the placeholder
    form.elements[name].value = s.sources[name] === 'settings' ? s[name] : '';
    if (s.sources[name] !== 'settings' && s[name]) form.elements[name].placeholder = s[name];
  }
  form.elements.smtp_secure.checked = s.smtp_secure;
  form.elements.smtp_pass.value = '';
  form.elements.smtp_pass.placeholder = s.password_set ? '•••••••• (saved, leave blank to keep)' : 'Not set';
  document.querySelectorAll('#email-settings-form [data-src]').forEach(el => {
    el.className = 'src';
    el.textContent = '';
    if (s.sources[el.dataset.src] === 'env') {
      el.textContent = 'from .env';
      el.classList.add('src-tag');
    }
  });
  if (!$('#email-test-to').value) $('#email-test-to').value = me.email;
}

$('#email-settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  showNotice('#email-settings-notice', '');
  $('#email-settings-error').textContent = '';
  const form = e.target;
  const body = Object.fromEntries(['app_url', 'app_name', 'mail_from', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass']
    .map(n => [n, form.elements[n].value]));
  body.smtp_secure = form.elements.smtp_secure.checked;
  // Keep .env values for fields left empty (shown as placeholders)
  try {
    const result = await api('PUT', '/api/settings/email', body);
    await loadEmailSettings();
    const c = result.connection;
    if (!c.configured) showNotice('#email-settings-notice', 'Saved. Email is not set up yet: emails will be printed in the server log until a server, username and password are entered.');
    else if (c.ok) showNotice('#email-settings-notice', `Saved. Connected to ${result.smtp_host} successfully.`);
    else $('#email-settings-error').textContent = `Saved, but the app could not connect to the mail server: ${c.error}`;
  } catch (err) {
    $('#email-settings-error').textContent = err.message;
  }
});

$('#email-test-send').addEventListener('click', async () => {
  showNotice('#email-test-notice', '');
  $('#email-test-error').textContent = '';
  $('#email-test-send').disabled = true;
  $('#email-test-send').textContent = 'Sending...';
  try {
    const { message } = await api('POST', '/api/settings/email/test', { to: $('#email-test-to').value });
    showNotice('#email-test-notice', message);
  } catch (err) {
    $('#email-test-error').textContent = err.message;
  } finally {
    $('#email-test-send').disabled = false;
    $('#email-test-send').textContent = 'Send test email';
  }
});

// ----- General settings: app title -----

function applyAppTitle(title) {
  document.querySelectorAll('[data-app-title]').forEach(el => (el.textContent = title));
  document.title = title;
  // The top bar icon (when set) stands in for the title, so it carries the title for screen readers and as a tooltip
  $('#header-icon').alt = title;
  $('#header-icon').title = title;
}

// Login page icon; iconVersion is null when no icon is set
const iconUrl = iconVersion => `/api/branding/icon?v=${encodeURIComponent(iconVersion)}`;
// Shows the icon on the login page and in the top bar; without an icon the top bar shows the title text
function applyIcon(iconVersion) {
  for (const img of [$('#login-icon'), $('#header-icon')]) {
    img.classList.toggle('hidden', !iconVersion);
    if (iconVersion) img.src = iconUrl(iconVersion);
    else img.removeAttribute('src');
  }
  $('#header-title').classList.toggle('hidden', !!iconVersion);
}

function renderIconSetting(iconVersion) {
  $('#icon-preview').innerHTML = iconVersion
    ? `<img src="${iconUrl(iconVersion)}" alt="Current icon">`
    : '<span class="muted">No icon</span>';
  $('#icon-remove').classList.toggle('hidden', !iconVersion);
}

async function saveIcon(icon, message) {
  showNotice('#icon-notice', '');
  $('#icon-error').textContent = '';
  try {
    const { icon_version } = await api('PUT', '/api/settings/general/icon', { icon });
    renderIconSetting(icon_version);
    applyIcon(icon_version);
    showNotice('#icon-notice', message);
  } catch (err) {
    $('#icon-error').textContent = err.message;
  }
}

$('#icon-file').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = ''; // allow choosing the same file again later
  if (!file) return;
  if (file.size > 500 * 1024) {
    $('#icon-error').textContent = 'The image is too large. Please use one under 500 KB.';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => saveIcon(reader.result, 'Icon updated. It now shows on the login page.');
  reader.readAsDataURL(file);
});

$('#icon-remove').addEventListener('click', () => {
  if (confirm('Remove the icon from the login page?')) saveIcon(null, 'Icon removed.');
});

async function loadGeneralSettings() {
  showNotice('#general-settings-notice', '');
  $('#general-settings-error').textContent = '';
  const s = await api('GET', '/api/settings/general');
  $('#general-settings-form').elements.app_title.value = s.app_title === s.default_app_title ? '' : s.app_title;
  showNotice('#icon-notice', '');
  $('#icon-error').textContent = '';
  renderIconSetting(s.icon_version);
}

$('#general-settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  showNotice('#general-settings-notice', '');
  $('#general-settings-error').textContent = '';
  try {
    const { app_title } = await api('PUT', '/api/settings/general', { app_title: e.target.elements.app_title.value });
    applyAppTitle(app_title);
    showNotice('#general-settings-notice', `Saved. The app is now called "${app_title}".`);
  } catch (err) {
    $('#general-settings-error').textContent = err.message;
  }
});

// The title is needed before login too, so load it straight away
fetch('/api/branding').then(r => r.json()).then(({ title, icon_version }) => {
  applyAppTitle(title);
  applyIcon(icon_version);
}).catch(() => {});

// ---------- footer ----------

$('#footer-year').textContent = new Date().getFullYear();
fetch('/api/version').then(r => r.json()).then(({ version }) => {
  $('#footer-version').textContent = `· v${version}`;
}).catch(() => {});

// ---------- routing & boot ----------

// Handles links from emails (#verify/..., #reset/..., #ticket/...) and the auth links (#login, #register, #forgot).
async function handleRoute() {
  const [route, param] = location.hash.slice(1).split('/');

  if (route === 'verify' && param) {
    clearHash();
    try {
      const { message } = await api('POST', '/api/verify-email', { token: param });
      if (me) navigate('tickets');
      else {
        showAuth('login');
        showNotice('#login-notice', message);
      }
    } catch (err) {
      if (me) navigate('tickets');
      else showMessage('Link not valid', err.message);
    }
    return;
  }

  if (route === 'reset' && param) {
    clearHash();
    resetToken = param;
    if (me) {
      // Resetting from a logged-in browser: log out first so the new password is used from a clean state
      await api('POST', '/api/logout');
      me = null;
    }
    showAuth('reset');
    return;
  }

  if (route === 'ticket' && param) {
    if (me) openTicket(param);
    else {
      pendingTicketId = param;
      showAuth('login');
      showNotice('#login-notice', 'Please log in to view this ticket.');
    }
    return;
  }

  if (!me && ['login', 'register', 'forgot'].includes(route)) {
    showNotice('#login-notice', '');
    showAuth(route);
  }
}

window.addEventListener('hashchange', handleRoute);

(async () => {
  try {
    me = await api('GET', '/api/me');
  } catch {
    me = null;
  }
  const hash = location.hash.slice(1).split('/')[0];
  if (me) {
    if (hash === 'ticket') pendingTicketId = location.hash.split('/')[1];
    await showApp();
    if (['verify', 'reset'].includes(hash)) handleRoute();
  } else if (hash) {
    await handleRoute();
    if (!document.querySelector('[data-auth-card].active')) showAuth('login');
  } else {
    showAuth('login');
  }
})();
