'use strict';
const { PDFParse } = require('pdf-parse');
const fs = require('fs');

const buf = fs.readFileSync('C:/Users/ricka/Desktop/Example for POS/POS - Manutenzione Straordinaria terrazza pertinenziale int.11_compressed.pdf');

(async () => {
  try {
    const parser = new PDFParse();
    const data = await parser.parse(buf);
    console.log('Pages:', data.numpages);
    console.log('\n=== TEXT ===\n');
    data.pages.forEach((page, i) => {
      console.log(`\n--- PAGE ${i+1} ---`);
      page.lines.forEach(line => {
        const txt = line.words.map(w => w.text).join(' ');
        if (txt.trim()) console.log(txt);
      });
    });
  } catch(e) {
    console.error(e.message);
    console.error(e.stack);
  }
})();
