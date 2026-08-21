'use strict';

/**
 * lib/fatturaPaEnvelopeParser.js
 * Riconosce e apre i formati reali in cui arriva una fattura elettronica italiana
 * per il canale email (vedi routes/v1/emailIngest.js): XML puro, .p7m (firma CAdES),
 * .zip (più fatture/allegati insieme), PDF di cortesia, e le notifiche/ricevute SdI
 * (che non sono fatture e non vanno mai importate come tali).
 *
 * Estende lib/fatturaPaXmlParser.js senza modificarne l'API esistente: i chiamanti
 * attuali (services/sdiConsultation.js) continuano a ricevere solo XML puro e
 * ignorano il campo `documentType` aggiunto al risultato di parseFatturaPaXml.
 *
 * Nota di scope: lo sbustamento del .p7m estrae il contenuto firmato (eContent) SENZA
 * verificare la firma crittografica — non è compito di questo canale certificare
 * l'autenticità del documento (la fiducia viene da allowlist mittente + verifica
 * SPF/DKIM in routes/v1/emailIngest.js; la validità fiscale è già stata accertata dal
 * Sistema di Interscambio quando ha accettato la fattura).
 *
 * Limite noto: assume contenuto XML in UTF-8. Un file FatturaPA con dichiarazione di
 * encoding diversa (raro in pratica, la generalità del traffico SdI reale è UTF-8)
 * potrebbe produrre caratteri accentati corrotti — non gestito in questa versione.
 */

const crypto  = require('crypto');
const AdmZip  = require('adm-zip');
const asn1js  = require('asn1js');
const pkijs   = require('pkijs');
const { parseFatturaPaXml } = require('./fatturaPaXmlParser');

// pkijs naviga gli schemi ASN.1 anche solo per il parsing (non per la verifica firma,
// che qui non facciamo) e vuole comunque un motore crypto registrato — usiamo il
// WebCrypto nativo di Node, nessuna dipendenza esterna aggiuntiva.
pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: crypto.webcrypto }));

// Root XML noti del protocollo SdI che NON sono una fattura — mai importati come
// documento, sempre riconosciuti e loggati come tali (mai scarto silenzioso).
const SDI_NOTIFICATION_ROOTS = new Set([
  'NotificaEsitoCommittente', 'RicevutaConsegna', 'NotificaScarto',
  'NotificaMancataConsegna', 'NotificaDecorrenzaTermini', 'AttestazioneTrasmissioneFattura',
]);

const MAX_NESTING_DEPTH = 3; // uno zip dentro uno zip dentro un p7m, oltre è quasi certamente un caso degenere

function looksLikeZip(filename, buffer) {
  return /\.zip$/i.test(filename) || (buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b);
}

function looksLikeP7m(filename, buffer) {
  if (/\.p7m$/i.test(filename)) return true;
  // Un PKCS#7 in DER binario inizia sempre con il tag ASN.1 SEQUENCE (0x30).
  return buffer.length > 1 && buffer[0] === 0x30;
}

function looksLikePdf(filename, buffer) {
  return /\.pdf$/i.test(filename) || buffer.slice(0, 5).toString('ascii') === '%PDF-';
}

function looksLikeXml(filename, buffer) {
  if (/\.xml$/i.test(filename)) return true;
  const head = buffer.slice(0, 200).toString('utf8').trimStart();
  return head.startsWith('<?xml') || head.startsWith('<');
}

function extractXmlRootTag(xmlString) {
  // Un file XML puo iniziare con un BOM (0xFEFF) - va scartato prima di cercare
  // il prologo, altrimenti il regex del prologo non combacia e si finisce per
  // leggere il primo tag FIGLIO invece del root (bug osservato in test: root
  // letto come "FatturaElettronicaHeader" invece di "FatturaElettronica"). La
  // classe del regex del tag deve includere ":" per catturare interamente un tag
  // con prefisso di namespace (es. "p:FatturaElettronica").
  let s = xmlString.charCodeAt(0) === 0xFEFF ? xmlString.slice(1) : xmlString;
  s = s.replace(/^\s*<\?xml[^?]*\?>\s*/, '');
  const match = s.match(/<([a-zA-Z][\w:.-]*)[\s>/]/);
  if (!match) return null;
  return match[1].includes(':') ? match[1].split(':').pop() : match[1]; // rimuove prefisso namespace, es. p:FatturaElettronica
}

