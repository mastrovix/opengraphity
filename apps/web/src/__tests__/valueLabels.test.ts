/**
 * ONE RULE FOR A VALUE WITHOUT A LABEL (D29, tour of 23 Sep 2026).
 *
 * «Pick up at the IT desk» was shown «Pick Up At The IT Desk»: five copies of
 * `v.replace(/_/g, ' ').replace(/\b\w/g, …toUpperCase())` in the web — in
 * `lib/ciEnums.ts`, `hooks/useEntityFields.ts`, the CI list, the topology
 * legend — capitalised every word of any value. The rule is now
 * `humanizeValue` in @opengraphity/web-core, shared with the portal and the
 * catalog form. This guardian fails when a copy comes back.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const DIRS = ['apps/web/src', 'apps/portal/src']

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!['__tests__', 'test', 'node_modules'].includes(e.name)) sources(p, out); continue }
    if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

describe('the Title Case of a value lives in one place', () => {
  it('no source capitalises every word of a value by itself', () => {
    const copies: string[] = []
    for (const f of DIRS.flatMap((d) => sources(path.join(ROOT, d)))) {
      const src = fs.readFileSync(f, 'utf8')
      if (/\.replace\(\/\\b\\w\/g/.test(src)) copies.push(path.relative(ROOT, f))
    }
    expect(copies, `use humanizeValue from @opengraphity/web-core:\n  ${copies.join('\n  ')}`).toEqual([])
  })
})
