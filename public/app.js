/* ── NoCo AI CRM — Frontend ───────────────────────────────────────────────── */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  page: 1,
  limit: 50,
  sort: 'id',
  dir: 'asc',
  filters: {},
  total: 0,
  selected: new Set(),
  currentLead: null,
  saveTimer: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => (s == null ? '' : String(s));

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(e.error || r.statusText);
  }
  return r.json();
}

function notify(msg, ok = true) {
  const n = document.createElement('div');
  n.textContent = msg;
  n.style.cssText = `position:fixed;bottom:20px;right:20px;z-index:999;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:500;background:${ok ? '#22c55e' : '#ef4444'};color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.4);transition:opacity .4s`;
  document.body.appendChild(n);
  setTimeout(() => { n.style.opacity = '0'; setTimeout(() => n.remove(), 500); }, 2500);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function checkAuth() {
  const data = await api('GET', '/api/me');
  if (data.loggedIn) {
    showApp();
  } else {
    $('login-screen').classList.remove('hidden');
  }
}

function showApp() {
  $('login-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  init();
}

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('login-user').value;
  const password = $('login-pass').value;
  try {
    await api('POST', '/api/login', { username, password });
    showApp();
  } catch {
    $('login-error').classList.remove('hidden');
  }
});

$('logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  location.reload();
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => { t.classList.remove('active'); t.classList.add('hidden'); });
    tab.classList.add('active');
    const target = $('tab-' + tab.dataset.tab);
    target.classList.remove('hidden');
    target.classList.add('active');
    if (tab.dataset.tab === 'template') loadTemplate();
    if (tab.dataset.tab === 'logs') loadLogs();
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadFilterOptions();
  await loadStats();
  setupFilters();   // Bug 1 fix: attach listeners BEFORE first loadLeads()
  collectFilters(); // ensure state.filters is populated from current DOM values
  await loadLeads();
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
  const s = await api('GET', '/api/stats');
  $('s-total').textContent = s.total;
  $('s-pursuing').textContent = s.pursuing;
  $('s-maybe').textContent = s.maybe;
  $('s-hidden').textContent = s.hidden;
  $('s-untouched').textContent = s.untouched;
  $('s-emailed').textContent = s.emails_sent;
  $('s-has-email').textContent = s.has_email;
}

// ── Filter Options ────────────────────────────────────────────────────────────
async function loadFilterOptions() {
  const opts = await api('GET', '/api/filter-options');
  const cityEl = $('f-city');
  const segEl = $('f-segment');
  opts.cities.forEach(c => { const o = new Option(c, c); cityEl.appendChild(o); });
  opts.segments.forEach(s => { const o = new Option(s, s); segEl.appendChild(o); });
}

// ── Filters ───────────────────────────────────────────────────────────────────
let searchDebounce;
function setupFilters() {
  ['f-city','f-segment','f-status','f-rating','f-email','f-phone','f-website'].forEach(id => {
    $(id).addEventListener('change', () => { state.page = 1; collectFilters(); loadLeads(); });
  });
  $('search-box').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { state.page = 1; collectFilters(); loadLeads(); }, 350);
  });
  $('reset-filters').addEventListener('click', () => {
    ['f-city','f-segment','f-status','f-rating','f-email','f-phone','f-website'].forEach(id => $(id).value = '');
    $('search-box').value = '';
    state.filters = {};
    state.page = 1;
    loadLeads();
  });
  $('export-btn').addEventListener('click', exportCSV);

  // Bug 3: Hunter.io enrichment button
  $('enrich-btn').addEventListener('click', async () => {
    notify('Running Hunter.io enrichment…', true);
    try {
      const result = await api('POST', '/api/enrich', { limit: 100 });
      notify(`Enriched ${result.enriched} of ${result.checked} leads`, true);
      loadLeads(); loadStats();
    } catch (err) {
      notify('Enrichment failed: ' + err.message, false);
    }
  });
}

function collectFilters() {
  state.filters = {};
  const city = $('f-city').value; if (city) state.filters.city = city;
  const seg = $('f-segment').value; if (seg) state.filters.segment = seg;
  const status = $('f-status').value; if (status) state.filters.status = status;
  const rating = $('f-rating').value; if (rating) state.filters.min_rating = rating;
  const email = $('f-email').value; if (email) state.filters.has_email = email;
  const phone = $('f-phone').value; if (phone) state.filters.has_phone = phone;
  const website = $('f-website').value; if (website) state.filters.has_website = website;
  const search = $('search-box').value.trim(); if (search) state.filters.search = search;
}

