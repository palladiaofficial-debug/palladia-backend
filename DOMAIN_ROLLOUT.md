# Palladia — Domain Rollout Checklist

Questo file descrive tutti i passaggi per attivare il dominio `palladia.net` in produzione.
Esegui i passi nell'ordine indicato.

---

## 1. Registrar DNS

Prima di tutto, configura i DNS sul tuo registrar (es. Namecheap, GoDaddy, ecc.).

Vercel ti fornirà i valori esatti dopo che aggiungi il dominio (vedi passo 2), ma la struttura standard è:

| Tipo  | Nome | Valore                        | Note                          |
|-------|------|-------------------------------|-------------------------------|
| A     | @    | `76.76.21.21`                 | IP Vercel per il root domain  |
| CNAME | www  | `cname.vercel-dns.com`        | Redirect www → root           |

> I valori IP/CNAME esatti li trovi in Vercel dopo aver aggiunto il dominio.
> Se il tuo registrar non supporta CNAME sul root, usa un record ALIAS o ANAME.

---

## 2. Vercel (Frontend)

1. Vai su [vercel.com](https://vercel.com) → il tuo progetto Palladia frontend
2. **Settings → Domains → Add**
3. Inserisci `palladia.net`
4. Vercel mostrerà i record DNS da aggiungere (vedi passo 1)
5. Aggiungi anche `www.palladia.net` se vuoi il redirect automatico
6. Aspetta la verifica DNS (può richiedere fino a 24h, di solito pochi minuti)
7. Una volta verificato, Vercel rilascia automaticamente il certificato SSL

**Variabili env Vercel da aggiornare dopo l'attivazione del dominio:**

```
VITE_APP_URL=https://palladia.net
VITE_API_URL=https://palladia-backend-production.up.railway.app
```

> Le variabili che iniziano con `VITE_` sono pubbliche e incluse nel bundle frontend.

---

## 3. Supabase

1. Vai su [app.supabase.com](https://app.supabase.com) → il tuo progetto → **Authentication → URL Configuration**
2. **Site URL**: cambia in `https://palladia.net`
3. **Redirect URLs**: aggiungi questi URL (uno per riga):
   ```
   https://palladia.net/login
   https://palladia.net/auth/callback
   https://www.palladia.net/login
   https://www.palladia.net/auth/callback
   ```
   > Puoi lasciare anche i vecchi URL Vercel durante la transizione per non rompere le sessioni esistenti.

4. Clicca **Save**

---

## 4. Railway (Backend)

1. Vai su [railway.app](https://railway.app) → il tuo progetto → **Variables**
2. Aggiorna o aggiungi queste variabili:

   | Variabile      | Valore produzione             |
   |----------------|-------------------------------|
   | `APP_BASE_URL` | `https://palladia.net`        |
   | `FRONTEND_URL` | `https://palladia.net`        |

3. Railway fa il redeploy automatico dopo aver salvato le variabili
4. Verifica che il deploy sia andato a buon fine nel tab **Deployments**

> `APP_BASE_URL` è usato per i link QR e i link per gli ispettori ASL.
> `FRONTEND_URL` è usato per i redirect di Stripe (checkout success/cancel).

---

## 5. Resend (Email — da fare quando si configura il dominio email)

Quando vuoi inviare email da `noreply@palladia.net` invece di `onboarding@resend.dev`:

1. Vai su [resend.com](https://resend.com) → **Domains → Add Domain**
2. Inserisci `palladia.net`
3. Resend fornirà dei record DNS da aggiungere sul registrar:
   - Record **SPF** (TXT su `@`)
   - Record **DKIM** (TXT su un sottodominio tipo `resend._domainkey`)
   - Record **DMARC** (TXT su `_dmarc`) — opzionale ma consigliato
4. Aggiungi i record e attendi la verifica
5. Una volta verificato, su Railway aggiorna:
   ```
   RESEND_FROM=Palladia <noreply@palladia.net>
   ```

---

## 6. Test Finali

Esegui questi test nell'ordine dopo aver completato tutti i passi:

- [ ] `https://palladia.net` carica la landing page
- [ ] `https://www.palladia.net` fa redirect a `https://palladia.net`
- [ ] Login con email funziona e porta alla dashboard
- [ ] Login con Google OAuth funziona e torna su `https://palladia.net/login`
- [ ] La dashboard carica dati reali (cantieri, lavoratori)
- [ ] Genera un QR per un cantiere → il link nel PDF usa `palladia.net`
- [ ] Scansiona il QR → la pagina di timbratura si apre correttamente
- [ ] Genera un PDF POS → si scarica correttamente
- [ ] Checkout Stripe → success redirect torna su `https://palladia.net`
- [ ] Email di benvenuto → il link "Apri la dashboard" punta a `palladia.net`

---

## Architettura URL finale in produzione

```
Frontend (Vercel)    →  https://palladia.net
Backend  (Railway)   →  https://palladia-backend-production.up.railway.app
QR links             →  https://palladia.net/scan/<siteId>?t=<hmac>&exp=<unix>
ASL links            →  https://palladia.net/asl/<token>
Email links          →  https://palladia.net/dashboard
Stripe redirects     →  https://palladia.net/billing/success
                        https://palladia.net/billing/cancel
Webhook Stripe       →  https://palladia-backend-production.up.railway.app/api/webhooks/stripe
```
