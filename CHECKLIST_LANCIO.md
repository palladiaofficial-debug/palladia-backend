# Checklist pre-lancio Palladia — test manuale, un flusso alla volta

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

- [ ] 🔴 `SENTRY_DSN` impostata su Railway (backend) — verificare in `railway variables`
- [ ] 🔴 `VITE_SENTRY_DSN` impostata su Vercel (frontend) — verificare in `vercel env ls production`
- [ ] 🔴 Credito Anthropic sufficiente su console.anthropic.com (Plans & Billing)
- [x] 🔴 Migrazione `118_site_bookings.sql` applicata su Supabase — verificato 2026-07-06 con controllo sistematico di tutte le 131 migrazioni contro il DB reale
- [x] 🔴 Migrazione `119_chat_message_images.sql` applicata su Supabase — verificato 2026-07-06, vedi sopra
- [ ] 🟡 Nessuna conversazione fantasma in `chat_conversations` (0 messaggi) — query di verifica rapida
- [ ] 🟢 Hard refresh su tutti i dispositivi di test prima di iniziare (elimina bundle JS vecchio in cache)

---

## 1. Autenticazione e onboarding

- [ ] 🔴 Registrazione nuovo utente con email reale → arriva email di conferma
- [ ] 🔴 Login con credenziali corrette
- [ ] 🔴 Login con password sbagliata → messaggio di errore chiaro, non generico
- [ ] 🔴 Onboarding azienda: creazione company al primo accesso, nome salvato correttamente
- [ ] 🟡 Reset password: richiesta, email ricevuta, nuovo accesso funziona
- [ ] 🟡 Logout → sessione effettivamente terminata (provare a tornare indietro col browser)
- [ ] 🟢 Redirect corretto dopo login (torna dove stava andando, non sempre alla dashboard)

---

## 2. Dashboard

- [ ] 🔴 KPI mostrati (cantieri attivi, lavoratori, presenze oggi) corrispondono ai dati reali
- [ ] 🟡 Nessun errore in console browser al caricamento
- [ ] 🟢 Tempo di caricamento accettabile (< 3s su connessione normale)

---

## 3. Cantieri — lista

- [ ] 🔴 Lista cantieri mostra solo quelli della company loggata (provare con 2 account diversi)
- [ ] 🔴 Creazione nuovo cantiere: tutti i campi obbligatori validati, cantiere compare in lista subito dopo
- [ ] 🟡 Ricerca/filtro cantieri funziona
- [ ] 🟡 Badge "scaduto Ngg fa" / countdown giorni rimanenti corretto rispetto alle date reali

## 3a. Cantiere → tab "Cantiere" (Info)

- [ ] 🔴 Dati contratto (inizio/fine) modificabili e salvati
- [ ] 🔴 QR timbratura generato, valido, scaricabile in PDF
- [ ] 🟡 "Condividi link" QR funziona
- [ ] 🟡 Sospensioni giornata: aggiunta, mostrata nel calendario, **bottone ↩ annulla funziona**
- [ ] 🟡 Coordinate GPS impostabili (necessarie per meteo e geofence)
- [ ] 🟢 Progress bar percentuale completamento coerente con le date

## 3b. Cantiere → tab "Presenze"

- [ ] 🔴 Presenze di oggi mostrate correttamente (chi è dentro, chi è uscito)
- [ ] 🔴 Storico presenze per intervallo di date corretto
- [ ] 🟡 Export presenze PDF/CSV funziona e i dati coincidono con quelli a schermo
- [ ] 🟡 Link ASL pubblico (ispettore) generato e funzionante senza login

## 3c. Cantiere → tab "Organico"

- [ ] 🔴 Sub-tab **Organico**: lista lavoratori assegnati corretta, aggiunta/rimozione funziona
- [ ] 🔴 Sub-tab **Mezzi**: aggiunta/modifica mezzo, assegnazione a cantiere
- [ ] 🔴 Sub-tab **Subappalti**: aggiunta subappaltatore, documenti associati
- [ ] 🟡 Compliance banner (idoneità/formazione lavoratori) coerente con le scadenze reali

## 3d. Cantiere → tab "Documenti"

