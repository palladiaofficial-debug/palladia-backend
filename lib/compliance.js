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
  const expiry = new Date(expiryDate);
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

function overallStatus(worker) {
  if (!worker.is_active) return 'inactive';
  const s = [
    complianceStatus(worker.safety_training_expiry),
    complianceStatus(worker.health_fitness_expiry),
  ];
  if (s.includes('expired'))  return 'non_compliant';
  if (s.includes('expiring')) return 'expiring';
  if (s.includes('not_set'))  return 'incomplete';
  return 'compliant';
}

module.exports = { complianceStatus, overallCompliance, overallStatus };
