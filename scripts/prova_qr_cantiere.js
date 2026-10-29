// F-406 (AUDIT.md del frontend): resoconto della settimana di prova del QR del
// cantiere su un cantiere vero. Sola lettura. Per ogni giorno della prova:
// timbrature dal QR, dal badge, correzioni a mano, rifiuti fuori cantiere e
// operai che hanno timbrato l'entrata ma non l'uscita.
//
//   node scripts/prova_qr_cantiere.js "<nome cantiere>" [giorno-inizio YYYY-MM-DD] [company_id]
//
// Di base: azienda MSC, inizio = 7 giorni fa.
require('dotenv').config();
const supabase = require('../lib/supabase');

const MSC = '309e9018-1bcc-4876-9430-99cb89e043dd';
// worker_offline_punch: senza rete, dal QR o dal badge (F-284, F-406)
const METODO = { personal_phone: 'QR', worker_self_punch: 'badge', worker_offline_punch: 'senza rete', admin_manual_correction: 'a mano', ladia_action: 'a mano' };
const VUOTO = () => ({ QR: 0, badge: 0, 'senza rete': 0, 'a mano': 0 });
const giornoRoma = ts => new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const oraRoma = ts => new Date(ts).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });

(async () => {
  const [nome, inizioArg, companyId = MSC] = process.argv.slice(2);
  if (!nome) { console.error('Uso: node scripts/prova_qr_cantiere.js "<nome cantiere>" [YYYY-MM-DD] [company_id]'); process.exit(1); }
  const inizio = inizioArg || giornoRoma(Date.now() - 7 * 864e5);

  const { data: siti } = await supabase.from('sites').select('id, name, latitude, geofence_radius_m')
    .eq('company_id', companyId).neq('status', 'eliminato').ilike('name', `%${nome}%`);
  if (!siti?.length) { console.error(`Nessun cantiere con «${nome}»`); process.exit(1); }
  if (siti.length > 1) { console.error('Più cantieri trovati:', siti.map(s => s.name).join(' | ')); process.exit(1); }
  const site = siti[0];

  const da = new Date(`${inizio}T00:00:00+01:00`).toISOString();
  const { data: logs } = await supabase.from('presence_logs')
    .select('worker_id, event_type, method, timestamp_server, distance_m')
    .eq('site_id', site.id).gte('timestamp_server', da).order('timestamp_server').limit(5000);
  const { data: rifiuti } = await supabase.from('admin_audit_log').select('target_id, created_at, payload')
    .eq('company_id', companyId).eq('action', 'punch.rejected_geofence').gte('created_at', da).limit(1000);
  const rifiutiQui = (rifiuti || []).filter(r => r.payload?.site_id === site.id);
  const ids = [...new Set([...(logs || []).map(l => l.worker_id), ...rifiutiQui.map(r => r.target_id)])];
  const { data: workers } = ids.length ? await supabase.from('workers').select('id, full_name').in('id', ids) : { data: [] };
  const nomeOp = Object.fromEntries((workers || []).map(w => [w.id, w.full_name]));

  console.log(`Prova QR — ${site.name} (dal ${inizio})`);
  console.log(site.latitude == null ? 'ATTENZIONE: il cantiere non ha la posizione, il QR non controlla dove si trova l’operaio\n' : `Posizione impostata, raggio ${site.geofence_radius_m} m\n`);

  const giorni = {};
  for (const l of logs || []) (giorni[giornoRoma(l.timestamp_server)] ||= []).push(l);
  const tot = VUOTO();
  for (const [g, righe] of Object.entries(giorni)) {
    const conta = VUOTO();
    for (const r of righe) conta[METODO[r.method] || 'a mano']++;
    Object.keys(tot).forEach(k => { tot[k] += conta[k]; });
    console.log(`${g}: QR ${conta.QR} · badge ${conta.badge} · senza rete ${conta['senza rete']} · a mano ${conta['a mano']}`);
    const perOp = {};
    for (const r of righe) (perOp[r.worker_id] ||= []).push(r);
    for (const [wid, rr] of Object.entries(perOp)) {
      const seq = rr.map(r => `${r.event_type === 'ENTRY' ? 'E' : 'U'} ${oraRoma(r.timestamp_server)} (${METODO[r.method] || r.method})`).join(', ');
      const aperta = rr[rr.length - 1].event_type === 'ENTRY' ? '  ← senza uscita' : '';
      console.log(`   ${nomeOp[wid] || wid}: ${seq}${aperta}`);
    }
    const rif = rifiutiQui.filter(r => giornoRoma(r.created_at) === g);
    for (const r of rif) console.log(`   rifiutata fuori cantiere: ${nomeOp[r.target_id] || r.target_id} alle ${oraRoma(r.created_at)}, a ${r.payload.distance_m} m`);
  }
  const tutte = Object.values(tot).reduce((a, b) => a + b, 0);
  console.log(`\nTotale: ${tutte} timbrature — QR ${tot.QR}, badge ${tot.badge}, senza rete ${tot['senza rete']}, a mano ${tot['a mano']}, rifiutate fuori cantiere ${rifiutiQui.length}`);
  const { data: dubbi } = await supabase.from('presence_offline_punches').select('id').eq('site_id', site.id).eq('status', 'da_decidere').gte('received_at', da);
  if (dubbi?.length) console.log(`Timbrature senza rete da decidere in Da fare: ${dubbi.length}`);
  if (tutte) console.log(`Quota QR: ${Math.round(100 * tot.QR / tutte)}% · correzioni a mano: ${Math.round(100 * tot['a mano'] / tutte)}%`);
})();