- [ ] 🔴 Upload documento: file salvato, visibile subito, scaricabile dopo
- [ ] 🔴 Generazione POS: **testare l'intero flusso SSE fino al PDF finale**, verificare che l'header/footer del PDF non si sovrappongano al contenuto (bug storico)
- [ ] 🔴 Generazione DVR: stesso test end-to-end
- [ ] 🔴 Generazione PIMUS: stesso test end-to-end
- [ ] 🟡 Documenti in scadenza evidenziati correttamente

## 3e. Cantiere → tab "Diario" ⚠️ area con bug corretti oggi — testare con attenzione

- [ ] 🔴 Sub-tab **Diario di Cantiere**: nota del giorno visibile, editabile, salvata
- [ ] 🔴 Sub-tab **Note & Foto**: creazione nota manuale con foto allegata — **la foto resta visibile dopo un reload della pagina**
- [ ] 🔴 Da Ladia: "aggiungi una nota al diario con questa foto" → la nota compare **davvero** in questo tab (non solo nel messaggio di conferma di Ladia)
- [ ] 🔴 Bottone "Vai al diario" generato da Ladia → atterra sul tab Diario, non su Cantiere

## 3f. Cantiere → tab "Economia"

- [ ] 🔴 Budget, margine, SAL calcolati correttamente rispetto ai costi inseriti
- [ ] 🔴 Aggiunta costo/spesa cantiere: importo si riflette subito nel totale
- [ ] 🟡 Emissione SAL, segna pagato — stato coerente dopo il refresh
- [ ] 🟢 Computo metrico: voci, quantità, importi coerenti

---

## 4. Ladia AI — desktop (`/pal`) ⚠️ area con più bug corretti oggi

- [ ] 🔴 Messaggio di solo testo → risposta coerente, nessun errore
- [ ] 🔴 Messaggio con foto allegata → **elaborata correttamente, nessun "immagine troppo pesante"** (verificare con foto reale da fotocamera, non ridimensionata a mano)
- [ ] 🔴 Dopo l'invio con foto, **ricaricare la pagina**: la foto deve restare visibile nella cronologia
- [ ] 🔴 Azioni di scrittura (nota diario, nuovo lavoratore, aggiorna cantiere, ecc.) → verificare che il dato sia **davvero** salvato nel posto giusto, non solo confermato a parole
- [ ] 🔴 Bottoni `<ladia-action>` generati nelle risposte: ogni "Vai a..." porta alla sezione giusta (Presenze, Info, Lavoratori, Documenti, Diario, Economia)
- [ ] 🔴 Click su una conversazione passata nella sidebar → si apre con il contenuto reale, non resta sulla welcome screen
- [ ] 🟡 Cronologia raggruppata per data (Oggi/Ieri/Ultimi 7 giorni) corretta
- [ ] 🟡 Cartelle: creazione, assegnazione conversazione, eliminazione
- [ ] 🟡 Esporta conversazione in PDF/Excel funziona
- [ ] 🟡 Rate limit chat (20 msg/min) — non deve scattare in uso normale
- [ ] 🔴 **Durante un uso normale della chat, ricevere un deploy in produzione (chiedere a chi sviluppa di farne uno di test) e verificare che NON appaia un reload forzato che cancella il messaggio in scrittura** — deve comparire solo il toast "Nuova versione disponibile"

## 4a. Ladia AI — mobile (drawer)

- [ ] 🔴 Stessi test della sezione 4, ripetuti su un telefono reale (non solo DevTools responsive mode)
- [ ] 🟡 Tastiera mobile non copre il campo di input durante la digitazione
- [ ] 🟢 Voice mode (se attivo) funziona e non si blocca

---

## 5. Badge digitale / Timbratura

- [ ] 🔴 Scan QR cantiere da telefono lavoratore → identificazione via CF funziona
- [ ] 🔴 Timbratura ENTRY → EXIT → ENTRY alternata correttamente, mai due ENTRY di fila
- [ ] 🔴 Geofence: timbratura rifiutata se fuori raggio (con cantiere che ha coordinate impostate)
- [ ] 🟡 Rate limit "troppo presto" (60s tra timbrature) mostra messaggio chiaro
- [ ] 🟡 Badge PDF lavoratore: dati corretti, foto se presente, QR di verifica funzionante
- [ ] 🟢 Pagina pubblica verifica badge (`/badge/:code`) mostra dati corretti senza login

---

## 6. Scadenze

