/**
 * NESSUN TESTO ITALIANO SCRITTO A MANO DENTRO I TICKET.
 *
 * Commenti automatici, note delle transizioni, cause di risoluzione e titoli
 * degli incident creati dal prodotto sono dati salvati: il browser non li
 * traduce. Stanno in `lib/systemText.ts`, con tutte le lingue. Questo test
 * scorre l'API e rifiuta un letterale con parole italiane passato a uno di
 * quei punti (giro del 14 set 2026: «Evento di monitoraggio…», «Riassegnato
 * al team…», «Allarme correlato…» con il prodotto in inglese).
 *
 * Fuori dal controllo: i cinquanta moduli del tenant di prova
 * (`lib/testData/demoTenant/catalogContent.ts`). Lì l'italiano è il DATO di
 * un modulo — ogni campo porta la sua etichetta in inglese e in italiano,
 * perché chi compila il modulo lo vede nella propria lingua — e non un testo
 * che il prodotto scrive dentro un ticket.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!['__tests__', 'scripts', 'migrations'].includes(e.name)) files(p, out); continue }
    if (e.name === 'catalogContent.ts') continue
    if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/** Parole che in un testo inglese non compaiono: bastano a riconoscere una frase italiana. */
const ITALIANO = /\b(il|lo|la|gli|della|dello|delle|dalla|dal|nel|nella|è|non|resta|risolto|riaperto|allarme|allarmi|servizio|tempesta|passaggio|chiusura|approvazione|richiesta|evasa|riassegnato|assegnato|creata|tornato|sorgente)\b/i
/** I punti in cui un testo finisce salvato nel ticket. */
const PUNTI = /(addIncidentComment\(|resolveIncident\(|createTransitionComment\(|\bnotes:\s|\btitle:\s|reopenIncident\()/

describe('i testi scritti nei ticket passano da systemText', () => {
  it('nessun letterale italiano passato a commenti, note, cause o titoli', () => {
    const colpevoli: string[] = []
    for (const file of [...files(path.join(SRC, 'services')), ...files(path.join(SRC, 'graphql')), ...files(path.join(SRC, 'lib'))]) {
      const righe = fs.readFileSync(file, 'utf8').split('\n')
      righe.forEach((riga, i) => {
        if (riga.trim().startsWith('//') || riga.trim().startsWith('*')) return
        // Il punto può stare sulla riga prima (argomento a capo).
        const contesto = `${righe[i - 1] ?? ''}\n${riga}`
        if (!PUNTI.test(contesto)) return
        for (const m of riga.matchAll(/`([^`]*)`|'([^']*)'/g)) {
          const testo = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ')
          if (ITALIANO.test(testo)) colpevoli.push(`${path.relative(SRC, file)}:${i + 1} «${testo.trim().slice(0, 70)}»`)
        }
      })
    }
    expect(colpevoli).toEqual([])
  })
})
