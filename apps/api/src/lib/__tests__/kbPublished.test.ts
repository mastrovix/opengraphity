/**
 * Verifica «Cosa resta cablato», ondata 1: nessuna query riconosce un articolo
 * KB pubblicato dal NOME del passo. Vale la categoria (`kbArticlePublishedCypher`).
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { kbArticlePublishedCypher } from '../kbPublished.js'

const SRC = join(import.meta.dirname, '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'migrations' ? [] : sources(path)
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : []
  })
}

describe('articoli KB pubblicati', () => {
  it('il predicato guarda la categoria del passo corrente, non lo stato', () => {
    const cypher = kbArticlePublishedCypher('a')
    expect(cypher).toContain("(a)-[:HAS_WORKFLOW]->(:WorkflowInstance)-[:CURRENT_STEP]->(:WorkflowStep {category: 'published'})")
    expect(cypher).not.toMatch(/status/)
  })

  it("nessun sorgente dell'API filtra gli articoli su status = 'published'", () => {
    const offenders = sources(SRC)
      .filter((f) => /\.status\s*(=|<>)\s*'published'/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
    expect(offenders).toEqual([])
  })
})
