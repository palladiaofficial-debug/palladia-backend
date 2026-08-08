'use strict';
// Fix F-031/F-032 companion (AUDIT.md): la cancellazione azienda puliva solo 4 bucket
// legacy (documents/equipment-docs/worker-photos/company-docs) via storage.list(companyId),
// che non trova nulla nei bucket veri usati oggi (site-documents, site-media) perché i
// file vivono in sottocartelle (es. `${companyId}/workers/${workerId}/...`), non
// direttamente sotto companyId/. Qui i path vengono letti dalle tabelle stesse — dove
// sono garantiti corretti — invece di indovinare la struttura delle cartelle.
const supabase = require('./supabase');

// worker_certificates.pdf_url storicamente contiene una signed URL (1 anno), non un
// path raw — va estratta la chiave oggetto dal segmento /object/sign|public/<bucket>/.
function extractStorageKey(value, bucket) {
  if (!value || typeof value !== 'string') return null;
  if (!/^https?:\/\//i.test(value)) return value;
  for (const kind of ['sign', 'public']) {
    const marker = `/object/${kind}/${bucket}/`;
    const idx = value.indexOf(marker);
    if (idx === -1) continue;
    const rest = value.slice(idx + marker.length);
    const qIdx = rest.indexOf('?');
    const raw = qIdx === -1 ? rest : rest.slice(0, qIdx);
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return null; // URL esterna non appartenente a questo bucket — non nostra da rimuovere
}

// Come extractStorageKey, ma senza dover conoscere il bucket in anticipo —
// mirror JS della funzione SQL extract_storage_ref() (migrazione 150), usata
// dove il bucket stesso può variare (worker_certificates.pdf_url punta sia a
// site-documents sia a documents, verificato dal vivo, F-037).
function extractStorageRef(value) {
  if (!value || typeof value !== 'string') return null;
  if (!/^https?:\/\//i.test(value)) return { bucket: 'site-documents', path: value };
  const m = value.match(/\/object\/(?:sign|public)\/([a-z0-9-]+)\/([^?]+)/i);
  if (!m) return null;
  try { return { bucket: m[1], path: decodeURIComponent(m[2]) }; }
  catch { return { bucket: m[1], path: m[2] }; }
}

async function collectColumn(table, column, companyId) {
  const { data, error } = await supabase.from(table).select(column).eq('company_id', companyId);
  if (error || !data) return [];
  return data.map((r) => r[column]).filter(Boolean);
}

async function removeKeys(bucket, keys) {
  const clean = [...new Set(keys.filter(Boolean))];
  if (!clean.length) return { attempted: 0, error: null };
  const { error } = await supabase.storage.from(bucket).remove(clean);
  return { attempted: clean.length, error: error || null };
}

// Ripulisce ogni file di storage collegato a una company nei bucket document-centrici
// (site-documents, documents, site-media). Best-effort per singolo bucket: un errore
// su un bucket non blocca la pulizia degli altri.
async function cleanupCompanyDocumentStorage(companyId) {
  const summary = {};

  const siteDocKeys = [];
  for (const [table, column] of [
    ['site_documents', 'file_path'],
    ['company_documents', 'file_path'],
    ['worker_documents', 'file_path'],
    ['subcontractor_documents', 'file_path'],
    ['chat_uploads', 'storage_path'],
    ['payslips', 'file_path'],
    ['studio_shared_documents', 'file_path'],
    ['ladia_document_templates', 'storage_path'],
  ]) {
    siteDocKeys.push(...(await collectColumn(table, column, companyId)));
  }
  const requestUrls = await collectColumn('studio_document_requests', 'response_url', companyId);
  for (const url of requestUrls) {
    const key = extractStorageKey(url, 'site-documents');
    if (key) siteDocKeys.push(key);
  }
  summary['site-documents'] = await removeKeys('site-documents', siteDocKeys);

  const certUrls = await collectColumn('worker_certificates', 'pdf_url', companyId);
  const certKeys = certUrls.map((u) => extractStorageKey(u, 'documents')).filter(Boolean);
  summary['documents'] = await removeKeys('documents', certKeys);

  const mediaKeys = [];
  mediaKeys.push(...(await collectColumn('site_costs', 'file_url', companyId)));
  mediaKeys.push(...(await collectColumn('site_notes', 'media_path', companyId)));
  const { data: diaryRows } = await supabase.from('site_diary_entries').select('photos').eq('company_id', companyId);
  for (const row of diaryRows || []) {
    if (Array.isArray(row.photos)) mediaKeys.push(...row.photos.filter(Boolean));
  }
  summary['site-media'] = await removeKeys('site-media', mediaKeys);

  return summary;
}

module.exports = { cleanupCompanyDocumentStorage, extractStorageKey, extractStorageRef };
