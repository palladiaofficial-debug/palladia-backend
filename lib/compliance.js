'use strict';
// ── Compliance status — unica fonte di verità ─────────────────────────────────
// Importare da qui in tutti i moduli. NON duplicare la logica inline.
//
// complianceStatus(expiryDate) → 'not_set' | 'expired' | 'expiring' | 'ok'
//   - not_set  : data non impostata
//   - expired  : scaduta (expiryDate < oggi 00:00:00)
//   - expiring : scade entro 30 giorni (incluso oggi)
//   - ok       : valida, scade tra più di 30 giorni
//
// overallCompliance(safety, health) → 'non_compliant' | 'expiring' | 'incomplete' | 'compliant'
// overallStatus(worker) → include controllo is_active → aggiunge 'inactive'
// ─────────────────────────────────────────────────────────────────────────────

function complianceStatus(expiryDate) {
  if (!expiryDate) return 'not_set';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = String(expiryDate).split('T')[0].split('-').map(Number);
  const expiry = new Date(y, m - 1, d);
  if (expiry < today) return 'expired';
  const in30 = new Date(today);
  in30.setDate(in30.getDate() + 30);
  if (expiry <= in30) return 'expiring';
  return 'ok';
}

function overallCompliance(safety, health) {
  const s = [safety, health];
  if (s.includes('expired'))  return 'non_compliant';
  if (s.includes('expiring')) return 'expiring';
  if (s.includes('not_set'))  return 'incomplete';
  return 'compliant';
}

// F-482 (AUDIT.md): titolari e datori di lavoro non sono «lavoratori» da
// sorvegliare: visita medica e corso sicurezza non servono, quindi non sono mai
// «manca» né fanno partire avvisi. Si riconoscono dalla qualifica o dal ruolo
// scritti nella scheda (uguali, non «contiene»: «Socio lavoratore» è un lavoratore).
// Stessa regola in src/lib/compliance.ts del frontend: non duplicarla altrove.
const QUALIFICHE_SENZA_DOCUMENTI = new Set([
  'titolare', 'datore di lavoro', 'legale rappresentante', 'rappresentante legale',
  'amministratore', 'amministratore unico', 'socio amministratore',
]);
function nonServonoDocumenti(worker) {
  const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return QUALIFICHE_SENZA_DOCUMENTI.has(norm(worker?.qualification)) || QUALIFICHE_SENZA_DOCUMENTI.has(norm(worker?.role));
}

function overallStatus(worker) {
  if (!worker.is_active) return 'inactive';
  if (nonServonoDocumenti(worker)) return 'compliant';
  const s = [
    complianceStatus(worker.safety_training_expiry),
    complianceStatus(worker.health_fitness_expiry),
  ];
  if (s.includes('expired'))  return 'non_compliant';
  if (s.includes('expiring')) return 'expiring';
  if (s.includes('not_set'))  return 'incomplete';
  return 'compliant';
}

module.exports = { complianceStatus, overallCompliance, overallStatus, nonServonoDocumenti, QUALIFICHE_SENZA_DOCUMENTI };
