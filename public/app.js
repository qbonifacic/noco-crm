/* ── NoCo AI CRM — Frontend ───────────────────────────────────────────────── */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  page: 1,
  limit: 50,
  sort: 'google_rating',
  dir: 'desc',
  filters: {},
  total: 0,
  selected: new Set(),
  currentLead: null,
  companyLead: null,
  companyContacts: [],
  companyActivity: [],
  companyApiNotes: [],
  saveTimer: null,
  companySaveTimer: null,
  filtersBound: false,
  view: 'list', // 'list' | 'company'
  companyId: null,
};

const FILTER_IDS = [
  'f-city', 'f-segment', 'f-status', 'f-rating', 'f-email',
  'f-phone', 'f-website', 'f-contacts', 'f-min-client', 'f-min-target',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => (s == null ? '' : String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;'));

function hasValue(v) {
  return v != null && String(v).trim() !== '' && String(v).trim() !== '[]';
}

function scoreNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function websiteHref(url) {
  if (!url) return '';
  const s = String(url).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return 'https://' + s;
}

function websiteLabel(url) {
  if (!url) return '';
  try {
    let s = String(url).trim();
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    const u = new URL(s);
    return (u.hostname || '').replace(/^www\./, '') || s;
  } catch {
    return String(url).replace(/^https?:\/\//i, '').replace(/^www\./, '').split(/[/?#]/)[0];
  }
}

function fmtDate(v) {
  if (!v) return '—';
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function fmtDateTime(v) {
  if (!v) return '—';
  const s = String(v).replace('T', ' ');
  return s.length > 19 ? s.slice(0, 19) : s;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: r.statusText }));
    const err = new Error(e.error || r.statusText);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/** Soft fetch for optional Task 10 company APIs (404 → pending, no crash). */
async function apiOptional(method, url, body) {
  try {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    if (r.status === 404) return { _missing: true, status: 404 };
    if (!r.ok) return { _error: true, status: r.status };
    return await r.json();
  } catch {
    return { _error: true, status: 0 };
  }
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
  if (data.loggedIn) showApp();
  else $('login-screen').classList.remove('hidden');
}

function showApp() {
  $('login-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  init();
}

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('POST', '/api/login', {
      username: $('login-user').value,
      password: $('login-pass').value,
    });
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
    if (state.view === 'company') closeCompanyRecord();
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => {
      t.classList.remove('active');
      t.classList.add('hidden');
    });
    tab.classList.add('active');
    const target = $('tab-' + tab.dataset.tab);
    target.classList.remove('hidden');
    target.classList.add('active');
    if (tab.dataset.tab === 'template') loadTemplate();
    if (tab.dataset.tab === 'logs') loadLogs();
  });
});

// ── Hash routing (company record #/lead/:id) ──────────────────────────────────
function parseLeadHash() {
  const h = (location.hash || '').replace(/^#/, '');
  const m = h.match(/^\/?lead\/(\d+)\/?$/i);
  return m ? parseInt(m[1], 10) : null;
}

function setLeadHash(id) {
  const next = `#/lead/${id}`;
  if (location.hash !== next) location.hash = next;
  else openCompanyRecord(id);
}

function clearLeadHash() {
  if (parseLeadHash()) history.pushState(null, '', location.pathname + location.search);
}

async function handleRoute() {
  const id = parseLeadHash();
  if (id) await openCompanyRecord(id);
  else if (state.view === 'company') hideCompanyRecordUI();
}

window.addEventListener('hashchange', () => {
  handleRoute().catch(err => console.warn('route', err));
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  FILTER_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const searchEl = document.getElementById('search-box');
  if (searchEl) searchEl.value = '';
  if ($('f-include-merged')) $('f-include-merged').checked = false;
  if ($('f-include-hidden')) $('f-include-hidden').checked = false;
  state.filters = {};
  state.sort = 'google_rating';
  state.dir = 'desc';
  state.page = 1;
  if ($('f-phone')) $('f-phone').value = 'yes';

  await loadFilterOptions();
  setupFilters();
  collectFilters();
  await loadLeads();

  const deepId = parseLeadHash();
  if (deepId) await openCompanyRecord(deepId);

  const back = $('company-back');
  if (back && !back.dataset.bound) {
    back.dataset.bound = '1';
    back.addEventListener('click', () => closeCompanyRecord());
  }
  const quick = $('company-quick-drawer');
  if (quick && !quick.dataset.bound) {
    quick.dataset.bound = '1';
    quick.addEventListener('click', () => {
      if (state.companyId) openDetail(state.companyId);
    });
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const s = await api('GET', '/api/stats' + buildQuery());
    $('s-total').textContent = s.total;
    $('s-pursuing').textContent = s.pursuing;
    $('s-maybe').textContent = s.maybe;
    $('s-hidden').textContent = s.hidden;
    $('s-untouched').textContent = s.untouched;
    $('s-emailed').textContent = s.emails_sent;
    $('s-has-email').textContent = s.has_email;
    if ($('s-has-phone')) $('s-has-phone').textContent = s.has_phone != null ? s.has_phone : '—';
  } catch (err) {
    console.warn('stats load failed', err);
  }
}

// ── Filter Options ────────────────────────────────────────────────────────────
async function loadFilterOptions() {
  const opts = await api('GET', '/api/filter-options');
  const cityEl = $('f-city');
  const segEl = $('f-segment');
  while (cityEl.options.length > 1) cityEl.remove(1);
  while (segEl.options.length > 1) segEl.remove(1);
  opts.cities.forEach(c => { cityEl.appendChild(new Option(c, c)); });
  opts.segments.forEach(s => { segEl.appendChild(new Option(s, s)); });
}

// ── Filters ───────────────────────────────────────────────────────────────────
let searchDebounce;
function setupFilters() {
  if (state.filtersBound) return;
  state.filtersBound = true;

  FILTER_IDS.forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', () => { state.page = 1; collectFilters(); loadLeads(); });
  });
  ['f-include-merged', 'f-include-hidden'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', () => { state.page = 1; collectFilters(); loadLeads(); });
  });
  $('search-box').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { state.page = 1; collectFilters(); loadLeads(); }, 350);
  });
  $('reset-filters').addEventListener('click', () => {
    FILTER_IDS.forEach(id => { const el = $(id); if (el) el.value = ''; });
    $('search-box').value = '';
    if ($('f-include-merged')) $('f-include-merged').checked = false;
    if ($('f-include-hidden')) $('f-include-hidden').checked = false;
    state.filters = {};
    state.page = 1;
    state.sort = 'google_rating';
    state.dir = 'desc';
    loadLeads();
  });
  $('export-btn').addEventListener('click', exportCSV);

  const moreBtn = $('filters-more-btn');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      const panel = $('filters-more');
      if (!panel) return;
      panel.classList.toggle('hidden');
      moreBtn.textContent = panel.classList.contains('hidden') ? 'More ▾' : 'More ▴';
    });
  }

  document.querySelectorAll('.stat-click').forEach(el => {
    el.addEventListener('click', () => applyStatFilter(el.dataset.stat));
  });

  $('enrich-btn').addEventListener('click', async () => {
    if (!confirm(
      'Run Hunter.io enrichment on up to 25 leads with websites and no email?\n\n' +
      'This spends Hunter credits. Prefer after dedupe is clean.'
    )) return;
    notify('Running Hunter.io enrichment…', true);
    try {
      const result = await api('POST', '/api/enrich', { limit: 25 });
      notify(`Enriched ${result.enriched} of ${result.checked} leads`, true);
      loadLeads(); loadStats();
    } catch (err) {
      notify('Enrichment failed: ' + err.message, false);
    }
  });
}

