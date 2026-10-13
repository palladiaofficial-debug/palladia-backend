'use strict';
/**
 * lib/schedeFonti.js — F-350 (AUDIT.md del frontend). Dati di letteratura per
 * la valutazione di rumore e vibrazioni nelle schede lavorazione (art. 190
 * c. 5-bis e art. 202 c. 2 D.Lgs. 81/08), con la loro fonte, e i calcoli.
 *
 * GENERATO da scratch/schede_v2/build_fonti.js. Rumore: solo le tabelle CPT il
 * cui L_EX,8h ricalcolato dalle attività coincide con lo stampato (±0,3 dB):
 * scripts/selftest_schede_fonti.js lo ricontrolla a ogni esecuzione.
 *
 * Dati puri e funzioni pure: nessun I/O.
 */

const FONTI = {
  rumore: 'CPT Como, «Esposizione al rumore — schede dei gruppi omogenei per attività e per mansione», dati di letteratura derivati dal CPT di Torino (settimana di presumibile maggiore esposizione)',
  vibAttrezzi: 'ISPESL, «Vibrazioni al sistema mano-braccio. Valutazioni senza misurazioni», Tabelle A/1–A/6 (valore medio dell\'impugnatura peggiore ± deviazione standard)',
  vibGruppi: 'CPT Torino, «Valutazione dei rischi derivanti da vibrazioni» (D.Lgs. 187/05), gruppi omogenei: percentuale di esposizione',
};

