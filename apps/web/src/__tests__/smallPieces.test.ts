/**
 * «LOADING…», THE SEARCH BOX, THE FOCUS AND THE HOVER ARE THE APP'S (26 Sep
 * 2026, wave 5 of «tutte in fila»).
 *
 * Fifty-four «Loading…» written by hand, eight magnifiers placed by hand (one
 * of them over the text), fourteen fields lit on focus by a handler and a
 * dozen hovers written into the style by script. They are `Loading`,
 * `SearchBox`, the `.og-field:focus` rule and the `hover-*` classes. This
 * guard reads every file.
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

describe('small pieces', () => {
  it('«Loading…» is Loading (a list option or item says it inside its list)', () => {
    expect(filesWith(/<(p|div|span)\b[^>]*>\s*\{t\('common\.loading'\)\}\s*<\/\1>/)).toEqual(['components/ui/Loading.tsx'])
  })

  it('a magnifier inside a field is a SearchBox', () => {
    expect(filesWith(/🔍|<Search\b[^>]*position: 'absolute'/)).toEqual(['components/ui/SearchBox.tsx'])
  })

  it('no field lights up on focus by a handler: .og-field:focus does it for all', () => {
    expect(filesWith(/on(Focus|Blur)=\{[^}]*style\.borderColor/)).toEqual([])
  })

  it('a hover written into the style by script only where it depends on a state or a colour of the data', () => {
    expect(filesWith(/onMouseEnter=\{[^]*?style\.\w+\s*=/)).toEqual([
      'components/Button.tsx', // the primary's hover, only when its own background is in effect
      'components/ReportSectionBuilder.tsx', // a card of the report builder, tinted in brand
      'pages/analysis/WhatIfPage.tsx', // only once a CI is chosen
      'pages/changes/components/ChangeTypeModal.tsx', // a card, in its type's colour
      'pages/knowledge-base/KnowledgeBasePage.tsx', // a category tile, in its category's colour
      'pages/reports/ReportsPage.tsx', // a conversation, unless it is the open one
      'pages/topology/TopologyPage.tsx', // an option, unless it is the chosen one
      'pages/workflow/WorkflowListPage.tsx', // a workflow card, in its entity's colour
    ])
  })
})