function applyStatFilter(stat) {
  FILTER_IDS.forEach(id => { const el = $(id); if (el) el.value = ''; });
  if ($('f-include-merged')) $('f-include-merged').checked = false;
  if ($('f-include-hidden')) $('f-include-hidden').checked = false;
  $('search-box').value = '';
  if (stat === 'pursue' || stat === 'maybe' || stat === 'untouched' || stat === 'hide') {
    $('f-status').value = stat;
    if (stat === 'hide' && $('f-include-hidden')) $('f-include-hidden').checked = true;
  } else if (stat === 'has_email') {
    $('f-email').value = 'yes';
  } else if (stat === 'has_phone') {
    $('f-phone').value = 'yes';
  } else if (stat === 'emailed') {
    $('f-email').value = 'yes';
  }
  state.page = 1;
  collectFilters();
  loadLeads();
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
  const mc = $('f-contacts').value; if (mc) state.filters.min_contacts = mc;
  const minClient = $('f-min-client') ? $('f-min-client').value : '';
  if (minClient) state.filters.min_client = minClient;
  const minTarget = $('f-min-target') ? $('f-min-target').value : '';
  if (minTarget) state.filters.min_target = minTarget;
  if ($('f-include-merged') && $('f-include-merged').checked) state.filters.include_merged = '1';
  if ($('f-include-hidden') && $('f-include-hidden').checked) state.filters.include_hidden = '1';
  const search = $('search-box').value.trim(); if (search) state.filters.search = search;
}

function buildQuery(extra = {}) {
  const p = { page: state.page, limit: state.limit, sort: state.sort, dir: state.dir, ...state.filters, ...extra };
  return '?' + new URLSearchParams(p).toString();
}

// ── Leads Table ───────────────────────────────────────────────────────────────
async function loadLeads() {
  collectFilters();
  const data = await api('GET', '/api/leads' + buildQuery());
  state.total = data.total;
  renderTable(data.rows);
  renderPagination(data.total, data.page, data.limit);
  updateBulkBar();
  updateStickyOffset();
  const meta = $('view-meta');
  if (meta) {
    const page = data.page || state.page;
    const limit = data.limit || state.limit;
    const from = data.total ? (page - 1) * limit + 1 : 0;
    const to = Math.min(page * limit, data.total);
    meta.textContent = data.total
      ? `Viewing ${from}–${to} of ${data.total}`
      : 'No matching leads';
  }
  loadStats();
}

function scoreBadgesHtml(lead) {
  const client = scoreNum(lead.fit_client_score);
  const target = scoreNum(lead.fit_target_score);
  const parts = [];
  if (client) parts.push(`<span class="badge badge-score-client" title="Client fit">${client}</span>`);
  if (target) parts.push(`<span class="badge badge-score-target" title="Target fit">${target}</span>`);
  if (!parts.length) return '<span class="text-dim">—</span>';
  return `<div class="score-cell">${parts.join(' ')}</div>`;
}

