'use strict';
// ── Ore e assenze del mese (F-265, F-335 — AUDIT.md del frontend) ───────────
// Riepilogo per lavoratore e giorno per le buste paga: ore ordinarie e
// straordinario contati sull'ORARIO DI LAVORO (lib/oreContrattuali.js, F-335),
// ritardi, uscite anticipate, ferie, permessi, malattia, maltempo, infortuni,
// ore per cantiere (Cassa Edile), e le domande che servono per chiudere il mese.
//
// Regola non negoziabile: qui si LEGGE soltanto. Le coppie entrata/uscita
// vengono da buildWorkerHoursReport (stesso accoppiamento dei report
// esistenti) e le assenze da worker_absences. Niente in questo modulo scrive
// presence_logs o passa qualcosa a lib/presencePairing.js.
const supabase = require('./supabase');
const { buildWorkerHoursReport } = require('../services/workerHoursReport');
const { contaGiorno, risolviOrario, oreGiornoContratto, toMin, fmt } = require('./oreContrattuali');

const ORE_GIORNO_MIN = 480; // ore di un giorno da contratto con l'orario predefinito

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }

/** Pasqua (algoritmo di Gauss/Meeus), per il Lunedì dell'Angelo. */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}

/** Festività nazionali italiane dell'anno (YYYY-MM-DD → nome). */
function festivita(y) {
  const out = {
    [ymd(y, 1, 1)]: 'Capodanno', [ymd(y, 1, 6)]: 'Epifania', [ymd(y, 4, 25)]: 'Liberazione',
    [ymd(y, 5, 1)]: 'Festa dei lavoratori', [ymd(y, 6, 2)]: 'Festa della Repubblica', [ymd(y, 8, 15)]: 'Ferragosto',
    [ymd(y, 11, 1)]: 'Ognissanti', [ymd(y, 12, 8)]: 'Immacolata', [ymd(y, 12, 25)]: 'Natale', [ymd(y, 12, 26)]: 'Santo Stefano',
  };
  const em = easter(y); em.setUTCDate(em.getUTCDate() + 1);
  out[em.toISOString().slice(0, 10)] = 'Lunedì dell’Angelo';
  return out;
}

// Motivi d'uscita (presence_log_reasons) → ore non lavorate di che tipo
const MANCANTI_DI = {
  maltempo: 'maltempo', caldo: 'maltempo', ritardo_maltempo: 'maltempo',
  permesso: 'permesso', ritardo_permesso: 'permesso', visita_medica: 'permesso',
  malattia: 'malattia', infortunio: 'infortunio',
};
const MOTIVI_USCITA_GIUSTIFICATA = new Set(['maltempo', 'caldo', 'permesso', 'malattia', 'infortunio']);
const ORARIO_COLS = 'orario_inizio, orario_fine, pausa_inizio, pausa_fine';

/** Il giorno (report) → coppie in minuti per contaGiorno. */
function coppieDelGiorno(rd) {
  const pairs = (rd?.entries || []).filter(e => e.entry_time && e.exit_time);
  return pairs.map((e) => ({
    in: toMin(e.entry_time),
    out: toMin(e.exit_time),
    siteId: e.exit_site_id || e.entry_site_id || null,
    siteIdIn: e.entry_site_id || null,
    motivo: MOTIVI_USCITA_GIUSTIFICATA.has(e.exit_reason) ? e.exit_reason : null,
    motivoEntrata: e.entry_reason || null,
  }));
}

/**
 * Conta un giorno del report con l'orario giusto (lavoratore → cantiere della
 * prima entrata → azienda). Unica funzione usata dal foglio del mese e dalle
 * proposte di pioggia (lib/pioggiaDaConfermare.js): devono dire le stesse ore.
 */
function contaDalReport(rd, { company = {}, siteById = new Map(), worker = null } = {}, lavorativo = true) {
  const daySite = rd ? siteById.get(rd.entries.find(e => e.entry_site_id)?.entry_site_id) : null;
  const orario = risolviOrario({ company, site: daySite, worker });
  const contratto = oreGiornoContratto(orario);
  const conto = contaGiorno({ coppie: coppieDelGiorno(rd), orario, lavorativo, pausaSaltata: !!rd?.no_lunch_override });
  return { conto, orario, contratto };
}

