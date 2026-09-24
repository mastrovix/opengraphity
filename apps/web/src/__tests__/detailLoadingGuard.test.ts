/**
 * Giro nel browser del 14 set 2026 (#20): dopo «Add note» la sezione commenti
 * si richiudeva e la pagina tornava in cima. Con Apollo 4 un `refetch` rimette
 * `loading` a true: una pagina che mostra lo scheletro su `if (loading)` smonta
 * tutto e lo rimonta. Lo scheletro va solo al primo caricamento, quando non ci
 * sono ancora dati.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../pages')

function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) files(p, out)
    else if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

describe('le pagine con refetch non si smontano durante il ricaricamento', () => {
  it('nessuna pagina che fa refetch mostra lo scheletro su `if (loading)` da solo', () => {
    const offenders = files(PAGES).filter((f) => {
      const src = fs.readFileSync(f, 'utf8')
      // `loading` as a condition of its own, alone or beside others with `||`,
      // that draws something instead of the page (review of 23 Sep 2026:
      // `if (metamodelLoading || loading)` slipped through).
      return /\brefetch\b/.test(src) && /^\s*if \((?:[^()\n]*\|\|\s*)?loading(?:\s*\|\|[^()\n]*)?\)\s*\{?\s*return\s*[(<]/m.test(src)
    }).map((f) => path.relative(PAGES, f))
    expect(offenders).toEqual([])
  })
})
