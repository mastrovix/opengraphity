/**
 * Ogni link del percorso in cima porta a una pagina che esiste (giro nel
 * browser del 14 set 2026).
 *
 * Dal vivo: nel dettaglio di un CI «CMDB» portava a `/ci` e nel dettaglio di
 * un'attività «Tasks» a `/tasks` — due indirizzi senza pagina, «Page not
 * found». Il test prende TUTTE le rotte da main.tsx, apre il percorso di
 * ciascuna e controlla che ogni link corrisponda a una rotta.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Breadcrumb } from './Topbar'
import { renderWithProviders } from '@/test/utils'

const main = readFileSync(join(import.meta.dirname, '..', '..', 'main.tsx'), 'utf8')
const ROUTES = [...new Set([...main.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]!).filter((p) => p !== '*'))]
const toRegex = (route: string) => new RegExp('^/' + route.replace(/^\//, '').split('/').map((s) => (s.startsWith(':') ? '[^/]+' : s)).join('/') + '$')
const PATTERNS = [/^\/$/, ...ROUTES.map(toRegex)]
const sample = (route: string) => '/' + route.replace(/^\//, '').split('/').map((s) => (s.startsWith(':') ? '0e764d9c-6e20-473e-9b73-6736661dda3b' : s)).join('/')

describe('Breadcrumb: i link portano a pagine esistenti', () => {
  it('le rotte si leggono da main.tsx', () => {
    expect(ROUTES.length).toBeGreaterThan(40)
  })

  it('nessun link a un indirizzo senza pagina', () => {
    const broken: string[] = []
    for (const route of ROUTES) {
      const path = sample(route)
      const { unmount } = renderWithProviders(<Breadcrumb />, { route: path })
      for (const a of screen.queryByRole('navigation')?.querySelectorAll('a') ?? []) {
        const href = a.getAttribute('href') ?? ''
        if (!PATTERNS.some((p) => p.test(href))) broken.push(`${path} → ${href}`)
      }
      unmount()
    }
    expect(broken).toEqual([])
  })
})
