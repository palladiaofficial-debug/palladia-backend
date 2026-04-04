'use strict';
/**
 * services/complianceEngine.js
 *
 * Motore di conformità Palladia.
 * Controlla 5 dimensioni di rischio per un cantiere e restituisce
 * un report strutturato pronto per Telegram o per il trigger proattivo.
 *
 * Norme di riferimento:
 *  - D.Lgs. 81/2008 art. 29   — valutazione rischi e NC
 *  - D.Lgs. 81/2008 art. 37   — formazione lavoratori
 *  - D.Lgs. 81/2008 art. 41   — sorveglianza sanitaria (idoneità)
 *  - D.Lgs. 81/2008 art. 90   — obblighi committente (diario cantiere)
 */

const supabase = require('../lib/supabase');

// ── Tipi di stato ─────────────────────────────────────────────
// 'ok'       → ✅ nessun problema
// 'warn'     → ⚠️ attenzione, non ancora critico
// 'critical' → ❌ rischio contestazione in caso di ispezione

// ── Engine principale ─────────────────────────────────────────

/**
 * Esegue tutti i check di conformità per un cantiere.
 * @returns {Promise<ComplianceReport>}
 *
 * ComplianceReport: {
 *   siteName:      string,
 *   score:         'verde' | 'giallo' | 'rosso',
 *   checks:        ComplianceCheck[],
 *   criticalCount: number,
 *   warnCount:     number,
 * }
 *
 * ComplianceCheck: {
 *   id:     string,
 *   icon:   string,
 *   label:  string,
 *   status: 'ok' | 'warn' | 'critical',
 *   detail: string,
 *   norm?:  string,
 * }
 */
