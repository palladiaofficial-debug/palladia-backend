'use strict';
/**
 * lib/oreInvio.js — F-393 (AUDIT.md del frontend): il foglio del mese parte
 * dal titolare al commercialista con un tocco.
 *
 * Decisione del titolare (21/10/2026): «Un tocco tuo» — niente parte da solo.
 * Il commercialista si scrive una volta (companies.consulente_nome/_email);
 * «Manda» costruisce lo stesso PDF e lo stesso Excel dei download
 * (lib/oreMeseFoglio.js, stessi numeri di buildOreMese) e li spedisce in
 * un'email con risposta diretta al titolare. Ogni invio resta in ore_invii,
 * così la pagina dice «Mandato il … a …» e Da fare smette di ricordarlo.
 * Rimandare (dopo una correzione) è un nuovo invio, non una modifica.
 */
const supabase = require('./supabase');
const { auditLog } = require('./audit');
const { buildOreMese } = require('./oreMese');
const { generateFoglioHtml, generateFoglioXlsx, meseLabel } = require('./oreMeseFoglio');

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const MESE_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

class InvioError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ore = (min) => (Math.round((min || 0) / 6) / 10).toLocaleString('it-IT', { maximumFractionDigits: 1 });

/** Il commercialista dell'azienda e gli invii del mese (più recente prima). */
async function statoInvio(companyId, month) {
  if (!MESE_RE.test(String(month || ''))) throw new InvioError('INVALID_MONTH', 'Mese non valido (YYYY-MM)');
  const [{ data: co, error: e1 }, { data: invii, error: e2 }] = await Promise.all([
    supabase.from('companies').select('consulente_nome, consulente_email').eq('id', companyId).maybeSingle(),
    supabase.from('ore_invii').select('id, sent_at, sent_to, lavoratori, domande_aperte').eq('company_id', companyId).eq('month', month).order('sent_at', { ascending: false }),
  ]);
  if (e1 || e2) throw new InvioError('DB_ERROR', (e1 || e2).message, 500);
  return {
    consulente: co?.consulente_email ? { nome: co.consulente_nome || null, email: co.consulente_email } : null,
    invii: invii || [],
  };
}

async function salvaConsulente(companyId, { nome, email }) {
  const em = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(em) || em.length > 200) throw new InvioError('INVALID_EMAIL', 'Scrivi un indirizzo email valido');
  const nm = String(nome || '').trim().slice(0, 120) || null;
  const { error } = await supabase.from('companies').update({ consulente_nome: nm, consulente_email: em }).eq('id', companyId);
  if (error) throw new InvioError('DB_ERROR', error.message, 500);
  return { nome: nm, email: em };
}

/** Il testo dell'email: chi, che mese, quanti, e cosa c'è in allegato. */
function corpoEmail({ azienda, mese, data, domandeAperte, mittente }) {
  const tot = data.lavoratori.reduce((a, l) => ({ ord: a.ord + (l.tot.ordinarieMin || 0), str: a.str + (l.tot.straordMin || 0) }), { ord: 0, str: 0 });
  return `
    <p style="margin:0 0 14px;font-size:16px;color:#1A1714;line-height:1.6;">Buongiorno,<br>in allegato le presenze di <strong>${esc(mese)}</strong> di <strong>${esc(azienda)}</strong> per le buste paga.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFEFD;border-radius:14px;border:1px solid #ECE7DF;margin:0 0 16px;">
      <tr><td style="padding:16px 18px;font-size:15px;color:#1A1714;line-height:1.8;">
        <strong>${data.lavoratori.length}</strong> lavoratori · <strong>${data.giorniLavorativi}</strong> giorni lavorativi<br>
        Ore ordinarie: <strong>${ore(tot.ord)}</strong> · straordinario: <strong>${ore(tot.str)}</strong>
        ${domandeAperte ? `<br><span style="color:#8A3B0E;font-weight:700;">${domandeAperte} ${domandeAperte === 1 ? 'punto è' : 'punti sono'} ancora da verificare: li trova nel PDF alla voce «Da verificare».</span>` : ''}
      </td></tr>
    </table>
    <p style="margin:0 0 6px;font-size:15px;color:#1A1714;line-height:1.6;"><strong>PDF</strong>: il mese giorno per giorno, il riassunto di ogni lavoratore, ore per cantiere, assenze e legenda delle causali.</p>
    <p style="margin:0 0 16px;font-size:15px;color:#1A1714;line-height:1.6;"><strong>Excel</strong>: le stesse ore e il foglio «Movimenti» (codice fiscale, data, causale, ore) per il programma paghe.</p>
    <p style="margin:0;font-size:14px;color:#5E574F;line-height:1.6;">Per qualsiasi domanda risponda a questa email: arriva a ${esc(mittente || azienda)}.</p>`;
}

/**
 * Manda il foglio del mese al commercialista.
 * @param {object} p { companyId, userId, userRole, userEmail, month, req, invia? }
 *   invia: funzione d'invio (default services/email.sendPlainLayoutEmail) — sostituibile nei test
 */
