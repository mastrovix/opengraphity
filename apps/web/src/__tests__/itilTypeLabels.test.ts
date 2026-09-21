/**
 * Revisione del 14 set 2026 · F16: le etichette dei tipi ITIL vengono dal
 * metamodello (`useItilTypeLabels`), non da tabelle scritte nelle pagine. Un
 * tipo rinominato dal cliente nel designer restava col nome di fabbrica in sei
 * posti. Questo guardiano impedisce che una tabella torni.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(process.cwd(), 'src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === '__tests__' || name === 'i18n' || name === 'test' ? [] : sources(p)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

describe('etichette dei tipi ITIL', () => {
  it('nessuna pagina scrive a mano il nome di un tipo ITIL come etichetta', () => {
    const offenders: string[] = []
    const pattern = /label:\s*'(Incident|Problem|Change|Service Request)'|return\s+'(Incident|Problem|Change|Service Request)'|(incident|problem|change|service_request):\s*'(Incident|Problem|Change|Service Request)'/
    for (const file of sources(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => { if (pattern.test(line)) offenders.push(`${relative(SRC, file)}:${i + 1}`) })
    }
    expect(offenders, 'Usa useItilTypeLabels(): il cliente può rinominare i tipi ITIL.').toEqual([])
  })
})
