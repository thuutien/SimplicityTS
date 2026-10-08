// Request forms: each department can have its own form on the New ticket page.
// A form is a request type name (shown in the "Request Type" dropdown) and a list of fields:
//   { id, label, type: 'text' | 'select' | 'textarea', required, options: [...] (dropdowns only) }
// A submitted ticket keeps a copy of the questions and answers (tickets.form_data), so editing
// a form later never changes what older tickets show.

const crypto = require('crypto');

const FIELD_TYPES = { text: 'Small textbox', select: 'Dropdown', textarea: 'Text box' };
const MAX_FIELDS = 20;
const MAX_OPTIONS = 50;
const MAX_VALUE = { text: 100, select: 100, textarea: 5000 };

// The forms the two built-in departments started with (see db.js)
const DEFAULT_FORMS = {
  production: {
    title: 'Production Request',
    fields: [
      { id: 'location', label: 'Location', type: 'text', required: true },
      { id: 'request', label: 'Request', type: 'select', required: true, options: ['Work Cart', 'Empty Cart', 'RMA', 'Tech Issue'] },
      { id: 'info', label: 'Additional Info', type: 'textarea', required: false },
    ],
  },
  it: {
    title: 'Report Issue to IT',
    fields: [
      { id: 'location', label: 'Location', type: 'text', required: true },
      { id: 'issue', label: 'Issue Description', type: 'textarea', required: true },
    ],
  },
};

function parseFields(json) {
  try {
    const fields = JSON.parse(json || '[]');
    return Array.isArray(fields) ? fields : [];
  } catch {
    return [];
  }
}

// Checks a form sent from Settings. Returns { error } or { title, fields } cleaned up.
// title null = the department is not on the New ticket form.
function validateForm(body) {
  const enabled = !!body.enabled;
  const title = String(body.title || '').trim();
  if (enabled && !title) return { error: 'Please enter a request type name' };
  if (title.length > 50) return { error: 'Request type names can be at most 50 characters' };

  const input = Array.isArray(body.fields) ? body.fields : [];
  if (enabled && !input.length) return { error: 'Add at least one field to the form' };
  if (input.length > MAX_FIELDS) return { error: `A form can have at most ${MAX_FIELDS} fields` };

  const fields = [];
  const ids = new Set();
  const labels = new Set();
  for (const [i, f] of input.entries()) {
    const label = String(f?.label || '').trim();
    const where = `Field ${i + 1}`;
    if (!label) return { error: `${where}: please enter a label` };
    if (label.length > 60) return { error: `${where}: labels can be at most 60 characters` };
    if (labels.has(label.toLowerCase())) return { error: `Two fields are called "${label}". Please give each field its own label.` };
    labels.add(label.toLowerCase());
    if (!FIELD_TYPES[f.type]) return { error: `${where} ("${label}"): please choose a field type` };

    // Keep existing ids so the field stays the same field; new fields get a random one
    let id = /^[a-z0-9_-]{1,40}$/i.test(f.id || '') ? f.id : '';
    if (!id || ids.has(id)) id = 'f' + crypto.randomBytes(4).toString('hex');
    ids.add(id);

    const field = { id, label, type: f.type, required: !!f.required };
    if (f.type === 'select') {
      const options = [...new Set((Array.isArray(f.options) ? f.options : []).map(o => String(o).trim()).filter(Boolean))];
      if (!options.length) return { error: `${where} ("${label}"): add at least one choice to the dropdown` };
      if (options.length > MAX_OPTIONS) return { error: `${where} ("${label}"): a dropdown can have at most ${MAX_OPTIONS} choices` };
      if (options.some(o => o.length > 100)) return { error: `${where} ("${label}"): choices can be at most 100 characters` };
      field.options = options;
    }
    fields.push(field);
  }
  return { title: enabled ? title : null, fields };
}

// Checks a submitted New ticket form against the department's fields.
// Returns { error } or the ticket columns: title, description, location, request_item, form_data.
function readSubmission(department, values) {
  values = values && typeof values === 'object' ? values : {};
  const answers = [];
  for (const f of parseFields(department.form_fields)) {
    const value = String(values[f.id] ?? '').trim();
    if (f.required && !value) {
      return { error: f.type === 'select' ? `Please choose ${f.label}` : `Please fill in ${f.label}` };
    }
    if (value.length > MAX_VALUE[f.type]) return { error: `${f.label} can be at most ${MAX_VALUE[f.type]} characters` };
    if (f.type === 'select' && value && !f.options.includes(value)) return { error: `Please choose ${f.label}` };
    answers.push({ label: f.label, type: f.type, value });
  }
  if (!answers.some(a => a.value)) return { error: 'Please fill in the form' };

  // Columns used by the ticket list, the Dashboard and search:
  //   location     = the field called "Location" (Dashboard: Top locations)
  //   request_item = the first dropdown (Dashboard: Requests)
  //   description  = the text box(es)
  const filled = answers.filter(a => a.value);
  const location = filled.find(a => a.type === 'text' && a.label.toLowerCase() === 'location')?.value || null;
  const requestItem = filled.find(a => a.type === 'select')?.value || null;
  const boxes = filled.filter(a => a.type === 'textarea');
  const description = boxes.length === 1 ? boxes[0].value : boxes.map(a => `${a.label}:\n${a.value}`).join('\n\n');

  // Title: "<request> – <location>", e.g. "Work Cart – Line 3" or "Report Issue to IT – Front desk"
  const where = location || filled.find(a => a.type === 'text')?.value;
  const what = requestItem || department.form_title;
  const title = (where ? `${what} – ${where}` : what).slice(0, 200);

  return { title, description, location, request_item: requestItem, form_data: JSON.stringify(answers) };
}

// The answers of a ticket made with a form (null for older tickets)
function ticketAnswers(ticket) {
  if (!ticket?.form_data) return null;
  const answers = parseFields(ticket.form_data);
  return answers.length ? answers : null;
}

module.exports = { FIELD_TYPES, DEFAULT_FORMS, parseFields, validateForm, readSubmission, ticketAnswers };