function buildQuery(extra = {}) {
  const p = { page: state.page, limit: state.limit, sort: state.sort, dir: state.dir, ...state.filters, ...extra };
  return '?' + new URLSearchParams(p).toString();
}

// ── Leads Table ───────────────────────────────────────────────────────────────
async function loadLeads() {
  const data = await api('GET', '/api/leads' + buildQuery());
  state.total = data.total;
  renderTable(data.rows);
  renderPagination(data.total, data.page, data.limit);
  updateBulkBar();
  updateStickyOffset();
}

function renderTable(rows) {
  const tbody = $('leads-tbody');
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--text-dim)">No leads found</td></tr>';
    return;
  }
  rows.forEach(lead => {
    const tr = document.createElement('tr');
    tr.className = `status-${lead.status || 'untouched'}`;
    tr.dataset.id = lead.id;
    const checked = state.selected.has(lead.id) ? 'checked' : '';
    tr.innerHTML = `
      <td onclick="event.stopPropagation()"><input type="checkbox" class="row-check" data-id="${lead.id}" ${checked}></td>
      <td class="truncate">${esc(lead.business_name)}</td>
      <td>${esc(lead.segment)}</td>
      <td>${esc(lead.city)}</td>
      <td class="text-dim">${esc(lead.phone)}</td>
      <td>${lead.email ? `<span title="${esc(lead.email)}">✉</span>${lead.email_sent ? ' <span class="emailed-dot" title="Email sent"></span>' : ''}` : '<span class="text-dim">—</span>'}</td>
      <td>${lead.google_rating ? `<b>${lead.google_rating}</b>` : '<span class="text-dim">—</span>'}</td>
      <td class="text-dim">${lead.google_review_count || '—'}</td>
      <td><span class="badge badge-${lead.status || 'untouched'}">${lead.status || 'untouched'}</span></td>
      <td onclick="event.stopPropagation()">
        <div class="action-btns">
          <button class="btn btn-pursue btn-sm" data-action="pursue" data-id="${lead.id}">✓</button>
          <button class="btn btn-maybe btn-sm" data-action="maybe" data-id="${lead.id}">?</button>
          <button class="btn btn-hide btn-sm" data-action="hide" data-id="${lead.id}">✗</button>
        </div>
      </td>
    `;
    tr.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
      openDetail(lead.id);
    });
    tbody.appendChild(tr);
  });

  // Row checkboxes
  tbody.querySelectorAll('.row-check').forEach(cb => {
    cb.addEventListener('change', e => {
      const id = parseInt(e.target.dataset.id);
      if (e.target.checked) state.selected.add(id);
      else state.selected.delete(id);
      updateBulkBar();
      updateSelectAll();
    });
  });

  // Quick action buttons — toggle: clicking same status reverts to untouched
  tbody.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const row = btn.closest('tr');
      const currentBadge = row.querySelector('.badge');
      const currentStatus = currentBadge ? currentBadge.textContent.trim() : 'untouched';
      const newStatus = currentStatus === action ? 'untouched' : action;
      await api('PATCH', `/api/leads/${id}`, { status: newStatus });
      loadLeads(); loadStats();
    });
  });

  updateStickyOffset();
}

// Sortable columns
document.querySelectorAll('.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (state.sort === col) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else { state.sort = col; state.dir = 'asc'; }
    state.page = 1;
    loadLeads();
  });
});

// Select all
$('select-all').addEventListener('change', e => {
  const checks = document.querySelectorAll('.row-check');
  checks.forEach(cb => {
    cb.checked = e.target.checked;
    const id = parseInt(cb.dataset.id);
    if (e.target.checked) state.selected.add(id);
    else state.selected.delete(id);
  });
  updateBulkBar();
});

function updateSelectAll() {
  const checks = document.querySelectorAll('.row-check');
  const all = checks.length && [...checks].every(c => c.checked);
  $('select-all').checked = all;
  $('select-all').indeterminate = !all && state.selected.size > 0;
}

function updateBulkBar() {
  const bar = $('bulk-bar');
  if (state.selected.size > 0) {
    bar.style.display = 'flex';
    $('bulk-count').textContent = `${state.selected.size} selected`;
  } else {
    bar.style.display = 'none';
  }
}

// Bulk actions
$('bulk-apply').addEventListener('click', async () => {
  const status = $('bulk-status-sel').value;
  const ids = [...state.selected];
  if (!ids.length) return;
  await api('POST', '/api/leads/bulk-status', { ids, status });
  state.selected.clear();
  loadLeads(); loadStats();
  notify(`Updated ${ids.length} leads to ${status}`);
});