async function runComplianceChecks(siteId, companyId) {
  const today    = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const todayObj = new Date(today + 'T00:00:00.000Z');
  const in7days  = new Date(todayObj.getTime() + 7 * 86_400_000).toLocaleDateString('sv-SE');
  const cutoff48 = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const cutoff7d = new Date(Date.now() - 7  * 86_400_000).toISOString();

  // Fetch cantiere per nome
  const { data: site } = await supabase
    .from('sites')
    .select('name, address')
    .eq('id', siteId)
    .maybeSingle();

  const siteName = site?.name || site?.address || 'Cantiere';

  // Lavoratori attivi assegnati al cantiere
  const { data: assignments } = await supabase
    .from('worksite_workers')
    .select('worker_id')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .eq('status', 'active')
    .limit(200);

  const workerIds = (assignments || []).map(a => a.worker_id);

  // Query parallele
  const [ncRes, docsRes, lastNoteRes, badgeRes] = await Promise.all([

    // Check 1 — NC alte/critiche non risolte da >48h
    supabase.from('site_notes')
      .select('id, urgency, ai_summary, content, created_at')
      .eq('site_id', siteId)
      .eq('company_id', companyId)
      .eq('category', 'non_conformita')
      .in('urgency', ['alta', 'critica'])
      .is('resolved_at', null)
      .lt('created_at', cutoff48)
      .order('urgency', { ascending: false })
      .limit(10),

    // Check 2 & 3 — Documenti lavoratori (scaduti e in scadenza)
    workerIds.length
      ? supabase.from('workers')
          .select('id, full_name, safety_training_expiry, health_fitness_expiry')
          .in('id', workerIds)
          .or([
            `safety_training_expiry.lte.${in7days}`,
            `health_fitness_expiry.lte.${in7days}`,
          ].join(','))
          .limit(50)
      : Promise.resolve({ data: [] }),

    // Check 4 — Ultima nota del cantiere
    supabase.from('site_notes')
      .select('created_at')
      .eq('site_id', siteId)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Check 5 — Lavoratori senza badge
    workerIds.length
      ? supabase.from('workers')
          .select('id', { count: 'exact', head: true })
          .in('id', workerIds)
          .is('badge_code', null)
      : Promise.resolve({ count: 0 }),
  ]);

  const staleNcs  = ncRes.data   || [];
  const docWorkers = docsRes.data || [];
  const lastNote  = lastNoteRes.data;
  const noBadge   = badgeRes.count || 0;

  const checks = [];

  // ── Check 1: NC critiche/alte non risolte ────────────────────
  {
    const critica = staleNcs.filter(n => n.urgency === 'critica').length;
    const alta    = staleNcs.filter(n => n.urgency === 'alta').length;

    if (critica > 0) {
      checks.push({
        id:     'nc_critiche',
        icon:   '❌',
        label:  'Non conformità',
        status: 'critical',
        detail: `${critica} NC critica${critica > 1 ? 'e' : ''} + ${alta} alta${alta !== 1 ? '' : ''} aperta${staleNcs.length > 1 ? 'e' : ''} da >48h`,
        norm:   'D.Lgs. 81/2008 art. 29 co. 2',
      });
    } else if (alta > 0) {
      checks.push({
        id:     'nc_alte',
        icon:   '⚠️',
        label:  'Non conformità',
        status: 'warn',
        detail: `${alta} NC alta${alta > 1 ? '' : ''} aperta${alta > 1 ? 'e' : ''} da >48h`,
        norm:   'D.Lgs. 81/2008 art. 29 co. 2',
      });
    } else {
      checks.push({
        id:     'nc',
        icon:   '✅',
        label:  'Non conformità',
        status: 'ok',
        detail: 'Nessuna NC critica/alta aperta',
      });
    }
  }

  // ── Check 2 & 3: Documenti ────────────────────────────────────
  {
    const scaduti  = []; // expired
    const inScad   = []; // expiring soon

    for (const w of docWorkers) {
      const trainDays = w.safety_training_expiry
        ? Math.round((new Date(w.safety_training_expiry) - todayObj) / 86_400_000) : null;
      const fitDays   = w.health_fitness_expiry
        ? Math.round((new Date(w.health_fitness_expiry)  - todayObj) / 86_400_000) : null;

      if (trainDays !== null && trainDays <= 0) {
        scaduti.push(`${w.full_name} — formazione${trainDays < 0 ? ` (${Math.abs(trainDays)}gg fa)` : ' (oggi)'}`);
      } else if (trainDays !== null && trainDays <= 7) {
        inScad.push(`${w.full_name} — formazione tra ${trainDays}gg`);
      }

      if (fitDays !== null && fitDays <= 0) {
        scaduti.push(`${w.full_name} — idoneità${fitDays < 0 ? ` (${Math.abs(fitDays)}gg fa)` : ' (oggi)'}`);
      } else if (fitDays !== null && fitDays <= 7) {
        inScad.push(`${w.full_name} — idoneità tra ${fitDays}gg`);
      }
    }

    if (scaduti.length > 0) {
      const shown = scaduti.slice(0, 3).join('\n  ');
      const extra = scaduti.length > 3 ? `\n  …e altri ${scaduti.length - 3}` : '';
      checks.push({
        id:     'doc_scaduti',
        icon:   '❌',
        label:  'Documenti scaduti',
        status: 'critical',
        detail: `${scaduti.length} document${scaduti.length > 1 ? 'i scaduti' : 'o scaduto'}:\n  ${shown}${extra}`,
        norm:   'D.Lgs. 81/2008 artt. 37 e 41',
      });
    } else if (inScad.length > 0) {
      const shown = inScad.slice(0, 3).join('\n  ');
      const extra = inScad.length > 3 ? `\n  …e altri ${inScad.length - 3}` : '';
      checks.push({
        id:     'doc_scadenza',
        icon:   '⚠️',
        label:  'Scadenze prossime',
        status: 'warn',
        detail: `${inScad.length} document${inScad.length > 1 ? 'i in scadenza' : 'o in scadenza'}:\n  ${shown}${extra}`,
        norm:   'D.Lgs. 81/2008 artt. 37 e 41',
      });
    } else {
      checks.push({
        id:     'doc',
        icon:   '✅',
        label:  'Documenti',
        status: 'ok',
        detail: 'Formazione e idoneità sanitaria in regola',
      });
    }
  }

  // ── Check 4: Aggiornamento diario ────────────────────────────
  {
    if (!lastNote) {
      checks.push({
        id:     'attivita',
        icon:   '⚠️',
        label:  'Diario cantiere',
        status: 'warn',
        detail: 'Nessuna nota registrata — il cantiere risulta inattivo',
        norm:   'D.Lgs. 81/2008 art. 90 (diario lavori)',
      });
    } else {
      const daysSince = Math.floor((Date.now() - new Date(lastNote.created_at).getTime()) / 86_400_000);
      if (daysSince > 7) {
        checks.push({
          id:     'attivita',
          icon:   '⚠️',
          label:  'Diario cantiere',
          status: 'warn',
          detail: `Ultima nota ${daysSince} giorni fa — diario non aggiornato`,
          norm:   'D.Lgs. 81/2008 art. 90 (diario lavori)',
        });
      } else {
        checks.push({
          id:     'attivita',
          icon:   '✅',
          label:  'Diario cantiere',
          status: 'ok',
          detail: `Aggiornato ${daysSince === 0 ? 'oggi' : `${daysSince} giorn${daysSince > 1 ? 'i' : 'o'} fa`}`,
        });
      }
    }
  }

  // ── Check 5: Badge lavoratori ─────────────────────────────────
  {
    if (workerIds.length === 0) {
      checks.push({
        id:     'badge',
        icon:   '⚠️',
        label:  'Badge digitali',
        status: 'warn',
        detail: 'Nessun lavoratore assegnato a questo cantiere',
      });
    } else if (noBadge > 0) {
      checks.push({
        id:     'badge',
        icon:   '⚠️',
        label:  'Badge digitali',
        status: 'warn',
        detail: `${noBadge} lavorator${noBadge > 1 ? 'i' : 'e'} senza badge digitale`,
      });
    } else {
      checks.push({
        id:     'badge',
        icon:   '✅',
        label:  'Badge digitali',
        status: 'ok',
        detail: `${workerIds.length} lavorator${workerIds.length > 1 ? 'i' : 'e'} con badge attivo`,
      });
    }
  }

  // ── Score finale ──────────────────────────────────────────────
  const criticalCount = checks.filter(c => c.status === 'critical').length;
  const warnCount     = checks.filter(c => c.status === 'warn').length;
  const score = criticalCount > 0 ? 'rosso' : warnCount > 0 ? 'giallo' : 'verde';

  return { siteName, score, checks, criticalCount, warnCount };
}