function renderTable(rows) {
  const tbody = $('leads-tbody');
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:32px;color:var(--text-dim)">No leads found</td></tr>';
    return;
  }
  rows.forEach(lead => {
    const tr = document.createElement('tr');
    tr.className = `status-${lead.status || 'untouched'}`;
    tr.dataset.id = lead.id;
    tr.dataset.status = lead.status || 'untouched';
    const checked = state.selected.has(lead.id) ? 'checked' : '';

    const phoneCell = hasValue(lead.phone)
      ? `<a href="tel:${esc(lead.phone)}" onclick="event.stopPropagation()">${esc(lead.phone)}</a>`
      : '<span class="text-dim">—</span>';

    const href = websiteHref(lead.website);
    const websiteCell = href
      ? `<a class="truncate-sm" href="${esc(href)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${esc(lead.website)}">${esc(websiteLabel(lead.website))}</a>`
      : '<span class="text-dim">—</span>';

    tr.innerHTML = `
      <td onclick="event.stopPropagation()"><input type="checkbox" class="row-check" data-id="${lead.id}" ${checked}></td>
      <td class="truncate" title="${esc(lead.business_name)}">${esc(lead.business_name)}</td>
      <td>${esc(lead.segment)}</td>
      <td>${esc(lead.city)}</td>
      <td>${phoneCell}</td>
      <td>${websiteCell}</td>
      <td>${hasValue(lead.email) ? `<span title="${esc(lead.email)}">✉</span>${lead.email_sent ? ' <span class="emailed-dot" title="Email sent"></span>' : ''}` : '<span class="text-dim">—</span>'}</td>
      <td>${lead.contact_count > 0 ? `<span class="contact-badge" title="${lead.contact_count} contacts">👥 ${lead.contact_count}</span>` : '<span class="text-dim">—</span>'}</td>
      <td>${lead.google_rating ? `<b>${lead.google_rating}</b>` : '<span class="text-dim">—</span>'}</td>
      <td>${scoreBadgesHtml(lead)}</td>
      <td><span class="badge badge-${lead.status || 'untouched'}">${lead.status || 'untouched'}</span></td>
      <td onclick="event.stopPropagation()">
        <div class="action-btns">
          <button type="button" class="btn btn-ghost btn-sm" data-open-company="${lead.id}" title="Open company record">Open</button>
          <button class="btn btn-pursue btn-sm" data-action="pursue" data-id="${lead.id}">✓</button>
          <button class="btn btn-maybe btn-sm" data-action="maybe" data-id="${lead.id}">?</button>
          <button class="btn btn-hide btn-sm" data-action="hide" data-id="${lead.id}">✗</button>
        </div>
      </td>
    `;
    tr.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT' || e.target.tagName === 'A') return;
      setLeadHash(lead.id);
    });
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.row-check').forEach(cb => {
    cb.addEventListener('change', e => {
      const id = parseInt(e.target.dataset.id, 10);
      if (e.target.checked) state.selected.add(id);
      else state.selected.delete(id);
      updateBulkBar();
      updateSelectAll();
    });
  });

  tbody.querySelectorAll('[data-open-company]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      setLeadHash(parseInt(btn.dataset.openCompany, 10));
    });
  });

  tbody.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const row = btn.closest('tr');
      const currentStatus = row ? (row.dataset.status || 'untouched') : 'untouched';
      const newStatus = currentStatus === action ? 'untouched' : action;
      await api('PATCH', `/api/leads/${id}`, { status: newStatus });
      loadLeads(); loadStats();
    });
  });

  updateStickyOffset();
}

document.querySelectorAll('.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (state.sort === col) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else {
      state.sort = col;
      state.dir = (col === 'google_rating' || col === 'google_review_count') ? 'desc' : 'asc';
    }
    state.page = 1;
    loadLeads();
  });
});