// Estrae eContent da un PKCS#7 SignedData (CAdES-BES) senza verificarne la firma.
function unwrapP7m(buffer) {
  // Quasi sempre DER binario; alcuni client di posta corrompono i binari in
  // attachment testuali — se non parte con il tag SEQUENCE proviamo a decodificarlo
  // come base64/PEM prima di arrenderci.
  let der = buffer;
  if (der[0] !== 0x30) {
    const asText = buffer.toString('utf8').replace(/-----BEGIN[^-]*-----|-----END[^-]*-----|\s+/g, '');
    const decoded = Buffer.from(asText, 'base64');
    if (decoded.length > 0 && decoded[0] === 0x30) der = decoded;
  }

  const ber = der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength);
  const asn1 = asn1js.fromBER(ber);
  if (asn1.offset === -1) throw new Error('struttura ASN.1 non valida');

  const contentInfo = new pkijs.ContentInfo({ schema: asn1.result });
  const signedData  = new pkijs.SignedData({ schema: contentInfo.content });

  const eContent = signedData.encapContentInfo?.eContent;
  if (!eContent) throw new Error('contenuto firmato (eContent) non trovato — p7m forse cifrato, non solo firmato');

  // eContent è un OCTET STRING, semplice o costruito (a blocchi) per contenuti grandi.
  if (eContent.valueBlock.valueHex) return Buffer.from(eContent.valueBlock.valueHex);
  return Buffer.concat((eContent.valueBlock.value || []).map((v) => Buffer.from(v.valueBlock.valueHex)));
}

/**
 * Classifica ed estrae il contenuto di un allegato. Ritorna un array (uno zip produce
 * più elementi) di:
 *   - { xml, parsed, contentHash, sourceFilename } — candidato fattura valido
 *   - { courtesyPdf: true, filename, buffer }        — PDF, da correlare a un candidato
 *                                                        nella stessa email dal chiamante
 *   - { skip: true, reason: 'sdi_metadata'|'unrecognized', filename, note }
 */
function extractInvoiceCandidates(filename, buffer, depth = 0) {
  if (depth > MAX_NESTING_DEPTH) {
    return [{ skip: true, reason: 'unrecognized', filename, note: 'annidamento troppo profondo' }];
  }

  if (looksLikeZip(filename, buffer)) {
    let zip;
    try {
      zip = new AdmZip(buffer);
    } catch (err) {
      return [{ skip: true, reason: 'unrecognized', filename, note: `zip non apribile: ${err.message}` }];
    }
    const out = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      try {
        out.push(...extractInvoiceCandidates(entry.entryName, entry.getData(), depth + 1));
      } catch (err) {
        // Un singolo entry corrotto/incoerente (osservato dal vivo: crash di libreria
        // su un allegato zip reale) non deve far perdere l'intera email — segnala solo
        // quell'entry come non recuperabile, il resto dello zip continua a essere letto.
        out.push({ skip: true, reason: 'unrecognized', filename: entry.entryName, note: `voce zip non leggibile: ${err.message}` });
      }
    }
    return out;
  }

  if (looksLikeP7m(filename, buffer)) {
    let xmlBuffer;
    try {
      xmlBuffer = unwrapP7m(buffer);
    } catch (err) {
      return [{ skip: true, reason: 'unrecognized', filename, note: `p7m non sbustabile: ${err.message}` }];
    }
    return extractInvoiceCandidates(filename.replace(/\.p7m$/i, ''), xmlBuffer, depth + 1);
  }

  if (looksLikePdf(filename, buffer)) {
    return [{ courtesyPdf: true, filename, buffer }];
  }

  if (looksLikeXml(filename, buffer)) {
    const xmlString = buffer.toString('utf8');
    const rootTag = extractXmlRootTag(xmlString);

    if (rootTag && rootTag !== 'FatturaElettronica') {
      const known = SDI_NOTIFICATION_ROOTS.has(rootTag);
      return [{
        skip: true,
        reason: 'sdi_metadata',
        filename,
        note: known ? `notifica/ricevuta SdI (${rootTag}), non una fattura` : `root XML non riconosciuto (${rootTag})`,
      }];
    }

    try {
      const parsed = parseFatturaPaXml(xmlString);
      const contentHash = crypto.createHash('sha256').update(xmlString).digest('hex');
      return [{ xml: xmlString, parsed, contentHash, sourceFilename: filename }];
    } catch (err) {
      return [{ skip: true, reason: 'unrecognized', filename, note: `xml non valido come FatturaElettronica: ${err.message}` }];
    }
  }

  return [{ skip: true, reason: 'unrecognized', filename, note: 'tipo file non riconosciuto' }];
}

module.exports = { extractInvoiceCandidates };
