/**
 * POS Template - Documento ibrido con sezioni fisse + AI per i rischi
 * Conforme al D.lgs 81/2008 e s.m.i.
 */

function buildPosDocument(posData, revision, aiRisks) {
  const d = posData || {};
  const rev = revision || 1;
  const oggi = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });

  // Helper: se il dato manca, metti segnaposto
  const v = (val) => val || '[DA COMPILARE]';

  // Helper: lista lavoratori formattata
  const workersTable = (d.workers && d.workers.length > 0)
    ? d.workers.map((w, i) => `| ${i + 1} | ${v(w.name)} | ${v(w.qualification)} | ${v(w.matricola)} |`).join('\n')
    : '| 1 | [DA COMPILARE] | [DA COMPILARE] | [DA COMPILARE] |';

  const workersCount = (d.workers && d.workers.length > 0) ? d.workers.length : (d.numWorkers || '[DA COMPILARE]');

  return `# PIANO OPERATIVO DI SICUREZZA
## ai sensi del D.lgs 81/2008 e s.m.i. - Allegato XV

---

**REVISIONE ${rev}** - Data: ${oggi}

**Impresa Esecutrice:** ${v(d.companyName)}
**P.IVA:** ${v(d.companyVat)}

---

## SEZIONE 1 - INTESTAZIONE E DATI IDENTIFICATIVI

### Piano Operativo di Sicurezza - Revisione ${rev}

Il presente Piano Operativo di Sicurezza (POS) viene redatto ai sensi dell'art. 89, comma 1, lettera h) del D.lgs 81/2008 e s.m.i., come documento complementare al Piano di Sicurezza e Coordinamento (PSC), ove previsto.

Il POS contiene le informazioni relative alle specifiche attivita' lavorative dell'impresa esecutrice e le misure preventive e protettive integrative al PSC, necessarie per garantire la sicurezza e la salute dei lavoratori nel cantiere.

| Campo | Valore |
|-------|--------|
| Impresa esecutrice | ${v(d.companyName)} |
| Partita IVA | ${v(d.companyVat)} |
| Cantiere | ${v(d.siteAddress)} |
| Committente | ${v(d.client)} |
| Natura dei lavori | ${v(d.workType)} |
| Revisione | ${rev} |
| Data di emissione | ${oggi} |

---

## SEZIONE 2 - DATI GENERALI DEL LAVORO

### 2.1 Descrizione dell'opera

| Campo | Valore |
|-------|--------|
| Indirizzo cantiere | ${v(d.siteAddress)} |
| Committente | ${v(d.client)} |
| Natura dei lavori | ${v(d.workType)} |
| Importo lavori | EUR ${d.budget || '[DA COMPILARE]'} |
| Data inizio prevista | ${v(d.startDate)} |
| Data fine prevista | ${v(d.endDate)} |
| Numero massimo operai | ${workersCount} |

### 2.2 Elenco lavoratori impiegati in cantiere

| N. | Nominativo | Qualifica | Matricola |
|----|-----------|-----------|-----------|
${workersTable}

### 2.3 Orario di lavoro
- Orario ordinario: 08:00 - 12:00 / 13:00 - 17:00
- Sabato: solo se autorizzato dal Coordinatore per l'Esecuzione
- Lavoro notturno: non previsto (salvo autorizzazione specifica)

### 2.4 Turni di lavoro
Non sono previsti turni di lavoro, salvo diverse disposizioni del Direttore dei Lavori o del CSE.

---

## SEZIONE 3 - SOGGETTI CON COMPITI DI SICUREZZA

### 3.1 Organigramma della sicurezza in cantiere

| Ruolo | Nominativo |
|-------|-----------|
| Datore di Lavoro | ${v(d.companyName)} |
| Responsabile Lavori | ${v(d.responsabileLavori)} |
| Coordinatore Sicurezza in fase di Progettazione (CSP) | ${v(d.csp)} |
| Coordinatore Sicurezza in fase di Esecuzione (CSE) | ${v(d.cse)} |
| Responsabile Servizio Prevenzione e Protezione (RSPP) | ${v(d.rspp)} |
| Rappresentante Lavoratori per la Sicurezza (RLS) | ${v(d.rls)} |
| Medico Competente | ${v(d.medico)} |
| Addetto Primo Soccorso | ${v(d.primoSoccorso)} |
| Addetto Antincendio ed Emergenze | ${v(d.antincendio)} |
| Direttore Tecnico di Cantiere | ${v(d.direttoreTecnico || d.responsabileLavori)} |
| Preposto/i | ${v(d.preposto)} |

### 3.2 Compiti e responsabilita'

**Datore di Lavoro:** Responsabile dell'organizzazione e della gestione della sicurezza in cantiere. Nomina le figure della sicurezza, fornisce i DPI, assicura la formazione e l'informazione dei lavoratori.

**RSPP:** Collabora con il Datore di Lavoro nella valutazione dei rischi, nell'elaborazione delle misure di prevenzione e protezione, nella scelta dei DPI e nell'organizzazione della formazione.

**RLS:** Rappresenta i lavoratori per quanto riguarda la sicurezza. Ha accesso alla documentazione, partecipa alle riunioni periodiche, puo' richiedere verifiche e sopralluoghi.

**Medico Competente:** Effettua la sorveglianza sanitaria, esprime i giudizi di idoneita', collabora alla valutazione dei rischi per gli aspetti sanitari.

**Addetto Primo Soccorso:** Interviene in caso di infortunio o malore, utilizza i presidi sanitari disponibili, allerta i servizi di emergenza se necessario.

**Addetto Antincendio:** Gestisce le emergenze incendio, conosce l'ubicazione e l'uso dei mezzi antincendio, coordina l'evacuazione.

**Preposto:** Sorveglia l'attivita' lavorativa, verifica il rispetto delle procedure di sicurezza, segnala tempestivamente le situazioni di pericolo.

---

## SEZIONE 4 - AREA DI CANTIERE E ORGANIZZAZIONE

### 4.1 Caratteristiche dell'area
L'area di cantiere sara' delimitata con recinzione perimetrale continua di altezza minima 2 metri, realizzata con pannelli metallici modulari su basi in calcestruzzo. Gli accessi saranno controllati e dotati di cancello chiudibile a chiave.

### 4.2 Viabilita' di cantiere
- Accesso carraio: tramite cancello principale con larghezza minima 4 m
- Accesso pedonale: separato da quello carraio, con percorso protetto
- Viabilita' interna: percorsi distinti per mezzi e pedoni, segnalati con cartellonistica
- Velocita' massima in cantiere: 10 km/h
- Senso unico di marcia dove le dimensioni non consentono il doppio senso

### 4.3 Impianti di cantiere

**Impianto elettrico:**
- Quadro generale di cantiere con interruttore differenziale (Id = 30 mA)
- Sottoquadri di zona con protezioni magnetotermiche
- Impianto di messa a terra con verifica biennale (DPR 462/01)
- Cavi e prolunghe di tipo H07RN-F o equivalente, resistenti all'acqua e all'abrasione

**Impianto idrico:**
- Allacciamento alla rete pubblica o autocisterna
- Punti di distribuzione per usi igienici e lavorativi

### 4.4 Servizi igienico-assistenziali
- Baraccamento spogliatoio con armadietti a doppio scomparto
- Servizi igienici chimici o allacciati alla rete fognaria (min. 1 ogni 10 lavoratori)
- Locale refettorio/ristoro con tavoli, sedie, scaldavivande, frigorifero
- Cassetta di primo soccorso conforme al D.M. 388/2003 (Gruppo B)
- Acqua potabile disponibile

### 4.5 Depositi e stoccaggi
- Area deposito materiali: su superficie piana e stabile, materiali accatastati in modo sicuro
- Deposito sostanze pericolose: area dedicata, coperta, con bacino di contenimento
- Deposito rifiuti: area recintata con contenitori differenziati e cartellonistica

### 4.6 Gestione delle interferenze
In caso di presenza contemporanea di piu' imprese o lavoratori autonomi, il CSE coordina le attivita' mediante riunioni di coordinamento. Le interferenze spaziali e temporali sono gestite attraverso il cronoprogramma dei lavori e specifiche procedure operative.

---

## SEZIONE 5 - LAVORAZIONI, RISCHI E MISURE DI PREVENZIONE

${aiRisks || '[SEZIONE DA GENERARE - Nessun contenuto AI disponibile]'}

---

## SEZIONE 6 - SEGNALETICA DI SICUREZZA (ISO 7010)

### 6.1 Segnaletica di divieto (cerchio rosso, sfondo bianco)
| Codice | Segnale | Ubicazione |
|--------|---------|------------|
| P001 | Divieto generico | Ingresso cantiere |
| P002 | Vietato fumare | Depositi, baraccamenti |
| P003 | Vietato fumare e usare fiamme libere | Deposito sostanze infiammabili |
| P006 | Vietato l'accesso ai non addetti ai lavori | Ingresso cantiere, zone pericolose |
| P007 | Divieto di accesso ai portatori di pacemaker | Zona saldatura, apparecchi elettromagnetici |
| P008 | Vietato ai pedoni | Zona manovre mezzi |

### 6.2 Segnaletica di avvertimento (triangolo giallo)
| Codice | Segnale | Ubicazione |
|--------|---------|------------|
| W001 | Pericolo generico | Zone a rischio specifico |
| W006 | Tensione elettrica pericolosa | Quadri elettrici |
| W007 | Carrelli in movimento | Viabilita' di cantiere |
| W008 | Pericolo di inciampo | Dislivelli, ostacoli a terra |
| W009 | Caduta con dislivello | Bordi scavi, aperture nel vuoto |
| W012 | Pericolo scivolamento | Aree bagnate |
| W016 | Sostanze tossiche | Deposito sostanze pericolose |
| W023 | Sostanze corrosive | Deposito acidi/basi |
| W026 | Pericolo caduta materiali | Sotto zone di lavoro in quota |

### 6.3 Segnaletica di obbligo (cerchio blu)
| Codice | Segnale | Ubicazione |
|--------|---------|------------|
| M001 | Protezione obbligatoria degli occhi | Zone con proiezione schegge |
| M002 | Casco di protezione obbligatorio | Tutto il cantiere |
| M003 | Protezione obbligatoria dell'udito | Zone con rumore >85 dB(A) |
| M004 | Protezione obbligatoria vie respiratorie | Zone con polveri/vapori |
| M008 | Calzature di sicurezza obbligatorie | Tutto il cantiere |
| M009 | Guanti di protezione obbligatori | Zone di manipolazione materiali |
| M010 | Indumenti protettivi obbligatori | Zone specifiche |
| M014 | Imbracatura di sicurezza obbligatoria | Lavori in quota >2 m |
| M015 | Giubbotto ad alta visibilita' obbligatorio | Zone di transito mezzi |

### 6.4 Segnaletica di salvataggio (rettangolo verde)
| Codice | Segnale | Ubicazione |
|--------|---------|------------|
| E001 | Uscita di emergenza | Vie di fuga |
| E002 | Direzione uscita di emergenza | Lungo le vie di fuga |
| E003 | Primo soccorso | Presso cassetta PS |
| E010 | DAE (defibrillatore) | Se presente in cantiere |
| E011 | Lavaocchi di emergenza | Presso deposito chimici |

### 6.5 Segnaletica antincendio (rettangolo rosso)
| Codice | Segnale | Ubicazione |
|--------|---------|------------|
| F001 | Estintore | Presso ogni estintore |
| F002 | Idrante | Presso ogni idrante |
| F003 | Scala antincendio | Se presente |
| F005 | Direzione da seguire (antincendio) | Percorso verso presidi |

---

## SEZIONE 7 - PROCEDURE DI EMERGENZA

### 7.1 Numeri utili di emergenza
| Servizio | Numero |
|----------|--------|
| Emergenza unica europea | **112** |
| Vigili del Fuoco | **115** |
| Emergenza sanitaria | **118** |
| Polizia di Stato | **113** |
| Carabinieri | **112** |
| Guardia di Finanza | **117** |
| Centro Antiveleni (Milano) | **02 66101029** |
| Centro Antiveleni (Roma) | **06 49978000** |
| INAIL (denuncia infortuni) | **06 6001** |

### 7.2 Procedura di emergenza incendio
1. Chi rileva l'incendio avvisa immediatamente l'Addetto Antincendio e il Preposto
2. Se l'incendio e' di piccola entita', tentare lo spegnimento con gli estintori disponibili
3. Se l'incendio non e' controllabile, attivare l'allarme e chiamare il 115
4. Evacuare l'area seguendo le vie di fuga predisposte
5. Raggiungere il punto di raccolta prestabilito
6. Effettuare l'appello nominativo dei lavoratori
7. Attendere l'arrivo dei Vigili del Fuoco e fornire indicazioni
8. Non rientrare nell'area fino all'autorizzazione delle autorita'

### 7.3 Procedura di primo soccorso
1. Chi rileva l'infortunio avvisa immediatamente l'Addetto Primo Soccorso
2. Valutare la scena (sicurezza dell'area, rischi residui)
3. Valutare lo stato dell'infortunato (coscienza, respiro, circolo)
4. Chiamare il 118 fornendo: luogo esatto, numero infortunati, dinamica, condizioni
5. Prestare i primi soccorsi nei limiti delle proprie competenze
6. Non spostare l'infortunato salvo pericolo imminente
7. Attendere i soccorsi e mantenere il contatto telefonico con il 118
8. Compilare il registro infortuni e la denuncia INAIL entro 48 ore

### 7.4 Procedura di evacuazione
1. Al segnale di evacuazione, interrompere immediatamente ogni attivita'
2. Mettere in sicurezza le attrezzature (spegnere fiamme, staccare corrente)
3. Seguire le vie di fuga indicate dalla segnaletica
4. NON usare ascensori
5. Raggiungere il punto di raccolta
6. Il Preposto effettua l'appello dei lavoratori presenti
7. Segnalare eventuali dispersi al Coordinatore dell'emergenza

### 7.5 Punto di raccolta
Il punto di raccolta e' individuato in area esterna al cantiere, facilmente raggiungibile e segnalato con cartello E007 (Punto di raccolta). La sua posizione e' comunicata a tutti i lavoratori all'ingresso in cantiere.

---

## SEZIONE 8 - DISPOSITIVI DI PROTEZIONE INDIVIDUALE (DPI)

### 8.1 Obblighi generali
Il Datore di Lavoro fornisce ai lavoratori i DPI necessari, conformi al Regolamento UE 2016/425, adeguati ai rischi specifici e mantenuti in buono stato. I lavoratori hanno l'obbligo di utilizzare correttamente i DPI e segnalare difetti o malfunzionamenti.

### 8.2 DPI di base obbligatori in cantiere
| DPI | Norma di riferimento | Categoria | Note |
|-----|---------------------|-----------|------|
| Casco di protezione | UNI EN 397:2012 | II | Obbligatorio in tutta l'area di cantiere |
| Calzature di sicurezza S3 | UNI EN ISO 20345:2022 | II | Puntale 200J, suola antiperforazione, antiscivolo |
| Guanti da lavoro | UNI EN 388:2016 | II | Resistenza al taglio, all'abrasione e alla perforazione |
| Giubbotto alta visibilita' | UNI EN ISO 20471:2013 | II | Classe 2 minimo, obbligatorio in zone di transito mezzi |
| Occhiali di protezione | UNI EN 166:2001 | II | Per lavorazioni con proiezione schegge/polveri |

### 8.3 DPI specifici per lavorazioni a rischio
| DPI | Norma di riferimento | Impiego |
|-----|---------------------|---------|
| Imbracatura anticaduta | UNI EN 361:2002 | Lavori in quota >2 m senza protezioni collettive |
| Cordino con assorbitore | UNI EN 355:2002 | In abbinamento all'imbracatura |
| Cuffie/inserti auricolari | UNI EN 352-1/2:2020 | Esposizione rumore >85 dB(A) |
| Facciale filtrante FFP2/FFP3 | UNI EN 149:2009 | Polveri, fibre, vapori |
| Maschera con filtri | UNI EN 14387:2004 | Vapori organici, gas |
| Tuta monouso tipo 5/6 | UNI EN 13034:2005 | Manipolazione sostanze chimiche |
| Guanti antitaglio | UNI EN 388:2016 (Livello E) | Taglio lamiere, vetro |
| Guanti anticalore | UNI EN 407:2020 | Saldatura, taglio termico |
| Schermo per saldatura | UNI EN 175:1999 | Saldatura ad arco e ossiacetilenica |
| Ginocchiere | UNI EN 14404:2004 | Lavori a livello del suolo |

### 8.4 Gestione e manutenzione DPI
- Verifica dello stato dei DPI prima di ogni utilizzo
- Sostituzione immediata di DPI danneggiati o scaduti
- Conservazione in luogo pulito, asciutto e protetto
- Registro di consegna DPI con firma del lavoratore
- Formazione sull'uso corretto di ogni DPI consegnato

---

## SEZIONE 9 - MACCHINE, ATTREZZATURE E VERIFICHE

### 9.1 Disposizioni generali
Tutte le macchine e attrezzature utilizzate in cantiere devono essere conformi alle direttive europee applicabili, dotate di marcatura CE e di dichiarazione di conformita'. Devono essere utilizzate secondo le istruzioni del fabbricante e mantenute in efficienza.

### 9.2 Verifiche obbligatorie
| Attrezzatura | Verifica | Frequenza | Riferimento |
|-------------|----------|-----------|-------------|
| Gru a torre | Prima verifica + periodica | Biennale | All. VII D.lgs 81/08 |
| Gru su autocarro | Prima verifica + periodica | Annuale | All. VII D.lgs 81/08 |
| Piattaforme elevabili (PLE) | Prima verifica + periodica | Annuale | All. VII D.lgs 81/08 |
| Ponteggi metallici | Verifica prima del montaggio | Ad ogni montaggio | Art. 137 D.lgs 81/08 |
| Scale portatili | Controllo visivo | Giornaliero | Norma UNI EN 131 |
| Escavatori | Controllo manutenzione | Secondo libretto | Direttiva Macchine |
| Impianto elettrico | Verifica impianto di terra | Biennale | DPR 462/01 |
| Apparecchi a pressione | Verifica periodica | Secondo tabella | All. VII D.lgs 81/08 |
| Funi e catene | Controllo trimestrale | Trimestrale | Art. 71 D.lgs 81/08 |

### 9.3 Abilitazioni operatori
| Attrezzatura | Abilitazione richiesta | Riferimento |
|-------------|----------------------|-------------|
| Gru a torre | Patentino gruista | Acc. Stato-Regioni 22/02/2012 |
| Gru su autocarro | Patentino gruista | Acc. Stato-Regioni 22/02/2012 |
| Piattaforme elevabili | Patentino PLE | Acc. Stato-Regioni 22/02/2012 |
| Escavatori (>6 t) | Patentino escavatorista | Acc. Stato-Regioni 22/02/2012 |
| Carrello elevatore | Patentino carrellista | Acc. Stato-Regioni 22/02/2012 |
| Trattrice agricola | Patentino trattorista | Acc. Stato-Regioni 22/02/2012 |
| Autobetoniera | Patente C + CQC | Codice della Strada |

### 9.4 Manutenzione
- Registro di manutenzione per ogni macchina/attrezzatura
- Manutenzione ordinaria secondo le istruzioni del fabbricante
- Manutenzione straordinaria da personale qualificato
- Divieto di rimuovere o modificare i dispositivi di sicurezza
- Controllo pre-utilizzo giornaliero da parte dell'operatore

---

## SEZIONE 10 - SOSTANZE E PREPARATI PERICOLOSI

### 10.1 Gestione sostanze pericolose
Per ogni sostanza pericolosa utilizzata in cantiere e' necessario:
- Disporre della Scheda Dati di Sicurezza (SDS) aggiornata in 16 sezioni (Reg. REACH)
- Conservare le SDS in luogo accessibile a tutti i lavoratori
- Formare i lavoratori sui rischi e le misure di protezione
- Utilizzare i DPI indicati nella SDS
- Stoccare le sostanze in area dedicata con bacino di contenimento

### 10.2 Sostanze comuni in cantiere
| Sostanza | Classificazione CLP | Rischi principali | DPI richiesti |
|----------|-------------------|-------------------|---------------|
| Cemento/calcestruzzo | H315, H317, H318 | Irritazione cutanea, sensibilizzazione, lesioni oculari | Guanti, occhiali, mascherina |
| Additivi per cls | Variabile | Irritazione, corrosione | Guanti chimici, occhiali |
| Vernici e solventi | H225, H304, H336 | Infiammabile, tossicita' per inalazione | Maschera con filtri A, guanti chimici |
| Resine epossidiche | H315, H317, H319 | Sensibilizzazione cutanea | Guanti nitrile, occhiali |
| Oli disarmanti | H304 | Aspirazione polmonare | Guanti |
| Gasolio | H226, H304, H332 | Infiammabile, nocivo | Guanti, maschera se vapori |
| Amianto (se presente) | H350 | Cancerogeno | Piano lavoro specifico (art. 256) |

### 10.3 Etichettatura e stoccaggio
- Tutti i contenitori devono riportare l'etichetta CLP (pittogrammi GHS)
- Stoccaggio separato per incompatibilita' chimica
- Bacini di contenimento per liquidi (capacita' >= 110% del contenitore piu' grande)
- Divieto di travasare in contenitori anonimi
- Divieto di fumare e utilizzare fiamme libere nelle aree di stoccaggio

---

## SEZIONE 11 - GESTIONE RIFIUTI

### 11.1 Normativa di riferimento
La gestione dei rifiuti prodotti in cantiere e' effettuata nel rispetto del D.lgs 152/2006 (Testo Unico Ambientale) e s.m.i. L'impresa e' iscritta all'Albo Nazionale Gestori Ambientali per le categorie pertinenti.

### 11.2 Codici CER dei rifiuti tipici di cantiere
| Codice CER | Descrizione | Tipo | Gestione |
|------------|-------------|------|----------|
| 17 01 01 | Cemento | Non pericoloso | Recupero/discarica |
| 17 01 02 | Mattoni | Non pericoloso | Recupero/discarica |
| 17 01 03 | Mattonelle e ceramiche | Non pericoloso | Recupero/discarica |
| 17 01 07 | Miscugli di cemento, mattoni, mattonelle | Non pericoloso | Recupero/discarica |
| 17 02 01 | Legno | Non pericoloso | Recupero |
| 17 02 02 | Vetro | Non pericoloso | Recupero |
| 17 02 03 | Plastica | Non pericoloso | Recupero |
| 17 03 02 | Miscele bituminose (no catrame) | Non pericoloso | Recupero/discarica |
| 17 04 05 | Ferro e acciaio | Non pericoloso | Recupero |
| 17 04 07 | Metalli misti | Non pericoloso | Recupero |
| 17 05 04 | Terra e rocce (no sostanze pericolose) | Non pericoloso | Riutilizzo/discarica |
| 17 06 04 | Materiali isolanti (no amianto) | Non pericoloso | Discarica |
| 17 09 04 | Rifiuti misti di costruzione e demolizione | Non pericoloso | Recupero/discarica |
| 17 06 01* | Materiali isolanti contenenti amianto | **Pericoloso** | Ditta specializzata |
| 17 05 03* | Terra e rocce con sostanze pericolose | **Pericoloso** | Impianto autorizzato |
| 08 01 11* | Pitture e vernici con solventi organici | **Pericoloso** | Impianto autorizzato |
| 13 02 08* | Oli esausti | **Pericoloso** | Consorzio CONOU |

### 11.3 Procedure di gestione
- Deposito temporaneo: max 1 anno dalla data di produzione (o 10 mc per i pericolosi, 20 mc per i non pericolosi)
- Formulari di Identificazione Rifiuti (FIR) per ogni trasporto
- Registro cronologico di carico e scarico (modello SISTRI/RENTRI)
- Trasporto solo con mezzi autorizzati (Albo Gestori Ambientali)
- Conferimento a impianti autorizzati con verifica delle autorizzazioni

---

## SEZIONE 12 - FORMAZIONE E INFORMAZIONE DEI LAVORATORI

### 12.1 Formazione obbligatoria
Tutti i lavoratori devono aver completato la formazione prevista dall'Accordo Stato-Regioni del 21/12/2011 e successivi aggiornamenti:

| Tipo di formazione | Durata | Aggiornamento | Note |
|-------------------|--------|---------------|------|
| Formazione generale | 4 ore | - | Valida per sempre |
| Formazione specifica (rischio alto - edilizia) | 12 ore | 6 ore ogni 5 anni | Obbligatoria per cantieri |
| Preposto | 8 ore aggiuntive | 6 ore ogni 2 anni | Per chi svolge funzioni di preposto |
| Dirigente per la sicurezza | 16 ore | 6 ore ogni 5 anni | Se applicabile |
| Primo Soccorso (Gruppo B) | 12 ore | 4 ore ogni 3 anni | Per gli addetti designati |
| Antincendio (rischio medio) | 8 ore | 5 ore ogni 5 anni | Per gli addetti designati |
| RLS | 32 ore | 4 ore/anno | Rappresentante dei lavoratori |
| Ponteggi (PIMUS) | 28 ore | 4 ore ogni 4 anni | Per addetti montaggio/smontaggio |
| Lavori in quota | 4-8 ore | Secondo tipologia | Per chi opera oltre 2 m |
| Spazi confinati | 12 ore | Secondo valutazione | Se applicabile (art. 66 e DPR 177/11) |

### 12.2 Abilitazioni e patentini
Le abilitazioni per l'uso di attrezzature specifiche sono disciplinate dall'Accordo Stato-Regioni del 22/02/2012 (vedi Sezione 9.3).

### 12.3 Informazione
All'ingresso in cantiere, ogni lavoratore riceve informazione su:
- Rischi specifici del cantiere e delle lavorazioni
- Misure di prevenzione e protezione adottate
- Procedure di emergenza e vie di fuga
- Nominativi delle figure di sicurezza
- Ubicazione presidi di emergenza (cassetta PS, estintori, punto di raccolta)
- Contenuto del POS e del PSC (per le parti pertinenti)

### 12.4 Registro formazione
L'impresa conserva copia degli attestati di formazione di tutti i lavoratori impiegati in cantiere. Il registro e' disponibile per la consultazione da parte del CSE e degli organi di vigilanza.

---

## SEZIONE 13 - SORVEGLIANZA SANITARIA

### 13.1 Protocollo sanitario
Il Medico Competente (${v(d.medico)}) definisce il protocollo sanitario in base ai rischi specifici delle mansioni svolte. La sorveglianza sanitaria comprende:

- **Visita medica preventiva:** prima dell'assunzione o del cambio mansione
- **Visita medica periodica:** secondo le periodicita' stabilite dal protocollo
- **Visita medica su richiesta:** del lavoratore, se correlata ai rischi professionali
- **Visita medica alla cessazione:** per esposizione a rischi specifici (es. amianto, rumore)
- **Visita medica al rientro:** dopo assenza >60 giorni per malattia

### 13.2 Accertamenti sanitari tipici per lavoratori edili
| Rischio | Accertamento | Periodicita' |
|---------|-------------|--------------|
| Movimentazione manuale carichi | Visita + rachide | Annuale |
| Rumore >85 dB(A) | Audiometria | Annuale |
| Vibrazioni mano-braccio | Visita + arti superiori | Biennale |
| Vibrazioni corpo intero | Visita + rachide | Annuale |
| Polveri (silice, cemento) | Spirometria + Rx torace | Annuale/biennale |
| Sostanze chimiche | Esami ematochimici | Secondo SDS |
| Lavoro in quota | Visita + idoneita' specifica | Annuale |
| Lavoro notturno | Visita + accertamenti specifici | Annuale |
| Videoterminale (>20 h/sett) | Visita oculistica | Biennale/quinquennale |

### 13.3 Giudizio di idoneita'
Il Medico Competente esprime per ogni lavoratore uno dei seguenti giudizi:
- Idoneo alla mansione specifica
- Idoneo con prescrizioni o limitazioni
- Inidoneo temporaneo (con indicazione del periodo)
- Inidoneo permanente alla mansione specifica

La cartella sanitaria e' conservata dal Medico Competente con vincolo di segreto professionale.

---

## SEZIONE 14 - FIRME E PRESA VISIONE

Il presente Piano Operativo di Sicurezza e' stato redatto ai sensi del D.lgs 81/2008 e s.m.i. e viene sottoscritto dalle seguenti figure:

---

**Datore di Lavoro dell'impresa esecutrice**

Nome: ${v(d.companyName)}

Firma: _________________________________  Data: _________________

---

**Responsabile Servizio Prevenzione e Protezione (RSPP)**

Nome: ${v(d.rspp)}

Firma: _________________________________  Data: _________________

---

**Rappresentante dei Lavoratori per la Sicurezza (RLS)**

Nome: ${v(d.rls)}

Firma: _________________________________  Data: _________________

---

**Medico Competente**

Nome: ${v(d.medico)}

Firma: _________________________________  Data: _________________

---

**Coordinatore per la Sicurezza in fase di Esecuzione (CSE) - Per presa visione**

Nome: ${v(d.cse)}

Firma: _________________________________  Data: _________________

---

**DICHIARAZIONE DEI LAVORATORI**

I sottoscritti lavoratori dichiarano di aver ricevuto copia del presente POS, di averne compreso il contenuto e di impegnarsi al rispetto delle disposizioni in esso contenute.

| N. | Nominativo | Data | Firma |
|----|-----------|------|-------|
${(d.workers && d.workers.length > 0)
  ? d.workers.map((w, i) => `| ${i + 1} | ${v(w.name)} | _________________ | _________________ |`).join('\n')
  : '| 1 | [DA COMPILARE] | _________________ | _________________ |\n| 2 | [DA COMPILARE] | _________________ | _________________ |\n| 3 | [DA COMPILARE] | _________________ | _________________ |'
}

---

*Documento generato con sistema ibrido template + AI - ${oggi}*
*Revisione ${rev}*
`;
}

module.exports = { buildPosDocument };
