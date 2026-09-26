/**
 * EVERY ROW THAT OPENS SOMETHING LOOKS THE SAME (26 Sep 2026, the owner:
 * «alcune tabelle quando passi sulle righe hanno un bordino colorato, ma non
 * tutte»).
 *
 * The stripe on hover lived in SortableFilterTable only; the hand-made tables
 * had a grey background or nothing. Now the stripe is one class, `row-opens`,
 * given by SortableFilterTable and SimpleTable when a row opens, and by
 * `rowOpens` (components/ui/RowLink.tsx) to a hand-made row. This guard reads
 * every page: a <tr> with its own onClick is a regression.
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

function openingTag(source: string, start: number): string {
  let depth = 0
  for (let j = start + 1; j < source.length; j++) {
    const c = source[j]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0 && source[j - 1] !== '=') return source.slice(start, j)
  }
  return source.slice(start)
}

/** Lines of the <tr> that open something on click without the common stripe. */
export function rowsWithOwnClick(source: string): number[] {
  const lines: number[] = []
  for (const m of source.matchAll(/<tr\b/g)) {
    const tag = openingTag(source, m.index)
    if (/onClick=/.test(tag) && !/row-opens|rowOpens\(/.test(tag)) lines.push(source.slice(0, m.index).split('\n').length)
  }
  return lines
}

describe('rows that open something', () => {
  it('the scan sees a row with its own click, and not one built with rowOpens', () => {
    expect(rowsWithOwnClick(`<tr onClick={() => go()} className="hover-bg">`)).toEqual([1])
    expect(rowsWithOwnClick(`<tr {...rowOpens(() => go())}>`)).toEqual([])
  })

  it('no row of the app has its own click', () => {
    const found = tsx().flatMap((f) => rowsWithOwnClick(fs.readFileSync(f, 'utf8')).map((l) => `${path.relative(SRC, f)}:${String(l)}`))
    expect(found).toEqual([])
  })

  it('the stripe is one rule, on .row-opens', () => {
    const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8')
    expect(css).toMatch(/\.row-opens:hover > td:first-child \{\s*box-shadow: inset 8px 0 0 var\(--color-icon-accent\);/)
    expect(css).not.toMatch(/\.sft-row:hover/)
  })
})
