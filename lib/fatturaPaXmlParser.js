'use strict';

/**
 * lib/fatturaPaXmlParser.js
 * Parsing dello schema FatturaPA (standard pubblico stabile dell'Agenzia delle Entrate
 * per la fattura elettronica italiana — a differenza degli endpoint del provider A-Cube,
 * questo schema XML non dipende dal fornitore ed è documentato ufficialmente da anni).
 *
 * Usato da services/sdiConsultation.js per normalizzare le fatture scaricate dal
 * Cassetto Fiscale (XML grezzo) in una riga pronta per
 * services/sdiInvoices.js::ingestMappedExpense — lo stesso motore di ingest
 * condiviso anche da email e importazione massiva.
 */

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true, // "p:FatturaElettronica" → "FatturaElettronica", ecc.
  // Il parsing numerico automatico troncherebbe gli zero iniziali di P.IVA/codice
  // fiscale (es. "01234567890" → 1234567890) — teniamo tutto come stringa e
  // convertiamo esplicitamente solo ImportoTotaleDocumento, l'unico campo numerico reale.
  parseTagValue: false,
});

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstOf(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== '');
}

// Il CedentePrestatore può essere una persona fisica (Nome+Cognome) o un'impresa
// (Denominazione) — l'XSD FatturaPA prevede l'uno o l'altro, mai entrambi.
function extractSupplierName(anagrafica) {
  if (!anagrafica) return 'Fornitore sconosciuto';
  if (anagrafica.Denominazione) return String(anagrafica.Denominazione);
  const nome = anagrafica.Nome, cognome = anagrafica.Cognome;
  if (nome || cognome) return [nome, cognome].filter(Boolean).join(' ');
  return 'Fornitore sconosciuto';
}

function extractSupplierVat(cedentePrestatore) {
  const idFiscale = cedentePrestatore?.DatiAnagrafici?.IdFiscaleIVA;
  if (idFiscale?.IdCodice) return String(idFiscale.IdCodice);
  const cf = cedentePrestatore?.DatiAnagrafici?.CodiceFiscale;
  return cf ? String(cf) : null;
}

function extractPaymentMethod(datiPagamento) {
  const dettaglio = asArray(datiPagamento)[0]?.DettaglioPagamento;
  const modalita = String(asArray(dettaglio)[0]?.ModalitaPagamento || '').toUpperCase();
  // Codifica ufficiale FatturaPA: MP01 contanti, MP02 assegno, MP05/MP08 bonifico/carta, ecc.
  if (modalita === 'MP01') return 'contanti';
  if (modalita === 'MP02') return 'assegno';
  if (modalita === 'MP08' || modalita === 'MP18') return 'carta';
  return 'bonifico';
}

/**
 * Estrae dallo XML FatturaPA i dati necessari a costruire una riga company_expenses
 * (senza i campi company_id/source/sdi_invoice_id, aggiunti dal chiamante).
 *
 * Ritorna null se il body indica un documento diverso da fattura d'acquisto (es. nota
 * di credito emessa da noi, non gestita qui).
 */
function parseFatturaPaXml(xmlString) {
  const doc = parser.parse(xmlString);
  const root = doc?.FatturaElettronica;
  if (!root) throw new Error('XML non riconosciuto come FatturaElettronica');

  const header = root.FatturaElettronicaHeader;
  const body   = asArray(root.FatturaElettronicaBody)[0]; // un solo documento per file, caso comune
  if (!header || !body) throw new Error('FatturaElettronicaHeader/Body mancante');

  const cedente = header.CedentePrestatore;
  const datiGenerali = body.DatiGenerali?.DatiGeneraliDocumento;
  if (!datiGenerali) throw new Error('DatiGeneraliDocumento mancante');

  const amount = Number(datiGenerali.ImportoTotaleDocumento);
  if (!amount || amount <= 0) throw new Error('Fattura senza importo totale valido');

  const righe = asArray(body.DatiBeniServizi?.DettaglioLinee);
  const supplierName = extractSupplierName(cedente?.DatiAnagrafici?.Anagrafica);
  const docNumber = firstOf(datiGenerali.Numero, null);
  // TD04 = nota di credito, TD08/TD09 = nota di credito/debito semplificata — vanno
  // sottratte ai costi, non sommate (gestito dal chiamante, qui solo estratto).
  const documentType = firstOf(datiGenerali.TipoDocumento, null);

  return {
    amount:          Math.round(amount * 100) / 100,
    supplierName,
    supplierVat:     extractSupplierVat(cedente),
    docNumber:       docNumber ? String(docNumber) : null,
    issueDate:       firstOf(datiGenerali.Data, null),
    paymentMethod:   extractPaymentMethod(body.DatiPagamento),
    lineDescriptions: righe.map((r) => String(r.Descrizione || '')).filter(Boolean),
    documentType:    documentType ? String(documentType) : null,
    isCreditNote:    ['TD04', 'TD08'].includes(documentType),
  };
}

module.exports = { parseFatturaPaXml };
