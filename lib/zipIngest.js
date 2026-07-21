'use strict';
/**
 * lib/zipIngest.js
 * Estrazione e filtro entries da un archivio zip — estratto da chatUpload.js
 * per essere riusato anche dall'Importazione Intelligente (routes/v1/smartImport.js),
 * stessa logica di filtro junk/estensioni, un solo posto da mantenere.
 */

const path = require('path');
const AdmZip = require('adm-zip');

// Le voci dentro uno zip non portano un mimetype affidabile (dipende dal
// sistema che ha creato l'archivio) — lo deduciamo dall'estensione.
const EXT_TO_MIME = {
  '.pdf':  'application/pdf',
  '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.doc':  'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':  'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// Cartelle/file che i tool di sistema aggiungono agli zip/cartelle e vanno sempre ignorati.
function isJunkEntry(entryName) {
  const base = path.basename(entryName);
  return entryName.startsWith('__MACOSX/')
    || base === '.DS_Store' || base === 'Thumbs.db'
    || base.startsWith('._') || base.startsWith('.');
}

function safeName(original) {
  const ext  = path.extname(original) || '';
  const base = path.basename(original, ext).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return base + ext;
}

function mimeForName(name) {
  return EXT_TO_MIME[path.extname(name).toLowerCase()] || null;
}

/**
 * Apre uno zip e restituisce le entries valide (no cartelle, no junk).
 * Lancia se l'archivio è corrotto.
 */
function readZipEntries(buffer) {
  const zip = new AdmZip(buffer);
  return zip.getEntries().filter(e => !e.isDirectory && !isJunkEntry(e.entryName));
}

module.exports = { EXT_TO_MIME, isJunkEntry, safeName, mimeForName, readZipEntries };
