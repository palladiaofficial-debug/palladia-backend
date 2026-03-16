'use strict';
const fs = require('fs');
const p = 'C:/Users/ricka/Desktop/Example for POS/POS - Manutenzione Straordinaria terrazza pertinenziale int.11_compressed.pdf';
const buf = fs.readFileSync(p);
const str = buf.toString('binary');

// Extract parenthesized strings (PDF text objects)
const results = [];
for (let i = 0; i < str.length; i++) {
  if (str[i] === '(') {
    let j = i + 1;
    let s = '';
    while (j < str.length) {
      const ch = str[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === ')') { j++; break; }
      s += ch;
      j++;
    }
    if (s.length > 2) results.push(s);
    i = j - 1;
  }
}

const filtered = results
  .filter(s => /[a-zA-Z\u00C0-\u00FF]{2,}/.test(s))
  .filter(s => s.length < 200)
  .filter(s => !/^[0-9\s\.\-\+\/,;:]+$/.test(s));

console.log('Total text items:', filtered.length);
console.log('\n=== CONTENT ===');
filtered.forEach(t => console.log(t));
