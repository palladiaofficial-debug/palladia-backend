'use strict';
/**
 * services/ladiaTools.js
 * Definizioni e handler dei tool che Ladia può usare (Claude function calling).
 *
 * Tool disponibili:
 *   meteo_cantiere       → previsioni 3gg Open-Meteo (nessuna API key)
 *   lista_nc_aperte      → NC urgenti del cantiere filtrate per urgenza
 *   stato_cantiere       → riepilogo live: presenze, NC, budget, SAL
 *   crea_non_conformita  → inserisce NC in site_notes
 *   aggiungi_nota        → inserisce nota in site_notes
 */

const supabase = require('../lib/supabase');
const { getForecast }    = require('./weatherService');
const { searchTemplates, getTemplateContent } = require('./ladiaDocumentProcessor');

// ── Definizioni tool (formato Anthropic) ────────────────────────

const LADIA_TOOL_DEFINITIONS = [
  {
    name: 'meteo_cantiere',
    description:
      'Recupera le previsioni meteo dei prossimi 3 giorni per il cantiere attivo. ' +
      'Usa questo tool quando l\'utente chiede del meteo, o quando vuoi dare consigli ' +
      'su attività sensibili alle condizioni atmosferiche (gettate, opere esterne, ponteggi).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'lista_nc_aperte',
    description:
      'Elenca le non conformità aperte del cantiere, filtrabili per urgenza. ' +
      'Usalo quando l\'utente vuole un elenco aggiornato dei problemi aperti.',
    input_schema: {
      type: 'object',
      properties: {
        urgenza: {
          type: 'string',
          enum: ['tutte', 'alta', 'critica'],
          description: 'Filtra per urgenza. Default: tutte',
        },
      },
    },
  },
  {
    name: 'stato_cantiere',
    description:
      'Recupera un riepilogo live del cantiere: presenze ultime 24h, NC aperte, ' +
      'avanzamento SAL, stato budget. Utile per "dammi un quadro generale" o quando ' +
      'l\'utente vuole dati freschi.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'crea_non_conformita',
    description:
      'Crea una nuova non conformità nel sistema Palladia per il cantiere attivo. ' +
      'Usa questo tool SOLO quando l\'utente chiede esplicitamente di registrare un problema.',
    input_schema: {
      type: 'object',
      properties: {
        descrizione: {
          type: 'string',
          description: 'Descrizione chiara e completa del problema riscontrato',
        },
        urgenza: {
          type: 'string',
          enum: ['bassa', 'media', 'alta', 'critica'],
          description: 'Livello di urgenza della NC',
        },
      },
      required: ['descrizione', 'urgenza'],
    },
  },
  {
    name: 'aggiungi_nota',
    description:
      'Aggiunge una nota al diario del cantiere. Usa questo tool quando l\'utente ' +
      'vuole registrare un aggiornamento, un avanzamento o una comunicazione.',
    input_schema: {
      type: 'object',
      properties: {
        testo: {
          type: 'string',
          description: 'Testo completo della nota da salvare',
        },
        categoria: {
          type: 'string',
          enum: ['nota', 'presenza', 'incidente', 'verbale', 'documento', 'altro'],
          description: 'Categoria della nota. Default: nota',
        },
      },
      required: ['testo'],
    },
  },
  {
    name: 'cerca_template_documento',
    description:
      'Cerca tra i documenti PDF caricati dall\'impresa (contratti, capitolati, POS, preventivi, ecc.). ' +
      'Usalo quando l\'utente chiede di "scrivere un contratto come quello caricato", ' +
      '"redigere un documento simile", "basati sul nostro capitolato" o qualsiasi richiesta ' +
      'che richiede di replicare/adattare un documento già in archivio. ' +
      'Restituisce il testo e le sezioni chiave del documento trovato.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: ['contratto', 'capitolato', 'POS', 'PSC', 'computo', 'fattura',
                 'verbale', 'preventivo', 'lettera', 'relazione', 'altro', 'tutti'],
          description: 'Tipo di documento da cercare. Usa "tutti" per cercare in tutti i tipi.',
        },
        query: {
          type: 'string',
          description: 'Parola chiave per cercare per contenuto o nome file (opzionale)',
        },
        template_id: {
          type: 'string',
          description: 'ID specifico del template da leggere (opzionale — usa se l\'utente ha già indicato quale documento)',
        },
      },
    },
  },
];

// ── Esecutori tool ───────────────────────────────────────────────

/**
 * Esegue un tool per conto di Ladia.
 * @param {string} toolName
 * @param {object} input - parametri forniti da Claude
 * @param {{ companyId, siteId, authorId, authorName }} ctx
 * @returns {Promise<string>} testo del risultato
 */
