/**
 * EVERY FIELD IS THE APP'S FIELD (26 Sep 2026, wave 2 of «tutte in fila»).
 *
 * 157 inputs, selects and textareas drew their own box, from 17 copies of the
 * same style (`inputBase`, `inputStyle`, `selectStyle`, `INP`, `SEL`…) that
 * had drifted apart: radius 5 or 6, border strong or light, a disabled field
 * grey here and white there. They are `Input` / `Select` / `Textarea`. A raw
 * one is right only when it is not a boxed field: a borderless box inside
 * another box, or a trick input nobody sees. This guard reads every file.
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

/** Lines of the raw text fields: inputs (not checkbox, radio, file, hidden, colour, range), selects, textareas. */
export function rawFields(source: string): number[] {
  const lines: number[] = []
  for (const m of source.matchAll(/<(input|select|textarea)\b/g)) {
    if (source[m.index - 1] === '`') continue // named in a comment
    const tag = openingTag(source, m.index)
    if (m[1] === 'input' && /type="(checkbox|radio|file|hidden|color|range)"/.test(tag)) continue
    lines.push(source.slice(0, m.index).split('\n').length)
  }
  return lines
}

/** Raw fields on purpose, and why. */
const ALLOWED: Record<string, string> = {
  'components/ui/FormControls.tsx': 'the fields themselves',
  'components/layout/GlobalSearch.tsx': 'the search of the top bar: borderless, inside its box',
  'pages/reports/ReportScheduleSettings.tsx': 'the recipient being typed, borderless among the recipient chips',
  'pages/settings/SyncSourcesTab.tsx': 'an invisible input that makes the file choice required',
  'pages/topology/TopologyPage.tsx': 'the search of the map, borderless inside its box',
}

describe('hand-made fields', () => {
  it('the scan sees a raw field, and not a checkbox', () => {
    expect(rawFields(`<input type="text" value={v} />`)).toEqual([1])
    expect(rawFields(`<select value={v}><option /></select>`)).toEqual([1])
    expect(rawFields(`<input type="checkbox" checked={v} />`)).toEqual([])
  })

  it('no raw text field, but the few on purpose', () => {
    const found = tsx().filter((f) => rawFields(fs.readFileSync(f, 'utf8')).length > 0).map((f) => path.relative(SRC, f)).sort()
    expect(found).toEqual(Object.keys(ALLOWED).sort())
  })
})
