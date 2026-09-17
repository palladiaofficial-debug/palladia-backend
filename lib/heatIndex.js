'use strict';
/**
 * lib/heatIndex.js
 *
 * Stima del WBGT (Wet Bulb Globe Temperature) da temperatura e umidità
 * relativa, con la formula semplificata pubblica del Bureau of Meteorology
 * australiano (BOM) per condizioni outdoor esposte al sole:
 *
 *   WBGT ≈ 0.567·Ta + 0.393·e + 3.94
 *   e (pressione di vapore, hPa) = (RH/100) · 6.105 · exp(17.27·Ta / (237.7+Ta))
 *
 * Fonte: Australian Bureau of Meteorology, "Thermal Comfort observations"
 * (http://www.bom.gov.au/info/thermal_stress/) — formula pubblica, ampiamente
 * citata in letteratura di igiene occupazionale, non un'invenzione di questo
 * modulo.
 *
 * ATTENZIONE — limite reale, non un dettaglio tecnico: questa è una STIMA,
 * non il WBGT ufficiale ISO 7243. Il WBGT vero richiede un termometro a
 * globo nero (misura la temperatura radiante), che nessuna stazione ARPAL
 * standard possiede. Va presentato SEMPRE come "WBGT stimato", mai come
 * dato certificato — la temperatura e l'umidità che lo alimentano SONO
 * certificate ARPAL, il valore combinato che ne deriva no. Coerente con il
 * D.L. 107/2026 art. 6: la norma non richiede un WBGT ufficiale, richiede
 * una relazione tecnica con temperatura+umidità+altri fattori — questo
 * indice è un elemento di supporto in più, non il sostituto della
 * relazione stessa.
 */

/**
 * @param {number} tempC - temperatura dell'aria, °C
 * @param {number} humidityPct - umidità relativa, 0-100
 * @returns {number|null} WBGT stimato in °C, arrotondato a 1 decimale — null se input non validi
 */
function estimateWbgt(tempC, humidityPct) {
  if (!Number.isFinite(tempC) || !Number.isFinite(humidityPct)) return null;
  if (humidityPct < 0 || humidityPct > 100) return null;

  const vaporPressure = (humidityPct / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
  const wbgt = 0.567 * tempC + 0.393 * vaporPressure + 3.94;
  return Math.round(wbgt * 10) / 10;
}

module.exports = { estimateWbgt };