async function executeTool(toolName, input, ctx) {
  try {
    switch (toolName) {
      case 'meteo_cantiere':       return await toolMeteo(ctx.siteId);
      case 'lista_nc_aperte':      return await toolListaNc(ctx.companyId, ctx.siteId, input.urgenza || 'tutte');
      case 'stato_cantiere':       return await toolStatoCantiere(ctx.companyId, ctx.siteId);
      case 'crea_non_conformita':  return await toolCreaNc(ctx, input.descrizione, input.urgenza);
      case 'aggiungi_nota':            return await toolAggiungiNota(ctx, input.testo, input.categoria || 'nota');
      case 'cerca_template_documento': return await toolCercaTemplate(ctx.companyId, input.tipo, input.query, input.template_id);
      default:                         return `Tool "${toolName}" non riconosciuto.`;
    }
  } catch (err) {
    console.error(`[ladiaTools] ${toolName} error:`, err.message);
    return `Errore nell'eseguire l'azione: ${err.message}`;
  }
}

// ── Implementazioni ──────────────────────────────────────────────

async function toolMeteo(siteId) {
  const { data: site } = await supabase
    .from('sites')
    .select('name, latitude, longitude')
    .eq('id', siteId)
    .maybeSingle();

  if (!site?.latitude || !site?.longitude) {
    return 'Posizione GPS non configurata per questo cantiere — impossibile recuperare meteo.';
  }

  const forecast = await getForecast(site.latitude, site.longitude);
  const labels   = ['Oggi', 'Domani', 'Dopodomani'];
  const lines    = forecast.map((f, i) => {
    const temp = f.tempMax !== null ? ` | ${f.tempMin}–${f.tempMax}°C` : '';
    const rain = f.precipProb > 10  ? ` | precipitazioni ${f.precipProb}%` : '';
    const warn = f.isRainy && f.precipProb >= 40 ? ' ⚠️' : '';
    return `${labels[i]} (${f.date}): ${f.description}${temp}${rain}${warn}`;
  });

  return `Meteo ${site.name}:\n${lines.join('\n')}`;
}

