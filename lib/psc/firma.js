'use strict';
/**
 * lib/psc/firma.js — F-270. Riconoscimento della firma digitale sul PSC
 * firmato che il coordinatore ricarica: CAdES (.p7m) o PAdES (PDF firmato).
 * Legge chi ha firmato e quando, dal certificato. NON verifica la validità
 * della catena di certificazione (servirebbe la lista di fiducia AgID):
 * l'interfaccia lo dice chiaramente ("firma presente"), non "firma valida".
 */
const asn1js = require('asn1js');
const pkijs = require('pkijs');
const crypto = require('crypto');

pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: crypto.webcrypto }));

const OID_CN = '2.5.4.3';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';

function cnOf(cert) {
  try {
    const tv = cert.subject.typesAndValues.find(t => t.type === OID_CN);
    return tv ? String(tv.value.valueBlock.value) : null;
  } catch { return null; }
}

/** CAdES (.p7m): chi ha firmato, quando, e il PDF contenuto. */
function leggiP7m(buffer) {
  let der = buffer;
  if (der[0] !== 0x30) {
    const asText = buffer.toString('utf8').replace(/-----BEGIN[^-]*-----|-----END[^-]*-----|\s+/g, '');
    const decoded = Buffer.from(asText, 'base64');
    if (decoded.length && decoded[0] === 0x30) der = decoded;
  }
  const ber = der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength);
  const asn1 = asn1js.fromBER(ber);
  if (asn1.offset === -1) throw Object.assign(new Error('Il file .p7m non è leggibile'), { status: 400 });
  const ci = new pkijs.ContentInfo({ schema: asn1.result });
  const sd = new pkijs.SignedData({ schema: ci.content });
  const firmatari = [];
  for (const si of sd.signerInfos || []) {
    let when = null;
    const attr = (si.signedAttrs && si.signedAttrs.attributes || []).find(a => a.type === OID_SIGNING_TIME);
    if (attr && attr.values[0]) { try { when = attr.values[0].toDate().toISOString(); } catch { when = null; } }
    let cert = null;
    const sid = si.sid;
    for (const c of sd.certificates || []) {
      if (!c.serialNumber) continue;
      if (sid && sid.serialNumber && Buffer.from(c.serialNumber.valueBlock.valueHex).equals(Buffer.from(sid.serialNumber.valueBlock.valueHex))) { cert = c; break; }
    }
    if (!cert && sd.certificates && sd.certificates[0]) cert = sd.certificates[0];
    firmatari.push({ nome: cert ? cnOf(cert) : null, quando: when });
  }
  let contenuto = null;
  const e = sd.encapContentInfo && sd.encapContentInfo.eContent;
  if (e) contenuto = e.valueBlock.valueHex ? Buffer.from(e.valueBlock.valueHex) : Buffer.concat((e.valueBlock.value || []).map(v => Buffer.from(v.valueBlock.valueHex)));
  return { tipo: 'CAdES', firmatari, contenutoPdf: contenuto && contenuto.slice(0, 5).toString() === '%PDF-' ? contenuto : null };
}

/** PAdES: un PDF con una firma incorporata (/ByteRange + /Contents). */
function leggiPdfFirmato(buffer) {
  const s = buffer.toString('latin1');
  if (!/\/ByteRange\s*\[/.test(s) || !/\/Type\s*\/Sig\b|\/SubFilter\s*\/(ETSI\.CAdES|adbe\.pkcs7)/.test(s)) return null;
  const nomi = [...s.matchAll(/\/Name\s*\(([^)]{2,120})\)/g)].map(m => m[1]);
  const date = [...s.matchAll(/\/M\s*\(D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/g)].map(m => `${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:00Z`);
  const n = Math.max(1, (s.match(/\/Type\s*\/Sig\b/g) || []).length);
  const firmatari = Array.from({ length: n }, (_, i) => ({ nome: nomi[i] || null, quando: date[i] || null }));
  return { tipo: 'PAdES', firmatari };
}

/** Riconosce un file firmato. Ritorna null se non trova nessuna firma. */
function riconosci(buffer, fileName = '') {
  if (/\.p7m$/i.test(fileName) || buffer[0] === 0x30) {
    try { return leggiP7m(buffer); } catch (e) { if (/\.p7m$/i.test(fileName)) throw e; }
  }
  if (buffer.slice(0, 5).toString() === '%PDF-') return leggiPdfFirmato(buffer);
  return null;
}

module.exports = { riconosci, leggiP7m, leggiPdfFirmato };
