'use strict';
// ── "Sono malato" dall'Area lavoratore (F-318, AUDIT.md del frontend) ────────
// Decisione del titolare (2026-10-09): la malattia la comunica l'operaio.
// Non è una richiesta da approvare: è una comunicazione, conta subito nel
// foglio del mese e il titolare riceve l'avviso. Il numero del certificato
// (protocollo INPS) si può mandare subito o dopo.
// POST  /api/v1/area/:code/malattia              { dal, al?, protocollo? }
// PATCH /api/v1/area/:code/malattia/:id          { protocollo }
// Stesso accesso col PIN delle altre richieste (verifyWorkerArea).
const crypto = require('crypto');
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const supabase = require('../../lib/supabase');
const { verifyWorkerArea } = require('../../lib/workerAuth');
const { notifyCompany } = require('../../services/telegramNotifications');
const { sendPushToCompany } = require('../../services/pushNotifications');

const limiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'RATE_LIMIT_EXCEEDED' } });
const COLS = 'id, tipo, date_from, date_to, protocollo, note, stato, decided_at, created_at';
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const cleanProto = (v) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, 60) : null);
const fmt = (d) => d.split('-').reverse().join('/');

router.post('/area/:code/malattia', limiter, verifyWorkerArea, async (req, res) => {
  const { wid, cid } = req.workerPayload;
  const { dal, al, protocollo } = req.body || {};
  const oggi = oggiRoma();
  if (!isDate(dal)) return res.status(400).json({ error: 'INVALID_DATE', message: 'Scegli da che giorno.' });
  // Da 7 giorni fa a domani: si comunica quando succede, non mesi dopo
  if (dal < addDays(oggi, -7) || dal > addDays(oggi, 1)) return res.status(400).json({ error: 'DATE_OUT_OF_RANGE', message: 'Puoi scegliere un giorno da una settimana fa a domani.' });
  const fine = al && isDate(al) ? al : dal;
  if (fine < dal || fine > addDays(dal, 60)) return res.status(400).json({ error: 'INVALID_END', message: 'La data di fine non è valida.' });

  const { data: worker } = await supabase.from('workers').select('id, full_name').eq('id', wid).eq('company_id', cid).eq('is_active', true).maybeSingle();
  if (!worker) return res.status(403).json({ error: 'WORKER_INACTIVE' });

  // Già comunicata per lo stesso giorno: niente doppioni (doppio tocco)
  const { data: dup } = await supabase.from('worker_absences').select(COLS)
    .eq('company_id', cid).eq('worker_id', wid).eq('tipo', 'malattia').eq('date_from', dal).maybeSingle();
  if (dup) return res.status(200).json(dup);

  const { data, error } = await supabase.from('worker_absences').insert({
    company_id: cid, worker_id: wid, tipo: 'malattia', date_from: dal, date_to: fine,
    protocollo: cleanProto(protocollo), stato: 'approvata', da_lavoratore: true, created_by: null,
  }).select(COLS).single();
  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  const testo = `${worker.full_name} è malato dal ${fmt(dal)}${fine !== dal ? ` al ${fmt(fine)}` : ''}${data.protocollo ? ` · certificato ${data.protocollo}` : ' · certificato non ancora inviato'}`;
  await supabase.from('notifications').insert({
    company_id: cid, type: 'worker_illness', severity: 'warning', title: `Malattia: ${worker.full_name}`,
    body: testo, entity_type: 'worker_illness', entity_id: crypto.randomUUID(),
  });
  notifyCompany(cid, `🤒 <b>Malattia</b>\n${testo.replace(/</g, '&lt;')}`).catch(() => {});
  sendPushToCompany(cid, { title: 'Malattia', body: testo, tag: `malattia-${data.id}`, url: '/persone?tab=ore' }).catch(() => {});
  res.status(201).json(data);
});

router.patch('/area/:code/malattia/:id', limiter, verifyWorkerArea, async (req, res) => {
  const { wid, cid } = req.workerPayload;
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  const proto = cleanProto(req.body?.protocollo);
  if (!proto) return res.status(400).json({ error: 'PROTOCOLLO_REQUIRED', message: 'Scrivi il numero del certificato.' });
  const { data, error } = await supabase.from('worker_absences').update({ protocollo: proto })
    .eq('id', req.params.id).eq('company_id', cid).eq('worker_id', wid).eq('tipo', 'malattia').select(COLS);
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data?.length) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(data[0]);
});

module.exports = router;
