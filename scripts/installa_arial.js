#!/usr/bin/env node
/**
 * scripts/installa_arial.js — F-493 (AUDIT.md del frontend).
 *
 * I PDF di PSC e POS sono in Arial: Chrome lo scrive a frasi intere e c'è su
 * ogni PC, quindi Acrobat e Affinity li modificano bene. Sul server (Railway,
 * Linux) Arial non è installato: senza questo script Chrome usa DejaVu Sans.
 *
 * Durante la costruzione scarica l'installatore ORIGINALE di Arial dei
 * «Core fonts for the Web» di Microsoft (arial32.exe, dal mirror SourceForge
 * del progetto corefonts, lo stesso che usano ttf-mscorefonts-installer di
 * Debian/Ubuntu e il pacchetto corefonts di Nix) e ne estrae i quattro file
 * .ttf con cabextract in fonts-arial/. La licenza permette di distribuire
 * solo l'installatore originale: qui lo si scarica, non lo si ridistribuisce.
 *
 * Non blocca mai la costruzione: se qualcosa va storto lo dice e basta (i PDF
 * escono con il carattere di riserva, come prima). Su Windows e Mac non fa
 * niente: Arial c'è già.
 */
'use strict';
/* eslint-disable security/detect-non-literal-fs-filename -- percorsi fissi: fonts-arial/ del codice e la cartella temporanea */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const URL = 'https://downloads.sourceforge.net/corefonts/arial32.exe';
const SHA256 = '85297a4d146e9c87ac6f74822734bdee5f4b2a722d7eaa584b7f2cbf76f478f6';
const DEST = path.join(__dirname, '..', 'fonts-arial');

function scarica(url, file, salti = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'curl/8' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && salti < 8) {
        res.resume();
        return resolve(scarica(new URL_(res.headers.location, url).href, file, salti + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}
const URL_ = globalThis.URL;

(async () => {
  if (process.platform !== 'linux') { console.log('[arial] non Linux: Arial è già nel sistema, niente da fare'); return; }
  if (fs.existsSync(path.join(DEST, 'arial.ttf'))) { console.log('[arial] già installato'); return; }
  const exe = path.join(os.tmpdir(), 'arial32.exe');
  try {
    await scarica(URL, exe);
    const hash = require('crypto').createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
    if (hash !== SHA256) throw new Error(`file inatteso (sha256 ${hash.slice(0, 12)}…)`);
    fs.mkdirSync(DEST, { recursive: true });
    const r = spawnSync('cabextract', ['-q', '-L', '-F', '*.ttf', '-d', DEST, exe], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`cabextract uscito con ${r.status}${r.error ? ` (${r.error.message})` : ''}`);
    const ttf = fs.readdirSync(DEST).filter(f => f.endsWith('.ttf'));
    console.log(`[arial] installato: ${ttf.join(', ')}`);
  } catch (e) {
    console.warn(`[arial] NON installato (${e.message}): i PDF useranno il carattere di riserva`);
  } finally {
    try { fs.unlinkSync(exe); } catch { /* già tolto */ }
  }
})();
