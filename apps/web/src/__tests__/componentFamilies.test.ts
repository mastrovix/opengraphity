/**
 * DIALOGS, TABS, SWITCHES, CHIPS, TILES AND BADGES ARE THE APP'S (26 Sep
 * 2026, wave 4 of «tutte in fila»).
 *
 * Each of these had copies drawn page by page: four overlays of their own, six
 * rows of tabs, two switches, some twenty pills that turn on and off, three
 * pages of tiles, sixty-nine coloured spans. They are `Modal`, `Tabs`,
 * `Toggle`, `Chip`, `StatTile` and `Pill`. This guard reads every file.
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
const rel = (f: string) => path.relative(SRC, f)
const filesWith = (re: RegExp) => tsx().filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map(rel).sort()

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

describe('component families', () => {
  it('a dialog is a Modal: only it draws the veil', () => {
    expect(filesWith(/alpha\.scrim/)).toEqual(['components/Modal.tsx'])
  })

  it('a row of tabs is Tabs (the builder\'s canvas/preview switch is a segmented control)', () => {
    expect(filesWith(/\srole="tab"/)).toEqual(['components/ui/Tabs.tsx', 'pages/settings/catalogForm/FormBuilderPanel.tsx'])
  })

  it('a switch is a Toggle', () => {
    expect(filesWith(/\srole="switch"/)).toEqual(['components/ui/Toggle.tsx'])
  })

  it('a pill that turns on and off is a Chip', () => {
    const found = tsx().filter((f) => {
      const s = fs.readFileSync(f, 'utf8')
      return [...s.matchAll(/<button\b/g)].some((m) => {
        const tag = openingTag(s, m.index)
        return /aria-pressed/.test(tag) && /borderRadius:\s*(999|100|20)\b/.test(tag)
      })
    }).map(rel)
    expect(found).toEqual(['components/ui/Chip.tsx'])
  })

  it('a tile with a number is a StatTile: no page draws its own', () => {
    expect(filesWith(/function \w*Tile\b[^]*?fontSize: 28/)).toEqual(['components/ui/StatTile.tsx'])
  })

  it('a coloured label is a Pill, but the two that keep their own drawing', () => {
    const badge = /<span\b[^>]*style=\{\{[^}]*padding: '[0-3]px (4|5|6|7|8|10)px'[^}]*borderRadius[^}]*(background|backgroundColor): (?!'none'|'transparent')/
    expect(filesWith(badge)).toEqual([
      // A CI's status in a ticket: its colour is checked as a background colour, which Pill does not set.
      'components/ticket/AffectedCIList.tsx',
      // The component itself.
      'components/ui/Pill.tsx',
      // A tab's count: its accessible name reads «Beta3» with an inline span, the way the tests pin it.
      'components/ui/Tabs.tsx',
    ])
  })
})