async function toolListaNc(companyId, siteId, urgenza) {
  let query = supabase
    .from('site_notes')
    .select('id, content, ai_summary, urgency, created_at')
    .eq('company_id', companyId)
    .eq('site_id', siteId)
    .eq('category', 'non_conformita')
    .order('created_at', { ascending: false })
    .limit(25);

  if (urgenza !== 'tutte') query = query.eq('urgency', urgenza);

  const { data: ncs } = await query;

  if (!ncs?.length) {
    return `Nessuna NC${urgenza !== 'tutte' ? ' ' + urgenza : ''} trovata — ottimo! ✅`;
  }

  const lines = ncs.map(nc => {
    const d    = new Date(nc.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
    const text = (nc.ai_summary || nc.content || '').slice(0, 140);
    const icon = nc.urgency === 'critica' ? '🔴' : nc.urgency === 'alta' ? '🟠' : nc.urgency === 'media' ? '🟡' : '⚪';
    return `${icon} ${d}: ${text}`;
  });

  return `NC trovate (${ncs.length}):\n${lines.join('\n')}`;
}

async function toolStatoCantiere(companyId, siteId) {
  const yesterday = new Date(Date.now() - 86_400_000)
    .toISOString();

  const [siteRes, ncRes, presenceRes, econRes] = await Promise.all([
    supabase.from('sites')
      .select('name, status, sal_percentuale, budget_totale')
      .eq('id', siteId)
      .maybeSingle(),

    supabase.from('site_notes')
      .select('urgency')
      .eq('site_id', siteId)
      .eq('category', 'non_conformita')
      .limit(200),

    supabase.from('presence_logs')
      .select('worker_id, event_type')
      .eq('site_id', siteId)
      .gte('timestamp_server', yesterday)
      .limit(300),

    supabase.from('site_economia_voci')
      .select('tipo, importo')
      .eq('site_id', siteId)
      .eq('company_id', companyId)
      .limit(500),
  ]);

  const site = siteRes.data;
  if (!site) return 'Dati cantiere non disponibili.';

  const ncs    = ncRes.data     || [];
  const pres   = presenceRes.data || [];
  const voci   = econRes.data   || [];

  const ncCrit = ncs.filter(n => n.urgency === 'critica').length;
  const ncAlte = ncs.filter(n => n.urgency === 'alta').length;

  const entrati = new Set(pres.filter(p => p.event_type === 'ENTRY').map(p => p.worker_id));
  const usciti  = new Set(pres.filter(p => p.event_type === 'EXIT').map(p => p.worker_id));
  const senzaUscita = [...entrati].filter(id => !usciti.has(id)).length;

  const costi  = voci.filter(v => v.tipo === 'costo').reduce((s, v) => s + Number(v.importo), 0);
  const ricavi = voci.filter(v => v.tipo === 'ricavo').reduce((s, v) => s + Number(v.importo), 0);
  const budget = Number(site.budget_totale || 0);
  const sal    = Number(site.sal_percentuale || 0);
  const fmtEur = n => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

  let result = `Cantiere: ${site.name} — ${site.status}\nSAL: ${sal}%`;

  if (budget > 0) {
    const pct = Math.round((costi / budget) * 100);
    result += `\nBudget: ${fmtEur(budget)} — consumato ${pct}%`;
    if (pct > sal + 10) result += ` ⚠️ SFORAMENTO`;
  }

  result += `\n\nNC aperte: ${ncs.length} totali`;
  if (ncCrit > 0) result += ` — 🔴 ${ncCrit} critiche`;
  if (ncAlte > 0) result += ` — 🟠 ${ncAlte} alte`;

  if (pres.length > 0) {
    result += `\nPresenze ultime 24h: ${entrati.size} entrate`;
    if (senzaUscita > 0) result += `, ${senzaUscita} senza uscita registrata`;
  } else {
    result += `\nPresenze ultime 24h: nessuna timbratura`;
  }

  if (costi > 0 || ricavi > 0) {
    result += `\nEconomia: ${fmtEur(ricavi)} ricavi, ${fmtEur(costi)} costi, utile ${fmtEur(ricavi - costi)}`;
  }

  return result;
}

async function toolCreaNc(ctx, descrizione, urgenza) {
  const { companyId, siteId, authorId, authorName } = ctx;

  const { data, error } = await supabase
    .from('site_notes')
    .insert({
      company_id:  companyId,
      site_id:     siteId,
      author_id:   authorId || null,
      author_name: authorName || 'Ladia',
      source:      'telegram',
      category:    'non_conformita',
      content:     descrizione,
      urgency:     urgenza === 'bassa' || urgenza === 'media' ? 'normale' : urgenza,
    })
    .select('id')
    .single();

  if (error) return `Errore nel salvare la NC: ${error.message}`;
  return `✅ Non conformità registrata (${urgenza}). ID: ${data.id.slice(0, 8)}…\nVisibile su Palladia nella sezione cantiere.`;
}

async function toolAggiungiNota(ctx, testo, categoria) {
  const { companyId, siteId, authorId, authorName } = ctx;

  // Normalizza categoria: se non è in CHECK constraint usa 'nota'
  const validCategories = ['nota', 'foto', 'non_conformita', 'verbale', 'presenza', 'incidente', 'documento', 'altro'];
  const cat = validCategories.includes(categoria) ? categoria : 'nota';

  const { error } = await supabase
    .from('site_notes')
    .insert({
      company_id:  companyId,
      site_id:     siteId,
      author_id:   authorId || null,
      author_name: authorName || 'Ladia',
      source:      'telegram',
      category:    cat,
      content:     testo,
      urgency:     'normale',
    });

  if (error) return `Errore nel salvare la nota: ${error.message}`;
  return `✅ Nota salvata nel diario del cantiere.`;
}

async function toolCercaTemplate(companyId, tipo, query, templateId) {
  // Se viene fornito un ID specifico, carica il documento completo
  if (templateId) {
    const t = await getTemplateContent(companyId, templateId);
    if (!t) return `Nessun documento trovato con ID ${templateId}.`;

    let result = `📄 <b>${t.original_filename}</b> (${t.document_type})\n`;
    result += `Caricato: ${new Date(t.created_at).toLocaleDateString('it-IT')}\n\n`;
    result += `<b>Riassunto:</b> ${t.summary}\n\n`;

    if (t.key_sections?.length) {
      result += `<b>Sezioni chiave (${t.key_sections.length}):</b>\n`;
      t.key_sections.slice(0, 8).forEach(s => {
        result += `\n• <b>${s.titolo}</b>\n${(s.contenuto || '').slice(0, 400)}`;
      });
    }

    if (t.extracted_text) {
      result += `\n\n<b>Testo principale:</b>\n${t.extracted_text.slice(0, 8000)}`;
    }

    return result;
  }

  // Ricerca per tipo e/o query
  const templates = await searchTemplates(companyId, tipo || 'tutti', query);

  if (!templates.length) {
    const msg = tipo && tipo !== 'tutti'
      ? `Nessun documento di tipo "${tipo}" trovato.`
      : `Nessun documento in archivio.`;
    return msg + ` Invia un PDF a Ladia per caricarne uno.`;
  }

  // Se trovato uno solo → carica subito il contenuto completo
  if (templates.length === 1) {
    return toolCercaTemplate(companyId, null, null, templates[0].id);
  }

  // Più risultati → mostra lista e suggerisci di specificare
  let result = `Trovati ${templates.length} documenti:\n`;
  templates.forEach((t, i) => {
    const d = new Date(t.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
    result += `\n${i + 1}. <b>${t.original_filename}</b> (${t.document_type}) — ${d}\n   ${(t.summary || '').slice(0, 120)}`;
  });
  result += `\n\nSpecifica quale vuoi usare o richiedi per tipo (es. "usa il primo").`;

  return result;
}

module.exports = { LADIA_TOOL_DEFINITIONS, executeTool };
