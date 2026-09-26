/**
 * EVERY BUTTON IS THE APP'S BUTTON (26 Sep 2026, the owner: «ci sono altri
 * componenti scritti a mano che possono essere fattorizzati?» → «tutte in
 * fila», wave 1).
 *
 * About 160 buttons drew themselves: their own padding, colours, radius and
 * hover. When the buttons got a size smaller, only the `<Button>` ones did.
 * A raw <button> is still right for what is not a button to the eye: a chip
 * that is on or off (`aria-pressed`, round), a segment whose colour follows a
 * state, a card, a row, an icon, a link-like text. This guard reads every file
 * and flags a raw <button> dressed as a primary, secondary or danger button.
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

/** Lines of the raw <button> dressed as a Button. */
export function buttonsDressedByHand(source: string): number[] {
  const lines: number[] = []
  for (const m of source.matchAll(/<button\b/g)) {
    const tag = openingTag(source, m.index)
    const style = /style=\{([\s\S]*)\}/.exec(tag)?.[1] ?? ''
    if (/aria-pressed|role=/.test(tag)) continue
    if (/borderRadius:\s*(999|100|18|16|20|12)\b/.test(style)) continue
    if (/background(Color)?:[^,}]*\?/.test(style)) continue
    if (/flexDirection:\s*'column'/.test(style) || (/\bwidth:\s*\d/.test(style) && /\bheight:\s*\d/.test(style))) continue
    const constant = /\b(btnPrimary|btnSecondary|btnDanger|btnGhost)\b/.test(style)
    const primary = /background(Color)?:\s*(colors\.brand\b|'var\(--color-brand\)'|'var\(--accent\)')/.test(style) && /padding:/.test(style)
    const secondary = /border:\s*[`']1px solid/.test(style) && /padding:\s*'\d+px \d+px'/.test(style)
    if (constant || primary || secondary) lines.push(source.slice(0, m.index).split('\n').length)
  }
  return lines
}

/** Raw buttons that look like buttons on purpose, and why. */
const ALLOWED: Record<string, string> = {
  'components/WatcherBar.tsx': 'the watchers count: a badge that opens the list',
  'pages/knowledge-base/KnowledgeBasePage.tsx': 'the ✕ that clears the search, inside the box',
  'components/ReportSectionBuilder.tsx': 'the section kinds, as cards',
}

describe('hand-made buttons', () => {
  it('the scan sees a button dressed by hand, and not a chip', () => {
    expect(buttonsDressedByHand(`<button type="button" style={{ padding: '6px 14px', border: '1px solid var(--border)' }}>Save</button>`)).toEqual([1])
    expect(buttonsDressedByHand(`<button style={{ ...btnPrimary }}>Save</button>`)).toEqual([1])
    expect(buttonsDressedByHand(`<button aria-pressed={on} style={{ padding: '4px 10px', border: '1px solid red', borderRadius: 999 }}>x</button>`)).toEqual([])
  })

  it('no raw <button> is dressed as a Button, but the few on purpose', () => {
    const found = [...new Set(tsx().filter((f) => buttonsDressedByHand(fs.readFileSync(f, 'utf8')).length > 0).map((f) => path.relative(SRC, f)))].sort()
    expect(found).toEqual(Object.keys(ALLOWED).sort())
  })
})
