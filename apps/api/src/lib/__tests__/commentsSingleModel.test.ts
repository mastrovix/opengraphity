/**
 * Revisione del 14 set 2026 · F1: un modello solo per i commenti dei ticket.
 *
 * Il guardiano statico: nessun sorgente dell'API crea più nodi `EntityComment`
 * o `ProblemComment`, e ogni `CREATE (…:Comment {…})` scrive `is_internal`. Un
 * commento senza la proprietà non arriverebbe mai al portale (che mostra solo
 * `is_internal = false`), e nessuno saprebbe perché.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../../', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'migrations' ? [] : sources(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

describe('commenti dei ticket — un modello solo', () => {
  const files = sources(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }))

  it('nessuno crea EntityComment o ProblemComment', () => {
    const offenders = files.filter((f) => /CREATE\s*\(\s*\w*\s*:\s*(EntityComment|ProblemComment)\b/.test(f.text)).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('ogni CREATE di un Comment scrive is_internal', () => {
    const offenders: string[] = []
    for (const f of files) {
      for (const m of f.text.matchAll(/CREATE\s*\(\s*\w*\s*:\s*Comment\s*\{([\s\S]*?)\}\s*\)/g)) {
        if (!/\bis_internal\s*:/.test(m[1]!)) offenders.push(`${f.path}: ${m[0].slice(0, 60).replace(/\s+/g, ' ')}`)
      }
    }
    expect(offenders).toEqual([])
    expect(files.some((f) => f.text.includes('CREATE (c:Comment {'))).toBe(true)
  })
})
