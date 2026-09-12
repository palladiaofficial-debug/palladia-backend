# Registro delle Attività di Trattamento — dati dei lavoratori trattati dall'assistente IA (Ladia)

> **BOZZA DI LAVORO — non ancora validata da un consulente del lavoro o
> avvocato giuslavorista/DPO.** Non costituisce consulenza legale. Da
> rivedere con un professionista prima di essere usata come base per un
> adempimento formale verso il Garante Privacy o un ispettore.
> Creata: 2026-09-12, in seguito a F-176/F-177 (AUDIT.md).

Questo documento integra il registro dei trattamenti generale della
piattaforma (art. 30 GDPR) con la sezione specifica del trattamento dati
lavoratori tramite l'assistente IA Ladia — l'unico punto in cui dati dei
lavoratori lasciano l'infrastruttura Palladia/Supabase per raggiungere un
sub-responsabile esterno (Anthropic).

---

## 1. Titolare e sub-responsabile

- **Titolare del trattamento**: l'azienda cliente che usa Palladia (datore di
  lavoro dei lavoratori i cui dati sono trattati).
- **Responsabile del trattamento**: Palladia S.r.l. (fornitore della
  piattaforma).
- **Sub-responsabile**: Anthropic PBC, fornitore del modello IA (Claude) che
  elabora le richieste testuali di Ladia. Il trattamento verso Anthropic
  avviene nell'ambito dei Commercial Terms of Service di Anthropic, che
  incorporano automaticamente il loro Data Processing Addendum (DPA) —
  verificato il 2026-09-12 sui documenti pubblici:
  - [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms)
  - [Data Processing Addendum](https://www.anthropic.com/legal/data-processing-addendum)
  - [Elenco sub-processor](https://www.anthropic.com/subprocessors)

  Il DPA include le Clausole Contrattuali Standard UE (Module Two/Three) per
  il trasferimento extra-UE, e i Commercial Terms dichiarano esplicitamente
  che Anthropic non addestra modelli sui dati dei clienti API. **Azione
  raccomandata, non ancora fatta**: scaricare e archiviare una copia datata
  del DPA e della lista sub-processor, da esibire in caso di controllo (i
  documenti pubblici possono cambiare nel tempo).

## 2. Finalità del trattamento

Ladia è un assistente conversazionale che risponde a domande in linguaggio
naturale su cantieri, lavoratori, documenti e compliance (D.Lgs. 81/2008),
e può eseguire scritture (creazione/aggiornamento record) su richiesta
esplicita dell'utente. Per rispondere, Ladia interroga il database
dell'azienda e passa i risultati al modello Anthropic come contesto della
conversazione.

## 3. Categorie di dati dei lavoratori trattate dall'IA

**Dopo F-173/F-174 (11/9/2026) e F-176 (12/9/2026)**, i dati mandati ad
Anthropic sono ridotti al minimo necessario:

| Dato | Mandato in chiaro all'IA? | Note |
|---|---|---|
| Nome e cognome | **No** — sostituito da un codice pseudonimo stabile (`LAV-XXXXXX`) | F-176. Il nome reale non lascia mai l'infrastruttura Palladia. |
| Identificativo interno (UUID) | **No** — sostituito dallo stesso codice | F-176 |
| Codice fiscale | **No** — rimosso dai tool che lo includevano | F-173 |
| Data/luogo di nascita | **No** — rimossi | F-173/F-174 |
| Foto, tariffa oraria, credenziale badge digitale | **No** — rimossi dai risultati generici di scrittura | F-174 |
| Ruolo, qualifica, scadenze formazione/idoneità (stato sì/no, date) | **Sì** — necessario per rispondere a domande di compliance | Associato solo al codice pseudonimo, mai al nome |
| Testo scritto liberamente dall'utente umano (es. "quante ore ha fatto Mario Rossi?") | **Sì, invariato** | Ambito deciso esplicitamente (2026-09-12): non si tenta di rilevare/sostituire nomi nel linguaggio libero scritto da una persona — rischio di falsi negativi che darebbero un falso senso di sicurezza superiore al beneficio |

Il codice pseudonimo (`workers.ai_pseudonym_code`) è generato automaticamente
alla creazione di ogni lavoratore (DB, migrazione 202/204) e non è mai esso
stesso mandato all'IA senza che la mappa codice↔identità resti esclusivamente
nel database Palladia, protetto dalla stessa autenticazione/autorizzazione di
ogni altro dato aziendale — soddisfa la definizione di pseudonimizzazione
dell'art. 4(5) GDPR ("i dati personali non possono più essere attribuiti a
un interessato specifico senza il ricorso a informazioni aggiuntive").

## 4. Misure tecniche di sicurezza applicate

1. **Pseudonimizzazione** (F-176) — vedi sopra.
2. **Minimizzazione dei dati** (F-173/F-174) — solo i campi necessari alla
   funzione del tool, mai l'intera riga della tabella.
3. **Cache del prompt lato Anthropic** (TTL 1 ora) — riduce la quantità di
   dati ritrasmessi ad ogni turno, non solo un risparmio di costo.
4. **Rate limiting** — 30 messaggi/minuto per utente, 20/minuto per azienda —
   limita il volume di dati che può transitare in un intervallo di tempo.
5. **Registro tecnico** (F-177, tabella `ladia_ai_pseudonym_log`) — una riga
   per ogni turno di chat che ha coinvolto almeno un lavoratore, con il
   conteggio di quanti lavoratori distinti sono stati coinvolti — prova
   consultabile che la pseudonimizzazione è stata applicata realmente, non
   solo "il codice dice che dovrebbe". Non contiene nomi/id, solo un
   conteggio, per non diventare esso stesso un canale di dati personali.

## 5. Conservazione

- **Lato Anthropic**: log delle richieste API conservati 7 giorni (ridotto da
  30 giorni il 2025-09-14, verificato sui documenti pubblici Anthropic al
  2026-09-12) — dati già pseudonimizzati per quanto riguarda i lavoratori.
- **Lato Palladia**: la cronologia delle conversazioni (`chat_messages`) e il
  registro tecnico (`ladia_ai_pseudonym_log`) seguono la stessa policy di
  conservazione del resto della piattaforma — nessuna cancellazione
  automatica specifica per questo trattamento al 2026-09-12.

## 6. Diritti dell'interessato

Un lavoratore può esercitare i diritti di accesso, rettifica, portabilità e
reclamo al Garante Privacy (artt. 15-22 GDPR) rivolgendosi al proprio datore
di lavoro (titolare del trattamento), che a sua volta può richiedere a
Palladia l'estrazione dei dati trattati. Il codice pseudonimo non impedisce
l'esercizio di questi diritti: la mappa codice↔identità resta sempre
disponibile al titolare tramite la piattaforma.

## 7. Collegamenti

- [`gps-badge-art4-statuto-lavoratori.md`](./gps-badge-art4-statuto-lavoratori.md) — informativa specifica su geolocalizzazione/badge, trattamento distinto da questo (non coinvolge l'IA).
- `AUDIT.md` — F-173, F-174, F-175, F-176, F-177 per la cronologia tecnica completa di questo trattamento.
