'use strict';
/**
 * lib/psc/ai.js — F-270. Chiamata al modello con forma della risposta IMPOSTA
 * da un tool a schema (tool_choice forzato), budget mensile controllato e
 * consumo registrato. Stesso schema di lib/pscExtract.js.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { extractPdfText } = require('../pdfExtract');
const { docxText } = require('./files');
const { logUsage, checkAiBudget } = require('../ladiaUsageLog');

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TEXT_CHARS = 220_000;

async function callTool({ system, content, tool, maxTokens = 8000, companyId, userId = null, callSite }) {
  const budget = await checkAiBudget(companyId);
  if (!budget.allowed) { const e = new Error('Hai raggiunto il limite mensile di utilizzo dell\'AI del tuo piano'); e.status = 429; throw e; }
  const client = new Anthropic();
  const resp = await client.messages.create({
    model: MODEL, max_tokens: maxTokens, temperature: 0, system,
    tools: [tool], tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content }],
  });
  await logUsage({ companyId, userId, model: MODEL, callSite, usage: resp.usage });
  const block = (resp.content || []).find(b => b.type === 'tool_use');
  return { input: block ? block.input : null, truncated: resp.stop_reason === 'max_tokens' };
}

/**
 * Prepara il contenuto per il modello da un file: testo (PDF con testo, DOCX)
 * oppure il PDF stesso se è una scansione.
 */
async function contentFromFile(buffer, mime, label) {
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const { text, numPages } = docxText(buffer);
    if (text.trim().length < 300) { const e = new Error('Il file Word è quasi vuoto'); e.status = 422; throw e; }
    return { content: `${label} (documento Word, testo):\n\n${text.slice(0, MAX_TEXT_CHARS)}`, numPages, source: 'docx' };
  }
  if (mime !== 'application/pdf') { const e = new Error('Formato non supportato: usa PDF o Word (.docx)'); e.status = 400; throw e; }
  const { text, numPages } = await extractPdfText(buffer, { maxPages: 200, minChars: 10 });
  if (text && text.trim().length > 800) {
    return { content: `${label} (${numPages} pagine):\n\n${text.slice(0, MAX_TEXT_CHARS)}`, numPages, source: 'testo' };
  }
  if (buffer.length > 30 * 1024 * 1024) { const e = new Error('Scansione troppo grande (massimo 30 MB)'); e.status = 400; throw e; }
  return {
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: `Questo è il documento: ${label}.` },
    ],
    numPages, source: 'scansione',
  };
}

module.exports = { callTool, contentFromFile, MODEL };