$('bulk-clear').addEventListener('click', () => {
  state.selected.clear();
  document.querySelectorAll('.row-check').forEach(cb => cb.checked = false);
  $('select-all').checked = false;
  updateBulkBar();
});

$('bulk-send').addEventListener('click', () => {
  const ids = [...state.selected].filter(Boolean);
  if (!ids.length) return;
  if (!confirm(`Send emails to up to ${Math.min(ids.length, 20)} selected leads? (Only leads with email addresses will receive mail)`)) return;
  startBatchSend(ids);
});

// ── Pagination ────────────────────────────────────────────────────────────────
function renderPagination(total, page, limit) {
  const el = $('pagination');
  el.innerHTML = '';
  const pages = Math.ceil(total / limit);
  if (pages <= 1) return;

  const info = document.createElement('span');
  info.className = 'page-info';
  info.textContent = `${total} leads · Page ${page} of ${pages}`;

  const prev = document.createElement('button');
  prev.className = 'page-btn';
  prev.textContent = '← Prev';
  prev.disabled = page === 1;
  prev.addEventListener('click', () => { state.page--; loadLeads(); });

  const next = document.createElement('button');
  next.className = 'page-btn';
  next.textContent = 'Next →';
  next.disabled = page === pages;
  next.addEventListener('click', () => { state.page++; loadLeads(); });

  // Page number buttons (show up to 7)
  const pageNums = document.createElement('div');
  pageNums.style.display = 'flex'; pageNums.style.gap = '4px';
  let start = Math.max(1, page - 3), end = Math.min(pages, start + 6);
  start = Math.max(1, end - 6);
  for (let i = start; i <= end; i++) {
    const pb = document.createElement('button');
    pb.className = 'page-btn' + (i === page ? ' active' : '');
    pb.textContent = i;
    const pg = i;
    pb.addEventListener('click', () => { state.page = pg; loadLeads(); });
    pageNums.appendChild(pb);
  }

  el.append(prev, pageNums, next, info);
}

// ── Export CSV ────────────────────────────────────────────────────────────────
function exportCSV() {
  const url = '/api/leads' + buildQuery({ export: '1' });
  const a = document.createElement('a');
  a.href = url; a.download = 'leads.csv'; a.click();
}

// ── Lead Detail Panel ─────────────────────────────────────────────────────────
async function openDetail(id) {
  const lead = await api('GET', `/api/leads/${id}`);
  state.currentLead = lead;
  renderDetail(lead);
  $('detail-overlay').classList.remove('hidden');
  $('detail-panel').classList.remove('hidden');
}

function closeDetail() {
  $('detail-overlay').classList.add('hidden');
  $('detail-panel').classList.add('hidden');
  state.currentLead = null;
}

$('detail-close').addEventListener('click', closeDetail);
$('detail-overlay').addEventListener('click', closeDetail);

function renderDetail(lead) {
  $('detail-title').textContent = lead.business_name || 'Lead Detail';
  const body = $('detail-body');
  body.innerHTML = `
    <div class="detail-status-row">
      <button class="btn btn-pursue btn-sm" onclick="quickStatus('pursue')">✓ Pursue</button>
      <button class="btn btn-maybe btn-sm" onclick="quickStatus('maybe')">? Maybe</button>
      <button class="btn btn-hide btn-sm" onclick="quickStatus('hide')">✗ Hide</button>
      <span id="detail-status-badge" class="badge badge-${lead.status || 'untouched'}">${lead.status || 'untouched'}</span>
    </div>
    <div class="detail-sep"></div>

    ${field('Business', lead.business_name)}
    ${field('Segment', lead.segment)}
    ${field('City', lead.city)}
    ${field('Address', lead.address)}
    ${field('Phone', lead.phone ? `<a href="tel:${lead.phone}">${lead.phone}</a>` : '—', true)}
    ${field('Email', lead.email ? `<a href="mailto:${lead.email}">${lead.email}</a>` : '—', true)}
    ${lead.contacts && lead.contacts !== '[]' && lead.contacts !== '' ? renderContacts(lead.contacts) : ''}
    ${field('Website', lead.website ? `<a href="${lead.website}" target="_blank" rel="noopener">${lead.website}</a>` : '—', true)}
    ${field('Yelp', lead.yelp_url ? `<a href="${lead.yelp_url}" target="_blank" rel="noopener">View →</a>` : '—', true)}
    ${field('Owner', lead.owner_name)}
    ${field('Google Rating', lead.google_rating ? `${lead.google_rating} ★ (${lead.google_review_count || 0} reviews)` : '—')}
    ${field('Yelp Rating', lead.yelp_rating ? `${lead.yelp_rating} ★ (${lead.yelp_review_count || 0} reviews)` : '—')}
    ${field('Years in Business', lead.years_in_business)}
    ${field('Source', lead.source)}

    <div class="detail-sep"></div>

    <div class="detail-field">
      <label>Notes</label>
      <textarea id="detail-notes" class="detail-textarea">${esc(lead.notes)}</textarea>
    </div>

    <div class="detail-field">
      <label>Last Contacted</label>
      <input type="date" id="detail-last-contacted" class="detail-input" value="${esc(lead.last_contacted)}">
    </div>
    <div class="detail-field">
      <label>Next Follow-up</label>
      <input type="date" id="detail-next-followup" class="detail-input" value="${esc(lead.next_followup)}">
    </div>

    <div class="detail-field">
      <label>
        <input type="checkbox" id="detail-email-sent" ${lead.email_sent ? 'checked' : ''}> Email Sent
      </label>
      <input type="date" id="detail-date-sent" class="detail-input" style="margin-top:6px" value="${esc(lead.date_sent)}" placeholder="Date sent">
    </div>

    <div class="detail-sep"></div>

    <div class="detail-actions">
      <button class="btn btn-primary" onclick="saveDetail()">💾 Save</button>
      <button class="btn btn-warning" onclick="sendEmailDetail()" ${!lead.email ? 'disabled title="No email address"' : ''}>📧 Send Email</button>
      <span id="detail-save-ok" class="detail-save-ok hidden">✓ Saved</span>
    </div>
  `;

  // Auto-save on notes change
  $('detail-notes').addEventListener('input', debounceSave);
}