/** Orari di un'azienda (azienda, cantieri, lavoratori) per contaDalReport. */
async function caricaOrari(companyId, workerIds = []) {
  const [c, s, w] = await Promise.all([
    supabase.from('companies').select(`${ORARIO_COLS}, orario_tolleranza_min, straord_soglia_min, straord_blocco_min`).eq('id', companyId).maybeSingle(),
    supabase.from('sites').select(`id, ${ORARIO_COLS}`).eq('company_id', companyId),
    workerIds.length ? supabase.from('workers').select(`id, ${ORARIO_COLS}`).eq('company_id', companyId).in('id', workerIds) : { data: [] },
  ]);
  for (const r of [c, s, w]) if (r.error) throw new Error(r.error.message);
  return { company: c.data || {}, siteById: new Map((s.data || []).map(x => [x.id, x])), workerById: new Map((w.data || []).map(x => [x.id, x])) };
}

/** Chi segue sempre un altro orario (prima e fino a prima): orario personale da proporre. */
function orarioProposto(days, o) {
  const lav = days.filter(c => c.tipo === 'lavoro' && c.primaEntrata && c.ultimaUscita && !c.festivo);
  if (lav.length < 5) return null;
  const tipici = lav.filter((c) => {
    const i = toMin(c.primaEntrata), u = toMin(c.ultimaUscita);
    return i <= o.inizio - 15 && u <= o.fine - 15 && u >= o.fine - 90;
  });
  if (tipici.length / lav.length < 0.7) return null;
  const mediana = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const inizio = Math.round(mediana(tipici.map(c => toMin(c.primaEntrata))) / 15) * 15;
  const fine = inizio + (o.fine - o.inizio);
  const uscite = tipici.map(c => c.ultimaUscita).sort();
  return { inizio: fmt(inizio), fine: fmt(fine), giorni: tipici.length, su: lav.length, usciteDa: uscite[0], usciteA: uscite[uscite.length - 1] };
}

/**
 * @param {string} companyId
 * @param {string} month  'YYYY-MM'
 * @param {{ today?: string }} [opts]  oggi (YYYY-MM-DD, per i test); i giorni futuri non sono "da giustificare"
 */
