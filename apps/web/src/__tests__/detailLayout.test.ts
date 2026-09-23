/**
 * THE TWO COLUMNS OF A DETAIL PAGE ARE ONE RULE, NOT ONE GRID PER PAGE
 * (D9, tour of 23 Sep 2026).
 *
 * The incident detail wrote `gridTemplateColumns: '1fr 340px'`. A `1fr` track
 * has an automatic minimum — the widest thing in it — so the monitoring alarms
 * table pushed the main column to ~700px, and at a 1297px window with the
 * sidebar open the side column (workflow history, similar incidents) went 45px
 * out of the page, cut off. Problem, request and change-task pages had the
 * same grid with another number.
 *
 * The fix is `DetailLayout` (components/ui) and its `.og-detail` class. This
 * guardian keeps it that way: a page that declares a two-column grid with one
 * fluid and one fixed track, in either order, fails here — it should use the
 * component, whose fluid column is `minmax(0, 1fr)`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8')

function tsx(dir = SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'test') tsx(p, out); continue }
    if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) out.push(p)
  }
  return out
}
const rel = (p: string) => path.relative(SRC, p)

/** A fluid track: `1fr`, or `minmax(0, 1fr)` / `minmax(auto, 1fr)`. */
const FLUID = String.raw`(?:1fr|minmax\(\s*(?:0|auto|0px)\s*,\s*1fr\s*\))`
const FIXED = String.raw`\d+px`
/** Exactly two tracks, one fluid and one fixed, in either order, inside the quotes. */
const TWO_COLUMN_DETAIL_GRID = new RegExp(
  String.raw`gridTemplateColumns:\s*(['"\`])\s*(?:${FLUID}\s+${FIXED}|${FIXED}\s+${FLUID})\s*\1`, 'g',
)

describe('no page writes its own fluid + fixed two-column grid', () => {
  it('the pattern recognises the grids that caused the defect, and not the others', () => {
    const hit = (s: string) => new RegExp(TWO_COLUMN_DETAIL_GRID.source).test(s)
    for (const s of [
      "gridTemplateColumns: '1fr 340px'", "gridTemplateColumns: '1fr 300px'", "gridTemplateColumns: '1fr 360px'",
      "gridTemplateColumns: '220px 1fr'", "gridTemplateColumns: 'minmax(0, 1fr) 340px'", 'gridTemplateColumns: "340px 1fr"',
    ]) expect(hit(s), s).toBe(true)
    // Three tracks, equal columns, repeat(): other layouts, other rules.
    for (const s of [
      "gridTemplateColumns: '1fr 80px auto'", "gridTemplateColumns: '1fr 1fr'", "gridTemplateColumns: '1fr auto'",
      "gridTemplateColumns: 'repeat(3, 1fr)'", "gridTemplateColumns: '1fr 1fr 80px 1fr'",
    ]) expect(hit(s), s).toBe(false)
  })

  it('every .tsx uses DetailLayout instead', () => {
    const offenders: string[] = []
    for (const f of tsx()) {
      const src = fs.readFileSync(f, 'utf8')
      for (const m of src.matchAll(TWO_COLUMN_DETAIL_GRID)) {
        const line = src.slice(0, m.index).split('\n').length
        offenders.push(`${rel(f)}:${String(line)} ${m[0]}`)
      }
    }
    expect(offenders, `use <DetailLayout sideWidth={…}> (components/ui/DetailLayout):\n  ${offenders.join('\n  ')}`).toEqual([])
  })
})

describe('the rule itself', () => {
  it('.og-detail: the fluid column can shrink, the side one comes from the component', () => {
    expect(CSS).toMatch(/\.og-detail\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) var\(--og-detail-side/)
    expect(CSS).toMatch(/\.og-detail\.og-detail-side-first\s*\{[^}]*grid-template-columns:\s*var\(--og-detail-side, 340px\) minmax\(0, 1fr\)/)
    // The columns themselves may shrink too: a grid item has min-width: auto.
    expect(CSS).toMatch(/\.og-detail > \* \{ min-width: 0; \}/)
  })

  it('under 900px the two columns stack, like og-split', () => {
    expect(CSS).toMatch(/@media \(max-width: 900px\) \{\s*\.og-detail,\s*\.og-detail\.og-detail-side-first \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  })

  it.each([
    'pages/incidents/IncidentDetailPage.tsx',
    'pages/problems/ProblemDetailPage.tsx',
    'pages/requests/ServiceRequestDetailPage.tsx',
    'pages/tasks/TaskViewPage.tsx',
    'pages/knowledge-base/KBArticlePage.tsx',
  ])('%s uses DetailLayout', (file) => {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8')
    expect(src).toMatch(/<DetailLayout sideWidth=\{\d+\}/)
  })
})
