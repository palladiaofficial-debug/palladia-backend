'use strict';
/**
 * Canary anti-fabbricazione: scansiona i messaggi assistant recenti di Ladia
 * cercando frasi al passato che dichiarano un'azione di scrittura completata
 * ("ho archiviato", "ho creato", ecc.) e verifica se esiste davvero una riga
 * corrispondente in ladia_action_history per la stessa conversazione, vicina
 * nel tempo. Se non c'è, il messaggio è un sospetto di fabbricazione da
 * rivedere a mano — euristico (regex), non prova assoluta.
 *
 * Uso: node scripts/detect_fabrication.js [giorni_indietro=7]
 */
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Verbi al passato prossimo che implicano una scrittura o una verifica
// documentale reale — non conversazionali generici ("ho capito").
const CLAIM_PATTERNS = [
  /\bho archiviato\b/i, /\bho creato\b/i, /\bho eliminato\b/i, /\bho aggiornato\b/i,
  /\bho annullato\b/i, /\bho assegnato\b/i, /\bho registrato\b/i, /\bho salvato\b/i,
  /\bho emesso\b/i, /\bho generato\b/i, /\bho ricalcolato\b/i, /\bho rimosso\b/i,
  /\bho spostato\b/i, /\bho modificato\b/i, /\bho letto\b/i, /\bho verificato\b/i,
  /\bho consultato\b/i, /\bho controllato\b/i, /\bho disattivato\b/i,
];

const WINDOW_MS = 3 * 60 * 1000; // finestra di tolleranza tra messaggio e action_history

async function main() {
  const days = Number(process.argv[2]) || 7;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data: messages, error } = await supabase
    .from('chat_messages')
    .select('id, conversation_id, content, created_at')
    .eq('role', 'assistant')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(5000);
  if (error) { console.error('Errore lettura chat_messages:', error.message); process.exit(1); }

  const candidates = (messages || []).filter(m =>
    typeof m.content === 'string' && CLAIM_PATTERNS.some(re => re.test(m.content))
  );

  console.log(`Messaggi assistant negli ultimi ${days}gg: ${messages.length}`);
  console.log(`Con dichiarazione di azione completata: ${candidates.length}\n`);

  if (candidates.length === 0) { console.log('Nessun candidato da verificare.'); return; }

  const convIds = [...new Set(candidates.map(c => c.conversation_id))];
  const { data: actions, error: actErr } = await supabase
    .from('ladia_action_history')
    .select('conversation_id, created_at, resource, action, summary')
    .in('conversation_id', convIds);
  if (actErr) { console.error('Errore lettura ladia_action_history:', actErr.message); process.exit(1); }

  const byConv = {};
  for (const a of (actions || [])) {
    (byConv[a.conversation_id] ||= []).push(a);
  }

  let suspects = 0;
  for (const m of candidates) {
    const actionsForConv = byConv[m.conversation_id] || [];
    const t = new Date(m.created_at).getTime();
    const corroborated = actionsForConv.some(a => Math.abs(new Date(a.created_at).getTime() - t) <= WINDOW_MS);
    if (!corroborated) {
      suspects++;
      const matched = CLAIM_PATTERNS.find(re => re.test(m.content));
      const snippet = m.content.slice(0, 220).replace(/\n/g, ' ');
      console.log(`--- SOSPETTO #${suspects} ---`);
      console.log(`conversation_id: ${m.conversation_id}`);
      console.log(`created_at:      ${m.created_at}`);
      console.log(`verbo:           ${matched}`);
      console.log(`testo:           ${snippet}${m.content.length > 220 ? '…' : ''}`);
      console.log('');
    }
  }

  console.log(`\nTotale sospetti senza riscontro in ladia_action_history entro ±${WINDOW_MS / 1000}s: ${suspects}/${candidates.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