async function buildOreMese(companyId, month, opts = {}) {
  if (!/^\d{4}-\d{2}$/.test(month)) { const e = new Error('month deve essere YYYY-MM'); e.status = 400; throw e; }
  const [y, m] = month.split('-').map(Number);
  const nDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const from = ymd(y, m, 1), to = ymd(y, m, nDays);
  const today = opts.today || new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
  const hol = festivita(y);

  const days = [];
  for (let d = 1; d <= nDays; d++) {
    const key = ymd(y, m, d);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    days.push({ date: key, day: d, dow, weekend: dow === 0 || dow === 6, festivo: hol[key] || null });
  }

  const [report, absRes, compRes, sitesRes] = await Promise.all([
    buildWorkerHoursReport(null, companyId, from, to, null, true),
    supabase.from('worker_absences')
      .select('id, worker_id, tipo, date_from, date_to, ora_dalle, ora_alle, protocollo, note, stato, da_lavoratore, created_at, site_id, ore_min')
      .eq('company_id', companyId).lte('date_from', to).gte('date_to', from).order('date_from'),
    supabase.from('companies')
      .select(`name, piva, ${ORARIO_COLS}, orario_tolleranza_min, straord_soglia_min, straord_blocco_min, orario_confermato_at`)
      .eq('id', companyId).maybeSingle(),
    supabase.from('sites').select(`id, name, ${ORARIO_COLS}`).eq('company_id', companyId),
  ]);
  for (const r of [absRes, compRes, sitesRes]) if (r.error) { const e = new Error(r.error.message); e.status = 500; throw e; }
  const company = compRes.data || {};
  const siteById = new Map((sitesRes.data || []).map(s => [s.id, s]));
  const absences = absRes.data || [];
  const approved = absences.filter(a => a.stato === 'approvata');
  const orarioAzienda = risolviOrario({ company });
  const contrattoAzienda = oreGiornoContratto(orarioAzienda);

  // Lavoratori: chi ha timbrato nel mese + chi ha un'assenza registrata
  const byId = new Map(report.workers.map(w => [w.id, { id: w.id, nome: w.full_name, cf: w.fiscal_code || '', reportDays: new Map(w.days.map(d => [d.date_key, d])) }]));
  const missing = [...new Set(absences.map(a => a.worker_id))].filter(id => !byId.has(id));
  if (missing.length) {
    const { data: ws } = await supabase.from('workers').select('id, full_name, first_name, last_name, fiscal_code').in('id', missing).eq('company_id', companyId);
    for (const w of ws || []) byId.set(w.id, { id: w.id, nome: w.full_name || [w.first_name, w.last_name].filter(Boolean).join(' '), cf: w.fiscal_code || '', reportDays: new Map() });
  }
  const ids = [...byId.keys()];
  const [wRes, prima] = await Promise.all([
    ids.length
      ? supabase.from('workers').select(`id, ${ORARIO_COLS}, orario_personale_rifiutato, ore_da, ore_da_motivo`).in('id', ids).eq('company_id', companyId)
      : { data: [] },
    // Ha mai timbrato prima di questo mese? (chi è nuovo non ha giorni "da
    // giustificare" prima della prima timbratura). Una lettura sola (migr. 248).
    ids.length ? supabase.rpc('prima_timbratura_lavoratori', { p_company: companyId, p_workers: ids }) : { data: [] },
  ]);
  if (prima.error) { const e = new Error(prima.error.message); e.status = 500; throw e; }
  const wInfo = new Map((wRes.data || []).map(w => [w.id, w]));
  const inizioMese = Date.parse(`${from}T00:00:00Z`) - 2 * 3600e3; // mezzanotte di Roma, al più presto
  const timbravaGia = new Map((prima.data || []).map(r => [r.worker_id, Date.parse(r.prima) < inizioMese && new Date(r.prima).toLocaleDateString('sv', { timeZone: 'Europe/Rome' }) < from]));

  const lavoratori = [];
  const domande = [];
  for (const w of byId.values()) {
    const info = wInfo.get(w.id) || {};
    const tot = {
      ordinarieMin: 0, straordMin: 0, straordFestivoMin: 0, ferieGiorni: 0, permessoMin: 0, malattiaGiorni: 0, malattiaMin: 0,
      maltempoMin: 0, infortunioMin: 0, infortunioGiorni: 0, altroGiorni: 0, ingiustificataGiorni: 0, daGiustificare: 0, anomalie: 0,
      giorniLavorati: 0, ritardi: 0, ritardoMin: 0, uscitePrima: 0, uscitaPrimaMin: 0, mezzeGiornate: 0, entratePrima: 0,
      oreLavorabiliMin: 0, oreScoperteMin: 0, primaGiorni: 0, perCantiere: {},
    };
    // Primo giorno del mese con qualcosa (timbratura o assenza)
    const primoGiornoMese = days.find(d => w.reportDays.has(d.date) || approved.some(a => a.worker_id === w.id && a.date_from <= d.date && a.date_to >= d.date))?.date || null;
    // Chi non timbra con Palladia (nessuna timbratura, né ora né prima) non ha
    // giorni "da giustificare": Palladia non può sapere se c'era.
    const usaPalladia = w.reportDays.size > 0 || timbravaGia.get(w.id);
    const inizioOre = info.ore_da || (usaPalladia && !timbravaGia.get(w.id) && primoGiornoMese ? primoGiornoMese : null);

    const cells = days.map((d) => {
      const rd = w.reportDays.get(d.date);
      const abs = approved.find(a => a.worker_id === w.id && a.date_from <= d.date && a.date_to >= d.date);
      const lavorativo = !d.weekend && !d.festivo;
      const { conto, orario, contratto } = contaDalReport(rd, { company, siteById, worker: info }, lavorativo);
      const cell = {
        date: d.date, tipo: null,
        ore: conto.ordinarie, straord: conto.straordinario, festivo: conto.festivo && conto.straordinario > 0,
        ritardo: conto.ritardo, uscitoPrima: conto.uscitoPrima, entratoPrima: conto.entratoPrima, mezzaGiornata: conto.mezzaGiornata,
        oltreOrario: conto.oltreOrario, primaEntrata: conto.primaEntrata, ultimaUscita: conto.ultimaUscita,
        motivo: conto.motivo || conto.motivoEntrata || null, perCantiere: conto.perCantiere,
        permessoMin: 0, maltempoMin: 0, malattiaMin: 0, infortunioMin: 0,
        anomalia: !!(rd && rd.entries.some(e => !e.entry_time || !e.exit_time)),
        pausaMin: rd ? rd.lunch_break_minutes : 0, assenzaId: abs?.id || null,
        orario: orario.fonte === 'lavoratore' || orario.fonte === 'cantiere' ? `${fmt(orario.inizio)}–${fmt(orario.fine)}` : null,
      };
      const lavorato = !!rd && (conto.ordinarie > 0 || conto.straordinario > 0);
      const residuo = lavorativo ? Math.max(0, contratto - conto.ordinarie) : 0;

      if (abs && abs.tipo === 'maltempo') {
        // F-318: giornata (o parte) di pioggia confermata dal titolare
        cell.maltempoMin = Math.min(abs.ore_min || residuo, residuo); cell.tipo = lavorato ? 'lavoro' : 'maltempo';
      } else if (abs && abs.tipo === 'permesso') {
        const dur = abs.ora_dalle && abs.ora_alle ? Math.max(0, toMin(abs.ora_alle) - toMin(abs.ora_dalle)) : residuo;
        cell.permessoMin = Math.min(dur, residuo || dur); cell.tipo = lavorato ? 'lavoro' : 'permesso';
      } else if (abs && lavorativo) {
        cell.tipo = abs.tipo; // ferie | malattia | infortunio | ingiustificata | altro
      } else if (lavorato) {
        cell.tipo = 'lavoro';
        // Motivo dell'uscita (o dell'entrata in ritardo): le ore mancanti hanno una causale
        const tipoMancanti = MANCANTI_DI[conto.motivo] || MANCANTI_DI[conto.motivoEntrata];
        if (tipoMancanti && lavorativo) {
          cell[`${tipoMancanti}Min`] = residuo;
          if (MANCANTI_DI[conto.motivoEntrata]) cell.ritardo = 0; // ritardo giustificato
        }
      } else if (d.festivo) cell.tipo = 'festivo';
      else if (d.weekend) cell.tipo = 'weekend';
      // Prima di usare Palladia: non ancora in forza, oppure ore sul foglio di carta
      else if (inizioOre && d.date < inizioOre) cell.tipo = info.ore_da_motivo === 'carta' ? 'carta' : 'prima';
      // Solo giorni già finiti: oggi chi non ha timbrato può ancora farlo
      else if (usaPalladia && d.date < today) cell.tipo = 'giustificare';

      if (cell.uscitoPrima && cell.tipo !== 'lavoro') cell.uscitoPrima = 0;
      tot.ordinarieMin += cell.ore;
      tot.straordMin += cell.straord;
      if (cell.festivo) tot.straordFestivoMin += cell.straord;
      tot.permessoMin += cell.permessoMin;
      tot.maltempoMin += cell.maltempoMin;
      tot.malattiaMin += cell.malattiaMin;
      tot.infortunioMin += cell.infortunioMin;
      if (cell.tipo === 'lavoro') {
        tot.giorniLavorati++;
        if (cell.ritardo) { tot.ritardi++; tot.ritardoMin += cell.ritardo; }
        if (cell.mezzaGiornata && !cell.motivo) tot.mezzeGiornate++;
        if (cell.uscitoPrima) { tot.uscitePrima++; tot.uscitaPrimaMin += cell.uscitoPrima; }
        if (cell.entratoPrima) tot.entratePrima++;
        for (const [s, v] of Object.entries(cell.perCantiere)) tot.perCantiere[s] = (tot.perCantiere[s] || 0) + v;
      }
      if (cell.tipo === 'ferie') tot.ferieGiorni++;
      if (cell.tipo === 'malattia') tot.malattiaGiorni++;
      if (cell.tipo === 'infortunio') tot.infortunioGiorni++;
      if (cell.tipo === 'ingiustificata') tot.ingiustificataGiorni++;
      if (cell.tipo === 'altro') tot.altroGiorni++;
      if (cell.tipo === 'giustificare') tot.daGiustificare++;
      if (cell.tipo === 'prima') tot.primaGiorni++;
      if (cell.tipo === 'carta') tot.cartaGiorni = (tot.cartaGiorni || 0) + 1;
      if (cell.anomalia) tot.anomalie++;
      // Cassa Edile: ore lavorabili del mese (giorni lavorativi in forza) e ore non coperte
      if (lavorativo && usaPalladia && cell.tipo !== 'prima' && cell.tipo !== 'carta' && d.date < today) {
        tot.oreLavorabiliMin += contratto;
        const giustificate = cell.tipo === 'lavoro' ? cell.ore + cell.permessoMin + cell.maltempoMin + cell.malattiaMin + cell.infortunioMin
          : ['ferie', 'malattia', 'infortunio', 'altro'].includes(cell.tipo) ? contratto
            : cell.tipo === 'permesso' ? cell.permessoMin : cell.tipo === 'maltempo' ? cell.maltempoMin : 0;
        tot.oreScoperteMin += Math.max(0, contratto - giustificate);
      }
      return cell;
    });

    const proposto = !info.orario_inizio && !info.orario_personale_rifiutato ? orarioProposto(cells, orarioAzienda) : null;
    if (proposto) domande.push({ tipo: 'orario_personale', workerId: w.id, nome: w.nome, ...proposto });
    if (tot.primaGiorni && !info.ore_da) domande.push({ tipo: 'prima', workerId: w.id, nome: w.nome, dal: inizioOre });
    const giust = cells.filter(c => c.tipo === 'giustificare').map(c => c.date);
    if (giust.length) domande.push({ tipo: 'giustificare', workerId: w.id, nome: w.nome, giorni: giust });

    lavoratori.push({
      id: w.id, nome: w.nome, cf: w.cf, cells, tot,
      orario: info.orario_inizio ? `${String(info.orario_inizio).slice(0, 5)}–${String(info.orario_fine).slice(0, 5)}` : null,
    });
  }
  lavoratori.sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  if (!company.orario_confermato_at) domande.unshift({ tipo: 'orario_azienda', inizio: fmt(orarioAzienda.inizio), fine: fmt(orarioAzienda.fine), pausaDa: fmt(orarioAzienda.pausaDa), pausaA: fmt(orarioAzienda.pausaA) });
  const ordine = { orario_azienda: 0, orario_personale: 1, prima: 2, giustificare: 3 };
  domande.sort((a, b) => ordine[a.tipo] - ordine[b.tipo] || (a.nome || '').localeCompare(b.nome || '', 'it'));

  // Richieste in attesa: tutte, anche di altri mesi (ferie di ottobre chieste a settembre)
  const { data: pend } = await supabase.from('worker_absences')
    .select('id, worker_id, tipo, date_from, date_to, ora_dalle, ora_alle, note, stato, da_lavoratore, created_at, workers(full_name)')
    .eq('company_id', companyId).eq('stato', 'richiesta').order('date_from');
  const richieste = (pend || []).map(({ workers, ...a }) => ({ ...a, nome: workers?.full_name || '' }));
  const giorniLavorativi = days.filter(d => !d.weekend && !d.festivo).length;
  const cantieri = Object.fromEntries((sitesRes.data || []).map(s => [s.id, s.name]));

  return {
    month, from, to, days, giorniLavorativi, lavoratori, richieste, assenze: approved, domande, cantieri,
    azienda: { nome: company.name || '', piva: company.piva || '' },
    regole: {
      oreGiornoMin: contrattoAzienda,
      inizio: fmt(orarioAzienda.inizio), fine: fmt(orarioAzienda.fine), pausaDa: fmt(orarioAzienda.pausaDa), pausaA: fmt(orarioAzienda.pausaA),
      tolleranza: orarioAzienda.tolleranza, straordSoglia: orarioAzienda.straordSoglia, straordBlocco: orarioAzienda.straordBlocco,
      confermato: !!company.orario_confermato_at,
    },
  };
}

module.exports = { buildOreMese, festivita, ORE_GIORNO_MIN, coppieDelGiorno, orarioProposto, contaDalReport, caricaOrari };