- [ ] 🔴 Scadenzario generale mostra tutte le scadenze reali (documenti, idoneità, formazione)
- [ ] 🔴 Filtro per tipo (DURC, assicurazione, SOA, idoneità, formazione) funziona
- [ ] 🟡 Click da Ladia (`/scadenze?type=durc` ecc.) apre il filtro giusto

---

## 7. Formazione

- [ ] 🔴 Prenotazione corso: flusso completo fino a conferma
- [ ] 🟡 Marketplace corsi: ricerca, filtri, dettaglio provider
- [ ] 🟡 Area provider formazione: gestione sessioni, notifiche prenotazioni
- [ ] 🟢 Recensioni corso

---

## 8. Risorse (lavoratori, subappaltatori, mezzi)

- [ ] 🔴 Creazione lavoratore: tutti i campi salvati, badge_code generato univoco
- [ ] 🔴 Assegnazione lavoratore a cantiere e rimozione — stato coerente in entrambe le liste
- [ ] 🟡 Documenti lavoratore (certificati, idoneità): upload e scadenza tracciata
- [ ] 🟡 Subappaltatori: creazione, documenti, assegnazione cantiere
- [ ] 🟢 Mezzi: creazione, manutenzioni, assegnazione

---

## 9. Notifiche

- [ ] 🟡 Push notification ricevuta su mobile (se abilitate) per eventi chiave (scadenza, promemoria)
- [ ] 🟡 Email inviate correttamente (welcome, alert uscite mancanti, scadenze) — controllare cartella spam
- [ ] 🟢 Centro notifiche in-app: contatore corretto, segna come letto funziona

---

## 10. Billing / Abbonamento

- [ ] 🔴 Trial: countdown giorni rimanenti corretto, banner mostrato negli ultimi 7gg
- [ ] 🔴 Checkout Stripe: pagamento test completato, piano attivato subito dopo
- [ ] 🔴 Limite cantieri per piano rispettato (es. Starter blocca al 3° cantiere attivo)
- [ ] 🔴 Paywall: accesso bloccato correttamente a trial scaduto, sbloccato dopo pagamento
- [ ] 🟡 Portale gestione abbonamento (cambio piano, cancellazione) funziona
- [ ] 🟡 Webhook Stripe: verificare nei log che gli eventi arrivino e vengano processati

---

## 11. Team e inviti

- [ ] 🔴 Invito nuovo membro team: email ricevuta, accettazione funziona, ruolo corretto
- [ ] 🟡 Permessi per ruolo (owner/admin/tech/viewer) rispettati — provare azioni vietate con un account viewer
- [ ] 🟢 Rimozione membro team: accesso revocato immediatamente

---

## 12. Portali esterni

- [ ] 🟡 Portale Studio CDL: login, semaforo compliance clienti, richiesta documenti
- [ ] 🟡 Portale Coordinatore CSE: verbali, sopralluoghi, note
- [ ] 🟡 Area Lavoratore self-service: accesso, dati visibili corretti, upload documenti propri
- [ ] 🟢 Pagina pubblica ASL: accesso senza login, dati corretti, scadenza link rispettata

---

## 13. Sicurezza multi-tenant (fondamentale, non saltare)

- [ ] 🔴 Con due account di due company diverse, verificare che **nessun dato** (cantieri, lavoratori, documenti, conversazioni Ladia) sia visibile all'altra company
- [ ] 🔴 Provare a modificare l'URL con l'ID di una risorsa di un'altra company (es. `/cantieri/<uuid-altra-company>`) → deve dare errore, non mostrare i dati
- [ ] 🟡 Token scan/QR di un cantiere non funziona su un cantiere diverso

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

---

## Come usarla

Non fatela tutta in un giorno. Un blocco alla volta, con calma, segnando davvero cosa succede.
Ogni 🔴 fallito è un motivo per **non** lanciare finché non è chiuso. I 🟡 possono aspettare
la settimana dopo il lancio se non bloccano l'uso base. I 🟢 sono rifiniture, non urgenze.

Quando tutti i 🔴 sono ✅, siete pronti per un lancio limitato (pochi clienti reali, non tutti insieme) —
non per un lancio pubblico su larga scala. Quello arriva dopo che i primi clienti reali hanno
usato il prodotto per una-due settimane senza sorprese.