// [attività, L_Aeq dB(A), % del tempo nella settimana di maggiore esposizione, L_picco dB(C) o null]
const RUMORE_GRUPPI = [
 { "id": "nc-muratore", "nome": "Muratore", "contesto": "nuove", "pagina": 8, "titoloFonte": "Nuove costruzioni - muratore", "lexFonte": 88.6, "attivita": [
   ["Installazione e smantellamento cantiere", 80.5, 0, 95.5 ],
   ["Montaggio e smontaggio ponteggi a montante", 77.6, 0, 89.2 ],
   ["Formazione casseforme con uso di sega circolare e percussioni per: fondazioni e struttura piani interrati", 85.9, 0, 101.1 ],
   ["Formazione casseforme con uso di sega circolare e percussioni per: struttura in c.a. in elevazione", 86.8, 0, 102.5 ],
   ["Formazione casseforme con uso di sega circolare e percussioni per: strutture di copertura e posa manto", 84.4, 0, 99.7 ],
   ["Posa elementi di solaio", 80.8, 0, 92.5 ],
   ["Getto con uso di vibratore", 86.7, 0, 103.9 ],
   ["Disarmo (percussioni, caduta elementi)", 90.2, 0, 108.7 ],
   ["Costruzione tamponamenti con taglio elementi", 89.6, 0, 99.2 ],
   ["Costruzione tavolati interni e rappezzi con taglio elementi", 87.8, 10, 102.4 ],
   ["Intonacatura interna", 80.3, 14, 92.4 ],
   ["Intonacatura esterna", 80.2, 12, 90.2 ],
   ["Posa infissi interni ed esterni", 84.6, 10, 92.4 ],
   ["Posa ringhiere ed opere ferro", 86.6, 9, 103.6 ],
   ["Assistenza muraria impianti con uso scanalatore ed utensili manuali e meccanici", 94.8, 18, 113.5 ],
   ["Posa tubazioni varie", 74.2, 10, 85.6 ],
   ["Getto sottofondi e pavimenti", 83.2, 8, 98.6 ],
   ["Opere e sistemazioni esterne", 81.7, 5, 97.8 ],
   ["Pause e tempi fisiologici", 65, 4, null ] ]
 },
 { "id": "nc-muratore-gru", "nome": "Muratore con uso della gru", "contesto": "nuove", "pagina": 9, "titoloFonte": "Nuove costruzioni – muratore con uso gru", "lexFonte": 86.1, "attivita": [
   ["Installazione e smantellamento cantiere", 80.5, 0, 95.5 ],
   ["Montaggio e smontaggio ponteggi a montante", 77.6, 0, 89.2 ],
   ["Formazione casseforme con uso di sega circolare e percussioni per: fondazioni e struttura piani interrati", 85.9, 0, 101.1 ],
   ["Formazione casseforme con uso di sega circolare e percussioni per: struttura in c.a. in elevazione", 86.8, 0, 102.5 ],
   ["Disarmo (percussioni, caduta elementi)", 90.2, 0, 100.7 ],
   ["Costruzione tamponamenti con taglio elementi", 89.6, 0, 99.2 ],
   ["Costruzione tavolati interni e rappezzi con taglio elementi", 87.8, 8, 102.4 ],
   ["Intonacatura interna", 80.3, 10, 92.4 ],
   ["Intonacatura esterna", 80.2, 8, 90.2 ],
   ["Posa infissi interni ed esterni", 84.6, 8, 92.4 ],
   ["Posa ringhiere ed opere in ferro", 86.6, 8, 103.6 ],
   ["Assistenza muraria impianti con uso scanalatore ed utensili manuali e meccanici", 94.8, 8, 113.5 ],
   ["Posa tubazioni varie", 74.2, 4, 85.6 ],
   ["Opere e sistemazioni esterne", 81.7, 2, 97.8 ],
   ["Manovra gru con radiocomando o pulsantiera mobile", 80.3, 40, 89.2 ],
   ["Pause e tempi fisiologici", 65, 4, null ] ]
 },
 { "id": "nc-manovale", "nome": "Manovale", "contesto": "nuove", "pagina": 10, "titoloFonte": "Nuove costruzioni – manovale", "lexFonte": 90.6, "attivita": [
   ["Installazione e smantellamento cantiere", 80.5, 0, 95.5 ],
   ["Lavoro alla betoniera", 82.9, 16, 94.1 ],
   ["Approvvigionamento e trasporti materiali per attività varie (tavolati,intonaci,pavimenti, pose varie,ecc)", 75.9, 0, 92.3 ],
   ["Formazione e smontaggio ponti mobili", 83.9, 10, 98.7 ],
   ["Assistenza muraria impianti con uso scanalatore ed utensili manuali", 94.8, 14.5, 113.5 ],
   ["Scavetti e rinterri manuali e meccanici", 79.3, 13, 92.2 ],
   ["Uso martello demolitore pneumatico", 106.1, 1.5, 120.3 ],
   ["Pulizie", 73.1, 25, 86.3 ],
   ["Scarico macerie", 82.6, 16, 98.1 ],
   ["Sistemazioni esterne", 81.7, 0, 97.8 ],
   ["Pause e tempi fisiologici", 65, 4, null ] ]
 },
 { "id": "nc-gruista", "nome": "Manovratore della gru", "contesto": "nuove", "pagina": 11, "titoloFonte": "Nuove costruzioni – manovratore gru", "lexFonte": 78.6, "attivita": [
   ["Movimentazione materiali con radiocomando o pulsantiera mobile", 80.3, 60, 89.2 ],
   ["Manutenzione e pause tecniche", 74.8, 25, 88.5 ],
   ["Pause e tempi fisiologici", 65, 15, null ] ]
 },
 { "id": "nc-assistente", "nome": "Assistente di cantiere", "contesto": "nuove", "pagina": 11, "titoloFonte": "Nuove costruzioni – assistente", "lexFonte": 79.8, "attivita": [
   ["Esposto a tutte le lavorazioni ma non in modo continuativo (media ponderata)", 81.2, 70, null ],
   ["Ufficio", 70, 20, null ],
   ["Pause e tempi fisiologici", 65, 10, null ] ]
 },
 { "id": "nc-capocantiere", "nome": "Capocantiere", "contesto": "nuove", "pagina": 11, "titoloFonte": "Nuove costruzioni – capocantiere", "lexFonte": 78.9, "attivita": [
   ["Esposto a tutte le lavorazioni ma non in modo continuativo (media ponderata)", 81.2, 60, null ],
   ["Ufficio", 70, 35, null ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "rs-sottomurazioni-muratore", "nome": "Muratore (ristrutturazioni con sottomurazioni)", "contesto": "ristrutturazioni", "pagina": 12, "titoloFonte": "Ristrutturazioni edili – muratore", "lexFonte": 88.8, "attivita": [
   ["Installazione e smantellamento cantiere", 80.5, 0, 95.5 ],
   ["Sottomurazioni: scavo", 82.5, 0, 99.4 ],
   ["Sottomurazioni: carpenteria", 86.7, 0, 101.5 ],
   ["Sottomurazioni: getto", 86.8, 0, 103.3 ],
   ["Montaggio e smontaggio ponteggi a montante", 77.6, 0, 89.2 ],
   ["Rifacimento/sistemazione manto di copertura", 86.4, 0, 104.7 ],
   ["Demolizioni con martello elettrico ed utensili manuali", 97.1, 0, 113.6 ],
   ["Demolizione manuale murature in breccia", 86.5, 0, 102.6 ],
   ["Posa elementi solaio", 80.8, 0, 94.1 ],
   ["Getto con benna ed uso vibratore", 86.6, 0, 97.3 ],
   ["Getto con pompa ed uso vibratore", 88.6, 0, 107.2 ],
   ["Disarmo (percussioni, caduta elementi)", 90.2, 0, 108.7 ],
   ["Costruzione e rifacimenti murature varie e tavolati con taglio elementi e rappezzi", 85.2, 20, 99.3 ],
   ["Demolizione manuale tavolati", 84.3, 0, 100.2 ],
   ["Scrostatura manuale intonaco", 85.8, 0, 99.6 ],
   ["Nuovo intonaco", 80.3, 24, 96.4 ],
   ["Opere esterne", 79.6, 0, 92.4 ],
   ["Getto sottofondi e pavimenti", 82.2, 12, 98.6 ],
   ["Assistenza muraria impianti con uso scanalatore ed utensili manuali e meccanici", 94.8, 18, 113.5 ],
   ["Posa infissi, ringhiere ed opere ferro", 86.5, 12, 103.6 ],
   ["Posa tubazioni varie", 75.4, 9, 88.6 ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "rs-sottomurazioni-manovale", "nome": "Manovale (ristrutturazioni con sottomurazioni)", "contesto": "ristrutturazioni", "pagina": 13, "titoloFonte": "Ristrutturazioni edili – manovale", "lexFonte": 90.1, "attivita": [
   ["Installazione e smantellamento cantiere", 80.5, 0, 95.5 ],
   ["Sottomurazioni: scavo", 82.5, 0, 99.4 ],
   ["Sottomurazioni: carpenteria", 86.6, 0, 101.5 ],
   ["Sottomurazioni: getto", 86.9, 0, 103.3 ],
   ["Lavoro alla betoniera", 82.9, 0, 98.1 ],
   ["Approvvigionamento e trasporti materiali per attività varie (tavolati, intonaci, pavimenti, pose varie,ecc)", 75.9, 0, 92.3 ],
   ["Uso martello demolitore pneumatico", 106.1, 1, 120.3 ],
   ["Demolizioni manuali", 86.9, 10, 102.6 ],
   ["Formazione e smontaggio ponti mobili", 83.9, 16, 99.7 ],
   ["Assistenza muraria impianti con uso scanalatore ed utensili manuali e meccanici", 94.8, 15, 113.5 ],
   ["Movimentazione e scarico macerie", 82.7, 15, 92.1 ],
   ["Pulizie", 80.1, 20, 93.2 ],
   ["Sistemazioni esterne", 75.6, 0, 84.3 ],
   ["Aiuto per opere varie", 80.2, 18, 92.1 ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "rs-muratore", "nome": "Muratore", "contesto": "ristrutturazioni", "pagina": 14, "titoloFonte": "Ristrutturazioni edili – muratore", "lexFonte": 88.5, "attivita": [
   ["Installazione e smantellamento cantiere", 80.5, 0, 87.5 ],
   ["Montaggio e smontaggio ponteggi a montante", 77.6, 0, 87.2 ],
   ["Rifacimento/sistemazione manto di copertura", 86.4, 0, 96.7 ],
   ["Demolizioni con martello elettrico ed utensili manuali", 97.1, 0, 106.6 ],
   ["Demolizione manuale murature in breccia", 86.5, 0, 99.6 ],
   ["Posa elementi solaio", 80.7, 0, 94.1 ],
   ["Getto con benna ed uso vibratore", 86.6, 0, 97.3 ],
   ["Getto con pompa ed uso vibratore", 88.6, 0, 98.2 ],
   ["Disarmo (percussioni, caduta elementi)", 90.2, 0, 105.7 ],
   ["Costruzione e rifacimenti murature varie e tavolati con taglio elementi e rappezzi", 85.2, 20, 96.3 ],
   ["Demolizione manuale tavolati", 84.3, 0, 96.2 ],
   ["Scrostatura manuale intonaco", 85.8, 0, 97.6 ],
   ["Nuovo intonaco", 80.3, 24, 92.4 ],
   ["Opere esterne", 79.6, 0, 92.4 ],
   ["Getto sottofondi e pavimenti", 80.2, 12, 98.2 ],
   ["Assistenza muraria impianti con uso scanalatore ed utensili manuali e meccanici", 94.8, 18, 103.5 ],
   ["Posa infissi, ringhiere ed opere ferro", 86.5, 12, 99.6 ],
   ["Posa tubazioni varie", 75.4, 9, 85.6 ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "rs-manovale", "nome": "Manovale", "contesto": "ristrutturazioni", "pagina": 15, "titoloFonte": "Ristrutturazioni edili – manovale", "lexFonte": 90, "attivita": [
   ["Installazione e smantellamento cantiere", 80.5, 0, 87.5 ],
   ["Lavoro alla betoniera", 82.9, 0, 90.4 ],
   ["Approvvigionamento e trasporti materiali per attività varie (tavolati, intonaci, pavimenti, pose varie,ecc)", 75.9, 0, 84.5 ],
   ["Uso martello demolitore pneumatico", 106.1, 1, 115.3 ],
   ["Demolizioni manuali", 86.9, 10, 96.3 ],
   ["Formazione e smontaggio ponti mobili", 83.9, 16, 92.7 ],
   ["Assistenza muraria impianti con uso scanalatore ed utensili manuali e meccanici", 94.8, 15, 103.5 ],
   ["Movimentazione e scarico macerie", 82.7, 15, 92.1 ],
   ["Pulizie", 80.1, 20, 93.2 ],
   ["Sistemazioni esterne", 75.6, 0, 94.3 ],
   ["Aiuto per opere varie", 80.2, 18, 92.1 ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "mn-muratore", "nome": "Muratore", "contesto": "manutenzioni", "pagina": 17, "titoloFonte": "Manutenzioni edili – muratore", "lexFonte": 87.7, "attivita": [
   ["Montaggio e smontaggio ponteggi", 77.6, 0, 89.2 ],
   ["Ricorsa tetto", 85.6, 0, 99.7 ],
   ["Demolizioni manuale", 89.8, 18, 102.4 ],
   ["Scrostatura manuale intonaco", 89.1, 15, 99.6 ],
   ["Rifacimento intonaco", 83.1, 32, 98.3 ],
   ["Riparazione pavimenti e rivestimenti", 89.7, 25, 101.2 ],
   ["Interventi su canalizzazioni", 85.5, 0, 98.7 ],
   ["Pause e tempi fisiologici", 65, 10, null ] ]
 },
 { "id": "mn-manovale", "nome": "Manovale", "contesto": "manutenzioni", "pagina": 18, "titoloFonte": "Manutenzioni edili – manovale", "lexFonte": 84.6, "attivita": [
   ["Confezionamento malte", 83.8, 4, 99.2 ],
   ["Demolizioni manuale", 89.8, 12, 102.4 ],
   ["Allontanamento macerie", 86.1, 13, 101.4 ],
   ["Trasporto materiali per varie attività", 85.1, 28, 98.5 ],
   ["Uso elevatore", 78.8, 12, 98.3 ],
   ["Costruzione e smontaggio ponti mobili", 84.7, 0, 97.2 ],
   ["Aiuto per opere varie", 83.6, 10, 96.7 ],
   ["Pulizia", 76.9, 15, 92.5 ],
   ["Pause e tempi fisiologici", 65, 6, null ] ]
 },
 { "id": "mn-assistente", "nome": "Assistente di cantiere", "contesto": "manutenzioni", "pagina": 18, "titoloFonte": "Manutenzioni edili – assistente", "lexFonte": 79.5, "attivita": [
   ["Esposto a tutte le lavorazioni ma non in modo continuativo (media ponderata)", 81.1, 70, null ],
   ["Ufficio", 72.8, 25, null ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "magazzino", "nome": "Addetto al magazzino", "contesto": "altro", "pagina": 19, "titoloFonte": "Attività di magazzino", "lexFonte": 81.3, "attivita": [
   ["Carico e scarico materiali manuale o con uso carrello", 85.6, 10, 102.5 ],
   ["Accatastamento materiali", 82.1, 30, 98.1 ],
   ["Pulizia materiali", 78.5, 25, null ],
   ["Piccola manutenzione mezzi", 82.2, 20, 98.6 ],
   ["Pause e tempi fisiologici", 65, 15, null ] ]
 },
 { "id": "autobetoniera", "nome": "Autista di autobetoniera", "contesto": "altro", "pagina": 20, "titoloFonte": "Autista di autobetoniera", "lexFonte": 86.6, "attivita": [
   ["Carico", 88.6, 10, 97.5 ],
   ["Trasporto", 79.9, 35, 86.1 ],
   ["Scarico", 90.6, 30, null ],
   ["Manutenzione, tempi tecnici di attesa, pulizia", 70, 20, 82.3 ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "pompa-cls", "nome": "Operatore di pompa per calcestruzzo", "contesto": "altro", "pagina": 21, "titoloFonte": "Autista/manovratore di pompa per calcestruzzo", "lexFonte": 87.4, "attivita": [
   ["Spostamento", 79.2, 20, 87.5 ],
   ["Attività di pompaggio", 89.7, 55, 99.1 ],
   ["Manutenzione, tempi tecnici di attesa, pulizia", 78.8, 20, null ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "betonaggio", "nome": "Addetto alla centrale di betonaggio", "contesto": "altro", "pagina": 22, "titoloFonte": "Addetto centrale betonaggio", "lexFonte": 78.4, "attivita": [
   ["Confezionamento impasto (in cabina di comando)", 79.2, 40, 87.5 ],
   ["Durante carico autobetoniera (in cabina di comando)", 78.7, 40, 83.1 ],
   ["Manutenzione, tempi tecnici di attesa, pulizie varie", 75.8, 15, null ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "escavatore-martellone", "nome": "Manovratore di escavatore con martellone", "contesto": "altro", "pagina": 23, "titoloFonte": "Movimento terra – lavori di scavo – manovratore escavatore", "lexFonte": 80.8, "attivita": [
   ["Utilizzo escavatore (porta cabina chiusa)", 80.4, 60, 89.5 ],
   ["Utilizzo escavatore con martellone (porta cabina chiusa)", 90.2, 4, 106.1 ],
   ["Manutenzione, tempi tecnici di attesa, pulizia", 76.4, 30, 83.9 ],
   ["Pause e tempi fisiologici", 65, 6, null ] ]
 },
 { "id": "escavatore-pala-cabinata", "nome": "Manovratore di escavatore e pala (cabinata)", "contesto": "altro", "pagina": 25, "titoloFonte": "Movimento terra – lavori di scavo – manovratore escavatore e pala", "lexFonte": 81.9, "attivita": [
   ["Utilizzo escavatore (porta cabina chiusa)", 80.4, 50, 89.5 ],
   ["Utilizzo escavatore con martellone (porta cabina chiusa)", 90.2, 5, 106.1 ],
   ["Utilizzo di pala meccanica cabinata (porta chiusa)", 81.6, 30, 89.9 ],
   ["Manutenzione, tempi tecnici di attesa, pulizia", 76.4, 10, 83.9 ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "escavatore-pala", "nome": "Manovratore di escavatore e pala (senza martellone)", "contesto": "altro", "pagina": 26, "titoloFonte": "Movimento terra – lavori di scavo – manovratore escavatore e pala", "lexFonte": 80.4, "attivita": [
   ["Utilizzo escavatore (porta cabina chiusa)", 80.4, 50, 91.5 ],
   ["Utilizzo di pala meccanica cabinata (porta chiusa)", 81.6, 35, 89.9 ],
   ["Manutenzione, tempi tecnici di attesa, pulizia", 76.4, 10, 83.9 ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "pala", "nome": "Manovratore di pala", "contesto": "altro", "pagina": 27, "titoloFonte": "Movimento terra – lavori di scavo – manovratore pala", "lexFonte": 80.9, "attivita": [
   ["Utilizzo di pala meccanica cabinata (porta chiusa)", 81.6, 80, 89.9 ],
   ["Manutenzione, tempi tecnici di attesa, pulizia", 76.4, 15, 83.9 ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "escavatore", "nome": "Manovratore di escavatore (senza martellone)", "contesto": "altro", "pagina": 28, "titoloFonte": "Movimento terra – lavori di scavo – manovratore escavatore", "lexFonte": 79.7, "attivita": [
   ["Utilizzo escavatore (porta cabina chiusa)", 80.4, 80, 91.5 ],
   ["Manutenzione, tempi tecnici di attesa, pulizia", 76.4, 15, 83.9 ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "autocarro", "nome": "Autista di autocarro", "contesto": "altro", "pagina": 29, "titoloFonte": "Autista di autocarro", "lexFonte": 80.5, "attivita": [
   ["Utilizzo autocarro", 80.2, 60, 91.5 ],
   ["Carico/scarico", 82.6, 25, 89.9 ],
   ["Manutenzione, tempi tecnici di attesa, pulizia", 77.4, 10, 83.9 ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "canalizzazioni", "nome": "Squadra canalizzazioni", "contesto": "altro", "pagina": 30, "titoloFonte": "Costruzione e manutenzione canalizzazioni – componenti la squadra", "lexFonte": 85.7, "attivita": [
   ["Taglio (rifilatura) manto stradale", 93.2, 6, 103.3 ],
   ["Scavo e posa armatura prefabbricata", 82.5, 36, 91.5 ],
   ["Scarico e posa tubazioni", 79.4, 8, 88.1 ],
   ["Getti vari", 82.3, 10, 89.4 ],
   ["Rinterro e compattazione", 85.1, 8, 92.5 ],
   ["Formazione massicciata (sottofondo)", 87.5, 14, 95.6 ],
   ["Formazione manto bituminoso", 86.7, 6, 93.6 ],
   ["Formazione strato usura con rullatura", 88.3, 4, 94.6 ],
   ["Lavori di finitura", 78.1, 4, 87.6 ],
   ["Pause e tempi fisiologici", 65, 4, null ] ]
 },
 { "id": "stradali-nuove", "nome": "Squadra lavori stradali (nuova costruzione)", "contesto": "altro", "pagina": 32, "titoloFonte": "Lavori stradali – nuova costruzione – squadra addetti", "lexFonte": 86.4, "attivita": [
   ["Installazione e smantellamento cantiere", 76.5, 3, 87.6 ],
   ["Scavo di sbancamento e formazione cassonetto", 86.5, 25, 97.5 ],
   ["Movimentazione terra per rilevati", 84.7, 16, 96.8 ],
   ["Formazione fondo stradale", 87.2, 12, 98.1 ],
   ["Stesura stabilizzato e compattatura", 87.9, 15, 99.4 ],
   ["Formazione manto bituminoso", 86.7, 15, 92.5 ],
   ["Formazione strato usura con rullatura", 88.3, 7, 98.6 ],
   ["Lavori di finitura", 78.1, 3, 87.6 ],
   ["Pause e tempi fisiologici", 65, 4, null ] ]
 },
 { "id": "stradali-ripristino", "nome": "Squadra lavori stradali (riparazione e ripristino)", "contesto": "altro", "pagina": 33, "titoloFonte": "Lavori stradali – interventi di riparazione e ripristino – squadra addetti", "lexFonte": 93.3, "attivita": [
   ["Installazione e smantellamento cantiere", 76.5, 3, 87.6 ],
   ["Rifilatura manto con tagliasfalto", 98.8, 20, 109.5 ],
   ["Demolizione/rimozione manto", 91.7, 25, 100.8 ],
   ["Formazione manto bituminoso", 86.7, 25, 96.1 ],
   ["Formazione strato usura con rullatura", 88.3, 17, 99.4 ],
   ["Lavori di finitura", 78.1, 5, 87.6 ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "stradali-manti", "nome": "Squadra lavori stradali (rifacimento manti)", "contesto": "altro", "pagina": 34, "titoloFonte": "Lavori stradali – rifacimento manti – squadra addetti", "lexFonte": 90.7, "attivita": [
   ["Installazione e smantellamento cantiere", 76.5, 3, 87.6 ],
   ["Fresatura manto", 94.1, 20, 109.5 ],
   ["Demolizione/rimozione manto", 91.7, 30, 100.8 ],
   ["Formazione manto bituminoso", 86.7, 22, 96.1 ],
   ["Formazione strato usura con rullatura", 88.3, 15, 99.4 ],
   ["Lavori di finitura", 78.1, 5, null ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "pavimenti-malta", "nome": "Posatore di pavimenti e rivestimenti con malta", "contesto": "altro", "pagina": 35, "titoloFonte": "Posa pavimenti e rivestimenti con malta", "lexFonte": 83.9, "attivita": [
   ["Formazione piano di posa", 80, 35, 91.5 ],
   ["Posa piastrelle", 82, 55, 89.9 ],
   ["Battitura assestamento con battipiastrelle", 94, 5, 101.9 ],
   ["Pause tecniche - fisiologico", 65, 5, null ] ]
 },
 { "id": "pavimenti-colla", "nome": "Posatore di pavimenti e rivestimenti con colla", "contesto": "altro", "pagina": 36, "titoloFonte": "Posa pavimenti e rivestimenti con colla", "lexFonte": 79, "attivita": [
   ["Rettifica e regolazione piano di posa", 82, 5, 90.5 ],
   ["Stesura colla e posa piastrelle", 79, 90, 89.9 ],
   ["Pause tecniche - fisiologico", 65, 5, null ] ]
 },
 { "id": "impermeabilizzazioni", "nome": "Addetto alle impermeabilizzazioni con guaine", "contesto": "altro", "pagina": 37, "titoloFonte": "Impermeabilizzazioni - guaine", "lexFonte": 86.7, "attivita": [
   ["Rettifica e regolazione piano di posa", 81, 5, 88.5 ],
   ["Posa guaina con utilizzo cannello", 87.1, 90, 89.9 ],
   ["Pause tecniche - fisiologico", 65, 5, null ] ]
 },
 { "id": "tinteggiature", "nome": "Pittore / verniciatore", "contesto": "altro", "pagina": 38, "titoloFonte": "Tinteggiature/verniciature", "lexFonte": 80, "attivita": [
   ["Preparazione fondo", 81.1, 25, null ],
   ["Tinteggiatura/verniciatura", 79.6, 60, 84.9 ],
   ["Finitura", 81.4, 10, 89.1 ],
   ["Pause tecniche - fisiologico", 65, 5, null ] ]
 },
 { "id": "infissione-pali", "nome": "Squadra infissione pali", "contesto": "altro", "pagina": 39, "titoloFonte": "Infissione pali", "lexFonte": 88.7, "attivita": [
   ["Installazione e smantellamento cantiere", 76.5, 3, 92.6 ],
   ["Utilizzo macchina movimento terra", 84.5, 20, 104.5 ],
   ["Utilizzo battipalo", 91.7, 30, 105.8 ],
   ["Movimentazione materiale", 90.1, 22, 100.6 ],
   ["Pulizia e manutenzione", 78.3, 15, 90.6 ],
   ["Sistemazione terreno", 82.1, 5, 97.6 ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 },
 { "id": "pali-tubo-forma", "nome": "Squadra pali con tubo forma, armatura e getto", "contesto": "altro", "pagina": 40, "titoloFonte": "Infissione tubo forma, posa armatura metallica, getto e recupero", "lexFonte": 88.4, "attivita": [
   ["Installazione e smantellamento cantiere", 76.5, 3, 92.6 ],
   ["Utilizzo macchina movimento terra", 84.5, 15, 104.5 ],
   ["Utilizzo battipalo", 91.7, 30, 105.8 ],
   ["Posa armatura metallica", 84.7, 12, 98.6 ],
   ["Getto", 89.3, 15, 98.6 ],
   ["Recupero elemento", 85.1, 10, 97.6 ],
   ["Pulizia e manutenzione", 78.3, 5, 90.6 ],
   ["Sistemazione terreno", 82.1, 5, 97.6 ],
   ["Pause e tempi fisiologici", 65, 5, null ] ]
 } ];

// [id, nome, a_hv medio m/s², deviazione standard, numero di attrezzi, tabella ISPESL]
const VIB_ATTREZZI = [["avvitatrice-pneumatica","Avvitatrice pneumatica",28,17,13,"A/1"],
  ["bocciardatrice-pneumatica","Bocciardatrice pneumatica (gradina)",38,11,6,"A/1"],
  ["scalpellatore-pneumatico","Martello scalpellatore pneumatico",27,7,6,"A/1"],
  ["piastra-compattatrice","Piastra compattatrice",13,4,9,"A/1"],
  ["giravite-elettrico","Giravite elettrico",4,3,4,"A/2"],
  ["levigatrice-orbitale","Levigatrice orbitale elettrica",6,2,13,"A/2"],
  ["levigatrice-pulitrice","Levigatrice-pulitrice elettrica (disco lucidatore)",4,2,3,"A/3"],
  ["martello-demolitore-elettrico","Martello demolitore elettrico",11,3,4,"A/3"],
  ["martello-demolitore-pneumatico","Martello demolitore pneumatico (tradizionale)",25,5,19,"A/3"],
  ["martello-perforatore-pneumatico","Martello perforatore pneumatico (tradizionale)",20,7,19,"A/3"],
  ["motosega","Motosega",8,4,11,"A/4"],
  ["motocoltivatore","Motocoltivatore / motofalciatrice",19,6,3,"A/4"],
  ["smerigliatrice-angolare","Smerigliatrice angolare (disco abrasivo)",4,2,59,"A/5"],
  ["smerigliatrice-diamantata","Smerigliatrice angolare con lama diamantata",7,2,8,"A/5"],
  ["seghetto-alternativo","Seghetto alternativo elettrico",5,1,6,"A/5"],
  ["sega-circolare","Sega circolare elettrica portatile",2,1,3,"A/6"],
  ["trapano-batteria","Trapano avvitatore a batteria",2,0.4,5,"A/6"],
  ["trapano-elettrico","Trapano elettrico",5,4,12,"A/6"],
  ["trapano-pneumatico","Trapano pneumatico",9,5,3,"A/6"],
  ["vibratore-cls","Vibratore per calcestruzzo ad immersione",14,8,5,"A/6"]];

const VIB_GRUPPI = [
 {
  "id": "demolizioni-manuali",
  "nome": "Operaio addetto alle demolizioni",
  "pagina": 63,
  "uso": {
   "ristrutturazioni": [
    [
     "martello-demolitore-pneumatico",
     5
    ],
    [
     "martello-demolitore-elettrico",
     25
    ]
   ]
  }
 },
 {
  "id": "polivalente",
  "nome": "Operaio comune polivalente",
  "pagina": 61,
  "uso": {
   "nuove": [
    [
     "martello-demolitore-elettrico",
     5
    ]
   ],
   "ristrutturazioni": [
    [
     "martello-demolitore-elettrico",
     1
    ]
   ]
  }
 },
 {
  "id": "martello-pneumatico",
  "nome": "Addetto al martello demolitore pneumatico",
  "pagina": 37,
  "uso": {
   "demolizioni": [
    [
     "martello-demolitore-pneumatico",
     10
    ]
   ],
   "stradali": [
    [
     "martello-demolitore-pneumatico",
     50
    ]
   ]
  }
 },
 {
  "id": "carpentiere-opere-arte",
  "nome": "Carpentiere (opere d'arte)",
  "pagina": 55,
  "uso": {
   "altro": [
    [
     "vibratore-cls",
     40
    ]
   ]
  }
 },
 {
  "id": "opere-esterne",
  "nome": "Capo squadra opere esterne",
  "pagina": 52,
  "uso": {
   "nuove": [
    [
     "piastra-compattatrice",
     5
    ]
   ]
  }
 },
 {
  "id": "pavimentista-esterni",
  "nome": "Pavimentista per esterni (autobloccanti)",
  "pagina": 93,
  "uso": {
   "nuove": [
    [
     "piastra-compattatrice",
     15
    ]
   ]
  }
 }
];

// ── Calcoli ─────────────────────────────────────────────────────────────────
const BY_RUMORE = new Map(RUMORE_GRUPPI.map(g => [g.id, g]));
const BY_VIB = new Map(VIB_ATTREZZI.map(([id, nome, a, sd, n, tab]) => [id, { id, nome, a, sd, n, tab }]));

/** L_EX,8h da [attività, L_Aeq, %]: 10·log Σ (p/100)·10^(L/10). */
function lex(attivita) {
  const e = attivita.reduce((s, [, l, p]) => s + (p / 100) * 10 ** (l / 10), 0);
  return e > 0 ? Math.round(10 * Math.log10(e) * 10) / 10 : 0;
}
/** Fascia di esposizione e obblighi (artt. 189–196). */
function fasciaRumore(l) {
  if (l <= 80) return { fascia: 'fino a 80 dB(A)', classe: 0, obblighi: 'Nessun obbligo specifico oltre la formazione generale', breve: 'Nessun obbligo specifico' };
  if (l <= 85) return { fascia: '80–85 dB(A)', classe: 1, obblighi: 'Otoprotettori messi a disposizione (art. 193), informazione e formazione (art. 195), visita medica su richiesta (art. 196 c. 2)', breve: 'Otoprotettori a disposizione, formazione, visita su richiesta' };
  if (l <= 87) return { fascia: '85–87 dB(A)', classe: 2, obblighi: 'Otoprotettori obbligatori (art. 193), sorveglianza sanitaria (art. 196), zona segnalata e delimitata (art. 192 c. 3), programma di riduzione (art. 192 c. 2)', breve: 'Otoprotettori obbligatori, visita medica, zona segnalata, programma di riduzione' };
  return { fascia: 'oltre 87 dB(A)', classe: 3, obblighi: 'Otoprotettori obbligatori, scelti per stare sotto 87 dB(A) all\'orecchio (art. 193 c. 1 d), sorveglianza sanitaria (art. 196), zona segnalata e delimitata, programma di riduzione (art. 192)', breve: 'Otoprotettori obbligatori con attenuazione verificata, visita medica, zona delimitata, programma di riduzione' };
}
/** A(8) = √( Σ a²·t / 8 h ), con t = % del tempo × 8 h. */
function a8(usi) {
  return Math.round(Math.sqrt(usi.reduce((s, { a, pct }) => s + a * a * (pct / 100), 0)) * 100) / 100;
}
function esitoVibrazioni(v) {
  if (v > 5) return { esito: 'Supera il valore limite (5 m/s²)', classe: 3 };
  if (v > 2.5) return { esito: 'Supera il valore d\'azione (2,5 m/s²)', classe: 2 };
  return { esito: 'Sotto il valore d\'azione', classe: 0 };
}
/** Minuti di uso effettivo al giorno per arrivare a una soglia di A(8). */
function minutiFino(soglia, a) { return Math.floor(8 * 60 * (soglia / a) ** 2); }

/** Gruppo di rumore; con più varianti per contesto (nuove/ristrutturazioni/manutenzioni) si sceglie quella con L_EX più alto. */
function gruppoRumore(id) { return BY_RUMORE.get(id) || null; }
function attrezzoVib(id) { return BY_VIB.get(id) || null; }

module.exports = { FONTI, RUMORE_GRUPPI, VIB_ATTREZZI, VIB_GRUPPI, lex, fasciaRumore, a8, esitoVibrazioni, minutiFino, gruppoRumore, attrezzoVib };
