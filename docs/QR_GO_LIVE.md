# QR Timbratura — Go Live Checklist

> Segui gli STEP in ordine. Le azioni manuali inevitabili sono chiaramente indicate.

---

## STEP 1 — SQL Supabase (incolla in SQL Editor, in ordine)

Vai su **Supabase → SQL Editor**.
Esegui i blocchi seguenti uno alla volta, nell'ordine indicato.
Ogni script è idempotente (puoi rieseguirlo se necessario).

---

### 1a — Migration 002: schema multi-tenant

> **Prerequisito**: la tabella `sites` deve già esistere (migration 001).
> **ATTENZIONE**: fa DROP CASCADE di workers/presence_logs/worksite_workers — usa solo su DB vuoto o dopo backup.

Incolla il contenuto di `migrations/002_multi_tenant.sql` (già presente nel repo).

---

### 1b — Migration 003: append-only trigger + colonna pin_hash

```sql
-- Trigger che blocca UPDATE/DELETE su presence_logs a livello DB (funziona anche con service_role)
CREATE OR REPLACE FUNCTION _presence_logs_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'presence_logs is append-only: % not allowed', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS tg_presence_no_update ON presence_logs;
DROP TRIGGER IF EXISTS tg_presence_no_delete ON presence_logs;

CREATE TRIGGER tg_presence_no_update
  BEFORE UPDATE ON presence_logs FOR EACH ROW EXECUTE FUNCTION _presence_logs_append_only();

CREATE TRIGGER tg_presence_no_delete
  BEFORE DELETE ON presence_logs FOR EACH ROW EXECUTE FUNCTION _presence_logs_append_only();

-- Colonna pin sicuro (HMAC-SHA256 del PIN, mai in plaintext)
ALTER TABLE sites ADD COLUMN IF NOT EXISTS pin_hash text;
```

---

### 1c — Migration 004: colonna gps_accuracy_m su presence_logs

```sql
ALTER TABLE presence_logs
  ADD COLUMN IF NOT EXISTS gps_accuracy_m numeric(8,2);
```

---

### 1d — Migration 005: funzione punch_atomic (race-condition proof)

Incolla il contenuto completo di `migrations/005_punch_atomic.sql` (già presente nel repo).

La funzione:
- acquisisce `pg_advisory_xact_lock(worker_hash, site_hash)`
- legge l'ultimo punch dentro il lock (no race condition)
- determina event_type server-side (ENTRY→EXIT→ENTRY...)
- fa INSERT in `presence_logs` dentro la stessa transaction

---

### 1e — Crea company e aggiungi te come owner

> **Sostituisci** `TUO-USER-UUID` con il tuo `auth.users.id` (visibile in Supabase → Authentication → Users).

```sql
-- Crea la company (o usa una esistente)
INSERT INTO companies (name)
VALUES ('Palladia Srl')
RETURNING id;
-- ↑ Copia l'UUID restituito come COMPANY_ID

-- Aggiungi te come owner (sostituisci entrambi gli UUID)
INSERT INTO company_users (company_id, user_id, role)
VALUES (
  'COMPANY-UUID-QUI',   -- UUID restituito dallo step precedente
  'TUO-USER-UUID',      -- il tuo auth.users.id
  'owner'
);
```

---

### 1f — Collega i cantieri esistenti alla company

Se hai già cantieri in `sites` senza `company_id`:

```sql
UPDATE sites
SET company_id = 'COMPANY-UUID-QUI'
WHERE company_id IS NULL;
```

---

### 1g — Imposta lat/lon/geofence_radius su ogni cantiere (OBBLIGATORIO per punch)

Il punch è bloccato se il cantiere non ha coordinate GPS.

```sql
UPDATE sites
SET
  latitude          = 45.4654,   -- sostituisci con lat reale
  longitude         = 9.1866,    -- sostituisci con lon reale
  geofence_radius_m = 120        -- raggio in metri (default 120)
WHERE id = 'SITE-UUID-QUI';
```

---

### 1h — (Opzionale) Imposta PIN cantiere

Usa lo script Node.js (richiede backend running con `PIN_SIGNING_SECRET` impostata):

```bash
node scripts/set-site-pin.js <site_uuid> <pin>
```

Oppure calcola l'hash manualmente e inseriscilo:

```sql
-- dopo aver calcolato pin_hash con: node -e "
--   const c = require('crypto');
--   console.log(c.createHmac('sha256','TUO-PIN-SIGNING-SECRET').update('IL-PIN').digest('hex'));
-- "
UPDATE sites SET pin_hash = 'HASH-QUI' WHERE id = 'SITE-UUID-QUI';
```

---

## STEP 2 — Variabili Railway (backend)

Vai su **Railway → progetto backend → Variables**.

| Nome variabile | Valore | Note |
|---|---|---|
| `SUPABASE_URL` | `https://xxxx.supabase.co` | Supabase → Settings → API → Project URL |
| `SUPABASE_KEY` | `sb_publishable_...` o service_role key | Supabase → Settings → API → service_role secret |
| `QR_SIGNING_SECRET` | stringa random 64 hex chars | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PIN_SIGNING_SECRET` | stringa random 64 hex chars | come sopra |
| `APP_BASE_URL` | `https://palladia-kappa.vercel.app` | dominio Vercel del frontend — senza slash finale |
| `QR_TOKEN_TTL_SECS` | `604800` | facoltativo, default 7 giorni |
| `GPS_MAX_ACCURACY_M` | `80` | facoltativo, default 80m |
| `GPS_ACCURACY_REQUIRE_MODE` | `strict` | facoltativo, default strict |

