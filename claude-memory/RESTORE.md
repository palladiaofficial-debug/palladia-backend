# Come ripristinare Claude con memoria completa su un nuovo PC

## Scenario
Hai comprato un nuovo PC e vuoi ricominciare a lavorare con Claude su Palladia
esattamente da dove avevi lasciato, come se nulla fosse successo.

---

## Step 1 — Installa gli strumenti

1. Installa **Node.js** → https://nodejs.org (versione LTS)
2. Installa **Git** → https://git-scm.com
3. Installa **Claude Code** (il terminale AI):
   ```
   npm install -g @anthropic/claude-code
   ```

---

## Step 2 — Scarica il codice da GitHub

Apri il terminale e lancia questi comandi:

```bash
# Crea la cartella di lavoro sul Desktop
cd Desktop

# Clona il backend
git clone https://github.com/palladiaofficial-debug/palladia-backend.git

# Clona il frontend
mkdir PALLADIA && cd PALLADIA && mkdir palladia-main && cd palladia-main
git clone https://github.com/palladiaofficial-debug/palladia.git palladia-main
cd ../..
```

---

## Step 3 — Ripristina la memoria di Claude

Questo è il passaggio chiave. Copia i file di memoria nella cartella giusta:

**Su Windows:**
```bash
# Crea la cartella memoria (adatta il percorso al tuo username)
mkdir -p "%USERPROFILE%\.claude\projects\C--Users-TUO_USERNAME-Desktop-palladia-backend\memory"

# Copia i file
copy "Desktop\palladia-backend\claude-memory\MEMORY.md" "%USERPROFILE%\.claude\projects\C--Users-TUO_USERNAME-Desktop-palladia-backend\memory\MEMORY.md"
copy "Desktop\palladia-backend\claude-memory\project_pos_fixes_2026_03_20.md" "%USERPROFILE%\.claude\projects\C--Users-TUO_USERNAME-Desktop-palladia-backend\memory\project_pos_fixes_2026_03_20.md"
```

> **Nota**: sostituisci `TUO_USERNAME` con il tuo nome utente Windows
> (es. se il percorso è `C:\Users\mario`, scrivi `mario` al posto di `TUO_USERNAME`)

---

## Step 4 — Ricrea il file .env (le chiavi segrete)

Le chiavi segrete NON sono su GitHub per sicurezza. Le trovi su:
- **Railway** → dashboard del progetto → Variables (per il backend)
- **Vercel** → Settings → Environment Variables (per il frontend)

Crea il file `.env` nella cartella `palladia-backend/` copiando le variabili da Railway.

---

## Step 5 — Avvia Claude Code

```bash
cd Desktop/palladia-backend
claude
```

Claude riconoscerà automaticamente il progetto e avrà tutta la memoria del lavoro
precedente. Puoi riprendere esattamente da dove avevi lasciato.

---

## Cosa contiene questa cartella

| File | Contenuto |
|------|-----------|
| `MEMORY.md` | Memoria principale: architettura, regole PDF, auth flow, schema DB, billing |
| `project_pos_fixes_2026_03_20.md` | Dettaglio di tutti i fix al generatore POS |
| `RESTORE.md` | Questo file — istruzioni di ripristino |

---

## Repository GitHub

| Repo | URL | Contenuto |
|------|-----|-----------|
| Backend | github.com/palladiaofficial-debug/palladia-backend | Server Express + Node.js |
| Frontend | github.com/palladiaofficial-debug/palladia | App React + TypeScript |

---

*Aggiornato: 21 marzo 2026*
