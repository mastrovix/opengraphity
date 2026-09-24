/**
 * Every CSS variable the web uses is defined somewhere.
 *
 * Review of 23 Sep 2026: four colour tokens (`--color-surface-alt`,
 * `--color-amber`, `--color-brand-soft`, `--color-on-brand`) were used in a
 * dozen places and declared nowhere. An undefined `var()` is invalid at
 * computed-value time, so the property falls back without a word: disabled
 * buttons lost their fill, the release plan lanes disappeared, the calendar
 * grid had no background. A name is defined when a stylesheet of the app
 * declares it, or when the code sets it on an element itself.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(process.cwd(), 'src')

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return ['__tests__', 'test'].includes(name) ? [] : files(p, ext)
    return ext.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

/** Declared in a stylesheet (`--x:`) or set by the code (`'--x'` as a style key or with setProperty). */
function definedNames(): Set<string> {
  const names = new Set<string>()
  for (const file of files(SRC, /\.css$/)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/(--[\w-]+)\s*:/g)) names.add(m[1]!)
  }
  for (const file of files(SRC, /\.(ts|tsx)$/)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/['"`](--[\w-]+)['"`]\s*(?:as\s+string\s*\]\s*)?[:\],]/g)) names.add(m[1]!)
    for (const m of text.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) names.add(m[1]!)
  }
  return names
}

/** The text without comments: an example written in a comment is not a use. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('CSS variables', () => {
  it('every var(--x) used in the sources is defined', () => {
    const defined = definedNames()
    const missing: string[] = []
    for (const file of files(SRC, /\.(ts|tsx|css)$/)) {
      // `var(--x, fallback)` has its own fallback: it is allowed to be absent.
      for (const m of withoutComments(readFileSync(file, 'utf8')).matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
        if (!defined.has(m[1]!)) missing.push(`${relative(SRC, file)}: ${m[1]}`)
      }
    }
    expect([...new Set(missing)], 'declare the variable in index.css, or use an existing token').toEqual([])
  })
})
