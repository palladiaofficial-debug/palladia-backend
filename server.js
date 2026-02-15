require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.get('/', (req, res) => {
  res.json({ message: 'Palladia Backend API is running!' });
});

app.get('/api/sites', async (req, res) => {
  try {
    const { data, error } = await supabase.from('sites').select('*');
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sites', async (req, res) => {
  try {
    const { data, error } = await supabase.from('sites').insert([req.body]).select();
    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/sites/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('sites').update(req.body).eq('id', id).select();
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/sites/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('sites').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Site deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sites/:id/generate-pos', async (req, res) => {
  try {
    const posData = req.body;
    
    const megaPrompt = `Sei il miglior Coordinatore per la Sicurezza in Italia con 30 anni di esperienza. Genera un Piano Operativo di Sicurezza PROFESSIONALE e COMPLETO conforme al D.lgs 81/2008.

DATI CANTIERE:
Indirizzo: ${posData.siteAddress || 'N/A'}
Committente: ${posData.client || 'N/A'}
Natura lavori: ${posData.workType || 'N/A'}
Importo: €${posData.budget || '0'}
Periodo: ${posData.startDate || 'N/A'} - ${posData.endDate || 'N/A'}
Numero operai max: ${posData.numWorkers || '0'}

IMPRESA ESECUTRICE:
Ragione sociale: ${posData.companyName || 'N/A'}
P.IVA: ${posData.companyVat || 'N/A'}

FIGURE DI SICUREZZA:
Responsabile Lavori: ${posData.responsabileLavori || 'N/A'}
CSP: ${posData.csp || 'N/A'}
CSE: ${posData.cse || 'N/A'}
RSPP: ${posData.rspp || 'N/A'}
RLS: ${posData.rls || 'N/A'}
Medico Competente: ${posData.medico || 'N/A'}
Addetto Primo Soccorso: ${posData.primoSoccorso || 'N/A'}
Addetto Antincendio: ${posData.antincendio || 'N/A'}

LAVORAZIONI PREVISTE:
${posData.selectedWorks?.join('\n') || 'Da definire'}

LAVORATORI:
${posData.workers?.map(w => w.name + ' - ' + w.qualification + ' (matr. ' + w.matricola + ')').join('\n') || 'Da definire'}

GENERA DOCUMENTO COMPLETO (15.000+ parole) CON QUESTE SEZIONI OBBLIGATORIE:

═══════════════════════════════════════════════════════════════

1. DATI GENERALI DEL LAVORO
- Descrizione dettagliata dell'opera
- Ubicazione cantiere con riferimenti catastali
- Durata presunta lavori in giorni
- Numero massimo lavoratori presenti contemporaneamente
- Ammontare complessivo presunto lavori

2. SOGGETTI CON COMPITI DI SICUREZZA
- Committente (dati completi)
- Responsabile dei Lavori (qualifica, estremi nomina)
- Coordinatore Sicurezza Progettazione (qualifica art. 98)
- Coordinatore Sicurezza Esecuzione (qualifica art. 98)
- Impresa affidataria e subappaltatori
- Lavoratori autonomi
- RSPP aziendale (qualifica art. 32-33)
- RLS (qualifica art. 47)
- Medico Competente (qualifica art. 38)
- Preposti di cantiere
- Addetto Primo Soccorso (formazione 12h)
- Addetto Antincendio (formazione rischio medio/alto)

3. AREA DI CANTIERE E ORGANIZZAZIONE
- Planimetria con layout cantiere
- Viabilità interna ed esterna
- Zone di carico/scarico
- Depositi materiali
- Zone stoccaggio rifiuti
- Impianti fissi (elettrico, idrico, fognario)
- Servizi igienico-assistenziali (spogliatoi, mensa, servizi)
- Delimitazioni e recinzioni
- Segnaletica di cantiere
- Accessi e uscite di emergenza

4. LAVORAZIONI - PER OGNUNA DELLE ${posData.selectedWorks?.length || 0} LAVORAZIONI:

[LAVORAZIONE 1/N] - NOME LAVORAZIONE
a) DESCRIZIONE TECNICA DETTAGLIATA
   - Modalità esecutive step-by-step
   - Fasi operative
   - Interferenze con altre lavorazioni
   
b) TUTTI I RISCHI IDENTIFICATI (con valutazione P×D):
   - Caduta dall'alto (P×D = ...)
   - Caduta materiale dall'alto (P×D = ...)
   - Investimento (P×D = ...)
   - Elettrocuzione (P×D = ...)
   - Rumore (dBA, categoria rischio)
   - Vibrazioni HAV/WBV (m/s², categoria)
   - Movimentazione Manuale Carichi (kg, NIOSH)
   - Polveri/Amianto (mg/m³)
   - Agenti chimici (sostanze, CAS, VLE)
   - Radiazioni (UV, IR)
   - Microclima (WBGT)
   - Ustioni, schiacciamenti, tagli
   - Rischio biologico
   - Stress lavoro-correlato
   
   MATRICE RISCHIO:
   Probabilità (1-4) × Danno (1-4) = Rischio
   1-2: Basso | 3-4: Medio | 6-8: Alto | 9-16: Molto Alto
   
c) MISURE DI PREVENZIONE E PROTEZIONE
   - Misure tecniche (parapetti, reti, ancoraggi)
   - Misure organizzative (procedure, turnazioni)
   - Misure procedurali (permessi lavoro, check)
   - Segnaletica specifica (ISO 7010)
   
d) DPI OBBLIGATORI (con norme UNI EN):
   1. Elmetto protettivo (UNI EN 397 classe A/B)
   2. Calzature sicurezza S3 (UNI EN ISO 20345)
   3. Guanti protezione meccanica (UNI EN 388 livello ...)
   4. Occhiali/visiera (UNI EN 166 classe ottica 1)
   5. Otoprotettori SNR>... dB (UNI EN 352)
   6. Maschere FFP2/FFP3 (UNI EN 149)
   7. Imbracatura anticaduta (UNI EN 361)
   [Specificare per ogni DPI: tipo, classe, quando usarlo]

e) ATTREZZATURE E MACCHINE:
   - Elenco completo attrezzature
   - Verifiche periodiche obbligatorie (INAIL, enti)
   - Libretto d'uso e manutenzione
   - Formazione specifica richiesta (patentini)
   
f) PRESIDI SANITARI NECESSARI:
   - Cassetta pronto soccorso (DM 388/2003)
   - Pacchetto medicazione
   - Lavaocchi/doccia emergenza se chimici

5. SEGNALETICA DI SICUREZZA (ISO 7010)

CARTELLI DI OBBLIGO (Sfondo BLU):
- M014: Casco protezione obbligatorio
  Prescrizione: Indossare sempre elmetto conforme EN 397
- M008: Calzature di sicurezza obbligatorie
  Prescrizione: Scarpe S3 con puntale e lamina EN ISO 20345
- M009: Guanti di protezione obbligatori
  Prescrizione: Guanti conformi EN 388 secondo rischio
- M004: Protezione vie respiratorie obbligatoria
  Prescrizione: Maschere FFP2/FFP3 per polveri
- M013: Protezione viso obbligatoria
  Prescrizione: Visiera per schegge e sostanze
- M003: Protezione udito obbligatoria
  Prescrizione: Otoprotettori SNR adeguato
- M020: Imbracatura sicurezza obbligatoria
  Prescrizione: Cintura EN 361 + cordino EN 355

CARTELLI DI DIVIETO (Bordo ROSSO):
- P002: Vietato fumare
- P003: Vietato fuoco/fiamme libere
- P006: Vietato accesso ai non addetti
- P010: Vietato spegnere con acqua
- P021: Vietato passaggio pedonale

CARTELLI DI AVVERTIMENTO (Sfondo GIALLO):
- W012: Pericolo elettrico
- W001: Pericolo generico
- W016: Sostanze tossiche
- W017: Sostanze radioattive
- W023: Caduta con dislivello
- W035: Carichi sospesi

CARTELLI SALVATAGGIO (Sfondo VERDE):
- E001-E004: Uscite emergenza (4 direzioni)
- E003: Pronto soccorso
- E007: Punto di raccolta
- E012: Barella
- E013: Doccia di emergenza

CARTELLI ANTINCENDIO (Sfondo ROSSO):
- F001: Estintore
- F002: Idrante
- F003: Scala antincendio
- F005: Telefono emergenza

6. PROCEDURE DI EMERGENZA

NUMERI UTILI:
- 118: Emergenza Sanitaria
- 115: Vigili del Fuoco
- 112: Carabinieri
- Pronto Soccorso più vicino: [identificare]
- SPISAL locale: [identificare]
- Centro Antiveleni: 02-66101029

EVACUAZIONE:
1. Allarme (chi, come)
2. Interruzione lavori
3. Percorsi di esodo
4. Punto raccolta esterno
5. Appello nominale
6. Chiamata soccorsi

GESTIONE INFORTUNIO:
1. Soccorso immediato (addetto PS)
2. Chiamata 118 se grave
3. Protezione area
4. Apertura registro infortuni
5. Denuncia INAIL entro 2gg
6. Indagine cause (near miss)

INCENDIO:
1. Allarme
2. Tentativo spegnimento (addetto)
3. Evacuazione se non domabile
4. Chiamata VVF 115
5. Non usare acqua su quadri elettrici

7. DISPOSITIVI DI PROTEZIONE INDIVIDUALE - SCHEDE

DPI 1: ELMETTO DI PROTEZIONE
- Norma: UNI EN 397
- Classe: A (440V) o B (alta resistenza)
- Caratteristiche: resistenza penetrazione, assorbimento urto
- Manutenzione: lavaggio con acqua, no solventi
- Sostituzione: ogni 3 anni o dopo urto
- Consegna: prima dell'inizio lavori
- Formazione: 2h (art. 77 comma 5)

DPI 2: CALZATURE DI SICUREZZA
- Norma: UNI EN ISO 20345
- Classe: S3 (puntale 200J + lamina + suola antiscivolo)
- Marcatura: S1P/S2/S3 secondo zona lavoro
- Manutenzione: pulizia giornaliera, asciugatura naturale
- Sostituzione: quando suola consumata >50%

[...continua per TUTTI i DPI...]

8. MACCHINE E ATTREZZATURE - VERIFICHE

ATTREZZATURA 1: PONTEGGIO METALLICO
- Tipo: a tubi e giunti / a telai prefabbricati
- Altezza max: ... metri
- Verifiche:
  * Montaggio: Preposto + PIMUS
  * Periodica: ogni volta modificato
  * Straordinaria: dopo eventi eccezionali (vento, sisma)
  * ENPI: ogni 2 anni
- Libretto: PiMUS obbligatorio (art. 136)
- Formazione: Patentino montatori (4h teoria + 8h pratica)

ATTREZZATURA 2: GRU A TORRE
- Verifica prima messa in servizio (INAIL/Ente)
- Verifica periodica: annuale
- Registro verifiche: sì
- Libretto matricola ENPI
- Patentino gruista: 12h teoria + 14h pratica

[...per OGNI attrezzatura...]

9. SOSTANZE PERICOLOSE

SOSTANZA 1: CEMENTO PORTLAND
- CAS: 65997-15-1
- Classificazione: Skin Irrit. 2, Eye Dam. 1
- Frasi H: H315, H318, H335
- VLE: 10 mg/m³ polveri respirabili
- DPI: Guanti nitrile, occhiali, FFP2
- Scheda Sicurezza: allegata
- Stoccaggio: locale asciutto, no fiamme

[...per OGNI sostanza...]

10. GESTIONE RIFIUTI

RIFIUTI PERICOLOSI:
- Codice CER 17.06.01*: materiali isolanti contenenti amianto
- Stoccaggio: area dedicata, segnalata
- Trasporto: ditta autorizzata Albo Gestori
- FIR: obbligatorio entro 24h

RIFIUTI NON PERICOLOSI:
- CER 17.01.01: calcestruzzo
- CER 17.02.01: legno
[...ecc...]

11. FORMAZIONE LAVORATORI

FORMAZIONE GENERALE: 4 ore (tutti)
FORMAZIONE SPECIFICA:
- Rischio BASSO: +4h
- Rischio MEDIO: +8h  
- Rischio ALTO: +12h

AGGIORNAMENTI:
- Quinquennale 6h

FORMAZIONI SPECIALISTICHE:
- Ponteggi: 28h
- PLE: 10h
- Carrelli: 12h
- Gru: 22h

ATTESTATI OBBLIGATORI:
[Elenco per ogni lavoratore]

12. SORVEGLIANZA SANITARIA

PROTOCOLLO SANITARIO:
- Visita preassuntiva
- Visita periodica annuale/biennale
- Visita a richiesta lavoratore
- Visita pre-ripresa dopo assenza >60gg

ACCERTAMENTI SPECIFICI:
- Rumore >85dB: audiometria
- Vibrazioni: visita neurologica
- MMC: visita ortopedica
- Chimico: esami ematochimici

GIUDIZI IDONEITÀ:
- Idoneo
- Idoneo con prescrizioni
- Temporaneamente inidoneo
- Permanentemente inidoneo

═══════════════════════════════════════════════════════════════

GENERA TUTTO in formato TESTO STRUTTURATO, DETTAGLIATO, PROFESSIONALE.
Minimo 15.000 parole. Massima completezza tecnica e conformità normativa.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 16000,
        messages: [{ role: 'user', content: megaPrompt }]
      })
    });
    
    const data = await response.json();
    res.json({ content: data.content[0].text, posData });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});