/**
 * NO VARIABLE-LENGTH PATH IS COLLECTED TO KEEP ONE (review of 23 Sep 2026).
 *
 * What-if, impact, blast radius and the change's impacted CIs matched every
 * path up to 5 or 10 hops and collected them per CI only to keep the shortest:
 * on diamonds and two-way links the number of paths grows exponentially with
 * the depth. The way that holds is the incident's (B-34): the candidates with
 * DISTINCT (the planner prunes), then one `shortestPath` each. This keeps the
 * other way out of the sources.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dirname, '..')

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== '__tests__') sources(p, out); continue }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe('variable-length paths', () => {
  it('none is collected, or measured for its minimum, over every path', () => {
    const offenders = sources(SRC).flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return [/collect\(\s*path\s*\)/g, /min\(\s*length\(\s*path\s*\)\s*\)/g, /collect\(\s*p\s*\)\s*\[0\]/g]
        .flatMap((re) => [...text.matchAll(re)].map((m) => `${relative(SRC, file)}:${text.slice(0, m.index).split('\n').length}`))
    })
    expect(offenders, 'candidates with DISTINCT, then shortestPath per candidate (see incident.ts, B-34)').toEqual([])
  })
})
