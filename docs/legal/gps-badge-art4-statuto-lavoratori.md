# Pacchetto legale — Geolocalizzazione e badge digitale (art. 4 Statuto dei Lavoratori)

> **BOZZA DI LAVORO — non ancora validata da un consulente del lavoro o
> avvocato giuslavorista.** Non costituisce consulenza legale. Da rivedere
> con un professionista prima di essere distribuita a un cliente reale o
> usata come base per un accordo/richiesta di autorizzazione ufficiale.
> Creata: 2026-07-18, settimana 1 del piano operativo 60 giorni.

---

## 1. Il quadro normativo, per chi non lo conosce

**Art. 4 della Legge 300/1970 (Statuto dei Lavoratori)**, come modificato dal
Jobs Act (D.Lgs. 151/2015), regola gli strumenti da cui può derivare un
controllo a distanza dei lavoratori:

- **Comma 1**: impianti audiovisivi e altri strumenti da cui derivi anche
  la possibilità di controllo a distanza possono essere usati solo per
  esigenze organizzative/produttive, sicurezza del lavoro, tutela del
  patrimonio aziendale — **previo accordo con RSU/RSA, o in mancanza,
  autorizzazione della sede territoriale dell'Ispettorato Nazionale del
  Lavoro (INL)**.
- **Comma 2** — quello che riguarda direttamente Palladia: **questa regola
  NON si applica agli "strumenti utilizzati dal lavoratore per rendere la
  prestazione lavorativa" e agli "strumenti di registrazione degli accessi
  e delle presenze".** Un sistema di timbratura badge/QR rientra
  esplicitamente in questa esenzione.
- **Comma 3**: anche per gli strumenti esenti (comma 2), i dati raccolti
  sono utilizzabili a tutti i fini connessi al rapporto di lavoro **solo se
  al lavoratore è stata data adeguata informazione** delle modalità d'uso e
  dei controlli, nel rispetto del GDPR.

**Conclusione pratica**: la sola registrazione ENTRY/EXIT (badge/QR) non
richiede accordo sindacale né autorizzazione INL — richiede **sempre**
un'informativa chiara al lavoratore (comma 3). La componente **geofence GPS**
è un'area meno netta: Palladia la usa solo per **validare la timbratura al
momento del punch** (calcolo distanza server-side, nessun tracciamento
continuo del lavoratore durante il turno) — questo la avvicina comunque
alla finalità "registrazione presenze", ma un cliente particolarmente
prudente (o con RSU interna già attiva per altri motivi) potrebbe preferire
formalizzare comunque un accordo leggero. Per questo il pacchetto include
entrambi i percorsi.

---

## 2. Cosa fa davvero il sistema (base fattuale per qualunque informativa/accordo)

Prima di scrivere qualunque testo legale, i fatti tecnici esatti — verificati
sul codice, non assunti:

- Il lavoratore timbra ENTRY/EXIT tramite QR cantiere o badge personale
  (PWA sul proprio smartphone).
- Al momento della timbratura, il dispositivo invia la posizione GPS
  corrente al server.
- Il server calcola la distanza (formula haversine) tra la posizione
  inviata e le coordinate del cantiere configurate dall'azienda.
- Se la distanza supera il raggio di tolleranza configurato (default 80m),
  la timbratura viene **rifiutata** con errore esplicito — non salvata
  "con avviso", proprio rifiutata.
- **Nessun tracciamento continuo**: il sistema non registra la posizione del
  lavoratore se non nell'istante della timbratura. Non esiste una mappa "dove
  si trova ora" o uno storico di spostamenti durante il turno.
- I dati salvati per ogni timbratura: timestamp, tipo evento (ENTRY/EXIT),
  distanza calcolata dal cantiere, precisione GPS del dispositivo, metodo
  (QR/badge/correzione manuale).
- Il registro presenze è append-only (nessuna modifica/cancellazione
  possibile a livello di database) — rilevante anche ai fini della
  tracciabilità richiesta dal D.Lgs. 81/2008.

---

## 3. Informativa privacy specifica — geolocalizzazione e presenze

*(Documento da consegnare/rendere disponibile ad ogni lavoratore, integrativo
alla privacy policy generale della piattaforma — non la sostituisce)*