> **IMPORTANTE**: `SUPABASE_KEY` deve essere la **service_role** key (non la anon key), perché il backend bypassa RLS.
> Non usare i valori del `.env` locale come fonte di verità — il `.env` è in `.gitignore` e non viene deployato.

---

## STEP 3 — Variabili Vercel (frontend)

Vai su **Vercel → progetto frontend → Settings → Environment Variables**.

| Nome variabile | Valore | Note |
|---|---|---|
| `VITE_BACKEND_URL` | `https://tuo-backend.up.railway.app` | URL Railway del backend — senza slash finale |
| `VITE_SUPABASE_URL` | `https://xxxx.supabase.co` | stesso valore di SUPABASE_URL |
| `VITE_SUPABASE_ANON_KEY` | `eyJ...` | Supabase → Settings → API → anon public |

Dopo aver impostato le variabili, fai un **Redeploy** (Vercel → Deployments → Redeploy).

---

## STEP 4 — Test manuale end-to-end dal telefono

1. **Login admin**: apri `https://palladia-kappa.vercel.app` → login → dashboard
2. **Apri un cantiere**: naviga su `/cantieri/:siteId` (il cantiere deve avere `company_id` e lat/lon impostati)
3. **Genera QR**: nella sidebar destra apparirà il QR code (attendi caricamento)
4. **Scansiona con telefono**: inquadra il QR — il browser del telefono apre `/scan?site=...`
5. **Identificazione**: inserisci il Codice Fiscale (16 caratteri) → "Continua"
   - Se è il primo accesso: inserisci PIN + nome → "Continua"
6. **GPS**: concedi il permesso di geolocalizzazione quando richiesto
7. **Timbra**: premi "Timbra Presenza" → compare INGRESSO registrato con orario e distanza
8. **Verifica su Supabase**: controlla `presence_logs` che la riga sia stata inserita

---

## STEP 5 — Dove guardare se qualcosa si rompe

### Errori comuni e diagnosi

| Sintomo | Causa probabile | Dove guardare |
|---|---|---|
| QR non appare in SiteDetail | `VITE_BACKEND_URL` non impostata su Vercel | DevTools → Network → chiamata a `/api/v1/sites/:id/qr-link` |
| QR appare ma scansione non funziona | `APP_BASE_URL` errata su Railway | URL del QR deve iniziare con `https://palladia-kappa.vercel.app/scan?site=` |
| `/scan` dice "Sistema non ancora attivo" | `VITE_BACKEND_URL` non impostata su Vercel | Vercel → Settings → Env Vars |
| Identify → 404 WORKSITE_NOT_FOUND | Il cantiere non ha `company_id` nel DB | STEP 1f — assegna company_id |
| Punch → 422 GEOFENCE_NOT_CONFIGURED | Il cantiere non ha lat/lon | STEP 1g — imposta coordinate |
| Punch → 403 OUTSIDE_GEOFENCE | Distanza > `geofence_radius_m` | Aumenta il raggio o controlla le coordinate |
| Punch → LOG_WRITE_ERROR | `punch_atomic` RPC non esiste | STEP 1d — esegui migration 005 |
| CORS error in DevTools | Origine non in allowlist Railway | Il dominio Vercel deve essere `palladia*.vercel.app` |
| 403 COMPANY_MISMATCH | Session e cantiere appartengono a company diverse | Il cantiere non è collegato alla company corretta |

### Log Railway
- Railway → progetto backend → Logs (realtime)
- Cerca: `[punch]`, `[CORS]`, `[EMAIL]`
- Errori RPC PostgreSQL appaiono come `[punch] rpc error: ...`

### Log Supabase
- Supabase → Logs → API o Postgres
- Puoi vedere le query eseguite dal backend e i loro risultati

### Verifica RPC punch_atomic in Supabase SQL Editor
```sql
-- Testa con UUID fittizi (non salva nulla di reale se worker/site non esistono)
SELECT punch_atomic(
  gen_random_uuid(),  -- p_site_id
  gen_random_uuid(),  -- p_worker_id
  gen_random_uuid(),  -- p_company_id
  gen_random_uuid(),  -- p_session_id
  45.0, 9.0, 15, 10.5, '127.0.0.1', 'test-ua'
);
-- Se la funzione non esiste: ERROR: function punch_atomic does not exist
-- → esegui migration 005
```

---

## Riepilogo ENV obbligatorie

### Railway (backend)
```
SUPABASE_URL        ← service role access
SUPABASE_KEY        ← service_role key (NON anon)
QR_SIGNING_SECRET   ← min 32 bytes hex random
PIN_SIGNING_SECRET  ← min 32 bytes hex random
APP_BASE_URL        ← https://palladia-kappa.vercel.app
```

### Vercel (frontend)
```
VITE_BACKEND_URL    ← https://tuo-backend.up.railway.app
VITE_SUPABASE_URL   ← https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY ← chiave anon pubblica Supabase
```