$('select-all').addEventListener('change', e => {
  document.querySelectorAll('.row-check').forEach(cb => {
    cb.checked = e.target.checked;
    const id = parseInt(cb.dataset.id, 10);
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
  document.querySelectorAll('.row-check').forEach(cb => { cb.checked = false; });
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
  if (pages <= 1) {
    if (total > 0) {
      const info = document.createElement('span');
      info.className = 'page-info';
      info.textContent = `${total} leads`;
      el.appendChild(info);
    }
    return;
  }

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

  const pageNums = document.createElement('div');
  pageNums.style.display = 'flex';
  pageNums.style.gap = '4px';
  let start = Math.max(1, page - 3);
  let end = Math.min(pages, start + 6);
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

function exportCSV() {
  const a = document.createElement('a');
  a.href = '/api/leads' + buildQuery({ export: '1' });
  a.download = 'leads.csv';
  a.click();
}

// ── Company Record (Dynamics-style Account form) ──────────────────────────────
function showCompanyRecordUI() {
  state.view = 'company';
  const app = $('app');
  if (app) app.classList.add('company-mode');
  const rec = $('company-record');
  if (rec) rec.classList.remove('hidden');
}

function hideCompanyRecordUI() {
  state.view = 'list';
  state.companyId = null;
  state.companyLead = null;
  state.companyContacts = [];
  state.companyActivity = [];
  state.companyApiNotes = [];
  const app = $('app');
  if (app) app.classList.remove('company-mode');
  const rec = $('company-record');
  if (rec) rec.classList.add('hidden');
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === 'leads');
  });
  document.querySelectorAll('.tab-content').forEach(t => {
    const isLeads = t.id === 'tab-leads';
    t.classList.toggle('active', isLeads);
    t.classList.toggle('hidden', !isLeads);
  });
}

function closeCompanyRecord() {
  hideCompanyRecordUI();
  clearLeadHash();
}

async function openCompanyRecord(id) {
  showCompanyRecordUI();
  state.companyId = id;
  const body = $('company-body');
  if (body) body.innerHTML = '<div class="empty-state" style="padding:40px;text-align:center">Loading company record…</div>';

  const banner = $('company-api-banner');
  if (banner) {
    banner.classList.add('hidden');
    banner.textContent = '';
  }
  state.companyApiNotes = [];
  state.companyContacts = [];

  try {
    let lead = null;
    const companyRes = await apiOptional('GET', `/api/leads/${id}/company`);
    if (companyRes && !companyRes._missing && !companyRes._error) {
      lead = companyRes.lead || companyRes;
      if (Array.isArray(companyRes.contacts)) {
        state.companyContacts = normalizeContacts(companyRes.contacts);
      }
    } else {
      if (companyRes && companyRes._missing) state.companyApiNotes.push('GET /company pending');
      lead = await api('GET', `/api/leads/${id}`);
    }

    state.companyLead = lead;
    state.currentLead = lead;

    if (!state.companyContacts.length) {
      const cRes = await apiOptional('GET', `/api/leads/${id}/contacts`);
      if (cRes && !cRes._missing && !cRes._error && Array.isArray(cRes.rows)) {
        state.companyContacts = normalizeContacts(cRes.rows);
      } else {
        if (cRes && cRes._missing) state.companyApiNotes.push('GET /contacts pending');
        state.companyContacts = normalizeContacts(lead.contacts);
      }
    }

    state.companyActivity = [];
    const aRes = await apiOptional('GET', `/api/leads/${id}/activity?limit=50`);
    if (aRes && !aRes._missing && !aRes._error && Array.isArray(aRes.rows)) {
      state.companyActivity = aRes.rows;
    } else {
      if (aRes && aRes._missing) state.companyApiNotes.push('GET /activity pending');
      state.companyActivity = await loadActivityFallback(id, lead);
    }

    if (banner && state.companyApiNotes.length) {
      banner.textContent = 'API pending: ' + state.companyApiNotes.join(' · ');
      banner.classList.remove('hidden');
    }

    renderCompanyRecord(lead, state.companyContacts, state.companyActivity);
  } catch (err) {
    if (body) {
      body.innerHTML = `<div class="empty-state" style="padding:40px;text-align:center;color:var(--red)">Failed to load company: ${esc(err.message)}</div>`;
    }
  }
}

function normalizeContacts(raw) {
  let list = [];
  try {
    if (Array.isArray(raw)) list = raw;
    else if (hasValue(raw)) list = JSON.parse(raw);
  } catch {
    return [];
  }
  return list.map((c, i) => ({
    id: c.id != null ? c.id : null,
    lead_id: c.lead_id,
    name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '',
    email: c.email || '',
    role: c.role || c.position || c.title || '',
    is_primary: !!(c.is_primary || c.primary),
    last_emailed_at: c.last_emailed_at || c.last_emailed || null,
    last_email_status: c.last_email_status || c.email_status || null,
    _idx: i,
  })).filter(c => hasValue(c.email) || hasValue(c.name));
}

async function loadActivityFallback(leadId, lead) {
  const rows = [];
  try {
    const data = await api('GET', `/api/call-logs?lead_id=${leadId}&limit=25`);
    (data.rows || []).forEach(c => {
      rows.push({
        type: 'call',
        id: c.id,
        outcome: c.outcome,
        duration_seconds: c.duration_seconds,
        transcript: c.transcript,
        at: c.created_at,
      });
    });
  } catch { /* ignore */ }

  try {
    const logs = await api('GET', '/api/email-logs');
    const arr = Array.isArray(logs) ? logs : (logs.rows || []);
    arr.forEach(l => {
      const matchId = l.lead_id != null && Number(l.lead_id) === Number(leadId);
      const matchName = lead && lead.business_name && l.business_name === lead.business_name;
      if (matchId || matchName) {
        rows.push({
          type: 'email',
          id: l.id,
          contact_id: l.contact_id || null,
          recipient: l.recipient,
          subject: l.subject,
          status: l.status,
          error: l.error,
          at: l.sent_at || l.created_at,
        });
      }
    });
  } catch { /* ignore */ }

  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return rows.slice(0, 50);
}

function renderCompanyRecord(lead, contacts, activity) {
  const body = $('company-body');
  if (!body) return;

  const client = scoreNum(lead.fit_client_score);
  const target = scoreNum(lead.fit_target_score);
  const phone = hasValue(lead.phone)
    ? `<a href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a>`
    : '<span class="text-dim">—</span>';
  const email = hasValue(lead.email)
    ? `<a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a>`
    : '<span class="text-dim">—</span>';
  const web = hasValue(lead.website)
    ? `<a href="${esc(websiteHref(lead.website))}" target="_blank" rel="noopener">${esc(websiteLabel(lead.website))}</a>`
    : '<span class="text-dim">—</span>';

  body.innerHTML = `
    <div class="company-header">
      <div class="company-header-top">
        <div>
          <div class="company-title">${esc(lead.business_name || 'Company')}</div>
          <div class="company-subtitle">
            ${esc(lead.segment || '—')} · ${esc(lead.city || '—')}
            ${lead.google_rating ? ` · ${esc(lead.google_rating)}★ (${esc(lead.google_review_count || 0)} reviews)` : ''}
            ${client ? ` · <span class="badge badge-score-client">${client} client</span>` : ''}
            ${target ? ` <span class="badge badge-score-target">${target} target</span>` : ''}
          </div>
        </div>
        <div class="company-status-actions">
          <button type="button" class="btn btn-pursue btn-sm" data-co-status="pursue">✓ Pursue</button>
          <button type="button" class="btn btn-maybe btn-sm" data-co-status="maybe">? Maybe</button>
          <button type="button" class="btn btn-hide btn-sm" data-co-status="hide">✗ Hide</button>
          <button type="button" class="btn btn-ghost btn-sm" data-co-status="untouched">Clear</button>
          <span id="company-status-badge" class="badge badge-${lead.status || 'untouched'}">${esc(lead.status || 'untouched')}</span>
        </div>
      </div>
      <div class="company-meta-grid">
        <div class="company-meta-item"><label>Phone</label><div class="val">${phone}</div></div>
        <div class="company-meta-item"><label>Primary email</label><div class="val">${email}</div></div>
        <div class="company-meta-item"><label>Website</label><div class="val">${web}</div></div>
        <div class="company-meta-item"><label>Owner</label><div class="val">${hasValue(lead.owner_name) ? esc(lead.owner_name) : '—'}</div></div>
        <div class="company-meta-item"><label>Address</label><div class="val">${hasValue(lead.address) ? esc(lead.address) : '—'}</div></div>
        <div class="company-meta-item"><label>Source</label><div class="val">${hasValue(lead.source) ? esc(lead.source) : '—'}</div></div>
      </div>
    </div>

    ${researchBlockHtml(lead)}

    <div class="company-section">
      <div class="company-section-title">
        <span>Contacts</span>
        <span class="count">${contacts.length}</span>
      </div>
      ${renderContactsSubgrid(contacts, lead.id)}
      <div class="company-add-contact" id="company-add-contact">
        <label>Name<input type="text" id="co-add-name" placeholder="Name" autocomplete="off"></label>
        <label>Email<input type="email" id="co-add-email" placeholder="email@example.com" autocomplete="off"></label>
        <label>Role<input type="text" id="co-add-role" placeholder="Role" autocomplete="off"></label>
        <button type="button" class="btn btn-primary btn-sm" id="co-add-btn">+ Add contact</button>
      </div>
    </div>

    <div class="company-cols">
      <div class="company-section" style="margin-bottom:0">
        <div class="company-section-title">
          <span>Timeline</span>
          <span class="count">${activity.length}</span>
        </div>
        ${renderTimeline(activity)}
      </div>
      <div class="company-section" style="margin-bottom:0">
        <div class="company-section-title"><span>Notes &amp; follow-up</span></div>
        <div class="detail-field">
          <label>Notes</label>
          <textarea id="company-notes" class="detail-textarea">${esc(lead.notes)}</textarea>
        </div>
        <div class="company-notes-row">
          <div class="detail-field">
            <label>Last Contacted</label>
            <input type="date" id="company-last-contacted" class="detail-input" value="${esc(lead.last_contacted || '')}">
          </div>
          <div class="detail-field">
            <label>Next Follow-up</label>
            <input type="date" id="company-next-followup" class="detail-input" value="${esc(lead.next_followup || '')}">
          </div>
        </div>
        <div class="detail-field">
          <label>
            <input type="checkbox" id="company-email-sent" ${lead.email_sent ? 'checked' : ''}>
            Marked emailed (manual flag)
          </label>
          <input type="date" id="company-date-sent" class="detail-input" style="margin-top:6px" value="${esc(lead.date_sent || '')}">
        </div>
        <div class="detail-actions">
          <button type="button" class="btn btn-primary" id="company-save-btn">💾 Save</button>
          <button type="button" class="btn btn-warning" id="company-send-primary" ${!hasValue(lead.email) ? 'disabled title="No primary email"' : ''}>📧 Send to primary</button>
          <span id="company-save-ok" class="detail-save-ok hidden">✓ Saved</span>
        </div>

        <div class="detail-sep"></div>
        <div class="call-log-section" style="margin:0;background:var(--bg3)">
          <label>Log Call</label>
          <div class="call-log-form">
            <input id="co-call-duration" type="number" min="0" placeholder="min" value="5" title="Duration (minutes)">
            <select id="co-call-outcome" class="filter-select" style="width:auto">
              <option value="callback">callback</option>
              <option value="qualified">qualified</option>
              <option value="not_interested">not interested</option>
              <option value="no_answer">no answer</option>
              <option value="other">other</option>
            </select>
            <input id="co-call-transcript" type="text" placeholder="key points / transcript">
            <button type="button" class="btn btn-primary btn-sm" id="co-call-log-save">Save Call Log</button>
          </div>
        </div>
      </div>
    </div>
  `;

  body.querySelectorAll('[data-co-status]').forEach(btn => {
    btn.addEventListener('click', () => companyQuickStatus(btn.dataset.coStatus));
  });
  body.querySelectorAll('[data-copy-email]').forEach(btn => {
    btn.addEventListener('click', () => copyEmail(btn.dataset.copyEmail));
  });
  body.querySelectorAll('[data-send-email]').forEach(btn => {
    btn.addEventListener('click', () => {
      sendToContact(
        parseInt(btn.dataset.sendLead, 10),
        btn.dataset.sendEmail,
        btn.dataset.sendName || '',
        btn.dataset.sendContactId ? parseInt(btn.dataset.sendContactId, 10) : null
      );
    });
  });

  const notesEl = $('company-notes');
  if (notesEl) notesEl.addEventListener('input', debounceCompanySave);
  const saveBtn = $('company-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', saveCompanyDetail);
  const sendPrimary = $('company-send-primary');
  if (sendPrimary) sendPrimary.addEventListener('click', sendEmailCompanyPrimary);
  const addBtn = $('co-add-btn');
  if (addBtn) addBtn.addEventListener('click', addCompanyContact);
  const callBtn = $('co-call-log-save');
  if (callBtn) callBtn.addEventListener('click', saveCompanyCallLog);
}

function renderContactsSubgrid(contacts, leadId) {
  if (!contacts.length) {
    return '<div class="empty-state" style="padding:16px 4px">No contacts yet. Run enrich or add a contact below.</div>';
  }
  const rows = contacts.map(c => {
    const status = c.last_email_status ? String(c.last_email_status).toLowerCase() : '';
    let statusBadge = '<span class="badge badge-email-none">—</span>';
    if (status === 'sent' || status === 'ok' || status === 'success') {
      statusBadge = `<span class="badge badge-email-sent">${esc(status)}</span>`;
    } else if (status === 'error' || status === 'failed' || status === 'bounce') {
      statusBadge = `<span class="badge badge-email-error">${esc(status)}</span>`;
    } else if (status) {
      statusBadge = `<span class="badge badge-email-none">${esc(status)}</span>`;
    }
    const contactIdAttr = c.id != null ? ` data-send-contact-id="${esc(c.id)}"` : '';
    return `<tr>
      <td>${esc(c.name || '—')}${c.is_primary ? '<span class="badge badge-primary-contact">primary</span>' : ''}</td>
      <td>${esc(c.role || '—')}</td>
      <td class="email-cell">${hasValue(c.email) ? esc(c.email) : '—'}</td>
      <td>${fmtDate(c.last_emailed_at)}</td>
      <td>${statusBadge}</td>
      <td>
        <div class="contact-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-copy-email="${esc(c.email || '')}" ${!hasValue(c.email) ? 'disabled' : ''}>Copy</button>
          <button type="button" class="btn btn-sm btn-primary" data-send-lead="${leadId}" data-send-email="${esc(c.email || '')}" data-send-name="${esc(c.name || '')}"${contactIdAttr} ${!hasValue(c.email) ? 'disabled' : ''}>📧 Send</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `<div class="contacts-subgrid-wrap">
    <table class="contacts-subgrid">
      <thead>
        <tr>
          <th>Name</th>
          <th>Role</th>
          <th>Email</th>
          <th>Last emailed</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderTimeline(activity) {
  if (!activity || !activity.length) {
    const pending = state.companyApiNotes.some(n => /activity/i.test(n));
    if (pending) {
      return '<div class="empty-state" style="padding:12px 4px">No activity yet. Unified timeline API pending — showing empty until emails/calls are logged.</div>';
    }
    return '<div class="empty-state" style="padding:12px 4px">No email or call activity yet.</div>';
  }
  return `<div class="timeline-list">${activity.map(item => {
    const type = (item.type || '').toLowerCase() === 'call' ? 'call' : 'email';
    const icon = type === 'call' ? '📞' : '📧';
    if (type === 'call') {
      const mins = item.duration_seconds != null ? Math.round(Number(item.duration_seconds) / 60) : null;
      return `<div class="timeline-item">
        <div class="timeline-icon call">${icon}</div>
        <div class="timeline-main">
          <div class="timeline-row1">
            <span class="timeline-type">Call</span>
            <span class="timeline-at">${esc(fmtDateTime(item.at))}</span>
            ${item.outcome ? `<span class="badge badge-untouched">${esc(item.outcome)}</span>` : ''}
          </div>
          <div class="timeline-subject">${mins != null ? `${mins} min` : ''}${item.transcript ? (mins != null ? ' · ' : '') + esc(String(item.transcript).slice(0, 200)) : (mins == null ? '—' : '')}</div>
        </div>
      </div>`;
    }
    const st = item.status ? String(item.status).toLowerCase() : '';
    let stBadge = '';
    if (st === 'sent' || st === 'ok') stBadge = `<span class="badge badge-email-sent">${esc(st)}</span>`;
    else if (st === 'error' || st === 'failed') stBadge = `<span class="badge badge-email-error">${esc(st)}</span>`;
    else if (st) stBadge = `<span class="badge badge-email-none">${esc(st)}</span>`;
    return `<div class="timeline-item">
      <div class="timeline-icon email">${icon}</div>
      <div class="timeline-main">
        <div class="timeline-row1">
          <span class="timeline-type">Email</span>
          <span class="timeline-at">${esc(fmtDateTime(item.at))}</span>
          ${stBadge}
        </div>
        <div class="timeline-subject">${esc(item.subject || '(no subject)')}</div>
        <div class="timeline-meta">To: ${esc(item.recipient || '—')}${item.error ? ' · ' + esc(item.error) : ''}</div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

async function companyQuickStatus(status) {
  const lead = state.companyLead;
  if (!lead) return;
  await api('PATCH', `/api/leads/${lead.id}`, { status });
  state.companyLead.status = status;
  if (state.currentLead && state.currentLead.id === lead.id) state.currentLead.status = status;
  const badge = $('company-status-badge');
  if (badge) {
    badge.className = `badge badge-${status}`;
    badge.textContent = status;
  }
  loadLeads(); loadStats();
  notify(`Status → ${status}`);
}

function debounceCompanySave() {
  clearTimeout(state.companySaveTimer);
  state.companySaveTimer = setTimeout(saveCompanyDetail, 1500);
}

async function saveCompanyDetail() {
  const lead = state.companyLead;
  if (!lead) return;
  const notesEl = $('company-notes');
  if (!notesEl) return;
  const payload = {
    notes: notesEl.value,
    last_contacted: ($('company-last-contacted') && $('company-last-contacted').value) || null,
    next_followup: ($('company-next-followup') && $('company-next-followup').value) || null,
    email_sent: ($('company-email-sent') && $('company-email-sent').checked) ? 1 : 0,
    date_sent: ($('company-date-sent') && $('company-date-sent').value) || null,
  };
  try {
    await api('PATCH', `/api/leads/${lead.id}`, payload);
    Object.assign(lead, payload);
    const ok = $('company-save-ok');
    if (ok) {
      ok.classList.remove('hidden');
      setTimeout(() => ok.classList.add('hidden'), 2000);
    }
    loadStats();
  } catch (err) {
    notify('Save failed: ' + err.message, false);
  }
}

async function sendEmailCompanyPrimary() {
  const lead = state.companyLead;
  if (!lead || !hasValue(lead.email)) return;
  if (!confirm(`Send email to primary ${lead.email}?`)) return;
  try {
    await api('POST', `/api/send-email/${lead.id}`);
    notify('Email sent!');
    lead.email_sent = 1;
    if ($('company-email-sent')) $('company-email-sent').checked = true;
    if ($('company-date-sent')) $('company-date-sent').value = new Date().toISOString().slice(0, 10);
    loadStats();
    openCompanyRecord(lead.id);
  } catch (err) {
    notify('Send failed: ' + err.message, false);
  }
}

async function addCompanyContact() {
  const lead = state.companyLead;
  if (!lead) return;
  const name = ($('co-add-name') && $('co-add-name').value.trim()) || '';
  const email = ($('co-add-email') && $('co-add-email').value.trim()) || '';
  const role = ($('co-add-role') && $('co-add-role').value.trim()) || '';
  if (!email && !name) {
    notify('Enter at least a name or email', false);
    return;
  }
  try {
    await api('POST', `/api/leads/${lead.id}/contacts`, { name, email, role });
    notify('Contact added');
    openCompanyRecord(lead.id);
  } catch (err) {
    if (err.status === 404) notify('Add-contact API pending — use enrich for now', false);
    else notify('Add contact failed: ' + err.message, false);
  }
}

async function saveCompanyCallLog() {
  const lead = state.companyLead;
  if (!lead) return;
  const duration = parseInt(($('co-call-duration') && $('co-call-duration').value) || '0', 10) || 0;
  const outcome = ($('co-call-outcome') && $('co-call-outcome').value) || '';
  const transcript = ($('co-call-transcript') && $('co-call-transcript').value) || '';
  try {
    await api('POST', `/api/leads/${lead.id}/log-call`, {
      duration_seconds: duration * 60,
      transcript,
      outcome,
      source: 'manual',
    });
    notify('Call logged');
    openCompanyRecord(lead.id);
    loadLeads(); loadStats();
  } catch (err) {
    notify('Log call failed: ' + err.message, false);
  }
}

// ── Lead Detail Panel (quick triage) ──────────────────────────────────────────
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
  if (state.view !== 'company') state.currentLead = null;
}

$('detail-close').addEventListener('click', closeDetail);
$('detail-overlay').addEventListener('click', closeDetail);

function researchBlockHtml(lead) {
  if (!hasValue(lead.research_summary)) return '';
  const rec = hasValue(lead.recommended_action)
    ? `<div class="research-rec">Recommended: <b>${esc(lead.recommended_action)}</b></div>`
    : '';
  return `<details class="research-block" open>
    <summary>Research summary</summary>
    <div class="research-body">${esc(lead.research_summary)}</div>
    ${rec}
  </details>`;
}

function contactBlockHtml(lead) {
  const phone = hasValue(lead.phone)
    ? `<a href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a>`
    : '<span class="empty-state">No phone</span>';
  const email = hasValue(lead.email)
    ? `<a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a>`
    : '<span class="empty-state">No email</span>';
  const website = hasValue(lead.website)
    ? `<a href="${esc(websiteHref(lead.website))}" target="_blank" rel="noopener">${esc(lead.website)}</a>`
    : '<span class="empty-state">No website</span>';
  const owner = hasValue(lead.owner_name) ? esc(lead.owner_name) : '<span class="empty-state">No owner</span>';

  return `<div class="contact-block">
    <label>Contact</label>
    <div class="contact-primary">
      <div class="contact-primary-row"><span class="ckey">Phone</span><span>${phone}</span></div>
      <div class="contact-primary-row"><span class="ckey">Email</span><span>${email}</span></div>
      <div class="contact-primary-row"><span class="ckey">Web</span><span>${website}</span></div>
      <div class="contact-primary-row"><span class="ckey">Owner</span><span>${owner}</span></div>
    </div>
    ${renderContacts(lead.contacts, lead.id)}
    <div style="margin-top:10px">
      <button type="button" class="btn btn-primary btn-sm" id="detail-open-company">Open full company record →</button>
    </div>
  </div>`;
}

function renderDetail(lead) {
  $('detail-title').textContent = lead.business_name || 'Lead Detail';
  const body = $('detail-body');
  const client = scoreNum(lead.fit_client_score);
  const target = scoreNum(lead.fit_target_score);
  const clientBadge = client ? `<span class="badge badge-score-client">${client}</span>` : '';
  const targetBadge = target ? `<span class="badge badge-score-target">${target}</span>` : '';

  body.innerHTML = `
    <div class="detail-status-row">
      <button class="btn btn-pursue btn-sm" data-qstatus="pursue">✓ Pursue</button>
      <button class="btn btn-maybe btn-sm" data-qstatus="maybe">? Maybe</button>
      <button class="btn btn-hide btn-sm" data-qstatus="hide">✗ Hide</button>
      <span id="detail-status-badge" class="badge badge-${lead.status || 'untouched'}">${lead.status || 'untouched'}</span>
      <span style="margin-left:8px">${clientBadge} ${targetBadge}</span>
    </div>
    <div class="detail-sep"></div>
    ${researchBlockHtml(lead)}
    ${contactBlockHtml(lead)}
    ${field('Business', lead.business_name)}
    ${field('Segment', lead.segment)}
    ${field('City', lead.city)}
    ${field('Address', lead.address)}
    ${field('Google Rating', lead.google_rating ? `${lead.google_rating} ★ (${lead.google_review_count || 0} reviews)` : '—')}
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
        <input type="checkbox" id="detail-email-sent" ${lead.email_sent ? 'checked' : ''}>
        Marked emailed (manual flag)
      </label>
      <input type="date" id="detail-date-sent" class="detail-input" style="margin-top:6px" value="${esc(lead.date_sent)}">
    </div>
    <div class="detail-sep"></div>
    <div id="log-call" class="call-log-section">
      <label>Log Call</label>
      <div class="call-log-form">
        <input id="call-duration" type="number" min="0" placeholder="min" value="5">
        <select id="call-outcome" class="filter-select" style="width:auto">
          <option value="callback">callback</option>
          <option value="qualified">qualified</option>
          <option value="not_interested">not interested</option>
          <option value="no_answer">no answer</option>
          <option value="other">other</option>
        </select>
        <input id="call-transcript" type="text" placeholder="key points / transcript">
        <button type="button" class="btn btn-primary btn-sm" id="call-log-save-btn">Save Call Log</button>
      </div>
      <div id="call-history" class="call-history">
        <label>Call History</label>
        <div id="call-history-list" class="call-history-list">Loading…</div>
      </div>
    </div>
    <div class="detail-sep"></div>
    <div class="detail-actions">
      <button class="btn btn-primary" id="detail-save-btn">💾 Save</button>
      <button class="btn btn-warning" id="detail-send-btn" ${!hasValue(lead.email) ? 'disabled title="No email address"' : ''}>📧 Send Email</button>
      <span id="detail-save-ok" class="detail-save-ok hidden">✓ Saved</span>
    </div>
  `;

  body.querySelectorAll('[data-qstatus]').forEach(btn => {
    btn.addEventListener('click', () => quickStatus(btn.dataset.qstatus));
  });
  $('detail-notes').addEventListener('input', debounceSave);
  $('detail-save-btn').addEventListener('click', saveDetail);
  $('detail-send-btn').addEventListener('click', sendEmailDetail);
  const callSave = $('call-log-save-btn');
  if (callSave) callSave.addEventListener('click', saveCallLog);
  body.querySelectorAll('[data-copy-email]').forEach(btn => {
    btn.addEventListener('click', () => copyEmail(btn.dataset.copyEmail));
  });
  body.querySelectorAll('[data-send-email]').forEach(btn => {
    btn.addEventListener('click', () => {
      sendToContact(
        parseInt(btn.dataset.sendLead, 10),
        btn.dataset.sendEmail,
        btn.dataset.sendName || '',
        btn.dataset.sendContactId ? parseInt(btn.dataset.sendContactId, 10) : null
      );
    });
  });
  const openCo = $('detail-open-company');
  if (openCo) {
    openCo.addEventListener('click', () => {
      closeDetail();
      setLeadHash(lead.id);
    });
  }
  loadCallHistory(lead.id);
}

async function loadCallHistory(leadId) {
  try {
    const data = await api('GET', `/api/call-logs?lead_id=${leadId}&limit=10`);
    const el = $('call-history-list');
    if (!el) return;
    if (!data.rows || !data.rows.length) {
      el.innerHTML = '<span class="empty-state">No calls logged yet.</span>';
      return;
    }
    el.innerHTML = data.rows.map(c => {
      const d = c.created_at ? String(c.created_at).slice(0, 10) : '';
      const mins = Math.round((c.duration_seconds || 0) / 60);
      return `<div class="call-history-item">📞 ${esc(d)} ${mins}min [${esc(c.outcome || '')}] ${esc((c.transcript || '').slice(0, 120))}</div>`;
    }).join('');
  } catch {
    const el = $('call-history-list');
    if (el) el.innerHTML = '<span class="empty-state">History unavailable.</span>';
  }
}

async function saveCallLog() {
  const lead = state.currentLead;
  if (!lead) return;
  const duration = parseInt(($('call-duration') && $('call-duration').value) || '0', 10) || 0;
  const outcome = ($('call-outcome') && $('call-outcome').value) || '';
  const transcript = ($('call-transcript') && $('call-transcript').value) || '';
  try {
    await api('POST', `/api/leads/${lead.id}/log-call`, {
      duration_seconds: duration * 60,
      transcript,
      outcome,
      source: 'manual',
    });
    notify('Call logged');
    const fresh = await api('GET', `/api/leads/${lead.id}`);
    state.currentLead = fresh;
    renderDetail(fresh);
    loadLeads(); loadStats();
  } catch (err) {
    notify('Log call failed: ' + err.message, false);
  }
}

function field(label, val, raw = false) {
  const v = raw ? (val || '—') : (esc(val) || '<span class="text-dim">—</span>');
  return `<div class="detail-field"><label>${label}</label><div class="val">${v}</div></div>`;
}

async function quickStatus(status) {
  const lead = state.currentLead;
  if (!lead) return;
  await api('PATCH', `/api/leads/${lead.id}`, { status });
  state.currentLead.status = status;
  const badge = $('detail-status-badge');
  if (badge) {
    badge.className = `badge badge-${status}`;
    badge.textContent = status;
  }
  loadLeads(); loadStats();
}

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

async function sendEmailDetail() {
  const lead = state.currentLead;
  if (!lead || !hasValue(lead.email)) return;
  if (!confirm(`Send email to ${lead.email}?`)) return;
  try {
    await api('POST', `/api/send-email/${lead.id}`);
    notify('Email sent!');
    state.currentLead.email_sent = 1;
    if ($('detail-email-sent')) $('detail-email-sent').checked = true;
    if ($('detail-date-sent')) $('detail-date-sent').value = new Date().toISOString().slice(0, 10);
    loadStats();
  } catch (err) {
    notify('Send failed: ' + err.message, false);
  }
}

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
      `<div class="${r.status === 'sent' ? 'status-sent' : 'status-error'}">${r.status === 'sent' ? '✓' : '✗'} ${esc(r.email || `ID ${r.id}`)}: ${esc(r.status)}${r.reason ? ' (' + esc(r.reason) + ')' : ''}${r.error ? ' — ' + esc(r.error) : ''}</div>`
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
      <td class="text-dim">${esc(l.sent_at || '')}</td>
      <td>${esc(l.business_name || '')}</td>
      <td>${esc(l.recipient)}</td>
      <td class="truncate">${esc(l.subject)}</td>
      <td class="status-${esc(l.status)}">${esc(l.status)}</td>
      <td class="text-dim">${esc(l.error || '')}</td>
    </tr>
  `).join('');
}

$('refresh-logs').addEventListener('click', loadLogs);

function updateStickyOffset() { /* CSS sticky */ }
window.addEventListener('resize', updateStickyOffset);

// ── Contacts (drawer list) ────────────────────────────────────────────────────
function renderContacts(contactsRaw, leadId) {
  let contacts = [];
  try {
    if (Array.isArray(contactsRaw)) contacts = contactsRaw;
    else if (hasValue(contactsRaw)) contacts = JSON.parse(contactsRaw);
  } catch {
    return '<div class="empty-state">Contacts data unreadable</div>';
  }
  if (!contacts.length) {
    return '<div class="empty-state">No Hunter contacts yet — open full company record for subgrid</div>';
  }
  return `<div class="detail-field" style="margin:0">
    <label>Hunter.io Contacts (${contacts.length})</label>
    <div class="contacts-list">
      ${contacts.map(c => {
        const email = c.email || '';
        const name = c.name || '';
        const role = c.role || c.position || '';
        const cid = c.id != null ? ` data-send-contact-id="${esc(c.id)}"` : '';
        return `<div class="contact-item">
          <div class="contact-info">
            <span class="contact-email">${esc(email)}</span>
            ${name ? `<span class="contact-name">${esc(name)}</span>` : ''}
            ${role ? `<span class="contact-role text-dim">${esc(role)}</span>` : ''}
          </div>
          <div class="contact-actions">
            <button type="button" class="btn btn-sm btn-ghost" data-copy-email="${esc(email)}">Copy</button>
            <button type="button" class="btn btn-sm btn-primary" data-send-lead="${leadId}" data-send-email="${esc(email)}" data-send-name="${esc(name)}"${cid}>📧 Send</button>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function copyEmail(email) {
  if (!email) return;
  navigator.clipboard.writeText(email).then(() => notify('Copied!')).catch(() => notify('Copy failed', false));
}

async function sendToContact(leadId, email, name, contactId) {
  if (!email) return;
  if (!confirm(`Send email to ${name || email}?`)) return;
  try {
    const body = { email, name };
    if (contactId != null && !Number.isNaN(contactId)) body.contact_id = contactId;
    await api('POST', `/api/send-email-to/${leadId}`, body);
    notify(`Sent to ${email}!`);
    if (state.view === 'company' && state.companyId === leadId) openCompanyRecord(leadId);
  } catch (err) {
    notify('Send failed: ' + err.message, false);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
checkAuth();
