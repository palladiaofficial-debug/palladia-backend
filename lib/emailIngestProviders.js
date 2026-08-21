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
 * Percorsi menu presi dalle guide ufficiali di ciascun provider (Aruba:
 * guide.aruba.it; Legalmail: manuale utente InfoCert; Namirial: servicedesk
 * Namirial; Gmail/Outlook: supporto Google/Microsoft) — non verificati con uno
 * screenshot dal vivo del pannello attuale, quindi i nomi esatti delle voci
 * potrebbero differire se il provider ha aggiornato l'interfaccia da quando la
 * guida è stata scritta. Ordine di priorità: PEC (Aruba, Legalmail, Namirial —
 * le più usate dalle imprese edili italiane), poi Gmail/Outlook.
 *
 * `image` per ogni passo è lo spazio predisposto per uno screenshot annotato del
 * pannello reale (voce di menu evidenziata) — nessuno screenshot è stato ancora
 * verificato dal vivo, quindi resta `null` finché non ne produciamo uno vero:
 * un riquadro vuoto onesto è meglio di un'immagine inventata.
 */

const EMAIL_PROVIDERS = [
  {
    key: 'aruba', label: 'Aruba PEC', isPec: true,
    steps: [
      { text: 'Accedi alla Webmail Aruba con il tuo indirizzo PEC e la password.', image: null },
      { text: 'In alto a destra apri il menu col tuo nome o le tue iniziali, poi tocca "Impostazioni".', image: null },
      { text: 'Nel menu a sinistra apri "Messaggi e scrittura", poi "Inoltro automatico".', image: null },
      { text: 'Tocca "+ Crea inoltro automatico".', image: null },
      { text: "Incolla l'indirizzo che ti abbiamo dato come destinatario e salva.", image: null },
    ],
    confirmNote: "Aruba manda un'email di conferma alla tua casella — è normale, non serve fare nulla, ma può richiedere qualche minuto prima che l'inoltro sia attivo.",
  },
  {
    key: 'legalmail', label: 'Legalmail (InfoCert)', isPec: true,
    steps: [
      { text: 'Accedi alla Webmail Legalmail.', image: null },
      { text: 'Tocca l\'icona a ingranaggio "Impostazioni" in alto a destra, poi "Tutte le impostazioni".', image: null },
      { text: 'Vai su "Filtri e inoltro".', image: null },
      { text: 'Tocca "+ Nuovo Filtro". Imposta la regola su tutti i messaggi in arrivo, poi come azione scegli "Inoltra a" (o "inoltro").', image: null },
      { text: "Incolla l'indirizzo che ti abbiamo dato e salva.", image: null },
    ],
    confirmNote: 'Il filtro si applica solo ai nuovi messaggi da questo momento in poi, non a quelli già ricevuti.',
  },
  {
    key: 'namirial', label: 'Namirial PEC', isPec: true,
    steps: [
      { text: 'Accedi alla Webmail Namirial (webmailpro.sicurezzapostale.it).', image: null },
      { text: 'Tocca "Impostazioni", poi "Filtri", poi "Crea".', image: null },
      { text: 'Dai un nome al filtro e imposta una condizione che comprenda tutti i messaggi in arrivo.', image: null },
      { text: 'Come azione scegli "Inoltra il messaggio" e incolla l\'indirizzo che ti abbiamo dato.', image: null },
      { text: 'Salva.', image: null },
    ],
    confirmNote: 'Se il pannello non offre una condizione "tutti i messaggi", usane una molto ampia (per esempio un mittente che contiene "@") — l\'importante è che copra ogni email in arrivo.',
  },
  {
    key: 'gmail', label: 'Gmail', isPec: false,
    steps: [
      { text: 'Apri Gmail sul computer, poi tocca l\'icona a ingranaggio "Impostazioni" in alto a destra.', image: null },
      { text: 'Tocca "Visualizza tutte le impostazioni".', image: null },
      { text: 'Apri la scheda "Inoltro e POP/IMAP".', image: null },
      { text: 'Tocca "Aggiungi un indirizzo di inoltro" e incolla l\'indirizzo che ti abbiamo dato.', image: null },
      { text: 'Tocca "Avanti", poi "Procedi", poi "OK".', image: null },
    ],
    confirmNote: "Gmail manda un'email di verifica all'indirizzo di Palladia — la riconosce e conferma da sola, non devi fare nulla tu, ma può richiedere qualche minuto.",
  },
  {
    key: 'outlook', label: 'Outlook', isPec: false,
    steps: [
      { text: 'Apri Outlook.com, poi tocca l\'icona a ingranaggio "Impostazioni" in alto a destra.', image: null },
      { text: 'Tocca "Posta", poi "Inoltro".', image: null },
      { text: "Attiva l'interruttore e incolla l'indirizzo che ti abbiamo dato.", image: null },
      { text: 'Salva.', image: null },
    ],
    confirmNote: "L'inoltro parte subito sui nuovi messaggi in arrivo.",
  },
];

function getProvider(key) {
  return EMAIL_PROVIDERS.find((p) => p.key === key) || null;
}

module.exports = { EMAIL_PROVIDERS, getProvider };
