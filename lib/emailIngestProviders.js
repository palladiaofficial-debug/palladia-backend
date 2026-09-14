'use strict';

/**
 * lib/emailIngestProviders.js
 *
 * Fonte unica delle istruzioni di inoltro per provider — usata sia dal wizard
 * passo-passo nell'app (GET /api/v1/expenses/email-ingest/providers) sia
 * dall'email di delega inviata a chi gestisce la PEC al posto del titolare
 * (services/emailIngestConfig.js → sendDelegateInstructions). Prima di questo
 * file il testo viveva solo nel frontend (Account.tsx): duplicarlo in due posti
 * avrebbe rischiato di far leggere al delegato passi diversi da quelli mostrati
 * al titolare nell'app.
 *
 * F-106 (AUDIT.md, 2026-09-01) → redesign 2026-09-14: la versione precedente
 * istruiva un INOLTRO AUTOMATICO su tutti i messaggi in arrivo ("imposta una
 * regola/filtro su tutta la posta") — un cliente l'ha impostato sulla casella
 * principale dell'azienda e ha smesso di ricevere qualunque email per giorni,
 * scoperto solo quando l'assistenza del suo provider ha trovato la regola.
 * Nessuna riga di queste istruzioni deve MAI più menzionare una regola che si
 * applica a "tutti i messaggi"/"ogni email in arrivo" — un test di regressione
 * (selftest_email_ingest_no_bulk_forward.js) lo verifica sul testo stesso, non
 * solo sul comportamento.
 *
 * Nuovo approccio, strutturalmente sicuro per costruzione: NESSUNA regola
 * automatica da impostare. Per ogni fattura ricevuta, un inoltro MANUALE del
 * singolo messaggio (lo stesso identico gesto che un titolare fa già oggi per
 * girare una fattura via WhatsApp — qui la stessa azione, verso l'indirizzo
 * dedicato invece che verso una persona). Un inoltro manuale non può mai
 * "catturare" il resto della posta: è una scelta cosciente, messaggio per
 * messaggio, non una regola che continua ad agire quando nessuno guarda.
 * I passi sono quasi identici in ogni client di posta — "Inoltra" è una
 * funzione universale — quindi restano minimi e non richiedono più di
 * navigare in un pannello impostazioni.
 *
 * `image` per ogni passo è lo spazio predisposto per uno screenshot annotato
 * (pulsante "Inoltra" evidenziato) — nessuno screenshot è stato ancora
 * verificato dal vivo, quindi resta `null` finché non ne produciamo uno vero:
 * un riquadro vuoto onesto è meglio di un'immagine inventata.
 */

const EMAIL_PROVIDERS = [
  {
    key: 'aruba', label: 'Aruba PEC', isPec: true,
    steps: [
      { text: 'Apri la Webmail Aruba e apri l\'email della fattura ricevuta.', image: null },
      { text: 'Tocca "Inoltra" (l\'icona con la freccia).', image: null },
      { text: "Incolla l'indirizzo che ti abbiamo dato nel campo destinatario e invia.", image: null },
    ],
    confirmNote: "Ripeti questi 3 passi ogni volta che arriva una nuova fattura — un gesto singolo ogni volta, non tocca il resto della tua posta.",
  },
  {
    key: 'legalmail', label: 'Legalmail (InfoCert)', isPec: true,
    steps: [
      { text: 'Apri la Webmail Legalmail e apri l\'email della fattura ricevuta.', image: null },
      { text: 'Tocca "Inoltra" (l\'icona con la freccia).', image: null },
      { text: "Incolla l'indirizzo che ti abbiamo dato e invia.", image: null },
    ],
    confirmNote: 'Ripeti questi 3 passi ogni volta che arriva una nuova fattura — un gesto singolo ogni volta, non tocca il resto della tua posta.',
  },
  {
    key: 'namirial', label: 'Namirial PEC', isPec: true,
    steps: [
      { text: 'Apri la Webmail Namirial (webmailpro.sicurezzapostale.it) e apri l\'email della fattura ricevuta.', image: null },
      { text: 'Tocca "Inoltra".', image: null },
      { text: 'Incolla l\'indirizzo che ti abbiamo dato e invia.', image: null },
    ],
    confirmNote: 'Ripeti questi 3 passi ogni volta che arriva una nuova fattura — un gesto singolo ogni volta, non tocca il resto della tua posta.',
  },
  {
    key: 'gmail', label: 'Gmail', isPec: false,
    steps: [
      { text: 'Apri Gmail e apri l\'email della fattura ricevuta.', image: null },
      { text: 'Tocca "Inoltra" (l\'icona con la freccia, in basso o nel menu con i tre puntini).', image: null },
      { text: 'Incolla l\'indirizzo che ti abbiamo dato e invia.', image: null },
    ],
    confirmNote: "Ripeti questi 3 passi ogni volta che arriva una nuova fattura — un gesto singolo ogni volta, non tocca il resto della tua posta.",
  },
  {
    key: 'outlook', label: 'Outlook', isPec: false,
    steps: [
      { text: 'Apri Outlook.com e apri l\'email della fattura ricevuta.', image: null },
      { text: 'Tocca "Inoltra".', image: null },
      { text: "Incolla l'indirizzo che ti abbiamo dato e invia.", image: null },
    ],
    confirmNote: "Ripeti questi 3 passi ogni volta che arriva una nuova fattura — un gesto singolo ogni volta, non tocca il resto della tua posta.",
  },
];

function getProvider(key) {
  return EMAIL_PROVIDERS.find((p) => p.key === key) || null;
}

module.exports = { EMAIL_PROVIDERS, getProvider };
