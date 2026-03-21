---
name: POS fix UX + data integrity (2026-03-20)
description: Correzioni al flusso POS: UI generazione, formattazione importo, campi mancanti nel mapping, orario di lavoro reale, sezioni mancanti nel PDF
type: project
---

## Fix applicati 2026-03-20 (sessione 1)

### 1. UI generazione POS (POSGenerator.tsx)
- Rimosso lo streaming di testo grezzo durante la generazione
- Sostituito con schermata pulita: spinner + "L'IA sta componendo il tuo POS"

### 2. Input importoLavori (StepDatiGenerali.tsx)
- Cambiato da `type="number"` a `type="text"` con `inputMode="decimal"`
- Filter onChange: accetta solo cifre, punto e virgola (formato italiano es. 150.000,00)

### 3. mapFormToBackend — campi aggiuntivi (POSGenerator.tsx)
Aggiunto: `direttoreTecnico`, `preposto`, `oreLavorative`, `inizioTurno`, `pausaPranzo`, `turnoNotturno`, `cfCommittente`, `tipoAppalto`

### 4. Sezione 2.3 Orario di lavoro — dati reali (pos-html-generator.js + pos-template.js)
- Prima era HARDCODED; ora usa i dati reali compilati dall'utente

### 5. Formattazione importo lavori nel PDF (pos-html-generator.js + pos-template.js)
- `formatBudget()`: "150000" → "150.000", "150.000,00" → invariato

## Fix applicati 2026-03-20 (sessione 2 — audit credibilità)

### 6. Sezione Percorso Express — PSC fake rimosso (StepDatiGenerali.tsx)
- `simulateUpload()` rimossa completamente (era una simulazione falsa che mostrava progress bar finta)
- Sostituito con banner "Prossimamente" + link a Percorso Assistito/Manuale
- Rimossi stati inutilizzati: `uploadProgress`, `uploadDone`; rimossa dipendenza da `useState`

### 7. Campo Matricola lavoratori (posTypes.ts + StepOrganico.tsx + POSGenerator.tsx)
- Aggiunto `matricola: string` a `LavoratorePOS` interface
- Aggiunto campo input "Matricola" nel form StepOrganico.tsx (griglia 3 colonne)
- Corretto `matricola: w.id` (che era un timestamp) in `matricola: w.matricola || ""`

### 8. Fasi di lavoro (Step 4) ora nel PDF
- `mapFormToBackend` ora include `fasi: formData.fasi.map(...)`
- Sezione 2.4 aggiunta in pos-html-generator.js (tabella: Fase/Durata/Lavoratori/Lavorazioni)
- Sezione 2.5 aggiunta in pos-template.js (tabella markdown)

### 9. Imprese Subappaltatrici ora nel PDF
- `mapFormToBackend` ora include `subappaltatori: formData.subappaltatori.map(...)`
- Sezione 3.3 aggiunta in pos-html-generator.js (tabella: RS/PIVA/RL/Email)
- Sezione 3.3 aggiunta in pos-template.js (tabella markdown)

### 10. Rischi Specifici, Opere Provvisionali, Impianti, Note (Step 6) ora nel PDF
- `mapFormToBackend` include: `rischiSpecifici`, `opereProvvisionali`, `impiantiCantiere`, `noteAggiuntive`
- Sezioni 4.6, 4.7, 4.8, 4.9 aggiunte in pos-html-generator.js (liste bullet)
- Sezioni 4.7, 4.8, 4.9, 4.10 aggiunte in pos-template.js

### 11. Formato date ISO → italiano (pos-html-generator.js + pos-template.js)
- `formatDate()`: "2024-03-15" → "15/03/2024"
- Applicata su cover page (periodo), sezione 2.1, pos-template.js sezione 2.1

### 12. numWorkers fallback "4" rimosso (POSGenerator.tsx)
- `String(formData.lavoratori.length || 4)` → `formData.lavoratori.length > 0 ? String(...) : ""`
- Se nessun lavoratore inserito → mostra [DA COMPILARE] nel PDF, non "4"

### 13. Messaggio fuorviante "pre-selezionati X rischi" (StepRischi.tsx)
- Prima: sempre visibile con count 0 (rischi mai auto-popolati)
- Ora: visibile solo se ci sono rischi selezionati, senza claim falso di "pre-selezione"

## Fix applicati 2026-03-20 (sessione 3 — audit definitivo)

### 14. Bug critico PDF: handleDownloadPdf fallback rimosso (POSGenerator.tsx)
- `editableRisks || streamedText` → solo `editableRisks`
- **Why:** `streamedText` accumula il documento completo (14 sezioni markdown). Se passato come `content` a `generatePosHtml`, veniva renderizzato come sezione 5 → duplicazione catastrofica del PDF
- Error view aggiornata: mostra "Scarica PDF parziale" solo se `editableRisks` è valorizzato (non `streamedText`)

### 15. cfCommittente e tipoAppalto mai nel PDF
- Aggiunti nelle sezioni 1 e 2.1 di pos-html-generator.js e pos-template.js
- `tipoAppalto` capitalizzato (pubblico → Pubblico)

### 16. Persona contacts mai nel PDF (ALTO IMPATTO CREDIBILITÀ)
- mapFormToBackend ora include: cseTel, cseEmail, cseCf, rsppTel, rsppEmail, rsppCf, rlsTel, medicoTel, primoSoccorsoTel, antincendioTel
- Sezione 3.2 "Recapiti figure di sicurezza" aggiunta in pos-html-generator.js e pos-template.js (tabella Nome/Telefono/Email)
- Vecchie 3.2→3.3 (Compiti), vecchie 3.3→3.4 (Subappaltatori)

### 17. Bottoni placeholder attivi senza funzione
- StepFigureSicurezza: "Compila con dati aziendali" → `disabled`
- StepOrganico: "Aggiungi dal database" + "Carica attestato" → `disabled`

### 18. Dead code rimosso
- `PersonaForm.indirizzo` rimosso (mai mostrato in form né usato in PDF)
- `POSFormData.suggestedLavorazioni` rimossa (campo mai assegnato né usato — si usa `lavorazioniSelezionate`)

## Regola: aggiungere campi form al mapping
**How to apply:** Ogni nuovo campo del form deve essere aggiunto a `mapFormToBackend` in POSGenerator.tsx E gestito nelle sezioni di pos-html-generator.js E pos-template.js. Non inviare mai `streamedText` come `content` al PDF endpoint.
