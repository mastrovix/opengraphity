/**
 * NESSUNA FRASE ITALIANA NEI TESTI CHE L'API COMPONE.
 *
 * Il guardiano di `systemTextLint.test.ts` guarda solo i letterali passati ai
 * punti che scrivono nei ticket (commenti, note, titoli). Il giro nel browser
 * del 14 set 2026 (#60) ha trovato frasi composte PRIMA, in una variabile o in
 * una tabella: il riepilogo del what-if, titoli e descrizioni delle anomalie,
 * le note della cronologia dei servizi, i messaggi d'errore sui tipi CI e sui
 * vocabolari, le risposte di Slack. Qui si guarda OGNI letterale del codice
 * dell'API che contenga una frase.
 *
 * La regola, la stessa del web: il testo che l'API compone è inglese (log,
 * metriche, integrazioni, `message` degli errori) e, quando lo legge una
 * persona, porta una chiave o passa da `systemText` con tutte le lingue.
 *
 * Fuori dal controllo, DICHIARATI qui:
 *  - i commenti e i nomi dei test (sono per chi scrive il codice);
 *  - le tabelle delle traduzioni (`systemText`, i testi dei PDF, le etichette
 *    per valore spedite): contengono l'italiano di proposito;
 *  - le descrizioni SDL (`schema*.ts`): documentazione dello schema;
 *  - le righe di log: diagnostica per chi gestisce l'installazione;
 *  - i prompt dei modelli (assistente, triage, report AI, post-incident,
 *    progettista dei moduli, progettista dei report):
 *    istruzioni al modello, che risponde nella lingua che gli si chiede;
 *  - il glossario dei termini inglesi: il motivo di ogni voce è documentazione
 *    per chi scrive, e non esce verso nessuno;
 *  - script e migrazioni.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const EXCLUDED_DIRS = new Set(['__tests__', 'scripts', 'migrations'])
const EXCLUDED_FILES = new Set([
  'lib/systemText.ts', 'lib/pdf/texts.ts', 'lib/enumValueLabels.ts',
  'services/assistantService.ts', 'services/triageService.ts', 'services/reportAgent.ts', 'services/postIncidentService.ts',
  // Il progettista dei moduli (19 set 2026): prompt di sistema e `description`
  // dello schema JSON sono istruzioni AL MODELLO, che poi scrive etichette e
  // spiegazioni nella lingua del cliente (gliela si chiede nel system).
  'services/formDesignerService.ts',
  // Il progettista dei report (19 set 2026): stessa ragione — prompt di
  // sistema e `description` dello schema JSON sono istruzioni al modello.
  'services/reportDesignerService.ts',
  /*
   * Il glossario dei termini che restano inglesi (20 set 2026, ondata 4).
   *
   * Ogni voce porta il MOTIVO per cui quel termine non si traduce, e il motivo
   * è in italiano perché è documentazione per chi un domani vorrà aggiungerne
   * uno: «esiste una voce di menu che si chiama così?». Non esce da nessuna
   * parte — l'unica cosa che il file compone è `rigaDelGlossario()`, che è
   * inglese e va nel prompt. Il motivo sta accanto al termine, e non in un
   * commento, perché aggiungere una parola senza dire perché resti impossibile.
   */
  'lib/glossarioModello.ts',
])

function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!EXCLUDED_DIRS.has(e.name)) files(p, out); continue }
    const rel = path.relative(SRC, p)
    if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts') || e.name.startsWith('schema') || EXCLUDED_FILES.has(rel)) continue
    out.push(p)
  }
  return out
}

/** Parole che in una frase inglese non compaiono ("non-empty" non conta: è inglese). */
const ITALIANO = /[àèéìòù]|\b(il|lo|gli|della|dello|delle|dalla|dal|nel|nella|resta|risolto|riaperto|allarme|allarmi|servizio|tempesta|chiusura|approvazione|richiesta|riassegnato|assegnato|creata|tornato|sorgente|impatta|rischio|dipendenti|nuove|nuova|nuovo|senza|rilevat\w*|errore|utente|articolo|passo|passi|valore|valori|trovat\w*|nessun\w*|componenti|aggiornat\w|regole|sincronizzazione|mappa|salute|valutazione|cliente|soglia|mai|apert[oiae]|fallit[oiae]|in corso|esclus[oiae]|a mano|ancora|questo|questa|sono|viene|vengono)\b|\bnon\b(?!-)/i
const LOG_CALL = /\b(logger|log|console|\w+Logger)\.(debug|info|warn|error|fatal|trace|log)\(/

/** Commenti via, lasciando le righe al loro posto (così i numeri di riga restano giusti). */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, (m, before: string) => before + ' '.repeat(m.length - before.length))
}

describe('i testi composti dall\'API non sono in italiano', () => {
  it('nessuna frase italiana nei letterali del codice (esclusioni dichiarate in testa)', () => {
    const offenders: string[] = []
    for (const file of files(SRC)) {
      const lines = withoutComments(fs.readFileSync(file, 'utf8')).split('\n')
      let depth = 0
      lines.forEach((line, i) => {
        // Una chiamata di log può andare a capo: si salta fino a parentesi chiusa.
        if (depth > 0 || LOG_CALL.test(line)) {
          depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length
          if (depth < 0) depth = 0
          return
        }
        for (const m of line.matchAll(/`([^`]*)`|'([^'\n]*)'|"([^"\n]*)"/g)) {
          const text = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ')
          if (text.length > 3 && /\s/.test(text.trim()) && ITALIANO.test(text)) {
            offenders.push(`${path.relative(SRC, file)}:${i + 1} «${text.trim().slice(0, 80)}»`)
          }
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
