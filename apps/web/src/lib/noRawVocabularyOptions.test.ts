/**
 * Secondo giro UI del 15 set 2026 · V-18 (e V-21): tendine che offrivano i
 * valori interni di un vocabolario («low / medium / high», «production», «dr»)
 * invece delle etichette del Dizionario. Una `<option>` il cui testo è il suo
 * stesso valore è quasi sempre questo difetto: qui non ce ne sono.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '..')

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'i18n') sources(p, out); continue }
    if (e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx')) out.push(p)
  }
  return out
}

describe('nessuna tendina con il valore interno come testo', () => {
  it('nessun `<option key={x} value={x}>{x}</option>` su impatti, urgenze, ambienti, stati o valori enum', () => {
    const offenders: string[] = []
    for (const file of sources(SRC)) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        // Solo le liste che vengono da un vocabolario: impatti, urgenze, ambienti, stati, valori enum.
        if (/(impacts|urgencies|environments|statuses|enumValues)[^<]*<option key=\{(\w+)\} value=\{\2\}>\{\2\}<\/option>/.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
