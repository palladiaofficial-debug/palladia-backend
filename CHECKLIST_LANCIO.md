# Checklist pre-lancio Palladia — test manuale, un flusso alla volta

## 🔴🔴 CRITICO — 2026-07-09: RLS disabilitato su 24 tabelle, dati cross-tenant esposti

Scoperto testando manualmente la voce di sezione 13 ("provare a modificare l'URL con
l'ID di una risorsa di un'altra company"): navigando su `/cantieri/<uuid altra company>`
da loggati, l'app mostrava i dati reali del cantiere sbagliato (nome, date, avanzamento).

Causa: `sites` in produzione aveva `relrowsecurity=false` nonostante la migrazione 002
l'avesse abilitato — disattivato a mano da SQL Editor in qualche momento imprecisato e
mai più riattivato (nessuna migrazione tracciava il rollback). Audit sistematico di
`pg_class`/`pg_policies` su tutte le 112 tabelle: **24 tabelle** con RLS disabilitato,
incluse `workers`, `presence_logs`, `worksite_workers`, `worker_device_sessions`,
`chat_conversations`, `chat_messages`, `site_documents`, `subcontractors`,
`site_nonconformities`, `user_site_assignments`, `ladia_folders` — più la policy
`companies_select` alterata a `USING (true)` (chiunque autenticato leggeva tutte le
company). `SUPABASE_URL`/`ANON_KEY` sono pubblici (`GET /api/config` — stesso schema
già visto nella migrazione 123), quindi **qualunque utente con un account Palladia
poteva leggere — e in molti casi scrivere/cancellare — i dati di tutte le altre
company** via REST API diretta a Supabase, bypassando completamente il backend.

**Verificato dal vivo** (non solo a codice): riprodotta la query esatta del frontend
con una sessione reale (`carpiooricardo@gmail.com`, company MSCedilizia) — prima del
fix vedeva tutti i 17 cantieri e 29 lavoratori del DB, di 3 company diverse, inclusa
la company reale di campo (MSCedilizia S.r.l., account `carpio@mscedilizia.it`).

**Corretto**: migrazione `129_fix_rls_gaps.sql`, applicata in produzione — RLS
riabilitato + policy `is_company_member(company_id)` su tutte le tabelle interessate
(`chat_conversations`/`ladia_folders` con vincolo aggiuntivo `user_id = auth.uid()`,
essendo dati per-utente; `prezzario_voci` reso sola-lettura pubblica perché è listino
condiviso non per-tenant by design; tabelle coordinatori esterni — keyed per email, non
company — bloccate del tutto lato client, restano accessibili solo dal backend con
service-role). Riverificato dopo il fix con la stessa sessione reale: zero accesso
cross-company su sites/workers/companies/chat_conversations, accesso alla propria
company intatto su tutte le 15 tabelle controllate.

**Ancora da fare**: retest visivo in browser delle pagine che usano le tabelle appena
ristrette (Documenti, Subappalti, Non conformità, Ladia/cartelle) per confermare che
nessuna schermata si sia rotta — il controllo automatico conferma che le query non
danno errore, ma non sostituisce un click reale.

---

## Regressione automatica 2026-07-11 — `scripts/fulltest_platform.js` contro produzione

Rilanciata la suite di smoke test esistente (94/99, non usata da un po') con una sessione
reale generata per `carpiooricardo@gmail.com` (company MSCedilizia) — stesso principio delle
verifiche precedenti: chiamate dirette contro il backend di produzione, non contro codice letto.
Copre in un colpo solo gran parte delle sezioni 5, 8, 10 (solo stato), 11 (solo lettura), 13
(riconferma) e la sicurezza multi-tenant/append-only.

I 5 test falliti sono **tutti problemi dello script, non della piattaforma** (verificato leggendo
il codice reale dietro ognuno): `/api/pdf-smoke` richiede JWT e lo script lo chiamava senza; l'endpoint
`GET /sites/:id/workers` non è mai esistito (il frontend usa `/workers?siteId=`, testato a parte e ok);
`sites/overview` restituisce un array diretto, non `{sites:[...]}`, aspettativa del test obsoleta; il
`SITE_ID` hardcoded nello script punta a un cantiere reale ora con `status='eliminato'`, per cui
`weather-log` lo rifiuta correttamente (comportamento voluto, non un bug). Trovato anche: la company di
test contiene dati fittizi residui di sessioni manuali precedenti (cantiere "yhui"/"jioo") — rumore,
non un problema, da ripulire quando capita.

Il lavoratore di test creato dallo script non è cancellabile via API (nessun `DELETE /workers/:id`
esiste, e la sua riga in `presence_logs` — creata dallo stesso test di timbratura — è bloccata
dal trigger append-only, per design). Corretto disattivandolo (`is_active=false`) invece di
cancellarlo: **conferma indiretta e utile** che disattivare un lavoratore blocca subito la
timbratura (`403 BADGE_REVOKED`), verificato per caso durante il cleanup.

Esteso il test oltre lo script esistente per chiudere due voci ancora ambigue in sezione 5:
geofence e alternanza ENTRY/EXIT non erano mai state isolate dal rate limit (60s) nello script
originale. Rifatto con attese di 65s tra le chiamate: geofence dà `403 OUTSIDE_GEOFENCE` con
distanza esplicita (non confuso col rate limit), alternanza ENTRY→EXIT→ENTRY corretta.

---

## Audit automatico 2026-07-06 — bug trovati e corretti

Verifica di sicurezza/resilienza/migrazioni fatta leggendo il codice reale (non un audit
teorico) + verifica sistematica di tutte le 131 migrazioni contro il database di produzione
collegato. Bug reali trovati e già corretti in questa sessione:

- 🔴 **IDOR corretto** — `GET /api/v1/pos/:id` (`routes/v1/pos.js`) non filtrava per
  `company_id` e saltava del tutto il controllo tenant quando `site_id` era NULL (POS non
  ancora assegnati a un cantiere). Un utente di qualunque azienda, conoscendo l'UUID, poteva
  leggere il contenuto di un POS di un'altra azienda. Corretto filtrando direttamente su
  `company_id` (colonna già esistente e popolata).
- 🔴 **Bypass abbonamento corretto** — `/api/generate-pdf` e `/api/generate-pdf-html`
  (`server.js`) generavano PDF senza verificare né la company né l'abbonamento attivo — una
  company con abbonamento scaduto poteva continuare a stampare documenti ufficiali. Aggiunto
  `verifySiteAccess` + `checkBillingActive` come sugli altri endpoint di generazione.
- 🔴 **Webhook Stripe corretto** — in caso di errore nell'aggiornamento dello stato
  abbonamento su Supabase, il webhook rispondeva comunque `200 OK` a Stripe, che quindi non
  ritentava mai la consegna — lo stato restava silenziosamente disallineato. Ora risponde
  `500` sugli errori, così Stripe ritenta secondo il suo schema automatico.
- 🟡 **Timbratura pubblica più resiliente** — `public/badge-punch.html` non aveva alcun
  timeout sul fetch: un backend lento (non offline vero) lasciava lo spinner "Registrazione…"
  girare all'infinito senza errore né coda offline. Aggiunto timeout 15s che fa scattare lo
  stesso meccanismo già esistente di coda/retry automatico usato per il vero offline.
- ✅ **Migrazione 125** (`pos_drafts.risks_content`) — non era applicata, causa reale del
  fallimento della generazione rischi POS in chat. Applicata dall'utente durante la sessione.
- ✅ **Tutte le altre 130 migrazioni verificate presenti nel DB reale** — nessun'altra colonna/
  tabella mancante trovata con lo stesso controllo sistematico.

**Ancora aperto, non risolto in questa sessione** (serve una scelta/intervento più ampio, non
un fix puntuale):
- [x] 🔴 `SENTRY_DSN` (backend/Railway) — **verificato 2026-07-06 con `railway variables`: È
  impostata in produzione.** (Correzione: un controllo precedente in questa stessa sessione
  aveva erroneamente concluso che mancasse, guardando solo l'`.env` locale invece
  dell'ambiente Railway reale — errore di metodo, non un problema vero. Non ripetere quello
  sbaglio: per verificare env di produzione usare sempre `railway variables`/`vercel env ls`,
  mai il file `.env` locale.)
- [x] 🔴 `VITE_SENTRY_DSN` (frontend/Vercel) — **verificato 2026-07-06 con `vercel link` +
  `vercel env ls production`: È impostata in produzione da 32 giorni.** Anche qui il dubbio
  iniziale era infondato — Sentry risultava già configurato correttamente su entrambi i lati.
- 🟡 Nessun timeout applicativo sul client Supabase stesso (`lib/supabase.js`) — il fix di
  sopra copre solo il fetch pubblico della timbratura, non un problema strutturale più ampio
  se Supabase rallenta su altri endpoint autenticati.
- 🟡 Bundle frontend principale ~3MB (760KB gzip), zero code-splitting per route
  (`App.tsx` non usa `React.lazy`) — impatto concreto su time-to-interactive per operai in
  cantiere con connessione mobile debole. Non bloccante per un lancio limitato, da affrontare
  prima di una scala più larga.


Regole d'uso: ogni riga si testa **cliccando davvero nell'app**, non leggendo il codice.
Segna ✅ solo se il risultato osservato coincide con quello atteso. Se qualcosa non torna,
annota cosa hai visto invece — non "sembra ok".

Priorità: 🔴 blocca il lancio se rotto — 🟡 va sistemato ma non blocca — 🟢 rifinitura.

---

## 0. Pre-requisiti ambiente (una tantum, prima di iniziare)

- [x] 🔴 `SENTRY_DSN` impostata su Railway (backend) — riverificato 2026-07-09 con `railway variables`, presente
- [x] 🔴 `VITE_SENTRY_DSN` impostata su Vercel (frontend) — riverificato 2026-07-09 con `vercel env ls production`, presente (35gg)
- [ ] 🔴 Credito Anthropic sufficiente su console.anthropic.com (Plans & Billing) — da controllare manualmente, non verificabile da CLI/API
- [x] 🔴 Migrazione `118_site_bookings.sql` applicata su Supabase — verificato 2026-07-06 con controllo sistematico di tutte le 131 migrazioni contro il DB reale
- [x] 🔴 Migrazione `119_chat_message_images.sql` applicata su Supabase — verificato 2026-07-06, vedi sopra
- [x] 🟡 Nessuna conversazione fantasma in `chat_conversations` (0 messaggi) — verificato 2026-07-09: 101 conversazioni totali, 0 senza messaggi
- [ ] 🟢 Hard refresh su tutti i dispositivi di test prima di iniziare (elimina bundle JS vecchio in cache)

---

## 1. Autenticazione e onboarding

- [ ] 🟢 (nota minore, non bloccante) Pagina login su Microsoft Edge: contenuto visivamente shiftato a sinistra invece che centrato — non riprodotto/diagnosticato (zoom 100%, nessuna sidebar Edge visibile, DevTools non ha dato il tempo di leggere `window.innerWidth`). Edge non è tra i browser usati per test (Chrome) o campo (Firefox) — da rivedere con calma, non urgente
- [x] 🔴 Registrazione nuovo utente con email reale → arriva email di conferma — verificato dal vivo 2026-07-09 (account test "Nova CS Servizi")
- [x] 🔴 Login con credenziali corrette — verificato dal vivo 2026-07-09
- [x] 🔴 Login con password sbagliata → messaggio di errore chiaro, non generico — verificato dal vivo 2026-07-09, messaggio chiaro
- [x] 🔴 Onboarding azienda: creazione company al primo accesso, nome salvato correttamente — verificato dal vivo 2026-07-09
- [x] 🔴🔴 **CRITICO trovato e corretto 2026-07-09**: Reset password — il link email autenticava l'utente completamente (accesso a dashboard/cantieri/tutto) **senza mai fargli impostare una nuova password**. La sessione di recovery di Supabase veniva trattata come un login normale. Chiunque avesse aperto quel link (email condivisa, link intercettato) entrava nell'account senza sapere alcuna password, e la vecchia password restava valida. Corretto: `AuthContext` ora distingue l'evento `PASSWORD_RECOVERY`, `ProtectedRoute` blocca ogni pagina finché la password non viene davvero cambiata, `/password-reset` mostra il form corretto in quel caso. Commit `dcaab5c` (repo frontend), pushato. **Riverificato dal vivo 2026-07-09** in incognito con un link di recovery reale: ora appare correttamente il form "Imposta una nuova password" invece di dare accesso diretto
- [x] 🟡 Logout → sessione effettivamente terminata (provare a tornare indietro col browser) — verificato dal vivo 2026-07-09, dopo logout il tasto indietro non fa rientrare
- [ ] 🟢 Redirect corretto dopo login (torna dove stava andando, non sempre alla dashboard)

---

## 2. Dashboard

- [x] 🔴 KPI mostrati (cantieri attivi, lavoratori, presenze oggi) corrispondono ai dati reali — verificato dal vivo 2026-07-09
- [ ] 🟡 Nessun errore in console browser al caricamento
- [ ] 🟢 Tempo di caricamento accettabile (< 3s su connessione normale)

---

## 3. Cantieri — lista

- [x] 🔴 Lista cantieri mostra solo quelli della company loggata (provare con 2 account diversi) — già coperto dalla verifica sezione 13 (fix RLS)
- [x] 🔴 Creazione nuovo cantiere: tutti i campi obbligatori validati, cantiere compare in lista subito dopo — validazione ok; trovato e corretto 2026-07-09 bug reale: il popup non si chiudeva dopo il salvataggio (`onClose()` mancante in `handleCreate`), restava aperto vuoto sopra la pagina del nuovo cantiere. Commit `c6f41b4` (repo frontend). Nota a parte: durante il test è comparso in console un `AuthApiError: Invalid Refresh Token` — non riprodotto in isolamento, probabile residuo delle molte sessioni di test (incognito/account multipli) di questa sessione, non un bug nuovo confermato
- [x] 🟡 Ricerca/filtro cantieri funziona — verificato dal vivo 2026-07-09
- [x] 🟡 Badge "scaduto Ngg fa" / countdown giorni rimanenti corretto rispetto alle date reali — verificato dal vivo 2026-07-09 con calcolo manuale su 2 cantieri reali, combacia esattamente. Nota minore non bloccante: un cantiere con data inizio futura (tra 5gg) risultava già "attivo" invece di "non ancora iniziato" — da confermare se è comportamento voluto

## 3a. Cantiere → tab "Cantiere" (Info)

- [x] 🔴 Dati contratto (inizio/fine) modificabili e salvati — verificato dal vivo 2026-07-09, calcoli giorni/percentuale ricontrollati a mano e corretti
- [x] 🔴 QR timbratura generato, valido, scaricabile in PDF — verificato dal vivo 2026-07-09, PDF A4 ok, QR leggibile
- [x] 🟡 "Condividi link" QR funziona — verificato dal vivo 2026-07-09, link nel formato corretto (site-id + token firmato + scadenza)
- [x] 🟡 Sospensioni giornata: aggiunta, mostrata nel calendario, **bottone ↩ annulla funziona** — verificato dal vivo 2026-07-09: aggiunta sposta correttamente la data fine di un giorno, rimozione (icona cestino, non freccia ↩ — UI diversa da quanto descritto ma funzione identica) riporta indietro correttamente
- [x] 🟡 Coordinate GPS impostabili (necessarie per meteo e geofence) — verificato dal vivo 2026-07-09
- [x] 🟢 Progress bar percentuale completamento coerente con le date — verificato dal vivo 2026-07-09 con calcolo a mano

## 3b. Cantiere → tab "Presenze"

- [x] 🔴 Presenze di oggi mostrate correttamente (chi è dentro, chi è uscito) — verificato 2026-07-09 con analisi approfondita del codice (nessun lavoratore reale disponibile per test dal vivo): `punch_atomic` (lock per worker+site, event_type deciso server-side, auto-exit su cambio cantiere) + `groupByWorker` frontend (ultimo evento determina stato) — logica corretta, nessun bug trovato
- [x] 🔴 Storico presenze per intervallo di date corretto — stessa verifica di cui sopra, riusa la stessa logica di raggruppamento
- [ ] 🟡 Export presenze PDF/CSV funziona e i dati coincidono con quelli a schermo
- [x] 🟡🔴 **Trovato e corretto 2026-07-09**: il link ASL pubblico non era generabile da nessuna parte dell'app — nessun pulsante lo richiamava, nonostante il backend (`asl.js` + `public/asl.html`) fosse completo e funzionante, e nonostante fosse pubblicizzato su landing page e piani a pagamento ("Token ASL per ispettori"). In più, anche generandolo a mano via API, l'URL puntava al dominio sbagliato (`palladia.net`, il frontend, che non ha quella rotta) invece del backend che la serve davvero. Corretti entrambi: dominio dell'URL (backend, commit `d840937`) + nuovo sub-tab "Ispettore ASL" in Presenze per generare/copiare/revocare i link (frontend, commit `283d747`). **Riverificato dal vivo 2026-07-09** (senza usare Ladia, chiamate dirette API su account reale MSCedilizia S.r.l.): token generato, poi consumato senza NESSUN header di autenticazione — pagina pubblica 200, PDF 200/61KB/`application/pdf`, CSV 200 con intestazioni corrette. Token di test revocato subito dopo

## 3c. Cantiere → tab "Organico"

- [x] 🔴 Sub-tab **Organico**: lista lavoratori assegnati corretta, aggiunta/rimozione funziona — verificato dal vivo 2026-07-09
- [x] 🔴 Sub-tab **Mezzi**: aggiunta/modifica mezzo, assegnazione a cantiere — verificato dal vivo 2026-07-09
- [x] 🔴 Sub-tab **Subappalti**: aggiunta subappaltatore, documenti associati — verificato dal vivo 2026-07-09
- [ ] 🟡 Compliance banner (idoneità/formazione lavoratori) coerente con le scadenze reali

## 3d. Cantiere → tab "Documenti"

- [x] 🔴 Upload documento: file salvato, visibile subito, scaricabile dopo — verificato dal vivo 2026-07-09
- [x] ✨ **Nuovo 2026-07-09**: i documenti caricati qui ora vengono analizzati automaticamente in background (Haiku, stesso meccanismo già esistente per company/worker_documents dalla migrazione 050) — scadenza, tipo, ente emittente, problemi rilevati pronti per Ladia senza dover rileggere il PDF ogni volta. Testato end-to-end con un PDF reale, analisi corretta. Commit `5fcfda4`. Bonus: corretto per strada `get_site_documents` (tool Ladia), che falliva sempre per colonne/tabella inesistenti (bug pre-esistente, mai notato)
- [x] 🔴 Generazione POS: **testare l'intero flusso SSE fino al PDF finale**, verificare che l'header/footer del PDF non si sovrappongano al contenuto (bug storico) — verificato dal vivo 2026-07-09, flusso completo funzionante
- [x] 🔴 **DVR/PIMUS disattivati (2026-07-06, decisione esplicita)**: nessun bottone "Genera DVR"/"Genera PIMUS" visibile in Navbar/Altro/POSList; navigando direttamente a `/dvr/nuovo` e `/pimus/nuovo` compare il messaggio "non disponibile", non il form — verificato dal vivo 2026-07-09 su `/dvr/nuovo`
- [ ] 🟡 Documenti in scadenza evidenziati correttamente

## 3e. Cantiere → tab "Diario" ⚠️ area con bug corretti oggi — testare con attenzione

- [x] 🔴 Sub-tab **Diario di Cantiere**: nota del giorno visibile, editabile, salvata — verificato dal vivo 2026-07-09
- [x] 🔴 Sub-tab **Note & Foto**: creazione nota manuale con foto allegata — **la foto resta visibile dopo un reload della pagina** — verificato dal vivo 2026-07-09
- [x] 🔴🔴 **CRITICO trovato e corretto 2026-07-09**: Da Ladia: "aggiungi una nota al diario con questa foto" → la nota compariva nel diario (`site_diary_entries`, verificato) ma **la foto non veniva mai salvata** — Ladia la analizzava e scriveva una descrizione a parole, ma il file non risultava agganciato ("Foto: –" nella UI, che invece era già pronta a mostrarle). Causa: le foto venivano caricate su storage solo a fine turno, dopo che i tool avevano già girato — l'URL non esisteva ancora quando `create_diary_note` veniva eseguito. Corretto spostando l'upload prima del loop di tool (repo backend, commit `8186d39`), testato end-to-end direttamente sul DB. **Stesso gap identificato ma non ancora corretto su "Note & Foto"** (`create_site_note`/`site_notes`, convenzione di storage diversa) — da fare se serve. **Da riverificare dal vivo dopo il deploy**: chiedi di nuovo a Ladia di aggiungere una nota al diario con una foto

**Chiarito 2026-07-09** (non è un bug): il reset del pannello Ladia succedeva dopo un **ricaricamento completo della pagina** — comportamento voluto, la conversazione attiva non viene mai ripristinata dopo un hard reload (solo se il pannello è aperto/chiuso viene ricordato). La cronologia resta comunque salvata ed è raggiungibile dalla sidebar delle conversazioni.

**Bonus trovato durante questo test, corretto 2026-07-09**: la lista "Diario di Cantiere" non si aggiornava da sola dopo che Ladia scriveva una nota — serviva un reload manuale per vederla. Causa più ampia: **nessuna pagina della piattaforma** aveva un modo di sapere quando Ladia scriveva qualcosa. Costruito un meccanismo generico (evento `record_action` SSE esteso con `site_id` + nuovo bus `ladiaEvents.dataChanged`) e collegato a Diario, Economia (costi/SAL), Organico/Mezzi/Subappalti/Presenze/Sospensioni/POS/Documenti/Note (dentro un cantiere), Risorse (lavoratori) e Dashboard (KPI) — copertura non esaustiva su tutta l'app ma sulle sezioni con cui Ladia interagisce di più. Backend commit `c800357`, frontend commit `6b69d5c`. **Da riverificare dal vivo**: fai scrivere a Ladia qualcosa su un cantiere aperto (es. una nota diario) senza ricaricare — la pagina deve aggiornarsi da sola
- [x] 🔴 Bottone "Vai al diario" generato da Ladia → atterra sul tab Diario, non su Cantiere — verificato dal vivo 2026-07-09

## 3f. Cantiere → tab "Economia"

- [x] 🔴 Budget, margine, SAL calcolati correttamente rispetto ai costi inseriti — verificato 2026-07-09 con test matematico dal vivo su dati reali (creata/rimossa una spesa di prova, margine cambiato esattamente dell'importo atteso)
- [x] 🔴 Aggiunta costo/spesa cantiere: importo si riflette subito nel totale — verificato dal vivo, stesso test
- [x] 🟡 Emissione SAL, segna pagato — stato coerente dopo il refresh — verificato via codice (fetchSalHistory dopo ogni azione) + numerazione atomica anti-duplicati, PDF snapshot corretto al momento dell'emissione
- [x] 🟢 Computo metrico: voci, quantità, importi coerenti — verificato via codice, stessa logica di somma di calcPnl, nessun problema trovato

---

## 4. Ladia AI — desktop (`/pal`) ⚠️ area con più bug corretti oggi

- [x] 🔴🔴 **CRITICO trovato e corretto 2026-07-09**: l'invio di QUALUNQUE messaggio a Ladia dal drawer era completamente rotto — `ReferenceError: setNavChip is not defined` bloccava `send()` sulla primissima riga, prima ancora di mandare il messaggio. Introdotto dal refactor del 2026-07-08 (`1f8abae`), passato inosservato nonostante fosse segnato "verificato con Playwright". Corretto (repo frontend, commit `46d5c98`) sostituendo con `clearNavChip()`, la funzione realmente esposta dal context. **Riverificato dal vivo 2026-07-11**: nessuna traccia dell'errore in conversazioni successive al fix (vedi sotto), invio funzionante
- [ ] 🔴 Messaggio con foto allegata → **elaborata correttamente, nessun "immagine troppo pesante"** — non ancora testato con una foto reale non ridimensionata (i test 2026-07-11 hanno riusato conversazioni reali già esistenti, non inviato nuove foto per non consumare crediti Anthropic inutilmente)
- [x] 🔴 Dopo l'invio con foto, **ricaricare la pagina**: la foto deve restare visibile nella cronologia — **verificato dal vivo 2026-07-11 senza usare Ladia** (zero costo AI): trovata nel DB una foto allegata a una nota diario reale del 2026-07-09 (post-fix `8186d39`), l'URL firmato di storage risponde ancora `200`/169KB/`image/jpeg` due giorni dopo — persistenza confermata end-to-end
- [x] 🔴 Azioni di scrittura (nota diario, nuovo lavoratore, aggiorna cantiere, ecc.) → verificare che il dato sia **davvero** salvato nel posto giusto, non solo confermato a parole — **verificato dal vivo 2026-07-11 senza usare Ladia** (zero costo AI): interrogata `ladia_action_history` (il registro usato dalla funzione undo), trovate scritture reali recenti su `site_diary_entries` (con foto), `workers`, `worksite_workers`, `sites` (update), `pos_drafts` (create/update) — tutte con `changed_fields` coerenti e alcune con `undone_at` popolato correttamente, a conferma che sia le scritture che l'undo funzionano davvero, non solo a parole
- [x] 🔴 Bottoni `<ladia-action>` generati nelle risposte: ogni "Vai a..." porta alla sezione giusta (Presenze, Info, Lavoratori, Documenti, Diario, Economia) — **verificato dal vivo 2026-07-11 senza usare Ladia** (zero costo AI): estratti tutti i tag `<ladia-action>` reali generati nelle ultime conversazioni, path tipo `/cantieri/:id?tab=N` — incrociati con `SECTION_BY_INDEX` in `SiteDetail.tsx` del frontend (`['presenze','cantiere','organico','documenti','diario','economia']`): tab=1→Info, tab=2→Organico, tab=4→Diario, tab=5→Economia, tutti corretti. Anche `/scadenze?type=X` e `/cantieri` verificati come rotte reali esistenti
- [x] 🔴 Click su una conversazione passata nella sidebar → si apre con il contenuto reale, non resta sulla welcome screen — **verificato dal vivo 2026-07-11 senza usare Ladia** (zero costo AI): chiamata diretta a `GET /chat/conversations/:id` su una conversazione reale → risposta con array `messages` completo e popolato (non vuoto), stessa chiamata che il frontend usa al click in sidebar
- [ ] 🟡 Cronologia raggruppata per data (Oggi/Ieri/Ultimi 7 giorni) corretta
- [x] 🟡 Cartelle: creazione, assegnazione conversazione, eliminazione — **verificato dal vivo 2026-07-11 senza usare Ladia** (zero costo AI): ciclo completo su produzione con una cartella di test e una conversazione reale — creazione (`201`), assegnazione via `PATCH /chat/conversations/:id/folder` (`200`), rinomina (`200`), rimozione assegnazione (`200`), eliminazione cartella (`200`) — tutto pulito, nessun residuo lasciato
- [x] 🟡 Esporta conversazione in PDF/Excel funziona — **verificato dal vivo 2026-07-11 senza usare Ladia** (zero costo AI): `POST /chat/export` con messaggi reali → PDF valido restituito (23.7KB, header `%PDF-1.4` corretto)
- [ ] 🟡 Rate limit chat (20 msg/min) — non deve scattare in uso normale
- [ ] 🔴 **Durante un uso normale della chat, ricevere un deploy in produzione (chiedere a chi sviluppa di farne uno di test) e verificare che NON appaia un reload forzato che cancella il messaggio in scrittura** — deve comparire solo il toast "Nuova versione disponibile"

## 4a. Ladia AI — mobile (drawer)

- [ ] 🔴 Stessi test della sezione 4, ripetuti su un telefono reale (non solo DevTools responsive mode)
- [ ] 🟡 Tastiera mobile non copre il campo di input durante la digitazione
- [ ] 🟢 Voice mode (se attivo) funziona e non si blocca

---

## 5. Badge digitale / Timbratura

- [ ] 🔴 Scan QR cantiere da telefono lavoratore → identificazione via CF funziona — non ancora testato (serve telefono reale o flusso completo scan→identify, non solo punch diretto via badge_code)
- [x] 🔴 Timbratura ENTRY → EXIT → ENTRY alternata correttamente, mai due ENTRY di fila — **verificato dal vivo 2026-07-11** contro produzione con un lavoratore di test reale (`badge/:code/punch`, coordinate esatte del cantiere): sequenza ENTRY→EXIT→ENTRY corretta, mai due eventi uguali di fila
- [x] 🔴 Geofence: timbratura rifiutata se fuori raggio (con cantiere che ha coordinate impostate) — **verificato dal vivo 2026-07-11**: punch a +5° di latitudine (555km) → `403 OUTSIDE_GEOFENCE` con `distance_m`/`max_allowed_m` espliciti, non confuso con il rate limit
- [x] 🟡 Rate limit "troppo presto" (60s tra timbrature) mostra messaggio chiaro — **verificato dal vivo 2026-07-11**: doppia timbratura immediata → `429 PUNCH_TOO_SOON` con `retry_after_secs`
- [ ] 🟡 Badge PDF lavoratore: dati corretti, foto se presente, QR di verifica funzionante
- [ ] 🟢 Pagina pubblica verifica badge (`/badge/:code`) mostra dati corretti senza login

**Bonus confermato durante il test**: disattivare un lavoratore (`is_active=false`) blocca subito la timbratura (`403 BADGE_REVOKED`) — comportamento di sicurezza corretto, scoperto per caso quando il worker di test disattivato in cleanup ha bloccato il round successivo del test.

---

## 6. Scadenze

- [x] 🔴 Scadenzario generale mostra tutte le scadenze reali (documenti, idoneità, formazione) — **verificato dal vivo 2026-07-11**: tutti i lavoratori dell'account di test erano disattivati (nessun dato in produzione da mostrare, corretto che `GET /expiry-calendar` tornasse vuoto). Riattivato temporaneamente un lavoratore con scadenza idoneità nota (16/7, tra 5gg) → l'evento compare con data/giorni/severità (`critical`) calcolati correttamente, poi ripristinato allo stato originale
- [x] 🔴 Filtro per tipo (DURC, assicurazione, SOA, idoneità, formazione) funziona — verificato via codice (`Scadenze.tsx`): filtro client-side sull'array eventi, applicato correttamente (riga con `e.type !== typeFilter`)
- [x] 🟡 Click da Ladia (`/scadenze?type=durc` ecc.) apre il filtro giusto — verificato via codice: `typeFilter` si inizializza direttamente da `searchParams.get("type")`

---

## 7. Formazione

- [ ] 🔴 Prenotazione corso: flusso completo fino a conferma
- [ ] 🟡 Marketplace corsi: ricerca, filtri, dettaglio provider
- [ ] 🟡 Area provider formazione: gestione sessioni, notifiche prenotazioni
- [ ] 🟢 Recensioni corso

---

## 8. Risorse (lavoratori, subappaltatori, mezzi)

- [x] 🔴 Creazione lavoratore: tutti i campi salvati, badge_code generato univoco — **verificato dal vivo 2026-07-11** via API reale su produzione, `POST /workers` → 201, `badge_code` generato e univoco per ogni lavoratore creato
- [x] 🔴 Assegnazione lavoratore a cantiere e rimozione — stato coerente in entrambe le liste — **verificato dal vivo 2026-07-11**: assegnazione (`POST /sites/:id/workers` → 200/201) e rimozione (`DELETE /sites/:id/workers/:workerId`) confermate, nessuna riga orfana rimasta in `worksite_workers`
- [x] 🟡 Documenti lavoratore (certificati, idoneità): upload e scadenza tracciata — **verificato dal vivo 2026-07-11** su produzione: upload reale (PDF) con `expiry_date` manuale → risposta `201`, `workers.health_fitness_expiry` sincronizzato automaticamente al valore corretto, documento presente in lista
- [x] 🟡 Subappaltatori: creazione, documenti, assegnazione cantiere — **verificato dal vivo 2026-07-11**: creazione `201`, upload documento reale `201`, assegnazione a cantiere `201` e presente nella lista del cantiere. Cleanup completo (disassegnato, archiviato)
- [x] 🟢 Mezzi: creazione, manutenzioni, assegnazione — **verificato dal vivo 2026-07-11**: creazione `201`, aggiornamento data manutenzione via PATCH `200`, assegnazione a cantiere `201` e presente nella lista. Cleanup completo (disassegnato, eliminato)

---

## 9. Notifiche

- [ ] 🟡 Push notification ricevuta su mobile (se abilitate) per eventi chiave (scadenza, promemoria)
- [ ] 🟡 Email inviate correttamente (welcome, alert uscite mancanti, scadenze) — controllare cartella spam
- [ ] 🟢 Centro notifiche in-app: contatore corretto, segna come letto funziona

---

## 10. Billing / Abbonamento

- [ ] 🟡 Trial: countdown giorni rimanenti corretto, banner mostrato negli ultimi 7gg — `days_left` calcolato correttamente lato API (verificato indirettamente), manca solo la verifica visiva del banner
- [ ] 🔴 Checkout Stripe: pagamento test completato, piano attivato subito dopo — **non testabile da qui** (nessun browser disponibile in questo ambiente per completare un checkout Stripe reale con carta). `POST /billing/checkout` genera correttamente un URL Stripe valido (verificato 2026-07-11), ma serve un click reale con carta di test per chiudere questa voce
- [x] 🔴 Limite cantieri per piano rispettato (es. Starter blocca al 3° cantiere attivo) — **verificato dal vivo 2026-07-11** con una company isolata usa-e-getta (piano trial, limite 3): i primi 3 cantieri passano, il 4° dà `403 SITE_LIMIT_REACHED`
- [x] 🔴🔴 **CRITICO trovato e corretto 2026-07-11**: `checkBillingActive` era collegato solo alla generazione PDF e a Ladia (fix del 2026-07-06), non alle rotte CRUD normali. Un abbonamento con trial scaduto poteva continuare a creare/modificare cantieri, lavoratori, documenti ecc. chiamando l'API direttamente, bypassando completamente il paywall lato frontend — stesso pattern del bug PDF già corretto, mai esteso al resto della piattaforma. Corretto estendendo il controllo al choke point comune `verifySupabaseJwt` (`middleware/verifyJwt.js`): blocca ogni scrittura (tutti i metodi tranne GET/HEAD/OPTIONS) se l'abbonamento non è attivo, con eccezione esplicita per `/billing/checkout` e `/billing/portal` (altrimenti un account bloccato non potrebbe più riattivarsi da solo). Commit `fdb6e02`. **Riverificato dal vivo dopo il deploy** con 3 scenari su produzione: (1) company con trial scaduto → scrittura bloccata `402 SUBSCRIPTION_REQUIRED`, lettura resta libera, checkout resta permesso e genera URL Stripe valido; (2) company con trial attivo → scrittura normale `201`; (3) account reale MSCedilizia (piano pro, attivo) → lettura e scrittura invariate, nessuna regressione
- [ ] 🔴 Paywall: accesso bloccato correttamente a trial scaduto, sbloccato dopo pagamento — lato backend ora chiuso (vedi sopra), **manca ancora la verifica visiva lato frontend** (il paywall React mostra la schermata giusta? e si sblocca subito dopo un pagamento reale?)
- [ ] 🟡 Portale gestione abbonamento (cambio piano, cancellazione) funziona
- [ ] 🟡 Webhook Stripe: verificare nei log che gli eventi arrivino e vengano processati

---

## 11. Team e inviti

- [x] 🔴 Invito nuovo membro team: email ricevuta, accettazione funziona, ruolo corretto — **verificato dal vivo 2026-07-11** end-to-end su produzione (company reale MSCedilizia): creazione invito → token → preview pubblico → accettazione con sessione reale → ruolo `tech` assegnato correttamente in `company_users` → invito sparisce dai pendenti dopo l'uso. Non verificato l'arrivo effettivo dell'email in una casella reale (il token è stato letto dal DB per non dover intercettare una mail), solo che `sendInviteEmail` viene invocata senza eccezioni
- [x] 🟡🔴 **CRITICO trovato e corretto 2026-07-11**: il ruolo `viewer` non bloccava NESSUNA scrittura — `req.userRole` veniva letto in tutte le rotte solo per l'audit log, mai per negare un'azione. Un account viewer poteva creare/modificare/cancellare cantieri, lavoratori, documenti ecc. via API diretta esattamente come un owner (verificato: `POST /sites` → `201` con un account viewer di test). Corretto nello stesso choke point del fix billing (`middleware/verifyJwt.js`, commit `6dde1c1`): ogni scrittura per ruolo `viewer` ora dà `403 VIEWER_READ_ONLY`, lettura sempre permessa. **Riverificato dal vivo dopo il deploy**: viewer bloccato in scrittura (403) ma non in lettura (200); ruolo `tech` confermato non impattato (scrittura ancora `201`)
- [ ] 🟢 Rimozione membro team: accesso revocato immediatamente

---

## 12. Portali esterni

- [ ] 🟡 Portale Studio CDL: login, semaforo compliance clienti, richiesta documenti
- [ ] 🟡 Portale Coordinatore CSE: verbali, sopralluoghi, note
- [ ] 🟡 Area Lavoratore self-service: accesso, dati visibili corretti, upload documenti propri
- [ ] 🟢 Pagina pubblica ASL: accesso senza login, dati corretti, scadenza link rispettata

---

## 13. Sicurezza multi-tenant (fondamentale, non saltare)

- [x] 🔴 Con due account di due company diverse, verificare che **nessun dato** (cantieri, lavoratori, documenti, conversazioni Ladia) sia visibile all'altra company — trovato rotto 2026-07-09 (RLS disabilitato su 24 tabelle), **corretto** con migrazione 129, riverificato dopo il fix con sessione reale
- [x] 🔴 Provare a modificare l'URL con l'ID di una risorsa di un'altra company (es. `/cantieri/<uuid-altra-company>`) → deve dare errore, non mostrare i dati — questo test ha trovato il bug sopra; ora dà correttamente "non trovato" invece dei dati reali
- [x] 🟡 Token scan/QR di un cantiere non funziona su un cantiere diverso — verificato 2026-07-09 dal vivo contro produzione: token generato per un sito, riusato dichiarando un sito di un'altra company → `INVALID_SIGNATURE` (HMAC lega il token al site_id)

---

## 14. PWA / mobile generale

- [ ] 🔴 App installata come PWA su telefono: si apre, funziona offline-tolerant (non crasha senza rete)
- [ ] 🔴 Dopo un deploy, il toast "Nuova versione disponibile" compare e il bottone "Aggiorna" ricarica senza perdere la sessione
- [ ] 🟡 Notifiche push richieste e concesse correttamente al primo utilizzo
- [ ] 🟢 Condivisione file/foto verso l'app (share target) funziona da altre app del telefono

---

## 15. Osservabilità (verifica che il sistema di allarme funzioni davvero)

- [ ] 🔴 Generare un errore vero (es. scollegare temporaneamente internet durante un'azione critica) e verificare che compaia su Sentry entro pochi minuti
- [ ] 🟡 Controllare `usage.cache_read_input_tokens` nei log/dashboard Anthropic dopo qualche messaggio a Ladia — deve essere > 0 dal secondo messaggio in poi (conferma che il prompt caching funziona davvero, non solo che il codice è corretto)
- [x] 🟡 **Trovato e corretto 2026-07-11**: `ai-usage-report.js`/`ladia_usage_log` copriva solo la chat di Ladia (`chat_stream`/`auto_title`) — **18 dei 20 file che chiamano Claude direttamente non erano loggati affatto**: analisi documenti (azienda/cantiere/lavoratore/subappaltatore), OCR (mezzi/spese/scadenze/certificati), parsing computo metrico/capitolato/prezzario offerte, checklist cantiere AI, generazione POS/DVR/PIMUS, briefing mattutino Telegram, memoria/obiettivi Ladia, proposte smart proattive. La spesa reale della piattaforma era in gran parte invisibile, non solo non ottimizzata. Aggiunto `logUsage()` a ogni call site reale (companyId verificato caso per caso, non un placeholder). Commit `ce2d318`. Lasciati fuori intenzionalmente 3 file di codice morto mai invocato in produzione (`telegramAI.js`, `telegramLadia.js`, `services/ladiaDocumentProcessor.js` — orfani dal passaggio del bot Telegram a solo-notifiche dell'1/5). **Verificato dal vivo 2026-07-11** dopo il deploy: chiamata reale di test (`baracca_ai_suggestions`, Haiku) → nuova riga in `ladia_usage_log` entro pochi secondi, $0.0014

---

## Come usarla

Non fatela tutta in un giorno. Un blocco alla volta, con calma, segnando davvero cosa succede.
Ogni 🔴 fallito è un motivo per **non** lanciare finché non è chiuso. I 🟡 possono aspettare
la settimana dopo il lancio se non bloccano l'uso base. I 🟢 sono rifiniture, non urgenze.

Quando tutti i 🔴 sono ✅, siete pronti per un lancio limitato (pochi clienti reali, non tutti insieme) —
non per un lancio pubblico su larga scala. Quello arriva dopo che i primi clienti reali hanno
usato il prodotto per una-due settimane senza sorprese.
