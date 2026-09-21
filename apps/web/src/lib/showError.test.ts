/**
 * Un errore, un avviso: gli errori GraphQL e di rete li mostra il link degli
 * errori (tradotti), le pagine usano `showError` che non li ripete. Prima 140
 * `onError` li mostravano una seconda volta, e il messaggio compariva due volte.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { CombinedGraphQLErrors } from '@apollo/client/errors'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }))

const { showError } = await import('./showError')

beforeEach(() => toastError.mockReset())

describe('showError', () => {
  it('un errore GraphQL è già stato mostrato dal link: niente secondo avviso', () => {
    showError(new CombinedGraphQLErrors({ errors: [{ message: 'At least one active person must keep the permission' }] }), 'Salvataggio non riuscito')
    expect(toastError).not.toHaveBeenCalled()
  })

  it('un errore che il link non ha visto (browser, REST, controllo locale) si mostra, con la frase data o col suo messaggio', () => {
    showError(new Error('Upload failed: 413'))
    showError(new TypeError('x'), 'Export non riuscito')
    expect(toastError.mock.calls).toEqual([['Upload failed: 413'], ['Export non riuscito']])
  })
})

describe('guardiano: nessuna pagina ripete a mano il messaggio di un errore', () => {
  const SRC = join(import.meta.dirname, '..')
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'test' || f === '__tests__' ? [] : files(p)
    return /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : []
  })

  it('niente toast.error con il messaggio di un errore: si usa showError', () => {
    const offenders: string[] = []
    for (const file of files(SRC)) {
      if (file.endsWith('lib/showError.ts')) continue
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/toast\.error\([^)]*(\w+\.message\b|errorMessage\(|String\(\w+\))/.test(line) && !/result\?\.message/.test(line)) {
          offenders.push(`${relative(SRC, file)}:${String(i + 1)}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
