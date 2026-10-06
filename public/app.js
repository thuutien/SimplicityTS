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
    await api('POST', '/api/login', { email: form.get('email'), password: form.get('password') });
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
  departments = await api('GET', '/api/departments');
  document.querySelectorAll('.department-select').forEach(sel => {
    sel.querySelectorAll('option:not([value=""])').forEach(o => o.remove());
    sel.insertAdjacentHTML('beforeend', departments.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join(''));
  });
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

function renderMe() {
  $('#me-name').textContent = me.name;
  $('#me-role').textContent = label(me.role);
  $('#me-role').className = `badge ${me.role}`;
  $('#me-dept').textContent = me.department_name || '';
  $('#me-dept').classList.toggle('hidden', !me.department_name);
}

function navigate(page) {
  clearHash();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $(`#${page}-page`).classList.add('active');
  document.querySelectorAll('header nav button').forEach(b => b.classList.toggle('active', b.dataset.nav === page));
  if (page === 'tickets') loadTickets();
  if (page === 'users') loadUsers();
  if (page === 'account') loadAccount();
}

document.addEventListener('click', e => {
  const nav = e.target.closest('[data-nav]');
  if (nav) navigate(nav.dataset.nav);
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  showAuth('login');
});

// ---------- tickets ----------

let ticketState = 'open'; // Open / Closed buttons

// Local date as YYYY-MM-DD (for the date picker)
const localDateString = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// A Date as the database's UTC format "YYYY-MM-DD HH:MM:SS"
const toDbTime = d => d.toISOString().slice(0, 19).replace('T', ' ');

async function loadTickets() {
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
    <tr class="clickable" data-id="${t.id}">
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
        <label>Assigned to <select id="ctl-assignee"></select></label>
        <button id="ctl-save">Save changes</button>
        ${me.role === 'admin' ? '<button id="ctl-delete" class="danger">Delete ticket</button>' : ''}
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
      ${t.location ? `<div class="muted field-label">${t.request_item ? 'Additional info' : 'Issue description'}</div>` : ''}
      <div class="description">${esc(t.description)}</div>` : ''}
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
  if (t.can_work) {
    fillAssignees();
    $('#ctl-department').addEventListener('change', fillAssignees);
  }

  $('#ctl-save')?.addEventListener('click', () => updateTicket({
    status: $('#ctl-status').value,
    priority: $('#ctl-priority').value,
    ...($('#ctl-department').value ? { department_id: Number($('#ctl-department').value) } : {}),
    assigned_to: $('#ctl-assignee').value ? Number($('#ctl-assignee').value) : null,
  }));
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

async function loadUsers() {
  const users = await api('GET', '/api/users');
  usersById = Object.fromEntries(users.map(u => [u.id, u]));
  $('#user-rows').innerHTML = users.map(u => `
    <tr>
      <td>${esc(u.name)}${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}</td>
      <td>${esc(u.email)} ${u.verified ? '' : '<span class="badge unverified" title="Has not clicked the verification link yet">Unverified</span>'}</td>
      <td>${badge(u.role)}</td>
      <td>${u.role === 'agent' ? (esc(u.department_name) || '<span class="muted">None</span>') : '<span class="muted">-</span>'}</td>
      <td>${fmtDate(u.created_at)}</td>
      <td class="row-actions">
        <button class="secondary" data-edit-user="${u.id}">Edit</button>
        <button class="secondary" data-reset-user="${u.id}" title="Email this user a link to set a new password">Send reset link</button>
        ${u.id === me.id ? '' : `<button class="danger" data-delete-user="${u.id}">Delete</button>`}
      </td>
    </tr>`).join('');
  resetUserForm();
}

function resetUserForm() {
  const form = $('#user-form');
  form.reset();
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