function field(label, val, raw = false) {
  const v = raw ? (val || '—') : (esc(val) || '<span class="text-dim">—</span>');
  return `<div class="detail-field"><label>${label}</label><div class="val">${v}</div></div>`;
}

async function quickStatus(status) {
  const lead = state.currentLead;
  await api('PATCH', `/api/leads/${lead.id}`, { status });
  state.currentLead.status = status;
  $('detail-status-badge').className = `badge badge-${status}`;
  $('detail-status-badge').textContent = status;
  loadLeads(); loadStats();
}

window.quickStatus = quickStatus;

function debounceSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveDetail, 1500);
}

async function saveDetail() {
  const lead = state.currentLead;
  if (!lead) return;
  const payload = {
    notes: $('detail-notes').value,
    last_contacted: $('detail-last-contacted').value || null,
    next_followup: $('detail-next-followup').value || null,
    email_sent: $('detail-email-sent').checked ? 1 : 0,
    date_sent: $('detail-date-sent').value || null,
  };
  await api('PATCH', `/api/leads/${lead.id}`, payload);
  const ok = $('detail-save-ok');
  ok.classList.remove('hidden');
  setTimeout(() => ok.classList.add('hidden'), 2000);
  loadStats();
}

window.saveDetail = saveDetail;

async function sendEmailDetail() {
  const lead = state.currentLead;
  if (!lead || !lead.email) return;
  if (!confirm(`Send email to ${lead.email}?`)) return;
  try {
    await api('POST', `/api/send-email/${lead.id}`);
    notify('Email sent!');
    state.currentLead.email_sent = 1;
    $('detail-email-sent').checked = true;
    $('detail-date-sent').value = new Date().toISOString().slice(0, 10);
    loadStats();
  } catch (err) {
    notify('Send failed: ' + err.message, false);
  }
}

window.sendEmailDetail = sendEmailDetail;

// ── Batch Send ────────────────────────────────────────────────────────────────
async function startBatchSend(ids) {
  const modal = $('batch-modal');
  modal.classList.remove('hidden');
  $('batch-progress-text').textContent = `Sending to up to ${Math.min(ids.length, 20)} leads…`;
  $('batch-bar').style.width = '0%';
  $('batch-results').innerHTML = '';
  $('batch-close').classList.add('hidden');

  try {
    const result = await api('POST', '/api/send-batch', { ids });
    $('batch-bar').style.width = '100%';
    $('batch-progress-text').textContent = `Done. ${result.results.filter(r => r.status === 'sent').length} sent.`;
    $('batch-results').innerHTML = result.results.map(r =>
      `<div class="${r.status === 'sent' ? 'status-sent' : 'status-error'}">${r.status === 'sent' ? '✓' : '✗'} ${r.email || `ID ${r.id}`}: ${r.status}${r.reason ? ' ('+r.reason+')' : ''}${r.error ? ' — '+r.error : ''}</div>`
    ).join('');
    loadLeads(); loadStats();
  } catch (err) {
    $('batch-progress-text').textContent = 'Error: ' + err.message;
  }

  $('batch-close').classList.remove('hidden');
}