> **Informativa sul trattamento dei dati di presenza e geolocalizzazione**
>
> Ai sensi dell'art. 13 del Regolamento (UE) 2016/679 (GDPR) e dell'art. 4,
> comma 3, della Legge 300/1970, La informiamo che [NOME AZIENDA] utilizza
> la piattaforma Palladia per la rilevazione digitale delle presenze in
> cantiere.
>
> **Titolare del trattamento**: [NOME AZIENDA, P.IVA, indirizzo]
>
> **Finalità del trattamento**:
> 1. Rilevazione oraria di ingresso e uscita dal cantiere, ai fini della
>    corretta gestione del rapporto di lavoro e degli adempimenti retributivi
>    e contributivi;
> 2. Verifica che la timbratura avvenga effettivamente presso il cantiere
>    assegnato, tramite controllo di prossimità GPS (geofence), a tutela
>    della correttezza dei dati presenza e della sicurezza (D.Lgs. 81/2008 —
>    sapere chi è effettivamente presente in cantiere in caso di emergenza);
>    3. Adempimento degli obblighi di legge in materia di tracciabilità
>    delle presenze in cantiere (patente a crediti, D.L. 159/2025).
>
> **Dati raccolti**: orario e tipo di timbratura (ingresso/uscita),
> posizione GPS **rilevata esclusivamente nell'istante della timbratura**
> (nessun tracciamento continuo della posizione durante il turno di
> lavoro), distanza calcolata dal cantiere assegnato.
>
> **Base giuridica**: esecuzione del contratto di lavoro e adempimento di
> obblighi legali (sicurezza sul lavoro, tracciabilità presenze).
>
> **Conservazione**: i dati di presenza sono conservati in forma immutabile
> (nessuna modifica o cancellazione è tecnicamente possibile una volta
> registrati) per la durata prevista dalla normativa applicabile in materia
> di conservazione della documentazione di cantiere e del rapporto di
> lavoro.
>
> **Destinatari**: i dati sono accessibili al datore di lavoro e ai soggetti
> a cui la legge attribuisce diritto di accesso (es. ispettori ASL/INL nei
> limiti delle rispettive competenze). Non sono ceduti a terzi per finalità
> commerciali.
>
> **Diritti dell'interessato**: accesso, rettifica, portabilità e reclamo al
> Garante Privacy secondo gli artt. 15-22 GDPR — da esercitare presso
> [contatto privacy azienda].
>
> Data: __________ Firma per presa visione: __________________________

---

## 4. Percorso A — Accordo con RSU/RSA (se presente in azienda)

*(Da usare solo se l'azienda ha rappresentanza sindacale interna attiva —
minoranza delle imprese target 5-50 addetti, ma da avere pronto)*

> **Accordo ex art. 4, comma 1, L. 300/1970**
> **tra [NOME AZIENDA] e RSU/RSA aziendale**
>
> Premesso che l'azienda utilizza il sistema Palladia per la rilevazione
> digitale delle presenze in cantiere con verifica di prossimità GPS
> (geofence), attivata esclusivamente al momento della timbratura e non in
> modo continuativo;
>
> Le parti concordano quanto segue:
>
> 1. Il sistema è impiegato per finalità organizzative, di sicurezza sul
>    lavoro (D.Lgs. 81/2008) e di corretta gestione del rapporto di lavoro,
>    non per finalità di controllo disciplinare della prestazione lavorativa
>    al di fuori della verifica di presenza in cantiere;
> 2. I dati di geolocalizzazione sono raccolti unicamente nell'istante della
>    timbratura, non è previsto né tecnicamente possibile un tracciamento
>    continuo della posizione del lavoratore durante il turno;
> 3. Ogni lavoratore riceve l'informativa di cui al punto 3 di questo
>    documento prima del primo utilizzo del sistema;
> 4. L'utilizzo dei dati per finalità disciplinari è ammesso solo nei limiti
>    e con le garanzie previste dalla legge e dai CCNL applicabili.
>
> Luogo e data: __________
> Per l'azienda: __________________
> Per la RSU/RSA: __________________

---

## 5. Percorso B — Richiesta di autorizzazione INL (senza RSU/RSA)

*(Il percorso più rilevante per la maggior parte dei clienti target — PMI
5-50 addetti spesso senza rappresentanza sindacale interna)*

**Nota preliminare importante**: per la sola funzione di registrazione
accessi/presenze (comma 2), **questo passaggio non è strettamente
obbligatorio** secondo la lettura più diffusa della norma — l'informativa
(sezione 3) è sufficiente. Questo percorso va offerto come opzione di
massima cautela, non presentato come obbligo assoluto, per non generare
un attrito superfluo nella vendita.

Per le imprese che vogliono comunque procedere in via prudenziale:

1. **Dove**: la domanda si presenta alla sede territoriale dell'Ispettorato
   Nazionale del Lavoro (INL) competente per la sede legale dell'azienda
   (o al Ministero del Lavoro se l'azienda opera in più regioni/province).
2. **Come**: tramite il portale servizi INL (accesso con SPID/CIE), sezione
   dedicata alle istanze ex art. 4 L. 300/1970.
3. **Cosa allegare**: descrizione tecnica del sistema (sezione 2 di questo
   documento), finalità dichiarate, informativa lavoratori (sezione 3).
4. **Tempistiche indicative**: l'INL ha 30 giorni per pronunciarsi
   (verificare tempistiche aggiornate al momento dell'uso — possono variare).

---

## 6. Come presentarlo a un cliente (nota interna, non per il cliente finale)

Il modo giusto di introdurre questo pacchetto in una vendita non è "avete un
problema legale" — è l'opposto: **"Palladia arriva già con il pacchetto di
conformità pronto, non dovete commissionarlo voi."** Consegnarlo insieme
all'onboarding, non come reazione a un'obiezione. Il CDL partner è il
canale naturale per la validazione finale con il cliente (è già la persona
di fiducia dell'imprenditore su questi temi, coerente con l'analisi
strategica del 18/7/2026).
