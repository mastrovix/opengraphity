/**
 * Every class the web puts on an element is styled somewhere, or is a hook
 * a library or the code reads.
 *
 * Review of 23 Sep 2026 (decided by the owner on 24 Sep: Tailwind goes).
 * Tailwind was imported and never compiled, so its classes styled nothing:
 * `animate-spin` sat on twenty-six loading icons that never turned, the
 * skeleton of eleven pages had no background, the header menu no highlight
 * and no separator — and nothing said so, because an unknown class is not an
 * error. A class name that no stylesheet defines is the same failure,
 * whoever wrote it.
 *
 * Defined means: a selector in a stylesheet of the app, or in a `<style>`
 * block a component renders. The hooks below are read by a library or by the
 * code, not styled, each with its reason.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(process.cwd(), 'src')

const HOOKS: Readonly<Record<string, string>> = {
  'node-drag-handle': 'React Flow: the handle a node is dragged by (ReportFlowNodes)',
  nodrag:             'React Flow: an element inside a node that must not start a drag',
  nopan:              'React Flow: an element inside a node that must not pan the canvas',
  'skip-link':        'the skip link is styled inline and shown by its focus handlers (AppLayout)',
}

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return ['__tests__', 'test'].includes(name) ? [] : files(p, ext)
    return ext.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const selectorsOf = (css: string) => new Set([...withoutComments(css).matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]!))

function definedClasses(): Set<string> {
  const names = new Set<string>()
  for (const file of files(SRC, /\.css$/)) for (const n of selectorsOf(readFileSync(file, 'utf8'))) names.add(n)
  for (const file of files(SRC, /\.tsx$/)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/<style[^>]*>\s*\{\s*`([\s\S]*?)`/g)) {
      for (const n of selectorsOf(m[1]!)) names.add(n)
    }
  }
  return names
}

/** The classes of the `className` literals: a plain string, or a template's fixed parts. */
function usedClasses(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/g)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ')
    out.push(...value.split(/\s+/).filter(Boolean))
  }
  return out
}

describe('CSS classes', () => {
  it('reads the classes of a className, and the selectors of a style block', () => {
    expect(usedClasses('<a className="a b" /> <b className={`c ${x} d`} /> <i className=\'e\' />')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect([...selectorsOf('.x:hover, .y .z { } /* .w */')]).toEqual(['x', 'y', 'z'])
  })

  it('every class on an element is styled somewhere, or is a declared hook', () => {
    const defined = definedClasses()
    const missing: string[] = []
    for (const file of files(SRC, /\.tsx$/)) {
      for (const c of usedClasses(readFileSync(file, 'utf8'))) {
        if (!defined.has(c) && !(c in HOOKS)) missing.push(`${relative(SRC, file)}: ${c}`)
      }
    }
    expect([...new Set(missing)], 'style the class in index.css, or use an inline style').toEqual([])
  })

  it('a hook no element uses any more leaves the list', () => {
    const used = new Set(files(SRC, /\.tsx$/).flatMap((f) => usedClasses(readFileSync(f, 'utf8'))))
    expect(Object.keys(HOOKS).filter((h) => !used.has(h))).toEqual([])
  })
})
