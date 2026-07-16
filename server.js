'use strict';

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ── DB Pool ───────────────────────────────────────────────────────────────────
// Always prefer DATABASE_URL from environment (set on Mac Mini prod and local dev).
// The fallback default below is a placeholder ONLY for local dev convenience when .env is absent.
// It contains NO real credentials. Never rely on it in prod, shared envs, or commits.
// Populate .env (or launchd EnvironmentVariables on Mini) with the real string before any real use.
const pool = new Pool({
  // No password in fallback — set DATABASE_URL for any real use.
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/noco_crm',
  ssl: false
});

// ── Helper wrappers (raw pg with ? → $n conversion for compatibility) ─────────
async function dbGet(sql, ...params) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

async function dbAll(sql, ...params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function dbRun(sql, ...params) {
  return pool.query(sql, params);
}

function toPostgres(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function pgGet(sql, ...params) {
  return dbGet(toPostgres(sql), ...params);
}

async function pgAll(sql, ...params) {
  return dbAll(toPostgres(sql), ...params);
}

async function pgRun(sql, ...params) {
  return pool.query(toPostgres(sql), params);
}

// ── Schema (idempotent create + alter for existing DBs) ───────────────────────
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      business_name TEXT DEFAULT '',
      segment TEXT DEFAULT '',
      city TEXT DEFAULT '',
      address TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      website TEXT DEFAULT '',
      yelp_url TEXT DEFAULT '',
      yelp_rating REAL,
      yelp_review_count INTEGER,
      google_rating REAL,
      google_review_count INTEGER,
      years_in_business TEXT DEFAULT '',
      owner_name TEXT DEFAULT '',
      email TEXT DEFAULT '',
      social_media TEXT DEFAULT '',
      source TEXT DEFAULT '',
      status TEXT DEFAULT 'untouched',
      notes TEXT DEFAULT '',
      email_sent INTEGER DEFAULT 0,
      date_sent TEXT DEFAULT '',
      last_contacted TEXT DEFAULT '',
      next_followup TEXT DEFAULT '',
      contacts TEXT DEFAULT '',
      fit_client_score INTEGER DEFAULT 0,
      fit_target_score INTEGER DEFAULT 0,
      research_summary TEXT DEFAULT '',
      phone_source TEXT DEFAULT '',
      phone_confidence REAL DEFAULT 0,
      website_confidence REAL DEFAULT 0,
      last_enriched_at TIMESTAMP,
      tags JSONB DEFAULT '[]'::jsonb,
      dedupe_key TEXT,
      merged_into_id INTEGER,
      is_canonical BOOLEAN DEFAULT TRUE,
      website_domain TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS email_logs (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER,
      recipient TEXT,
      subject TEXT,
      status TEXT,
      sent_at TIMESTAMP DEFAULT NOW(),
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS call_logs (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER,
      direction TEXT,
      duration_seconds INTEGER,
      transcript TEXT,
      summary TEXT,
      outcome TEXT,
      source TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS email_template (
      id INTEGER PRIMARY KEY DEFAULT 1,
      subject TEXT,
      body TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS enrichment_runs (
      id SERIAL PRIMARY KEY,
      run_type TEXT,
      leads_checked INTEGER,
      leads_updated INTEGER,
      cost_cents_estimate INTEGER,
      started_at TIMESTAMP DEFAULT NOW(),
      finished_at TIMESTAMP
    );
  `);

  // Upgrade path: existing Mini/main DBs created before Phase 0 need columns added.
  // CREATE TABLE IF NOT EXISTS does not alter already-present tables.
  const leadAlters = [
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT ''",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS website TEXT DEFAULT ''",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS contacts TEXT DEFAULT ''",
    'ALTER TABLE leads ADD COLUMN IF NOT EXISTS fit_client_score INTEGER DEFAULT 0',
    'ALTER TABLE leads ADD COLUMN IF NOT EXISTS fit_target_score INTEGER DEFAULT 0',
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS research_summary TEXT DEFAULT ''",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_source TEXT DEFAULT ''",
    'ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_confidence REAL DEFAULT 0',
    'ALTER TABLE leads ADD COLUMN IF NOT EXISTS website_confidence REAL DEFAULT 0',
    'ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMP',
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb",
    'ALTER TABLE leads ADD COLUMN IF NOT EXISTS dedupe_key TEXT',
    'ALTER TABLE leads ADD COLUMN IF NOT EXISTS merged_into_id INTEGER',
    'ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_canonical BOOLEAN DEFAULT TRUE',
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS website_domain TEXT DEFAULT ''"
  ];
  for (const sql of leadAlters) {
    await pool.query(sql);
  }
  // Soft-merge helpers (Phase A dedupe) — non-unique index for lookups
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_leads_merged_into ON leads (merged_into_id) WHERE merged_into_id IS NOT NULL'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_leads_website_domain ON leads (website_domain) WHERE website_domain IS NOT NULL AND website_domain <> \'\''
  );

  // ── Contacts (Account→Contact; dual-read with leads.contacts JSON) ─────────
  // Soft-link only: contacts.lead_id → leads; no hard deletes of leads.
  // Empty emails skipped for uniqueness (partial unique index).
  // NOTE: Schema also owned by Task 09 (feature/contacts-schema). Idempotent here so
  // company API works if 09 is not yet merged; migrate-contacts.js remains Task 09.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      name TEXT DEFAULT '',
      email TEXT DEFAULT '',
      role TEXT DEFAULT '',
      is_primary BOOLEAN DEFAULT FALSE,
      source TEXT DEFAULT 'hunter',
      last_emailed_at TIMESTAMP,
      last_email_status TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_contacts_lead_id ON contacts (lead_id)'
  );
  // UNIQUE (lead_id, email) only when email is non-blank — blank emails are not row-unique
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_lead_email
    ON contacts (lead_id, email)
    WHERE email IS NOT NULL AND email <> ''
  `);

  // email_logs → optional contact link (Activity soft-link; existing rows stay NULL)
  await pool.query(
    'ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS contact_id INTEGER'
  );
  // FK only if missing (safe re-run). lead_id on email_logs historically had no FK.
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE email_logs
        ADD CONSTRAINT email_logs_contact_id_fkey
        FOREIGN KEY (contact_id) REFERENCES contacts(id);
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_email_logs_contact_id ON email_logs (contact_id) WHERE contact_id IS NOT NULL'
  );

  console.log('✓ Schema ready (incl. Phase 0/1 + contacts + email_logs.contact_id)');
}

// ── Seed user (idempotent) ────────────────────────────────────────────────────
// Uses INITIAL_ADMIN_PASS from .env if present (recommended).
// After first successful login as 'dj', rotate the password immediately (UI or direct DB) and clear/blank the env var.
// The placeholder default is intentionally weak and must never be used in any real deployment.
async function seedUser() {
  const existing = await pgGet('SELECT id FROM users WHERE username = ?', 'dj');
  if (!existing) {
    const initialPass = process.env.INITIAL_ADMIN_PASS || 'change-this-immediately-after-first-login';
    const hash = bcrypt.hashSync(initialPass, 10);
    await pgRun('INSERT INTO users (username, password_hash) VALUES (?, ?)', 'dj', hash);
    console.log('✓ User dj created (rotate password after first login)');
  }
}

// ── Seed default email template (idempotent) ──────────────────────────────────
async function seedTemplate() {
  const existing = await pgGet('SELECT id FROM email_template WHERE id = 1');
  if (!existing) {
    await pgRun(
      `INSERT INTO email_template (id, subject, body) VALUES (1, ?, ?)`,
      'How I cut lead response time to 60 seconds (and what it did to revenue)',
      `Hi [First Name],

My name is DJ Bonifacic — I've spent 8+ years building AI systems, analytics, and automation infrastructure for growing companies. I'm based in Fort Collins, and I'm selectively helping a handful of NoCo businesses deploy their first AI tool — at no cost.

Not a chatbot. An actual autonomous system that answers calls, qualifies leads, sends quotes, and follows up — while you sleep.

I'll build it, set it up, and hand you the keys. No catch. I want to show you what's possible. The reality is, AI can solve dozens of problems across your business — lead flow is just the easiest place to start and the fastest to show results.

Here's what the first tool typically handles:
- After-hours call comes in? Agent answers, captures the lead, follows up automatically
- New web inquiry? Text goes out in under 60 seconds
- Slow period? Agent reactivates your existing customer list on autopilot

Once you see it working, we can dig into wherever else you're losing time or money — scheduling, estimating, hiring, reporting, customer retention. There's almost no business problem AI can't meaningfully improve right now.

I have capacity for 3 businesses in NoCo this month. First come, first served.

Worth a 15-minute call?

— DJ Bonifacic
Fort Collins, CO
qbonifacic@icloud.com`
    );
    console.log('✓ Default email template created');
  }
}

// ── CSV Import (idempotent on count; used for initial bootstrap) ──────────────
async function seedLeads() {
  const countRow = await pgGet('SELECT COUNT(*) as cnt FROM leads');
  if (countRow && parseInt(countRow.cnt) > 0) {
    console.log(`✓ Leads already seeded (${countRow.cnt} rows)`);
    return;
  }

  const csvPath = process.env.CSV_PATH || path.join(__dirname, 'leads_data.csv');
  if (!fs.existsSync(csvPath)) {
    console.log('⚠ CSV not found at', csvPath);
    return;
  }

  const { parse } = require('csv-parse/sync');
  const raw = fs.readFileSync(csvPath, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of records) {
      await client.query(
        `INSERT INTO leads (business_name, segment, city, address, phone, website, yelp_url,
          yelp_rating, yelp_review_count, google_rating, google_review_count,
          years_in_business, owner_name, email, social_media, source, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          r.business_name || '',
          r.segment || '',
          r.city || '',
          r.address || '',
          r.phone || '',
          r.website || '',
          r.yelp_url || '',
          r.yelp_rating ? parseFloat(r.yelp_rating) : null,
          r.yelp_review_count ? parseInt(r.yelp_review_count) : null,
          r.google_rating ? parseFloat(r.google_rating) : null,
          r.google_review_count ? parseInt(r.google_review_count) : null,
          r.years_in_business || '',
          r.owner_name || '',
          r.email || '',
          r.social_media || '',
          r.source || '',
          r.status || 'untouched',
          r.notes || ''
        ]
      );
    }
    await client.query('COMMIT');
    console.log(`✓ Imported ${records.length} leads from CSV`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('CSV import failed:', e.message);
  } finally {
    client.release();
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);

app.use(session({
  // Require SESSION_SECRET in prod. Short non-secret fallback for local syntax-only boots.
  secret: process.env.SESSION_SECRET || 'dev-only',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: 'auto',
    sameSite: 'lax',
    maxAge: 86400000 * 7
  }
}));

const requireAuth = (req, res, next) => {
  // Dual auth: X-API-Key header first (for Q/hermes/n8n bots), then session cookie.
  // Set Q_API_KEY in .env (or launchd) to a long random value. Never commit it.
  const apiKey = req.headers['x-api-key'] || req.headers['X-API-Key'];
  if (apiKey && process.env.Q_API_KEY && apiKey === process.env.Q_API_KEY) {
    req.botAuth = true;
    return next();
  }
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

// ── Contact helpers (Task 10 company API) ─────────────────────────────────────
const CONTACT_SELECT =
  'id, lead_id, name, email, role, is_primary, source, last_emailed_at, last_email_status, created_at';

async function listContactsForLead(leadId) {
  return pgAll(
    `SELECT ${CONTACT_SELECT} FROM contacts WHERE lead_id = ? ORDER BY is_primary DESC, id ASC`,
    leadId
  );
}

async function getLeadOr404(id, res) {
  const lead = await pgGet('SELECT * FROM leads WHERE id = ?', id);
  if (!lead) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return lead;
}

/**
 * Resolve contact by id (must belong to lead) or by email; create if missing.
 * Used by send-email-to and manual POST contacts.
 */
async function resolveOrCreateContact(leadId, { contact_id, email, name, role, source, is_primary }) {
  const leadIdNum = parseInt(leadId, 10);
  if (contact_id) {
    const byId = await pgGet(
      `SELECT ${CONTACT_SELECT} FROM contacts WHERE id = ? AND lead_id = ?`,
      parseInt(contact_id, 10),
      leadIdNum
    );
    if (byId) return byId;
  }

  const emailNorm = (email || '').trim();
  if (emailNorm) {
    const existing = await pgGet(
      `SELECT ${CONTACT_SELECT} FROM contacts WHERE lead_id = ? AND email = ?`,
      leadIdNum,
      emailNorm
    );
    if (existing) {
      // Optionally refresh name/role if provided and currently empty
      if ((name && !existing.name) || (role && !existing.role)) {
        await pgRun(
          `UPDATE contacts SET
             name = CASE WHEN COALESCE(name,'') = '' AND ? != '' THEN ? ELSE name END,
             role = CASE WHEN COALESCE(role,'') = '' AND ? != '' THEN ? ELSE role END
           WHERE id = ?`,
          name || '', name || '', role || '', role || '', existing.id
        );
        return pgGet(`SELECT ${CONTACT_SELECT} FROM contacts WHERE id = ?`, existing.id);
      }
      return existing;
    }

    if (is_primary) {
      await pgRun('UPDATE contacts SET is_primary = FALSE WHERE lead_id = ?', leadIdNum);
    }

    const inserted = await pool.query(
      `INSERT INTO contacts (lead_id, name, email, role, is_primary, source)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${CONTACT_SELECT}`,
      [
        leadIdNum,
        name || '',
        emailNorm,
        role || '',
        !!is_primary,
        source || 'manual'
      ]
    );
    return inserted.rows[0];
  }

  // No email: create non-unique blank-email contact only when name provided (manual add)
  if (name) {
    if (is_primary) {
      await pgRun('UPDATE contacts SET is_primary = FALSE WHERE lead_id = ?', leadIdNum);
    }
    const inserted = await pool.query(
      `INSERT INTO contacts (lead_id, name, email, role, is_primary, source)
       VALUES ($1, $2, '', $3, $4, $5)
       RETURNING ${CONTACT_SELECT}`,
      [leadIdNum, name, role || '', !!is_primary, source || 'manual']
    );
    return inserted.rows[0];
  }

  return null;
}

async function updateContactEmailStatus(contactId, status) {
  if (!contactId) return;
  await pgRun(
    `UPDATE contacts SET last_emailed_at = NOW(), last_email_status = ? WHERE id = ?`,
    status,
    contactId
  );
}

// ── Health (no auth; launchd / monitoring). Non-secret status only. ────────────
app.get('/api/health', async (req, res) => {
  let db = 'down';
  try {
    await pool.query('SELECT 1');
    db = 'up';
  } catch {
    db = 'down';
  }
  const ok = db === 'up';
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'noco-crm',
    db,
    time: new Date().toISOString()
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await pgGet('SELECT * FROM users WHERE username = ?', username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({ loggedIn: true, username: req.session.username });
  } else {
    res.json({ loggedIn: false });
  }
});

// ── Shared lead list filters (stats + /api/leads) ─────────────────────────────
// Query flags:
//   include_merged=1  — show soft-merged dupes (default: hide them)
//   include_hidden=1  — include status=hide when no status filter (default: exclude hide)
//   min_client / min_target — fit score floors
function buildLeadFilters(query) {
  const {
    city, segment, status, min_rating, has_email, has_phone, has_website, min_contacts,
    search, min_client, min_target, include_merged, include_hidden
  } = query;

  const conditions = [];
  const params = [];
  let paramIdx = 1;

  // Soft-merge: only show canonical / unmerged rows by default.
  // When filtering status=hide, include merged losers unless include_merged=0.
  const showMerged =
    include_merged === '1' ||
    include_merged === 'yes' ||
    (status === 'hide' && include_merged !== '0' && include_merged !== 'no');
  if (!showMerged) {
    conditions.push('(merged_into_id IS NULL)');
  }

  if (city) { conditions.push(`city = $${paramIdx++}`); params.push(city); }
  if (segment) { conditions.push(`segment = $${paramIdx++}`); params.push(segment); }
  if (status) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(status);
  } else if (include_hidden !== '1' && include_hidden !== 'yes') {
    // Active-only default (D5) — hide status=hide unless explicitly filtered
    conditions.push(`(status IS NULL OR status <> 'hide')`);
  }
  if (min_rating) { conditions.push(`google_rating >= $${paramIdx++}`); params.push(parseFloat(min_rating)); }
  if (has_email === 'yes') conditions.push("(email IS NOT NULL AND email != '')");
  if (has_email === 'no') conditions.push("(email IS NULL OR email = '')");
  if (has_phone === 'yes') conditions.push("(phone IS NOT NULL AND phone != '')");
  if (has_phone === 'no') conditions.push("(phone IS NULL OR phone = '')");
  if (has_website === 'yes') conditions.push("(website IS NOT NULL AND website != '' AND COALESCE(website_domain,'') NOT IN ('facebook.com','instagram.com','yelp.com','google.com','maps.google.com','bing.com','linkedin.com','twitter.com','x.com','youtube.com'))");
  if (has_website === 'no') conditions.push("(website IS NULL OR website = '')");
  if (min_contacts) {
    const mc = parseInt(min_contacts, 10);
    if (!isNaN(mc) && mc > 0) {
      const contactsExpr = `CASE WHEN contacts IS NOT NULL AND contacts != '' AND contacts != '[]' THEN jsonb_array_length(contacts::jsonb) ELSE 0 END`;
      conditions.push(`${contactsExpr} >= $${paramIdx++}`);
      params.push(mc);
    }
  }
  if (min_client) {
    const n = parseInt(min_client, 10);
    if (!isNaN(n) && n > 0) {
      conditions.push(`COALESCE(fit_client_score,0) >= $${paramIdx++}`);
      params.push(n);
    }
  }
  if (min_target) {
    const n = parseInt(min_target, 10);
    if (!isNaN(n) && n > 0) {
      conditions.push(`COALESCE(fit_target_score,0) >= $${paramIdx++}`);
      params.push(n);
    }
  }
  if (search) {
    conditions.push(`(business_name ILIKE $${paramIdx} OR city ILIKE $${paramIdx + 1} OR address ILIKE $${paramIdx + 2} OR website ILIKE $${paramIdx + 3})`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    paramIdx += 4;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return { where, params, paramIdx, conditions };
}

// ── Stats (extended in later phases for scores) ───────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  const { where, params, conditions } = buildLeadFilters(req.query);
  const statusWhere = conditions.length ? ' AND ' + conditions.join(' AND ') : '';

  // For status breakdown, strip the default hide exclusion so "hidden" count is meaningful
  const baseNoStatus = buildLeadFilters({ ...req.query, status: undefined, include_hidden: '1' });

  res.json({
    total: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads ${where}`, params)).rows[0].n, 10),
    pursuing: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads WHERE status='pursue'${statusWhere}`, params)).rows[0].n, 10),
    hidden: parseInt((await pool.query(
      `SELECT COUNT(*) as n FROM leads ${baseNoStatus.where ? baseNoStatus.where + " AND status='hide'" : "WHERE status='hide'"}`,
      baseNoStatus.params
    )).rows[0].n, 10),
    maybe: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads WHERE status='maybe'${statusWhere}`, params)).rows[0].n, 10),
    untouched: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads WHERE status='untouched'${statusWhere}`, params)).rows[0].n, 10),
    emails_sent: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads WHERE email_sent=1${statusWhere}`, params)).rows[0].n, 10),
    has_email: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads WHERE email != ''${statusWhere}`, params)).rows[0].n, 10),
    has_phone: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads WHERE phone != ''${statusWhere}`, params)).rows[0].n, 10),
    has_research: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads WHERE research_summary != ''${statusWhere}`, params)).rows[0].n, 10),
    avg_client_score: parseFloat((Number((await pool.query(`SELECT AVG(fit_client_score) as a FROM leads ${where}`, params)).rows[0].a || 0)).toFixed(1)),
    avg_target_score: parseFloat((Number((await pool.query(`SELECT AVG(fit_target_score) as a FROM leads ${where}`, params)).rows[0].a || 0)).toFixed(1)),
    merged_excluded: req.query.include_merged !== '1' && req.query.include_merged !== 'yes',
    hidden_excluded: !req.query.status && req.query.include_hidden !== '1' && req.query.include_hidden !== 'yes',
  });
});

// ── Leads (core list + filters + export + Phase 0/1 fields returned automatically) ──
app.get('/api/leads', requireAuth, async (req, res) => {
  const {
    page = 1, limit = 50, sort = 'google_rating', dir = 'desc',
    export: doExport
  } = req.query;

  const allowed_sorts = ['id','business_name','segment','city','google_rating','google_review_count','yelp_rating','status','email_sent','fit_client_score','fit_target_score'];
  const sortCol = allowed_sorts.includes(sort) ? sort : 'google_rating';
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';

  const { where, params, paramIdx: startIdx } = buildLeadFilters(req.query);
  let paramIdx = startIdx;

  const countRow = await pool.query(`SELECT COUNT(*) as n FROM leads ${where}`, params);
  const total = parseInt(countRow.rows[0].n, 10);

  if (doExport === '1') {
    const rows = (await pool.query(`SELECT *, CASE WHEN contacts IS NOT NULL AND contacts != '' AND contacts != '[]' THEN jsonb_array_length(contacts::jsonb) ELSE 0 END AS contact_count FROM leads ${where} ORDER BY ${sortCol} ${sortDir}`, params)).rows;
    if (!rows.length) {
      res.setHeader('Content-Type', 'text/csv');
      return res.send('No data');
    }
    const cols = Object.keys(rows[0]);
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    return res.send(csv);
  }

  const offset = (parseInt(page) - 1) * parseInt(limit);
  const limitParam = paramIdx++;
  const offsetParam = paramIdx++;
  const rows = (await pool.query(
    `SELECT *, CASE WHEN contacts IS NOT NULL AND contacts != '' AND contacts != '[]' THEN jsonb_array_length(contacts::jsonb) ELSE 0 END AS contact_count FROM leads ${where} ORDER BY ${sortCol} ${sortDir} LIMIT $${limitParam} OFFSET $${offsetParam}`,
    [...params, parseInt(limit), offset]
  )).rows;
  res.json({ total, page: parseInt(page), limit: parseInt(limit), rows });
});

// ── Company / Contacts / Activity API (Task 10) ───────────────────────────────
// Dynamics-style Account record surface for Task 11 company UI.
// Prefer canonical companies (merged_into_id IS NULL) when listing; single-id GETs still work.

app.get('/api/leads/:id/company', requireAuth, async (req, res) => {
  try {
    const lead = await getLeadOr404(req.params.id, res);
    if (!lead) return;

    const contacts = await listContactsForLead(lead.id);
    const emailCount = parseInt(
      (await pgGet('SELECT COUNT(*)::int AS n FROM email_logs WHERE lead_id = ?', lead.id))?.n || 0,
      10
    );
    const callCount = parseInt(
      (await pgGet('SELECT COUNT(*)::int AS n FROM call_logs WHERE lead_id = ?', lead.id))?.n || 0,
      10
    );

    res.json({
      ...lead,
      contacts,
      summary: {
        contact_count: contacts.length,
        email_log_count: emailCount,
        call_log_count: callCount,
        is_merged: lead.merged_into_id != null,
        merged_into_id: lead.merged_into_id || null
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/:id/contacts', requireAuth, async (req, res) => {
  try {
    const lead = await getLeadOr404(req.params.id, res);
    if (!lead) return;
    const rows = await listContactsForLead(lead.id);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads/:id/contacts', requireAuth, async (req, res) => {
  try {
    const lead = await getLeadOr404(req.params.id, res);
    if (!lead) return;

    const { name = '', email = '', role = '', is_primary } = req.body || {};
    if (!String(name).trim() && !String(email).trim()) {
      return res.status(400).json({ error: 'name or email required' });
    }

    const contact = await resolveOrCreateContact(lead.id, {
      name: String(name || '').trim(),
      email: String(email || '').trim(),
      role: String(role || '').trim(),
      is_primary: !!is_primary,
      source: 'manual'
    });

    if (!contact) {
      return res.status(400).json({ error: 'Could not create contact' });
    }

    // If client asked for primary on an existing row, enforce it
    if (is_primary && !contact.is_primary) {
      await pgRun('UPDATE contacts SET is_primary = FALSE WHERE lead_id = ?', lead.id);
      await pgRun('UPDATE contacts SET is_primary = TRUE WHERE id = ?', contact.id);
      contact.is_primary = true;
    }

    res.status(201).json({ ok: true, contact });
  } catch (err) {
    // Unique violation on (lead_id, email)
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'Contact with this email already exists for lead' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/:id/activity', requireAuth, async (req, res) => {
  try {
    const lead = await getLeadOr404(req.params.id, res);
    if (!lead) return;

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const emails = await pgAll(
      `SELECT id, contact_id, recipient, subject, status, error, sent_at
       FROM email_logs WHERE lead_id = ? ORDER BY sent_at DESC NULLS LAST LIMIT ?`,
      lead.id,
      limit
    );

    let calls = [];
    try {
      calls = await pgAll(
        `SELECT id, outcome, duration_seconds, transcript, summary, direction, source, created_at
         FROM call_logs WHERE lead_id = ? ORDER BY created_at DESC NULLS LAST LIMIT ?`,
        lead.id,
        limit
      );
    } catch {
      // call_logs may be absent on very old DBs; activity still returns emails
      calls = [];
    }

    const rows = [
      ...emails.map((e) => ({
        type: 'email',
        id: e.id,
        contact_id: e.contact_id || null,
        recipient: e.recipient || '',
        subject: e.subject || '',
        status: e.status || '',
        error: e.error || null,
        at: e.sent_at
      })),
      ...calls.map((c) => ({
        type: 'call',
        id: c.id,
        outcome: c.outcome || '',
        duration_seconds: c.duration_seconds || 0,
        transcript: c.transcript || '',
        summary: c.summary || '',
        direction: c.direction || '',
        source: c.source || '',
        at: c.created_at
      }))
    ]
      .sort((a, b) => {
        const ta = a.at ? new Date(a.at).getTime() : 0;
        const tb = b.at ? new Date(b.at).getTime() : 0;
        return tb - ta;
      })
      .slice(0, limit);

    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/:id', requireAuth, async (req, res) => {
  const lead = await pgGet('SELECT * FROM leads WHERE id = ?', req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  // Lightweight enhance: include contacts[] when table present (Task 11 can use /company)
  try {
    const contacts = await listContactsForLead(lead.id);
    res.json({ ...lead, contacts });
  } catch {
    res.json(lead);
  }
});

app.patch('/api/leads/:id', requireAuth, async (req, res) => {
  // Extended for Python intel layer (fit scores, research, phone confidence etc.)
  const allowed = [
    'status','notes','email_sent','date_sent','last_contacted','next_followup','email','owner_name',
    'phone','website','contacts','fit_client_score','fit_target_score','research_summary',
    'phone_source','phone_confidence','website_confidence','tags','dedupe_key','last_enriched_at',
    'merged_into_id','is_canonical','website_domain'
  ];
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const k of allowed) {
    if (k in req.body) { sets.push(`${k} = $${idx++}`); vals.push(req.body[k]); }
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  await pool.query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
  res.json({ ok: true });
});

app.post('/api/leads/bulk-status', requireAuth, async (req, res) => {
  const { ids, status } = req.body;
  if (!ids || !ids.length || !status) return res.status(400).json({ error: 'Missing ids or status' });
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(',');
  await pool.query(`UPDATE leads SET status = $1 WHERE id IN (${placeholders})`, [status, ...ids]);
  res.json({ ok: true, updated: ids.length });
});

// ── Hunter.io Enrichment (wired from .env; conservative for budget) ───────────
// See .env.example and Phase 1 for full discovery + research layer (Python).
app.post('/api/enrich', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.body.limit) || 100, 100);
  const HUNTER_KEY = process.env.HUNTER_API_KEY;

  if (!HUNTER_KEY) {
    return res.status(500).json({ error: 'HUNTER_API_KEY not set in environment (see .env.example)' });
  }

  const leads = (await pool.query(
    `SELECT id, website, owner_name FROM leads WHERE (email IS NULL OR email = '') AND website != '' LIMIT $1`,
    [limit]
  )).rows;

  let enriched = 0;
  for (const lead of leads) {
    try {
      let domain = lead.website.trim();
      if (domain.match(/^https?:\/\//i)) {
        domain = new URL(domain).hostname.replace(/^www\./, '');
      } else {
        domain = domain.replace(/^www\./, '').split('/')[0];
      }
      if (!domain) continue;

      const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_KEY}`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const data = await resp.json();

      const emails = data?.data?.emails;
      if (!emails || !emails.length) continue;

      const contacts = emails.map(e => ({
        email: e.value,
        name: [e.first_name, e.last_name].filter(Boolean).join(' '),
        role: e.position || e.type || ''
      }));

      const preferred = emails.find(e => /owner|founder/i.test(e.position || e.type || '')) || emails[0];
      const primaryEmail = preferred.value;
      if (!primaryEmail) continue;

      const ownerName = (!lead.owner_name && (preferred.first_name || preferred.last_name))
        ? [preferred.first_name, preferred.last_name].filter(Boolean).join(' ')
        : lead.owner_name;

      await pool.query(
        `UPDATE leads SET email = $1, owner_name = COALESCE(NULLIF($2,''), owner_name), contacts = $3 WHERE id = $4`,
        [primaryEmail, ownerName || '', JSON.stringify(contacts), lead.id]
      );
      enriched++;
    } catch (e) {
      // individual failures are non-fatal
    }
  }

  res.json({ enriched, checked: leads.length });
});

