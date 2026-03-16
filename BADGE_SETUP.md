# Badge Digitale — Come testare in 5 minuti

Guida rapida per portare online le timbrature GPS da smartphone.

---

## Prerequisiti

| Cosa | Come ottenerlo |
|---|---|
| Server backend attivo | `node server.js` o Railway deploy |
| Database Supabase con migrazioni applicate | `001` → `002` → `003` → `004_gps_accuracy.sql` |
| `PIN_SIGNING_SECRET` in `.env` | Almeno 32 caratteri casuali |
| Un utente Supabase Auth | Creare via dashboard Supabase |

---

## Step 1 — Crea la company e associa l'utente

Eseguire in Supabase SQL Editor (sostituire i valori):

```sql
-- 1. Crea company
INSERT INTO companies (name) VALUES ('Palladia Srl')
RETURNING id;  -- copia questo UUID

-- 2. Associa il tuo utente come owner
-- (user_id = UUID dell'utente in auth.users)
INSERT INTO company_users (company_id, user_id, role)
VALUES ('<company-uuid>', '<user-uuid>', 'owner');
```

---

## Step 2 — Crea un cantiere con coordinate GPS

```sql
-- 3. Crea cantiere (se non esiste già)
INSERT INTO sites (company_id, name, address)
VALUES ('<company-uuid>', 'Cantiere Test', 'Via Roma 1, Milano')
RETURNING id;  -- copia questo UUID
```

Oppure usare il pannello `/setup` (vedi Step 3).

---

## Step 3 — Configura GPS e PIN via browser

1. Aprire `https://<tuo-server>/setup` su PC o tablet
2. **JWT**: copiare il token di sessione dal pannello Palladia
   - Metodo rapido: aprire Supabase Auth > Users > clic sul tuo utente > copiare il JWT dalla richiesta API
3. **Company ID**: incollare l'UUID copiato al Step 1
4. Cliccare **"Verifica e carica cantieri"** → appare la lista cantieri
5. Selezionare il cantiere → si apre il pannello configurazione
6. Cliccare **"Rileva posizione GPS attuale"** (deve essere sul luogo del cantiere o inserire manualmente)
7. Impostare il raggio geofence (default 100m — aumentare per cantieri grandi)
8. Cliccare **"Salva coordinate"**
9. *(Opzionale)* Inserire un PIN e cliccare **"Salva PIN"**
10. Copiare il **Link scan badge** mostrato in fondo

---

## Step 4 — Testa la timbratura da smartphone

1. Aprire il link copiato sullo smartphone:
   `https://<tuo-server>/scan/<worksite-uuid>`
2. La pagina mostra il nome del cantiere
3. Inserire il proprio **Codice Fiscale** (16 caratteri) → "Continua"
   - Se è il primo accesso: inserire nome completo e PIN cantiere
4. Comparirà il nome del lavoratore con il pulsante **"Timbra entrata / uscita"**
5. Il browser chiederà il permesso GPS → concederlo
6. Premere il pulsante → la schermata mostrerà ENTRATA 🟢 o USCITA 🔴
7. Premere di nuovo dopo 60 secondi → evento opposto

---

## Step 5 — Verifica nel database

```sql
-- Ultimi log presenze
SELECT worker_id, event_type, timestamp_server, distance_m, method
FROM presence_logs
ORDER BY timestamp_server DESC
LIMIT 10;
```

---

## Step 6 — Test automatici (opzionale)

```bash
# Env necessarie
export TEST_BASE_URL=http://localhost:3001
export TEST_WORKSITE_ID=<worksite-uuid>
export TEST_PIN=1234          # se impostato
export SUPABASE_URL=...
export SUPABASE_KEY=...       # service role key

node scripts/selftest_scan.js
# Risultato atteso: 9/9 test passati
```

---

## Endpoint disponibili

### Pubblici (no auth)
| Metodo | Path | Descrizione |
|---|---|---|
| `GET` | `/api/v1/scan/worksites/:id` | Info cantiere (no dati sensibili) |
| `POST` | `/api/v1/scan/identify` | Identifica lavoratore, ritorna session token |
| `POST` | `/api/v1/scan/punch` | Timbra ENTRATA/USCITA (GPS + geofence obbligatori) |

