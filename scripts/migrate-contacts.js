#!/usr/bin/env node
/**
 * Migrate leads.contacts JSON → first-class contacts rows (idempotent).
 *
 * Rules:
 *  1. For each lead with non-empty contacts JSON array: upsert one row per email
 *  2. If lead.email is set and not already in the array: create primary contact
 *  3. Blank emails are skipped (partial unique index on non-empty email)
 *  4. Do not drop leads.contacts JSON (dual-read window)
 *  5. Soft-link only — never hard-delete leads
 *
 * Usage:
 *   node scripts/migrate-contacts.js --dry-run
 *   node scripts/migrate-contacts.js --apply
 *
 * Requires DATABASE_URL (from env or repo-root .env). Never logs secret values.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnv();

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function parseContactsJson(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return Array.isArray(raw) ? raw : [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Ensure contacts table + email_logs.contact_id exist (same contract as server initSchema). */
async function ensureContactsSchema(client) {
  await client.query(`
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
  await client.query('CREATE INDEX IF NOT EXISTS idx_contacts_lead_id ON contacts (lead_id)');
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_lead_email
    ON contacts (lead_id, email)
    WHERE email IS NOT NULL AND email <> ''
  `);
  await client.query(
    'ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS contact_id INTEGER'
  );
  await client.query(`
    DO $$ BEGIN
      ALTER TABLE email_logs
        ADD CONSTRAINT email_logs_contact_id_fkey
        FOREIGN KEY (contact_id) REFERENCES contacts(id);
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$
  `);
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_email_logs_contact_id ON email_logs (contact_id) WHERE contact_id IS NOT NULL'
  );
}

/**
 * Build the set of contact upserts for one lead.
 * Returns [{ lead_id, name, email, role, is_primary, source }]
 */
function planContactsForLead(lead) {
  const leadId = lead.id;
  const primaryEmail = normalizeEmail(lead.email);
  const ownerName = String(lead.owner_name || '').trim();
  const fromJson = parseContactsJson(lead.contacts);

  /** @type {Map<string, { lead_id: number, name: string, email: string, role: string, is_primary: boolean, source: string }>} */
  const byEmail = new Map();

  for (const c of fromJson) {
    const email = normalizeEmail(c && c.email);
    if (!email) continue;
    const name = String((c && c.name) || '').trim();
    const role = String((c && c.role) || '').trim();
    const isPrimary = primaryEmail ? email === primaryEmail : false;
    const existing = byEmail.get(email);
    if (existing) {
      if (!existing.name && name) existing.name = name;
      if (!existing.role && role) existing.role = role;
      existing.is_primary = existing.is_primary || isPrimary;
      continue;
    }
    byEmail.set(email, {
      lead_id: leadId,
      name,
      email,
      role,
      is_primary: isPrimary,
      source: 'hunter',
    });
  }

  if (primaryEmail && !byEmail.has(primaryEmail)) {
    byEmail.set(primaryEmail, {
      lead_id: leadId,
      name: ownerName,
      email: primaryEmail,
      role: '',
      is_primary: true,
      source: 'primary_email',
    });
  } else if (primaryEmail && byEmail.has(primaryEmail)) {
    const row = byEmail.get(primaryEmail);
    row.is_primary = true;
    if (!row.name && ownerName) row.name = ownerName;
  }

  // If no primary marked but we have contacts, mark first as primary
  const list = [...byEmail.values()];
  if (list.length && !list.some((r) => r.is_primary)) {
    list[0].is_primary = true;
  }

  return list;
}

async function upsertContact(client, row, apply) {
  if (!apply) return { action: 'would_upsert' };

  const existing = await client.query(
    `SELECT id FROM contacts WHERE lead_id = $1 AND email = $2`,
    [row.lead_id, row.email]
  );
  const existed = existing.rows.length > 0;

  const result = await client.query(
    `
    INSERT INTO contacts (lead_id, name, email, role, is_primary, source)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (lead_id, email) WHERE email IS NOT NULL AND email <> ''
    DO UPDATE SET
      name = CASE
        WHEN contacts.name IS NULL OR contacts.name = '' THEN EXCLUDED.name
        ELSE contacts.name
      END,
      role = CASE
        WHEN contacts.role IS NULL OR contacts.role = '' THEN EXCLUDED.role
        ELSE contacts.role
      END,
      is_primary = contacts.is_primary OR EXCLUDED.is_primary,
      source = CASE
        WHEN contacts.source IS NULL OR contacts.source = '' THEN EXCLUDED.source
        ELSE contacts.source
      END
    RETURNING id
    `,
    [row.lead_id, row.name || '', row.email, row.role || '', !!row.is_primary, row.source || 'hunter']
  );
  const r = result.rows[0];
  return { action: existed ? 'updated' : 'inserted', id: r && r.id };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const dry = !apply || process.argv.includes('--dry-run');
  const doApply = apply && !process.argv.includes('--dry-run');

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required (set in env or .env). No secrets printed.');
    process.exit(2);
  }

  // Never log connection string (may embed credentials)
  console.log(`migrate-contacts: mode=${doApply ? 'APPLY' : 'DRY-RUN'}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
  const client = await pool.connect();

  const stats = {
    leads_scanned: 0,
    leads_with_plan: 0,
    contacts_planned: 0,
    inserted: 0,
    updated: 0,
    would_upsert: 0,
    skipped_blank: 0,
    parse_empty: 0,
    errors: 0,
  };

  try {
    await client.query('BEGIN');
    await ensureContactsSchema(client);

    const { rows: leads } = await client.query(
      `SELECT id, email, owner_name, contacts
       FROM leads
       ORDER BY id`
    );

    for (const lead of leads) {
      stats.leads_scanned++;
      const plan = planContactsForLead(lead);
      if (!plan.length) {
        stats.parse_empty++;
        continue;
      }
      stats.leads_with_plan++;
      stats.contacts_planned += plan.length;

      for (const row of plan) {
        try {
          const res = await upsertContact(client, row, doApply);
          if (res.action === 'inserted') stats.inserted++;
          else if (res.action === 'updated') stats.updated++;
          else if (res.action === 'would_upsert') stats.would_upsert++;
        } catch (e) {
          stats.errors++;
          console.error(`  lead_id=${lead.id} email_domain_err: ${e.message}`);
        }
      }
    }

    if (doApply) {
      await client.query('COMMIT');
      console.log('COMMIT applied.');
    } else {
      await client.query('ROLLBACK');
      console.log('DRY-RUN: transaction rolled back (schema ensure also rolled back if new).');
      console.log('Re-run with --apply to persist contacts rows (schema ensure re-runs safely).');
    }

    // On dry-run, schema was rolled back — re-ensure outside txn so dry-run still leaves table if desired?
    // Contract: dry-run should not mutate data. Schema CREATE IF NOT EXISTS is ok to leave.
    // Re-apply schema after rollback so subsequent boots / apply have table even after dry-run.
    if (!doApply) {
      await ensureContactsSchema(client);
      console.log('Schema ensure re-applied after dry-run rollback (idempotent DDL only).');
    }

    console.log('--- summary ---');
    console.log(JSON.stringify(stats, null, 2));

    if (stats.errors > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    console.error('migrate-contacts failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