// ── Formatta il report per Telegram ───────────────────────────

/**
 * Trasforma il risultato di runComplianceChecks in un messaggio Telegram HTML.
 */
function buildComplianceMessage(report) {
  const { siteName, score, checks, criticalCount, warnCount } = report;

  const scoreIcon  = { verde: '🟢', giallo: '🟡', rosso: '🔴' }[score];
  const scoreLabel = { verde: 'Pronto per ispezione', giallo: 'Attenzione richiesta', rosso: 'Rischio ispezione' }[score];

  let msg = `🛡️ <b>Conformità — ${siteName}</b>\n\n`;

  for (const c of checks) {
    msg += `${c.icon} <b>${c.label}:</b> ${c.detail.replace(/\n/g, '\n    ')}`;
    if (c.norm) msg += `\n    <i>${c.norm}</i>`;
    msg += '\n';
  }

  msg += `\n${scoreIcon} <b>${scoreLabel}</b>`;

  if (criticalCount > 0) {
    msg += `\n${criticalCount} problem${criticalCount > 1 ? 'i critici' : 'a critico'} — un ispettore ASL potrebbe contestarli immediatamente.`;
  } else if (warnCount > 0) {
    msg += `\nNessun blocco critico, ma ${warnCount} punto${warnCount > 1 ? 'i' : ''} da sistemare prima della prossima verifica.`;
  } else {
    msg += '\nIl cantiere è in ordine. Continua così.';
  }

  return msg;
}

module.exports = { runComplianceChecks, buildComplianceMessage };
