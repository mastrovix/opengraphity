/**
 * Mai `.toNumber()` su un valore che può essere già un numero (giro nel browser
 * del 14 set 2026).
 *
 * Dal vivo: l'analisi AI rispondeva «countRec?.get(...)?.toNumber is not a
 * function». Il driver restituisce un `number` JavaScript per i conteggi, e il
 * contesto dello schema del report agent chiamava `.toNumber()` alla cieca —
 * su ogni cliente, nascosto finché la pagina falliva prima per il 401.
 *
 * La conversione giusta è `toNumber` di `@opengraphity/neo4j`, che accetta
 * Integer, number, bigint e stringhe numeriche. Il guardiano ammette una
 * chiamata diretta a `.toNumber()` solo se la stessa riga o quella prima
 * controllano il tipo (`typeof`, `isInt`, `'toNumber' in`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (['__tests__', 'node_modules', 'dist', 'scripts'].includes(name)) continue
      walk(full, out)
    } else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('conversioni degli interi Neo4j', () => {
  it('ogni .toNumber() diretto è protetto da un controllo del tipo', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/\)\??\.toNumber\(\)/.test(line)) return
        if (/^\s*(\/\/|\*)/.test(line)) return
        const context = `${lines[i - 1] ?? ''}\n${line}`
        if (/typeof |isInt\(|'toNumber' in|neo4jInt\.is/.test(context)) return
        offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
