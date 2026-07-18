'use strict';
/**
 * lib/fuzzyMatch.js
 * Matching approssimato nome-contro-nome (lavoratori, cantieri) — estratto
 * da routes/v1/workerDocs.js (ai-import) per essere riusabile anche
 * dall'importazione massiva zip (services/chatBulkImport.js). Stesso
 * algoritmo, stessa soglia di punteggio, un solo posto da mantenere.
 */

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function normName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Mn}/gu, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Restituisce 0-100; gestisce "ROSSI Mario" vs "Mario Rossi" via token overlap
function scoreMatch(extracted, candidateName) {
  const a = normName(extracted);
  const b = normName(candidateName);
  if (!a || !b) return 0;
  const ta = new Set(a.split(' ').filter(t => t.length > 1));
  const tb = new Set(b.split(' ').filter(t => t.length > 1));
  const common = [...ta].filter(t => tb.has(t)).length;
  const tokenScore = common / Math.max(ta.size, tb.size, 1);
  const lev = levenshtein(a, b);
  const levScore = 1 - lev / Math.max(a.length, b.length, 1);
  return Math.round(tokenScore * 70 + levScore * 30);
}

/**
 * Trova il miglior candidato in una lista { id, name } per un nome estratto
 * dall'AI. Restituisce { id, name, score } del migliore, o null se nessuno
 * supera la soglia.
 */
function bestMatch(extractedName, candidates, nameKey = 'name', threshold = 35) {
  if (!extractedName) return null;
  let best = null;
  for (const c of candidates) {
    const score = scoreMatch(extractedName, c[nameKey]);
    if (score >= threshold && (!best || score > best.score)) best = { ...c, score };
  }
  return best;
}

module.exports = { levenshtein, normName, scoreMatch, bestMatch };
