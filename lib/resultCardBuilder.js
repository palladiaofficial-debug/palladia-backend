'use strict';
const { recheckCompliance } = require('./complianceRecheck');
const { computeActionValueDelta } = require('../services/valueMetrics');

// ── Compone una ResultCardData (Fatto/In Mano/Contato) ───────────────────────
// Punto unico che chiude un flusso significativo — chiamato dopo che la
// scrittura vera è già avvenuta (via executeWrite o un tool bespoke). Non
// esegue mai la scrittura: riceve solo il risultato per costruire il "verdetto"
// da mostrare, sempre ricalcolato dal motore (recheckCompliance), mai dedotto
// dal payload appena scritto.
//
// mismatchWarning: valorizzato quando lo stato reale dopo la scrittura non
// corrisponde a quanto ci si aspettava (es. un rinnovo che non ha spostato lo
// stato da "expired" a "ok" perché la nuova data è comunque nel passato) —
// l'enforcement meccanico di "se non è cambiato come previsto, Ladia lo dice".
function buildFattoSection(verdict, expectedImprovement) {
  if (!verdict) return { verified: false, verdict: { kind: 'none' }, after: 'Stato non riverificabile per questa risorsa.' };

  let after;
  if (verdict.kind === 'worker_overall') after = verdict.stato_complessivo;
  else if (verdict.kind === 'expiry') after = verdict.stato;
  else if (verdict.kind === 'risk_score') after = verdict.etichetta;
  else after = 'sconosciuto';

  let mismatchWarning;
  if (expectedImprovement && after !== expectedImprovement) {
    mismatchWarning = `Ci si aspettava lo stato "${expectedImprovement}" dopo questa azione, ma il motore di conformità riporta "${after}" — verificare i dati inseriti.`;
  }

  return { verified: true, verdict, after, mismatchWarning };
}

async function buildResultCard({ id, title, resourceName, recordId, companyId, complianceField, expectedImprovement, inMano, hoursSavedKey }) {
  const [verdict, contatoResult] = await Promise.all([
    recheckCompliance(resourceName, companyId, recordId, { field: complianceField }),
    computeActionValueDelta({ resourceName, recordId, companyId, hoursSavedKey }),
  ]);

  const card = {
    id,
    title,
    fatto: buildFattoSection(verdict, expectedImprovement),
  };
  if (inMano) card.inMano = inMano;
  if (contatoResult?.items?.length) card.contato = { items: contatoResult.items };

  return card;
}

module.exports = { buildResultCard };
