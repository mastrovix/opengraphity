/**
 * UNA BOZZA SI RISCRIVE DA `prev`, NON DALLA CHIUSURA.
 *
 * Il difetto (trovato nel browser su c-test, ondata 8 dei moduli): scegliere
 * il campo di «Imposta campo» in una business rule non aveva effetto — la
 * tendina tornava vuota e l'azione non era configurabile. La causa non era
 * nella tendina: `ActionParamsEditor` fa DUE modifiche nello stesso gesto,
 *
 *     onChange('field', e.target.value); onChange('value', '')
 *
 * e gli aiutanti della pagina calcolavano il patch dalla bozza della
 * chiusura (`draft.actions.map(…)`). Due patch costruiti sulla STESSA bozza
 * vecchia non si sommano: vince il secondo, e il campo appena scelto sparisce
 * con lui. React non avvisa, e nessun test lo vedeva perché ogni chiamata,
 * presa da sola, è giusta: sbagliata era la COPPIA.
 *
 * La regola: quando un aiutante RICOSTRUISCE una lista della bozza (map,
 * filter, o uno spread), deve leggerla dallo stato precedente —
 * `setDraft((prev) => …)`. Leggere un singolo valore per decidere resta
 * ammesso: non ricostruisce niente.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sorgenti(dir = SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'test') sorgenti(p, out); continue }
    if ((e.name.endsWith('.tsx') || e.name.endsWith('.ts')) && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

/**
 * I due modi di ricostruire una lista dentro un patch: `patch({ x: draft.x.map(…) })`
 * e `patch({ x: [...draft.x, …] })`. Il nome della bozza è `draft` o `form`
 * (le pagine la ribattezzano quando la leggono da `useCrudModal`).
 */
const RICOSTRUZIONI = [
  /patch\(\{[^}]*\b(?:draft|form)\.[A-Za-z_$]+\s*\.\s*(?:map|filter|slice|concat)\s*\(/,
  /patch\(\{[^}]*\[\s*\.\.\.\s*(?:draft|form)\.[A-Za-z_$]+/,
]

describe('la bozza si riscrive da prev', () => {
  it('nessun patch ricostruisce una lista leggendola dalla chiusura', () => {
    const colpevoli: string[] = []
    for (const file of sorgenti()) {
      const testo = fs.readFileSync(file, 'utf8')
      testo.split('\n').forEach((riga, i) => {
        if (RICOSTRUZIONI.some((r) => r.test(riga))) {
          colpevoli.push(`${path.relative(SRC, file)}:${i + 1}`)
        }
      })
    }
    expect(colpevoli, `usa setDraft((prev) => …): un secondo patch nello stesso gesto annullerebbe il primo\n${colpevoli.join('\n')}`).toEqual([])
  })

  it('le due pagine delle automazioni riscrivono azioni e condizioni da prev', () => {
    for (const pagina of ['pages/admin/BusinessRulesPage.tsx', 'pages/admin/AutoTriggersPage.tsx']) {
      const testo = fs.readFileSync(path.join(SRC, pagina), 'utf8')
      // La dichiarazione può andare a capo: si leggono due righe insieme.
      const righe = testo.split('\n')
      const i = righe.findIndex((r) => r.includes('setActionParam = '))
      const riga = `${righe[i] ?? ''}${righe[i + 1] ?? ''}`
      expect(riga, `${pagina}: setActionParam deve partire da prev`).toContain('prev')
      expect(riga, `${pagina}: setActionParam deve leggere le azioni da prev`).toContain('prev.actions')
    }
  })
})
