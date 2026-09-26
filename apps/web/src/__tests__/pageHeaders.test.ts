/**
 * THE WAY BACK AND THE TITLE ARE THE APP'S (26 Sep 2026, wave 3 of «tutte in
 * fila»).
 *
 * Sixteen «← back» links and fourteen <h1> were written page by page and had
 * drifted (arrow or «←», grey or blue, 12 to 14 px; weight 600 or 700). A list
 * page has `PageTitle`; a detail or create page has `BackLink` and
 * `DetailTitle` (components/ui/BackLink.tsx). This guard reads every file.
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

/** Where a raw <h1> is right, and why. */
const H1_ALLOWED: Record<string, string> = {
  'components/PageTitle.tsx': 'the title of the list pages',
  'components/ui/BackLink.tsx': 'the title of the detail pages',
  'pages/topology/TopologyPage.tsx': 'the full-screen map: its title sits small in the toolbar',
  'pages/workflow/WorkflowToolbar.tsx': 'the full-screen designer: its title sits small in the toolbar',
}

describe('page headers', () => {
  it('a raw <h1> only in the two title components and the two full-screen tools', () => {
    const found = tsx().filter((f) => /<h1\b/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort()
    expect(found).toEqual(Object.keys(H1_ALLOWED).sort())
  })

  it('a way back is a BackLink: no page draws its own arrow or «←» link', () => {
    const found = tsx().filter((f) => rel(f) !== 'components/ui/BackLink.tsx').flatMap((f) => {
      const s = fs.readFileSync(f, 'utf8')
      const lines: string[] = []
      // a <Link> or <button> whose content starts with an ArrowLeft icon or a «←»
      for (const m of s.matchAll(/<(Link|button)\b[^]*?<\/\1>/g)) {
        const content = m[0].replace(/^<(Link|button)\b(?:[^>{]|\{[^}]*\})*>/, '')
        if (/^\s*(<ArrowLeft\b|←)/.test(content)) lines.push(`${rel(f)}:${String(s.slice(0, m.index).split('\n').length)}`)
      }
      return lines
    })
    expect(found).toEqual([])
  })
})
