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
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://qbot:wolfpack2026@localhost:5432/noco_crm',
  ssl: false
});

// ── Helper wrappers ───────────────────────────────────────────────────────────
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

// ── Convert ? placeholders to $1, $2, ... ────────────────────────────────────
function toPostgres(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Wrapped versions that auto-convert placeholders
async function pgGet(sql, ...params) {
  return dbGet(toPostgres(sql), ...params);
}

async function pgAll(sql, ...params) {
  return dbAll(toPostgres(sql), ...params);
}

async function pgRun(sql, ...params) {
  return pool.query(toPostgres(sql), params);
}

// ── Schema ────────────────────────────────────────────────────────────────────
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
  `);
  console.log('✓ Schema ready');
}

// ── Seed user ─────────────────────────────────────────────────────────────────
async function seedUser() {
  const existing = await pgGet('SELECT id FROM users WHERE username = ?', 'dj');
  if (!existing) {
    const hash = bcrypt.hashSync('wolfpack2026', 10);
    await pgRun('INSERT INTO users (username, password_hash) VALUES (?, ?)', 'dj', hash);
    console.log('✓ User dj created');
  }
}

// ── Seed default email template ───────────────────────────────────────────────
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

// ── CSV Import ────────────────────────────────────────────────────────────────
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
// Trust Cloudflare proxy so secure cookies work over HTTPS
app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'wolfpack2026secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: 'auto',   // secure when behind HTTPS proxy, plain when localhost
    sameSite: 'lax',
    maxAge: 86400000 * 7
  }
}));

const requireAuth = (req, res, next) => {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

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

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  const { city, segment, min_rating, has_email, has_phone, has_website, min_contacts, search } = req.query;

  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (city) { conditions.push(`city = $${paramIdx++}`); params.push(city); }
  if (segment) { conditions.push(`segment = $${paramIdx++}`); params.push(segment); }
  if (min_rating) { conditions.push(`google_rating >= $${paramIdx++}`); params.push(parseFloat(min_rating)); }
  if (has_email === 'yes') conditions.push("email != ''");
  if (has_email === 'no') conditions.push("(email IS NULL OR email = '')");
  if (has_phone === 'yes') conditions.push("phone != ''");
  if (has_phone === 'no') conditions.push("(phone IS NULL OR phone = '')");
  if (has_website === 'yes') conditions.push("website != ''");
  if (has_website === 'no') conditions.push("(website IS NULL OR website = '')");
  if (min_contacts) {
    const mc = parseInt(min_contacts);
    if (!isNaN(mc) && mc > 0) {
      conditions.push(`jsonb_array_length(CASE WHEN contacts IS NOT NULL AND contacts != '' AND contacts != '[]' THEN contacts::jsonb ELSE '[]'::jsonb END) >= $${paramIdx++}`);
      params.push(mc);
    }
  }
  if (search) {
    conditions.push(`(business_name ILIKE $${paramIdx} OR city ILIKE $${paramIdx+1} OR address ILIKE $${paramIdx+2})`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    paramIdx += 3;
  }

  // Note: status is NOT included in the base filter so we can count each status separately
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const statusWhere = conditions.length ? ' AND ' + conditions.join(' AND ') : '';

  res.json({
    total: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads ${where}`, params)).rows[0].n),
    pursuing: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads WHERE status='pursue'${statusWhere}`, params)).rows[0].n),
    hidden: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads WHERE status='hide'${statusWhere}`, params)).rows[0].n),
    maybe: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads WHERE status='maybe'${statusWhere}`, params)).rows[0].n),
    untouched: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads WHERE status='untouched'${statusWhere}`, params)).rows[0].n),
    emails_sent: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads WHERE email_sent=1${statusWhere}`, params)).rows[0].n),
    has_email: parseInt((await pool.query(`SELECT COUNT(*) as n FROM leads WHERE email != ''${statusWhere}`, params)).rows[0].n),
  });
});

// ── Leads ─────────────────────────────────────────────────────────────────────
app.get('/api/leads', requireAuth, async (req, res) => {
  const {
    page = 1, limit = 50, sort = 'id', dir = 'asc',
    city, segment, status, min_rating, has_email, has_phone, has_website,
    min_contacts, search, export: doExport
  } = req.query;

  const allowed_sorts = ['id','business_name','segment','city','google_rating','google_review_count','yelp_rating','status','email_sent'];
  const sortCol = allowed_sorts.includes(sort) ? sort : 'id';
  const sortDir = dir === 'desc' ? 'DESC' : 'ASC';

  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (city) { conditions.push(`city = $${paramIdx++}`); params.push(city); }
  if (segment) { conditions.push(`segment = $${paramIdx++}`); params.push(segment); }
  if (status) { conditions.push(`status = $${paramIdx++}`); params.push(status); }
  if (min_rating) { conditions.push(`google_rating >= $${paramIdx++}`); params.push(parseFloat(min_rating)); }
  if (has_email === 'yes') conditions.push("email != ''");
  if (has_email === 'no') conditions.push("(email IS NULL OR email = '')");
  if (has_phone === 'yes') conditions.push("phone != ''");
  if (has_phone === 'no') conditions.push("(phone IS NULL OR phone = '')");
  if (has_website === 'yes') conditions.push("website != ''");
  if (has_website === 'no') conditions.push("(website IS NULL OR website = '')");
  if (min_contacts) {
    const mc = parseInt(min_contacts);
    if (!isNaN(mc) && mc > 0) {
      conditions.push(`jsonb_array_length(CASE WHEN contacts IS NOT NULL AND contacts != '' AND contacts != '[]' THEN contacts::jsonb ELSE '[]'::jsonb END) >= $${paramIdx++}`);
      params.push(mc);
    }
  }
  if (search) {
    conditions.push(`(business_name ILIKE $${paramIdx} OR city ILIKE $${paramIdx+1} OR address ILIKE $${paramIdx+2})`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    paramIdx += 3;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const countRow = await pool.query(`SELECT COUNT(*) as n FROM leads ${where}`, params);
  const total = parseInt(countRow.rows[0].n);

  if (doExport === '1') {
    const rows = (await pool.query(`SELECT * FROM leads ${where} ORDER BY ${sortCol} ${sortDir}`, params)).rows;
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
    `SELECT * FROM leads ${where} ORDER BY ${sortCol} ${sortDir} LIMIT $${limitParam} OFFSET $${offsetParam}`,
    [...params, parseInt(limit), offset]
  )).rows;
  res.json({ total, page: parseInt(page), limit: parseInt(limit), rows });
});

app.get('/api/leads/:id', requireAuth, async (req, res) => {
  const lead = await pgGet('SELECT * FROM leads WHERE id = ?', req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json(lead);
});

app.patch('/api/leads/:id', requireAuth, async (req, res) => {
  // Bug 4 fix: also allow email and owner_name (needed for enrichment and general updates)
  const allowed = ['status','notes','email_sent','date_sent','last_contacted','next_followup','email','owner_name'];
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

// ── Hunter.io Enrichment ──────────────────────────────────────────────────────
app.post('/api/enrich', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.body.limit) || 100, 100);
  const HUNTER_KEY = 'REDACTED_HUNTER_KEY';

  const leads = (await pool.query(
    `SELECT id, website, owner_name FROM leads WHERE (email IS NULL OR email = '') AND website != '' LIMIT $1`,
    [limit]
  )).rows;

  let enriched = 0;
  for (const lead of leads) {
    try {
      let domain = lead.website.trim();
      // Extract domain from URL
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

      // Build full contacts list
      const contacts = emails.map(e => ({
        email: e.value,
        name: [e.first_name, e.last_name].filter(Boolean).join(' '),
        role: e.position || e.type || ''
      }));

      // Prefer owner/founder for primary email
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
      // skip individual lead errors
    }
  }

  res.json({ enriched, checked: leads.length });
});

// ── Send to specific contact email (Hunter.io contacts) ───────────────────────
app.post('/api/send-email-to/:id', requireAuth, async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'No email provided' });
  const lead = await pgGet('SELECT * FROM leads WHERE id = ?', req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const template = await pgGet('SELECT * FROM email_template WHERE id = 1');
  if (!template) return res.status(400).json({ error: 'No template configured' });

  // Use contact name if provided for merge fields
  const mergedLead = { ...lead, owner_name: name || lead.owner_name };
  const subject = applyMergeFields(template.subject, mergedLead);
  const body = applyMergeFields(template.body, mergedLead);

  try {
    await transporter.sendMail({ from: 'DJ Bonifacic <qbonifacic@icloud.com>', to: email, subject, text: body });
    const now = new Date().toISOString().slice(0, 10);
    await pgRun(`INSERT INTO email_logs (lead_id, recipient, subject, status) VALUES (?,?,?,?)`, lead.id, email, subject, 'sent');
    res.json({ ok: true });
  } catch (err) {
    await pgRun(`INSERT INTO email_logs (lead_id, recipient, subject, status, error) VALUES (?,?,?,?,?)`, lead.id, email, subject, 'error', err.message);
    res.status(500).json({ error: err.message });
  }
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

// ── Email Sending ─────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: 'smtp.mail.me.com',
  port: 587,
  secure: false,
  requireTLS: true,
  auth: {
    user: 'qbonifacic@icloud.com',
    pass: 'jlqh-kqtb-dafj-pebc'
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

  const template = await pgGet('SELECT * FROM email_template WHERE id = 1');
  if (!template) return res.status(400).json({ error: 'No template configured' });

  const subject = applyMergeFields(template.subject, lead);
  const body = applyMergeFields(template.body, lead);

  try {
    await transporter.sendMail({ from: 'DJ Bonifacic <qbonifacic@icloud.com>', to: lead.email, subject, text: body });
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
      await transporter.sendMail({ from: 'DJ Bonifacic <qbonifacic@icloud.com>', to: lead.email, subject, text: body });
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
  });
}

boot().catch(err => {
  console.error('Boot failed:', err);
  process.exit(1);
});
