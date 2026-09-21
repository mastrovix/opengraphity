/**
 * I conteggi in testata si traducono con il plurale (giro nel browser del
 * 14 set 2026).
 *
 * Dal vivo: «3 policy», «0 certificate», «0 business capability», «6 workflow».
 * Quattro pagine componevano il testo a mano — `${policies.length} policy` —
 * fuori da i18next: niente plurale, niente italiano, e il guardiano i18n non lo
 * vede perché sta in un template. Il guardiano: nessun template che metta un
 * numero davanti a una parola.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'test') continue
      walk(full, out)
    } else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(full)
  }
  return out
}

describe('conteggi composti a mano', () => {
  it('nessun `${n} parola` nel JSX', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/`\$\{([\w.?]*\.length|[\w.?]*[Tt]otal|[\w.?]*[Cc]ount)\} (\$\{[^}]+\}|[A-Za-z]+)`/.test(line)) offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