$('batch-close').addEventListener('click', () => {
  $('batch-modal').classList.add('hidden');
  state.selected.clear();
  updateBulkBar();
});

// ── Email Template ────────────────────────────────────────────────────────────
const SAMPLE = { 'First Name': 'John', 'Business Name': 'Acme Plumbing', City: 'Fort Collins', Segment: 'plumber' };

function applyMerge(text) {
  return text.replace(/\[(First Name|Business Name|City|Segment)\]/g, (_, k) => SAMPLE[k] || `[${k}]`);
}

async function loadTemplate() {
  const t = await api('GET', '/api/template');
  $('tmpl-subject').value = t.subject || '';
  $('tmpl-body').value = t.body || '';
  updatePreview();
}

function updatePreview() {
  $('preview-subject').textContent = applyMerge($('tmpl-subject').value);
  $('preview-body').textContent = applyMerge($('tmpl-body').value);
}

$('tmpl-subject').addEventListener('input', updatePreview);
$('tmpl-body').addEventListener('input', updatePreview);

$('tmpl-save').addEventListener('click', async () => {
  await api('POST', '/api/template', { subject: $('tmpl-subject').value, body: $('tmpl-body').value });
  const ok = $('tmpl-saved');
  ok.classList.remove('hidden');
  setTimeout(() => ok.classList.add('hidden'), 2000);
});

// ── Email Logs ────────────────────────────────────────────────────────────────
async function loadLogs() {
  const logs = await api('GET', '/api/email-logs');
  const tbody = $('logs-tbody');
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-dim)">No emails sent yet</td></tr>';
    return;
  }
  tbody.innerHTML = logs.map(l => `
    <tr>
      <td class="text-dim">${l.sent_at || ''}</td>
      <td>${esc(l.business_name || '')}</td>
      <td>${esc(l.recipient)}</td>
      <td class="truncate">${esc(l.subject)}</td>
      <td class="status-${l.status}">${l.status}</td>
      <td class="text-dim">${esc(l.error || '')}</td>
    </tr>
  `).join('');
}

$('refresh-logs').addEventListener('click', loadLogs);

// ── Sticky Header Offset (Bug 1) ──────────────────────────────────────────────
function updateStickyOffset() {
  const navbar = document.querySelector('.navbar');
  const statsBar = document.getElementById('stats-bar');
  const filtersBar = document.querySelector('.filters-bar');
  const bulkBar = document.getElementById('bulk-bar');

  let offset = 0;
  if (navbar) offset += navbar.offsetHeight;
  if (statsBar) offset += statsBar.offsetHeight;
  if (filtersBar) offset += filtersBar.offsetHeight;
  if (bulkBar && bulkBar.style.display !== 'none') offset += bulkBar.offsetHeight;

  document.querySelectorAll('.leads-table th').forEach(th => {
    th.style.top = offset + 'px';
  });
}

window.addEventListener('resize', updateStickyOffset);

// ── Hunter.io Contacts (Bug 3) ────────────────────────────────────────────────
function renderContacts(contactsJson) {
  try {
    const contacts = JSON.parse(contactsJson);
    if (!contacts.length) return '';
    return `<div class="detail-field">
      <label>Hunter.io Contacts</label>
      <div class="contacts-list">
        ${contacts.map(c => `<div class="contact-item">
          <div class="contact-info">
            <span class="contact-email">${esc(c.email)}</span>
            ${c.name ? `<span class="contact-name">${esc(c.name)}</span>` : ''}
            ${c.role ? `<span class="contact-role text-dim">${esc(c.role)}</span>` : ''}
          </div>
          <div class="contact-actions">
            <button class="btn btn-sm btn-ghost" onclick="copyEmail('${esc(c.email)}')">Copy</button>
            <button class="btn btn-sm btn-primary" onclick="sendToContact(${lead.id},'${esc(c.email)}','${esc(c.name)}')">📧 Send</button>
          </div>
        </div>`).join('')}
      </div>
    </div>`;
  } catch { return ''; }
}

function copyEmail(email) {
  navigator.clipboard.writeText(email).then(() => notify('Copied!'));
}
window.copyEmail = copyEmail;

async function sendToContact(leadId, email, name) {
  if (!confirm(`Send email to ${name || email}?`)) return;
  try {
    await api('POST', `/api/send-email-to/${leadId}`, { email, name });
    notify(`Sent to ${email}!`);
  } catch (err) {
    notify('Send failed: ' + err.message, false);
  }
}
window.sendToContact = sendToContact;

// ── Boot ──────────────────────────────────────────────────────────────────────
checkAuth();