### Privati (JWT + X-Company-Id)
| Metodo | Path | Descrizione |
|---|---|---|
| `GET` | `/api/v1/sites` | Lista cantieri della company |
| `PATCH` | `/api/v1/sites/:id/coords` | Imposta lat/lon + raggio geofence |
| `PATCH` | `/api/v1/sites/:id/pin` | Imposta o rimuove il PIN |
| `GET` | `/api/v1/presence` | Registro presenze (filtro per cantiere/data) |
| `GET` | `/api/v1/reports/presence` | Export CSV presenze |

---

## Pagine web

| URL | Descrizione |
|---|---|
| `/scan/:worksiteId` | Pagina timbratura operaio (mobile-first) |
| `/setup` | Setup tecnico (GPS + PIN, interno) |

---

## Variabili d'ambiente richieste

```env
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_KEY=<service_role_key>          # NON la anon key
PIN_SIGNING_SECRET=<almeno-32-char-casuali>
QR_SIGNING_SECRET=<almeno-32-char-casuali>
GPS_MAX_ACCURACY_M=80                    # opzionale — default 80m
GPS_ACCURACY_REQUIRE_MODE=strict         # 'strict' (default) | 'compat' — vedi Rollout
PORT=3001
```

---

## Ordine di deploy (aggiornamento gps_accuracy_m)

### Prima installazione (da zero)

1. **Applica migration** — Supabase SQL Editor:
   ```sql
   -- da migrations/004_gps_accuracy.sql
   ALTER TABLE presence_logs ADD COLUMN IF NOT EXISTS gps_accuracy_m numeric(8,2);
   ```
2. **Deploy backend** con `GPS_ACCURACY_REQUIRE_MODE=strict` (default)
3. **Deploy frontend** — `public/scan.html` inizia a inviare `gps_accuracy_m` nel payload
4. **Verifica selftest**:
   ```bash
   node scripts/selftest_scan.js
   # Atteso: 9/9 test passati
   ```

---

### Rollout senza downtime (compat window)

Se backend e frontend **non vengono deployati nello stesso istante**, usare la finestra
di compatibilità per evitare che i client vecchi (senza `gps_accuracy_m`) ricevano 422.

**Comportamento modalità `compat`**: se `gps_accuracy_m` manca nel corpo del punch,
**nessuna riga viene scritta in `presence_logs`** — il backend risponde **202** con
`{ warning: "GPS_ACCURACY_MISSING", action: "REFRESH_REQUIRED" }` e la UI mostra
un prompt di ricarica pagina. I valori non validi o fuori soglia continuano
a produrre **422** in entrambe le modalità.

**Procedura**:

```
1. Imposta ENV  GPS_ACCURACY_REQUIRE_MODE=compat  nel backend
2. Deploy backend   → i client vecchi timbrano con gps_accuracy_m NULL + warning
3. Deploy frontend  → i client nuovi iniziano a inviare gps_accuracy_m
4. Verifica selftest in modalità compat:
      GPS_ACCURACY_REQUIRE_MODE=compat node scripts/selftest_scan.js
      # Atteso: 9/9 test passati (test 3 usa asserzioni compat)
5. Imposta ENV  GPS_ACCURACY_REQUIRE_MODE=strict  nel backend
6. Verifica selftest in modalità strict:
      node scripts/selftest_scan.js
      # Atteso: 9/9 test passati (test 3 usa asserzioni strict)
```

> **Nota**: i record con `gps_accuracy_m = NULL` scritti durante la compat window
> sono validi per audit — indicano che la timbratura è avvenuta senza dato di precisione.
> Dopo il passaggio a `strict`, qualunque client non aggiornato riceverà **422**.

---

## Sicurezza — Note per il deploy

- `PIN_SIGNING_SECRET` e `QR_SIGNING_SECRET`: generare con `openssl rand -hex 32`
- Il backend usa la **service_role key** (bypass RLS) → non esporre mai al client
- Il trigger `_presence_logs_append_only` blocca UPDATE/DELETE anche con service_role
- `company_id` è sempre derivato dal DB, mai accettato dal client
- `event_type` (ENTRATA/USCITA) è determinato server-side, mai accettato dal client
- Il session token raw (64 hex) è salvato **solo** in localStorage; nel DB viene
  conservato esclusivamente il suo SHA-256 hash
- La geofence è **obbligatoria**: configurare lat/lon prima di abilitare le timbrature
- `gps_accuracy_m > GPS_MAX_ACCURACY_M` blocca la timbratura server-side (source of truth);
  la UI disabilita il pulsante solo come UX, non come sicurezza
