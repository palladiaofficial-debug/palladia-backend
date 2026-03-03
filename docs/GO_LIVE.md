# GO LIVE — Palladia Backend + Frontend
> Checklist operativa · stimato ~30 minuti · aggiornato 2026-03-03

---

## 0. Verifica pre-deploy (da fare ADESSO sul repo locale)

```bash
# 1. migration 005 esiste
ls migrations/005_punch_atomic.sql          # deve comparire

# 2. scan.js usa SOLO rpc('punch_atomic') — zero fallback read-then-insert
grep -n "punch_atomic" routes/v1/scan.js    # deve trovare riga ~383
grep -n "presence_logs" routes/v1/scan.js   # NON deve trovare nessun INSERT diretto

# 3. CORS include X-Company-Id
grep "X-Company-Id" server.js               # deve comparire in allowedHeaders

# 4. syntax check
node --check server.js && echo OK
```

**Risultati attesi:**
- `005_punch_atomic.sql` esiste ✓
- `punch_atomic` trovato in scan.js a riga ~383 ✓
- Nessun `INSERT INTO presence_logs` diretto in scan.js ✓
- `X-Company-Id` presente in server.js ✓

---

## 1. SUPABASE — Eseguire migration 005

### Dove incollare

1. Apri [Supabase Dashboard](https://supabase.com/dashboard) → progetto **uijquqdnsvzahrtbnnvh**
2. Sidebar sinistra → **SQL Editor** → **+ New query**
3. Incolla l'intero contenuto di `migrations/005_punch_atomic.sql`
4. Clicca **Run** (▶)

### Verifica immediata (nella stessa SQL Editor)

```sql
-- Verifica che la funzione esista
SELECT proname, prosecdef
FROM pg_proc
WHERE proname = 'punch_atomic';
-- Risultato atteso: 1 riga — proname=punch_atomic, prosecdef=true

-- Test funzionale (sostituisci con UUID reali dal tuo DB)
-- Se non hai UUID reali, salta — il test curl al punto 3 è sufficiente
SELECT punch_atomic(
  '00000000-0000-0000-0000-000000000001'::uuid,  -- site_id
  '00000000-0000-0000-0000-000000000002'::uuid,  -- worker_id
  '00000000-0000-0000-0000-000000000003'::uuid,  -- company_id
  '00000000-0000-0000-0000-000000000004'::uuid,  -- session_id
  45.4654, 9.1859, 12, 8.5, '127.0.0.1', 'test'
);
-- Se i UUID non esistono come FK ritorna errore FK violation — è corretto.
-- Serve solo verificare che la funzione sia stata creata.
```

### Verifica append-only trigger (migration 003)

```sql
-- Deve esistere il trigger che blocca UPDATE/DELETE su presence_logs
SELECT trigger_name
FROM information_schema.triggers
WHERE event_object_table = 'presence_logs';
-- Atteso: _presence_logs_append_only
```

---

## 2. RAILWAY — Env vars + redeploy

### Pannello Railway
1. Apri [Railway Dashboard](https://railway.app) → progetto Palladia → servizio backend
2. Vai su **Variables** (tab)

### Variabili OBBLIGATORIE (devono essere presenti)

| Variabile | Descrizione | Dove trovare il valore |
|-----------|-------------|------------------------|
| `SUPABASE_URL` | URL progetto Supabase | Dashboard Supabase → Settings → API → Project URL |
| `SUPABASE_KEY` | **Service role key** (NON anon key) | Dashboard Supabase → Settings → API → `service_role` (secret) |
| `QR_SIGNING_SECRET` | Segreto HMAC per firmare token QR | Genera: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PIN_SIGNING_SECRET` | Segreto HMAC per hash PIN cantiere | Genera: stessa riga sopra (valore diverso!) |
| `NODE_ENV` | Ambiente | `production` |

### Variabili OPZIONALI

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `RESEND_API_KEY` | — | Email transazionali (welcome). Se assente le email sono silenziosamente saltate |
| `APP_BASE_URL` | — | URL frontend (es. `https://palladia.vercel.app`). Usato per generare link QR |
| `GPS_MAX_ACCURACY_M` | `80` | Soglia max precisione GPS per timbrature (metri) |
| `GPS_ACCURACY_REQUIRE_MODE` | `strict` | `strict` (default) = accuracy obbligatoria · `compat` = tollerata assenza (solo rollout) |
| `QR_TOKEN_TTL_SECS` | `604800` | TTL link QR in secondi (default 7 giorni) |
| `PDF_DEBUG` | `false` | Log overflow elementi PDF — solo debug locale |
| `ANTHROPIC_API_KEY` | — | Per generazione POS AI |
| `PORT` | `3001` | Railway di solito imposta PORT automaticamente |

### Come generare i secret

```bash
# Sul tuo terminale locale (Node.js)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Esegui DUE VOLTE: uno per QR_SIGNING_SECRET, uno per PIN_SIGNING_SECRET
```

### Redeploy

Dopo aver salvato le variabili:
- Railway → **Deploy** tab → **Redeploy** (o `git push` che triggera auto-deploy)
- Attendi che i log Railway mostrino `Server listening on port XXXX`

---

## 3. VERCEL — Redeploy + env check

### Env vars su Vercel
1. Apri [Vercel Dashboard](https://vercel.com) → progetto Palladia → **Settings** → **Environment Variables**
2. Verifica che esistano:

| Variabile | Valore atteso |
|-----------|---------------|
| `VITE_SUPABASE_URL` | `https://uijquqdnsvzahrtbnnvh.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | anon key da Supabase → Settings → API |
| `VITE_API_BASE_URL` | URL Railway del backend (es. `https://palladia-backend.up.railway.app`) |

### Redeploy Vercel

```bash
# Dalla root del frontend
git push origin main
# Vercel triggera auto-deploy — attendi build verde nella dashboard
```

Oppure manualmente: Vercel Dashboard → Deployments → **Redeploy** sull'ultimo commit.

---

## 4. SMOKE TEST — 6 comandi curl

> Sostituisci le variabili con i valori reali prima di eseguire.
> `$BACKEND` = URL Railway (es. `https://palladia-backend.up.railway.app`)

```bash
# Variabili di comodo — imposta prima di procedere
BACKEND="https://palladia-backend.up.railway.app"
SITE_ID="<uuid-cantiere-esistente>"
JWT="<supabase-jwt-dal-browser>"          # F12 → Application → localStorage → sb-xxx-auth-token → access_token
COMPANY_ID="<uuid-azienda>"               # localStorage → palladia_company_id
WORKER_CF="RSSMRA80A01H501Z"              # CF lavoratore di test

# ── Test 1: info cantiere (endpoint pubblico) ─────────────────────────────
curl -s "$BACKEND/api/v1/scan/worksites/$SITE_ID" | jq .
# Atteso: {"id":"...","name":"...","geofence_radius_m":...,"has_geofence":true/false,...}
# Errore: 404 WORKSITE_NOT_FOUND → SITE_ID sbagliato

# ── Test 2: identify (CF → session token) ────────────────────────────────
SESSION_JSON=$(curl -s -X POST "$BACKEND/api/v1/scan/identify" \
  -H "Content-Type: application/json" \
  -d "{\"worksite_id\":\"$SITE_ID\",\"fiscal_code\":\"$WORKER_CF\"}")
echo $SESSION_JSON | jq .
SESSION_TOKEN=$(echo $SESSION_JSON | jq -r .session_token)
# Atteso: {"session_token":"<64-hex>","worker_name":"...","expires_in_days":60}
# Se 403 INVALID_PIN → il cantiere ha PIN configurato, aggiungere "pin_code":"XXXX" nel body

# ── Test 3: punch (timbratura singola) ────────────────────────────────────
curl -s -X POST "$BACKEND/api/v1/scan/punch" \
  -H "Content-Type: application/json" \
  -d "{
    \"worksite_id\":\"$SITE_ID\",
    \"session_token\":\"$SESSION_TOKEN\",
    \"latitude\":45.4654,
    \"longitude\":9.1859,
    \"gps_accuracy_m\":12.5
  }" | jq .
# Atteso: {"event_type":"ENTRY","timestamp_server":"...","distance_m":...}
# Se 403 OUTSIDE_GEOFENCE → coordinate fuori dal raggio → usa lat/lon del cantiere (±0.0001°)
# Se 422 GEOFENCE_NOT_CONFIGURED → il cantiere non ha lat/lon → configurarle in Supabase

# ── Test 4: punch doppio simultaneo (no duplicati, race-condition safe) ───
# Invia 2 punch in parallelo — uno deve vincere, l'altro deve ricevere 429 PUNCH_TOO_SOON
curl -s -X POST "$BACKEND/api/v1/scan/punch" \
  -H "Content-Type: application/json" \
  -d "{\"worksite_id\":\"$SITE_ID\",\"session_token\":\"$SESSION_TOKEN\",\"latitude\":45.4654,\"longitude\":9.1859,\"gps_accuracy_m\":12.5}" &
curl -s -X POST "$BACKEND/api/v1/scan/punch" \
  -H "Content-Type: application/json" \
  -d "{\"worksite_id\":\"$SITE_ID\",\"session_token\":\"$SESSION_TOKEN\",\"latitude\":45.4654,\"longitude\":9.1859,\"gps_accuracy_m\":12.5}" &
wait
# Atteso: una response {"event_type":"EXIT",...} + una response {"error":"PUNCH_TOO_SOON","retry_after_secs":...}
# Se ENTRAMBE ritornano event_type → race condition NON risolta (migration 005 non eseguita!)

# ── Test 5: report presenze PDF ────────────────────────────────────────────
DATE_FROM=$(date -d "7 days ago" +%Y-%m-%d 2>/dev/null || date -v-7d +%Y-%m-%d)
DATE_TO=$(date +%Y-%m-%d)
curl -s -o /tmp/presenze.pdf \
  -H "Authorization: Bearer $JWT" \
  -H "X-Company-Id: $COMPANY_ID" \
  "$BACKEND/api/v1/reports/sites/$SITE_ID/presenze?from=$DATE_FROM&to=$DATE_TO"
file /tmp/presenze.pdf
# Atteso: /tmp/presenze.pdf: PDF document — se 0 byte o JSON → vedere errore nel body

# ── Test 6: QR link firmato (endpoint privato) ─────────────────────────────
curl -s \
  -H "Authorization: Bearer $JWT" \
  -H "X-Company-Id: $COMPANY_ID" \
  "$BACKEND/api/v1/sites/$SITE_ID/qr-link" | jq .
# Atteso: {"url":"...","token":"<64-hex>","exp":...,"expiresAt":"...","ttlDays":7}
# Se 404 SITE_NOT_FOUND_OR_FORBIDDEN → SITE_ID non appartiene a COMPANY_ID
```

### Verifica DB post-test (Supabase SQL Editor)

```sql
-- Conta i log creati
SELECT COUNT(*), event_type
FROM presence_logs
WHERE site_id = '<SITE_ID>'
GROUP BY event_type;
-- Atteso: almeno 1 ENTRY + 1 EXIT (o solo ENTRY se hai fatto 1 punch)

-- Verifica append-only: nessuno deve poter fare UPDATE/DELETE
UPDATE presence_logs SET event_type = 'ENTRY' WHERE id = (SELECT id FROM presence_logs LIMIT 1);
-- DEVE fallire con: "ERROR: presence_logs is append-only"

DELETE FROM presence_logs WHERE id = (SELECT id FROM presence_logs LIMIT 1);
-- DEVE fallire con: "ERROR: presence_logs is append-only"
```

---

## 5. ROLLBACK — Se qualcosa va male

### Scenario A — Bug nel backend (non legato a migration)

```bash
cd /path/to/palladia-backend

# Torna al commit precedente (SENZA toccare il DB)
git log --oneline -5          # identifica il commit precedente buono
git revert HEAD               # crea un commit di revert (sicuro, reversibile)
# oppure, se sei sicuro:
git reset --hard <commit-sha> # distruttivo — solo se il commit non è in produzione

# Redeploy su Railway
git push origin main          # triggera auto-deploy Railway
```

### Scenario B — Migration 005 causa problemi (altamente improbabile — la funzione è SECURITY DEFINER + CREATE OR REPLACE)

```sql
-- Opzione 1: DROP e ricreare senza la funzione (temporaneo)
-- Il backend torna al vecchio comportamento NON atomico
DROP FUNCTION IF EXISTS punch_atomic(uuid,uuid,uuid,uuid,double precision,double precision,integer,numeric,text,text);
-- ATTENZIONE: i punch tornano non-atomici. Usare solo come misura temporanea di emergenza.

-- Opzione 2 (preferita): fix e ricrea con CREATE OR REPLACE
-- Modifica il file migrations/005_punch_atomic.sql e ri-eseguilo in SQL Editor
```

### Scenario C — Frontend rotto (Vercel)

Vercel Dashboard → Deployments → seleziona il deployment precedente → **Promote to Production**
(rollback immediato, zero downtime)

### Scenario D — Env var sbagliata su Railway

Railway → Variables → correggi → **Redeploy**
Il backend si riavvia in ~30 secondi.

### Scenario E — CORS ancora bloccato dopo deploy

```bash
# Verifica che il deploy sia andato a buon fine
curl -s -I -X OPTIONS \
  -H "Origin: https://palladia.vercel.app" \
  -H "Access-Control-Request-Headers: X-Company-Id,Authorization" \
  "$BACKEND/api/v1/workers"
# Atteso: Access-Control-Allow-Headers deve contenere X-Company-Id
# Se mancante → Railway non ha ancora deployato la versione aggiornata
```

---

## 6. CHECKLIST RAPIDA go/no-go

```
SUPABASE
[ ] Migration 005 eseguita → SELECT proname FROM pg_proc WHERE proname='punch_atomic' ritorna 1 riga
[ ] Trigger append-only attivo → SELECT da information_schema.triggers su presence_logs
[ ] RLS policies attive su companies, company_users, workers, sites

RAILWAY
[ ] SUPABASE_URL impostata
[ ] SUPABASE_KEY impostata (service role, NON anon)
[ ] QR_SIGNING_SECRET impostata (≥32 char random)
[ ] PIN_SIGNING_SECRET impostata (≥32 char random, diverso da QR)
[ ] NODE_ENV=production
[ ] Log Railway: "Server listening on port ..."

VERCEL
[ ] VITE_SUPABASE_URL impostata
[ ] VITE_SUPABASE_ANON_KEY impostata
[ ] VITE_API_BASE_URL punta al backend Railway
[ ] Build verde nella Vercel dashboard

SMOKE TEST
[ ] Test 1 (GET worksites) → 200
[ ] Test 2 (identify) → session_token ricevuto
[ ] Test 3 (punch singolo) → event_type ENTRY
[ ] Test 4 (punch doppio) → 1 OK + 1 PUNCH_TOO_SOON (race condition safe ✓)
[ ] Test 5 (PDF presenze) → file PDF valido
[ ] Test 6 (QR link) → url con token 64-hex

DB SANITY
[ ] COUNT presence_logs > 0 dopo i test
[ ] UPDATE presence_logs → fallisce con append-only error
[ ] DELETE presence_logs → fallisce con append-only error
```

---

*Documento generato automaticamente dall'audit di sicurezza — 2026-03-03.*
*Non include credenziali. I valori `<placeholder>` devono essere sostituiti prima dell'uso.*
