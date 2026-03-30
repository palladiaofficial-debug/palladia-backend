'use strict';
// Script eseguito con: railway run node scripts/run-migrations-014-015.js
// Esegue le migration 014 e 015 su Supabase usando la Management API.
// Richiede SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY nell'ambiente.

const https = require('https');
const url   = require('url');

const SUPABASE_URL       = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Mancano SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Estrae il project ref dall'URL
const projectRef = SUPABASE_URL.replace('https://', '').split('.')[0];
console.log('[migrate] Project ref:', projectRef);

// SQL delle due migration
const MIGRATIONS = [
  {
    name: '014_coordinator_cse',
    sql: `
CREATE TABLE IF NOT EXISTS site_coordinator_invites (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  site_id             uuid        NOT NULL REFERENCES sites(id)      ON DELETE CASCADE,
  token_hash          text        UNIQUE NOT NULL,
  coordinator_name    text        NOT NULL CHECK (length(trim(coordinator_name)) > 0),
  coordinator_email   text,
  coordinator_company text,
  created_by          uuid,
  expires_at          timestamptz NOT NULL,
  last_accessed_at    timestamptz,
  access_count        int         NOT NULL DEFAULT 0,
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coord_invites_token   ON site_coordinator_invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_coord_invites_site    ON site_coordinator_invites(site_id);
CREATE INDEX IF NOT EXISTS idx_coord_invites_company ON site_coordinator_invites(company_id);
CREATE TABLE IF NOT EXISTS site_coordinator_notes (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES companies(id)             ON DELETE CASCADE,
  site_id          uuid        NOT NULL REFERENCES sites(id)                 ON DELETE CASCADE,
  invite_id        uuid        NOT NULL REFERENCES site_coordinator_invites(id) ON DELETE CASCADE,
  note_type        text        NOT NULL DEFAULT 'observation'
                               CHECK (note_type IN ('observation','request','approval','warning')),
  content          text        NOT NULL CHECK (length(trim(content)) >= 3),
  coordinator_name text        NOT NULL,
  is_read          boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coord_notes_site   ON site_coordinator_notes(site_id);
CREATE INDEX IF NOT EXISTS idx_coord_notes_invite ON site_coordinator_notes(invite_id);
CREATE INDEX IF NOT EXISTS idx_coord_notes_unread ON site_coordinator_notes(site_id, is_read) WHERE NOT is_read;
    `.trim(),
  },
  {
    name: '015_coordinator_rpc',
    sql: `
CREATE OR REPLACE FUNCTION increment_coord_access(p_invite_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE site_coordinator_invites
  SET access_count = access_count + 1
  WHERE id = p_invite_id;
$$;
    `.trim(),
  },
];

function httpPost(reqUrl, data, headers) {
  return new Promise((resolve, reject) => {
    const parsed  = url.parse(reqUrl);
    const body    = JSON.stringify(data);
    const options = {
      hostname: parsed.hostname,
      port:     443,
      path:     parsed.path,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runMigration(name, sql) {
  console.log(`\n[migrate] Running ${name}...`);

  // Usa Supabase Management API
  const mgmtUrl = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
  const res = await httpPost(mgmtUrl, { query: sql }, {
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  });

  if (res.status === 200 || res.status === 201) {
    console.log(`[migrate] ✓ ${name} — OK`);
    return true;
  }

  console.log(`[migrate] Management API status ${res.status}: ${res.body.slice(0, 200)}`);

  // Fallback: prova tramite RPC supabase (se esiste una funzione exec_sql)
  const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/exec_sql`;
  const rpcRes = await httpPost(rpcUrl, { sql }, {
    apikey:        SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  });

  if (rpcRes.status === 200 || rpcRes.status === 201) {
    console.log(`[migrate] ✓ ${name} via exec_sql — OK`);
    return true;
  }

  console.log(`[migrate] exec_sql status ${rpcRes.status}: ${rpcRes.body.slice(0, 200)}`);
  return false;
}

async function main() {
  let allOk = true;
  for (const m of MIGRATIONS) {
    const ok = await runMigration(m.name, m.sql);
    if (!ok) allOk = false;
  }
  if (allOk) {
    console.log('\n[migrate] ✓ Tutte le migration completate con successo.');
  } else {
    console.error('\n[migrate] ✗ Alcune migration non riuscite — esegui manualmente su Supabase SQL Editor.');
    process.exit(1);
  }
}

main().catch(e => { console.error('[migrate] Errore fatale:', e); process.exit(1); });
