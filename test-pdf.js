'use strict';
const { generatePosHtml } = require('./pos-html-generator');
const { renderHtmlToPdf } = require('./pdf-renderer');
const fs = require('fs');

const posData = require('./posData.example.json');

const aiRisks = `### Rimozione manto impermeabilizzante esistente

**Descrizione tecnica:** Rimozione meccanica e manuale del manto impermeabilizzante esistente mediante utensili manuali e macchine scarificatrici.

**Rischi identificati e valutazione (matrice P x D):**

| Rischio | P (1-4) | D (1-4) | R (PxD) | Livello |
|---------|---------|---------|---------|---------|
| Caduta dall'alto dalla copertura | 3 | 4 | 12 | Alto |
| Inalazione polveri e fibre | 2 | 3 | 6 | Medio |
| Urti e tagli con attrezzatura | 2 | 2 | 4 | Medio |

**Misure di prevenzione e protezione:**
- Installazione di parapetti perimetrali fissi h >= 1 m
- Imbracatura anticaduta obbligatoria con punto di ancoraggio certificato
- Mascherina FFP2 obbligatoria durante le operazioni di rimozione
- Delimitazione area sottostante con transenna e segnaletica

**DPI obbligatori:**
| DPI | Norma UNI EN | Note |
|-----|-------------|------|
| Imbracatura anticaduta | UNI EN 361:2002 | Obbligatoria per lavori in quota |
| Facciale filtrante FFP2 | UNI EN 149:2009 | Per polveri di demolizione |
| Casco di protezione | UNI EN 397:2012 | Obbligatorio in tutta l'area |
| Guanti antitaglio | UNI EN 388:2016 | Livello D taglio |

**Attrezzature e verifiche:**
| Attrezzatura | Verifica richiesta | Frequenza |
|-------------|-------------------|-----------|
| Scale portatili | Controllo visivo | Prima di ogni utilizzo |
| Utensili manuali | Controllo efficienza | Giornaliero |

---

### Posa nuovo massetto in pendenza

**Descrizione tecnica:** Posa di massetto alleggerito in pendenza per il corretto deflusso delle acque meteoriche.

**Rischi identificati e valutazione (matrice P x D):**

| Rischio | P (1-4) | D (1-4) | R (PxD) | Livello |
|---------|---------|---------|---------|---------|
| Contatto con cemento e additivi | 3 | 2 | 6 | Medio |
| Movimentazione manuale carichi | 2 | 2 | 4 | Medio |
| Caduta dall'alto | 2 | 4 | 8 | Medio |

**Misure di prevenzione e protezione:**
- Uso di guanti resistenti alla calce durante la manipolazione del cemento
- Utilizzo di carriole e pale ergonomiche per limitare sforzo fisico
- Sistemi di protezione collettiva anti-caduta mantenuti in opera

**DPI obbligatori:**
| DPI | Norma UNI EN | Note |
|-----|-------------|------|
| Guanti da lavoro resistenti alla calce | UNI EN 388:2016 | Cambio frequente |
| Occhiali di protezione | UNI EN 166:2001 | Durante miscelazione |
| Calzature S3 | UNI EN ISO 20345:2022 | Obbligatorie |

---
`;

(async () => {
  console.log('Generazione HTML...');
  const html = await generatePosHtml(posData, 1, aiRisks, []);
  console.log('HTML OK:', html.length, 'caratteri');

  console.log('Generazione PDF con Puppeteer...');
  try {
    const pdfBuf = await renderHtmlToPdf(html, {
      docTitle: 'POS – Edil Bianchi S.r.l. – Rev. 1',
      revision: 1
    });
    fs.writeFileSync('./test-output.pdf', pdfBuf);
    console.log('PDF OK:', pdfBuf.length, 'bytes (' + Math.round(pdfBuf.length / 1024) + ' KB)');
    console.log('File salvato: test-output.pdf');
  } catch (e) {
    console.error('ERRORE Puppeteer:', e.message);
    process.exit(1);
  }
})();
