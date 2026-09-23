/**
 * THE COVERAGE MEASURES WHAT IS THERE (tour of 23 Sep 2026).
 *
 * A test read every source file with `import.meta.glob(…, { query: '?raw',
 * eager: true })`. Vite then loaded each file as a TEXT module, and coverage
 * counted it as loaded — by a module with no code — so the 101 files that no
 * test runs were reported with 0 statements instead of all their statements
 * uncovered. The web read 97.5% where it was 65.8%, and nobody could see it.
 *
 * A test that needs the sources as text reads them from the disk
 * (`node:fs`), like `detailLayout.test.ts` and `i18nPlurals.test.ts` do.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) testFiles(full, out)
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** The code without its comments: a comment may tell the story of the defect, the code must not repeat it. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('coverage', () => {
  it('no test loads the sources as text modules: coverage would count them as run', () => {
    const self = fileURLToPath(import.meta.url)
    const offenders = testFiles(SRC)
      .filter((f) => f !== self)
      .filter((f) => {
        const src = withoutComments(fs.readFileSync(f, 'utf8'))
        return /import\.meta\.glob\s*[(<]/.test(src) || /['"`][^'"`\n]*\?raw['"`]/.test(src)
      })
      .map((f) => path.relative(SRC, f))
    expect(offenders).toEqual([])
  })
})
