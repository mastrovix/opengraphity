/**
 * LE TESTATE DI TABELLA HANNO UNO STILE SOLO, e lo decide index.css.
 *
 * Erano tre stili e ventitre varianti scritte a mano. Nessun test lo vedeva
 * perche ogni tabella era corretta da se: sbagliata era la DIFFERENZA. La
 * regola adesso sta in `table thead th { … !important }`, e questo test tiene
 * ferme le due meta: che la regola esista, e che nessuna tabella la contraddica
 * con uno stile in linea — che con `!important` sarebbe codice morto, e senza
 * sarebbe il difetto di prima.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function tsx(dir = SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'test') tsx(p, out); continue }
    if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

/** Le proprieta che la testata non puo avere in linea: le decide index.css. */
const DELLA_REGOLA = ['background', 'backgroundColor', 'color', 'fontSize', 'fontWeight', 'textTransform', 'letterSpacing', 'borderBottom']

describe('testate di tabella: uno stile solo', () => {
  it('index.css impone tinta, corpo, peso, maiuscole, spaziatura e colore a ogni testata', () => {
    const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8')
    const regola = /table thead th \{([^}]*)\}/.exec(css)?.[1] ?? ''
    for (const decl of ['background:', 'border-bottom:', 'font-size:', 'font-weight:', 'text-transform:', 'letter-spacing:', 'color:']) {
      const riga = regola.split('\n').find((r) => r.trim().startsWith(decl)) ?? ''
      expect(riga, `manca ${decl} nella regola delle testate`).toContain('!important')
    }
  })

  it('nessuna tabella contraddice la regola con uno stile in linea nella testata', () => {
    const fuoriRiga: string[] = []
    for (const file of tsx()) {
      const rel = path.relative(SRC, file)
      // La tabella ordinabile applica gia gli stessi valori: e la sorgente da cui la regola e nata.
      if (rel === 'components/SortableFilterTable.tsx') continue
      const src = fs.readFileSync(file, 'utf8')
      for (const blocco of src.matchAll(/<thead\b[\s\S]*?<\/thead>/g)) {
        for (const tag of blocco[0].matchAll(/<(th|tr)\b[^>]*?style=\{\{([\s\S]*?)\}\}/g)) {
          const chiavi = [...tag[2]!.matchAll(/(?:^|[\s,{])([A-Za-z]+)\s*:/g)].map((m) => m[1]!)
          const vietate = chiavi.filter((k) => DELLA_REGOLA.includes(k))
          if (vietate.length > 0) fuoriRiga.push(`${rel}: <${tag[1]}> ${vietate.join(', ')}`)
        }
      }
    }
    expect(fuoriRiga, 'Queste testate hanno uno stile in linea che la regola di index.css decide gia').toEqual([])
  })
})