// ── Send to specific contact (Hunter multi-contact + contacts table) ──────────
// Body: { email, name, contact_id? }
// Resolves/creates contact, sends via SMTP_FROM, logs email_logs.contact_id, updates contact status.
app.post('/api/send-email-to/:id', requireAuth, async (req, res) => {
  const { email, name, contact_id } = req.body || {};
  if (!email) return res.status(400).json({ error: 'No email provided' });
  const lead = await pgGet('SELECT * FROM leads WHERE id = ?', req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const template = await pgGet('SELECT * FROM email_template WHERE id = 1');
  if (!template) return res.status(400).json({ error: 'No template configured' });

  const from = mailFrom();
  if (!from || (!process.env.SMTP_PASS && !process.env.ICLOUD_APP_PASS)) {
    return res.status(503).json({ error: 'SMTP not configured (set SMTP_USER/SMTP_PASS/SMTP_FROM)' });
  }

  let contact = null;
  try {
    contact = await resolveOrCreateContact(lead.id, {
      contact_id,
      email,
      name: name || '',
      source: contact_id ? 'manual' : 'manual',
      role: ''
    });
  } catch (e) {
    // Non-fatal: still send email even if contact table write fails
    contact = null;
  }

  const mergedLead = { ...lead, owner_name: name || (contact && contact.name) || lead.owner_name };
  const subject = applyMergeFields(template.subject, mergedLead);
  const body = applyMergeFields(template.body, mergedLead);
  const contactIdVal = contact && contact.id ? contact.id : null;

  try {
    await transporter.sendMail({ from, to: email, subject, text: body });
    if (contactIdVal) {
      await pgRun(
        `INSERT INTO email_logs (lead_id, recipient, subject, status, contact_id) VALUES (?,?,?,?,?)`,
        lead.id, email, subject, 'sent', contactIdVal
      );
      await updateContactEmailStatus(contactIdVal, 'sent');
    } else {
      await pgRun(
        `INSERT INTO email_logs (lead_id, recipient, subject, status) VALUES (?,?,?,?)`,
        lead.id, email, subject, 'sent'
      );
    }
    res.json({ ok: true, contact_id: contactIdVal });
  } catch (err) {
    if (contactIdVal) {
      await pgRun(
        `INSERT INTO email_logs (lead_id, recipient, subject, status, error, contact_id) VALUES (?,?,?,?,?,?)`,
        lead.id, email, subject, 'error', err.message, contactIdVal
      );
      await updateContactEmailStatus(contactIdVal, 'error');
    } else {
      await pgRun(
        `INSERT INTO email_logs (lead_id, recipient, subject, status, error) VALUES (?,?,?,?,?)`,
        lead.id, email, subject, 'error', err.message
      );
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Call logging (voice skeleton hook) ────────────────────────────────────────
// POST body: { direction?, duration_seconds, transcript, summary?, outcome, source? }
// Inserts to call_logs, touches lead last_contacted + notes append.
app.post('/api/leads/:id/log-call', requireAuth, async (req, res) => {
  const leadId = parseInt(req.params.id, 10);
  const { direction = 'outbound', duration_seconds = 0, transcript = '', summary = '', outcome = '', source = 'manual' } = req.body || {};
  if (!leadId) return res.status(400).json({ error: 'Bad lead id' });

  const lead = await pgGet('SELECT id FROM leads WHERE id = ?', leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const nowDate = new Date().toISOString().slice(0, 10);
  const notesAppend = `Call ${direction} ${duration_seconds}s [${outcome}]: ${transcript ? transcript.slice(0, 200) : ''}`.trim();

  await pgRun(
    `INSERT INTO call_logs (lead_id, direction, duration_seconds, transcript, summary, outcome, source, created_at)
     VALUES (?,?,?,?,?,?,?,NOW())`,
    leadId, direction, parseInt(duration_seconds) || 0, transcript, summary, outcome, source
  );
  await pgRun(
    `UPDATE leads SET last_contacted = ?, notes = COALESCE(notes,'') || E'\n' || ? WHERE id = ?`,
    nowDate, notesAppend, leadId
  );

  res.json({ ok: true });
});

// GET call logs (recent or per-lead). Parallel to email logs.
app.get('/api/call-logs', requireAuth, async (req, res) => {
  const { lead_id, limit = 100 } = req.query;
  let sql = 'SELECT cl.*, l.business_name FROM call_logs cl LEFT JOIN leads l ON l.id = cl.lead_id';
  const params = [];
  if (lead_id) {
    sql += ' WHERE cl.lead_id = ?';
    params.push(parseInt(lead_id));
  }
  sql += ' ORDER BY cl.created_at DESC LIMIT ?';
  params.push(parseInt(limit) || 100);
  // Must use pgAll so ? → $n (dbAll does not convert placeholders)
  const rows = await pgAll(sql, ...params);
  res.json({ rows });
});

// ── Email Template ────────────────────────────────────────────────────────────
app.get('/api/template', requireAuth, async (req, res) => {
  const t = await pgGet('SELECT * FROM email_template WHERE id = 1');
  res.json(t || { subject: '', body: '' });
});

app.post('/api/template', requireAuth, async (req, res) => {
  const { subject, body } = req.body;
  await pool.query(
    `INSERT INTO email_template (id, subject, body, updated_at) VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET subject = $1, body = $2, updated_at = NOW()`,
    [subject, body]
  );
  res.json({ ok: true });
});

// ── Email Sending (transporter fully driven from environment) ─────────────────
// Set SMTP_HOST/PORT/USER/PASS/FROM in .env (Proton SMTP token for custom domain).
// Never hardcode credentials or From addresses.
function mailFrom() {
  return (
    process.env.SMTP_FROM ||
    (process.env.SMTP_USER
      ? `DJ Bonifacic <${process.env.SMTP_USER}>`
      : '')
  );
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.protonmail.ch',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || process.env.ICLOUD_APP_PASS || ''
  }
});

function applyMergeFields(text, lead) {
  const firstName = (lead.owner_name || lead.business_name || 'there').split(' ')[0];
  return text
    .replace(/\[First Name\]/g, firstName)
    .replace(/\[Business Name\]/g, lead.business_name || '')
    .replace(/\[City\]/g, lead.city || '')
    .replace(/\[Segment\]/g, lead.segment || '');
}

app.post('/api/send-email/:id', requireAuth, async (req, res) => {
  const lead = await pgGet('SELECT * FROM leads WHERE id = ?', req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (!lead.email) return res.status(400).json({ error: 'No email for this lead' });
  const from = mailFrom();
  if (!from || !process.env.SMTP_PASS && !process.env.ICLOUD_APP_PASS) {
    return res.status(503).json({ error: 'SMTP not configured (set SMTP_USER/SMTP_PASS/SMTP_FROM)' });
  }

  const template = await pgGet('SELECT * FROM email_template WHERE id = 1');
  if (!template) return res.status(400).json({ error: 'No template configured' });

  const subject = applyMergeFields(template.subject, lead);
  const body = applyMergeFields(template.body, lead);

  try {
    await transporter.sendMail({ from, to: lead.email, subject, text: body });
    const now = new Date().toISOString().slice(0, 10);
    await pgRun(`UPDATE leads SET email_sent=1, date_sent=? WHERE id=?`, now, lead.id);
    await pgRun(`INSERT INTO email_logs (lead_id, recipient, subject, status) VALUES (?,?,?,?)`, lead.id, lead.email, subject, 'sent');
    res.json({ ok: true });
  } catch (err) {
    await pgRun(`INSERT INTO email_logs (lead_id, recipient, subject, status, error) VALUES (?,?,?,?,?)`, lead.id, lead.email, subject, 'error', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-batch', requireAuth, async (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: 'No ids' });
  const from = mailFrom();
  if (!from || !process.env.SMTP_PASS && !process.env.ICLOUD_APP_PASS) {
    return res.status(503).json({ error: 'SMTP not configured (set SMTP_USER/SMTP_PASS/SMTP_FROM)' });
  }
  const template = await pgGet('SELECT * FROM email_template WHERE id = 1');
  if (!template) return res.status(400).json({ error: 'No template' });

  const results = [];
  const toSend = ids.slice(0, 20);

  for (const id of toSend) {
    const lead = await pgGet('SELECT * FROM leads WHERE id = ?', id);
    if (!lead || !lead.email) { results.push({ id, status: 'skipped', reason: lead ? 'no email' : 'not found' }); continue; }
    const subject = applyMergeFields(template.subject, lead);
    const body = applyMergeFields(template.body, lead);
    try {
      await transporter.sendMail({ from, to: lead.email, subject, text: body });
      const now = new Date().toISOString().slice(0, 10);
      await pgRun(`UPDATE leads SET email_sent=1, date_sent=? WHERE id=?`, now, lead.id);
      await pgRun(`INSERT INTO email_logs (lead_id, recipient, subject, status) VALUES (?,?,?,?)`, lead.id, lead.email, subject, 'sent');
      results.push({ id, status: 'sent', email: lead.email });
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      await pgRun(`INSERT INTO email_logs (lead_id, recipient, subject, status, error) VALUES (?,?,?,?,?)`, lead.id, lead.email, subject, 'error', err.message);
      results.push({ id, status: 'error', error: err.message });
    }
  }
  res.json({ ok: true, results, skipped: ids.length - toSend.length });
});

// ── Filter options ────────────────────────────────────────────────────────────
app.get('/api/filter-options', requireAuth, async (req, res) => {
  const cities = (await pgAll("SELECT DISTINCT city FROM leads WHERE city != '' ORDER BY city")).map(r => r.city);
  const segments = (await pgAll("SELECT DISTINCT segment FROM leads WHERE segment != '' ORDER BY segment")).map(r => r.segment);
  res.json({ cities, segments });
});

// ── Email logs ────────────────────────────────────────────────────────────────
app.get('/api/email-logs', requireAuth, async (req, res) => {
  const logs = await pgAll('SELECT el.*, l.business_name FROM email_logs el LEFT JOIN leads l ON el.lead_id = l.id ORDER BY el.sent_at DESC LIMIT 200');
  res.json(logs);
});

// ── SPA catch-all ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  await initSchema();
  await seedUser();
  await seedTemplate();
  await seedLeads();
  app.listen(PORT, () => {
    console.log(`✓ NoCo CRM running on port ${PORT}`);
    console.log('  Set HUNTER_API_KEY, SMTP_PASS (or ICLOUD_APP_PASS), SESSION_SECRET, DATABASE_URL, Q_API_KEY in .env');
  });
}

boot().catch(err => {
  console.error('Boot failed:', err);
  process.exit(1);
});