async function mandaFoglio(p) {
  const { companyId, month } = p;
  if (!MESE_RE.test(String(month || ''))) throw new InvioError('INVALID_MONTH', 'Mese non valido (YYYY-MM)');
  const { consulente } = await statoInvio(companyId, month);
  if (!consulente) throw new InvioError('NO_CONSULENTE', 'Scrivi prima l\'email del commercialista');

  const data = await buildOreMese(companyId, month);
  if (!data.lavoratori.length) throw new InvioError('MESE_VUOTO', 'In questo mese non ci sono ore da mandare', 422);
  const { data: co } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();
  const azienda = co?.name || '';
  const mese = meseLabel(month);

  const { rendererPool } = require('../pdf-renderer');
  const pdf = await rendererPool.render(generateFoglioHtml(data, azienda), { docTitle: `Presenze ${mese}`, rev: 1 });
  const xlsx = Buffer.from(await generateFoglioXlsx(data, azienda));
  const domandeAperte = (data.domande || []).length;

  const invia = p.invia || require('../services/email').sendPlainLayoutEmail;
  const r = await invia({
    to: consulente.email,
    subject: `Presenze ${mese} · ${azienda}`,
    title: `Presenze di ${mese}`,
    bodyHtml: corpoEmail({ azienda, mese, data, domandeAperte, mittente: p.userEmail }),
    replyTo: p.userEmail || undefined,
    attachments: [
      { filename: `presenze-${month}.pdf`, content: Buffer.from(pdf) },
      { filename: `presenze-${month}.xlsx`, content: xlsx },
    ],
  });
  if (r?.error) throw new InvioError('EMAIL_ERROR', 'L\'email non è partita. Riprova tra poco.', 502);

  const { data: row, error } = await supabase.from('ore_invii').insert({
    company_id: companyId, month, sent_to: consulente.email, sent_by: p.userId || null,
    lavoratori: data.lavoratori.length, domande_aperte: domandeAperte, email_id: r?.data?.id || r?.id || null,
  }).select('id, sent_at, sent_to, lavoratori, domande_aperte').single();
  if (error) throw new InvioError('DB_ERROR', error.message, 500);

  await auditLog({
    companyId, userId: p.userId || null, userRole: p.userRole || null, action: 'ore.foglio_inviato',
    targetType: 'ore_invii', targetId: String(row.id),
    payload: { month, to: consulente.email, lavoratori: data.lavoratori.length, domandeAperte },
    req: p.req || null,
  });
  return row;
}

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const GIORNI_PROMEMORIA = 20; // dopo il 20 del mese il promemoria smette (il mese è ormai chiuso altrove)
const URGENTE_DAL = 4;        // «Se non lo mandi entro il 3, te lo ricorda» (decisione del 21/10)

/**
 * Da fare: dal 1° al 20 del mese, «Manda il foglio di <mese scorso> al
 * commercialista» finché non è partito. Solo titolare e amministratori, e solo
 * se il mese scorso c'è almeno una timbratura.
 */
async function vociFoglio(companyId, ruolo, todayStr) {
  if (!['owner', 'admin'].includes(ruolo)) return [];
  const [y, m, d] = todayStr.split('-').map(Number);
  if (d > GIORNI_PROMEMORIA) return [];
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const month = `${py}-${String(pm).padStart(2, '0')}`;
  const inizio = `${month}-01`, fine = `${y}-${String(m).padStart(2, '0')}-01`;
  const [{ count, error: e1 }, { data: inviati, error: e2 }, { data: co }] = await Promise.all([
    supabase.from('presence_logs').select('id', { count: 'exact', head: true }).eq('company_id', companyId)
      .gte('timestamp_server', `${inizio}T00:00:00+02:00`).lt('timestamp_server', `${fine}T00:00:00+01:00`),
    supabase.from('ore_invii').select('id').eq('company_id', companyId).eq('month', month).limit(1),
    supabase.from('companies').select('consulente_nome, consulente_email').eq('id', companyId).maybeSingle(),
  ]);
  if (e1 || e2 || !count || (inviati || []).length) return [];
  const chi = co?.consulente_email ? (co.consulente_nome || co.consulente_email) : null;
  return [{
    id: `foglio:${month}`, kind: 'avviso', type: 'foglio_ore',
    title: `Manda il foglio di ${MESI[pm - 1]} al commercialista`,
    subtitle: chi ? `PDF ed Excel a ${chi}: un tocco da Ore e assenze` : 'Scrivi una volta l\'email del commercialista e mandalo da Ore e assenze',
    date: todayStr, days: 0, bucket: 'settimana', severity: 'warning', urgent: d >= URGENTE_DAL,
    link: `/persone?tab=ore&mese=${month}`,
  }];
}

module.exports = { statoInvio, salvaConsulente, mandaFoglio, corpoEmail, vociFoglio, InvioError };
