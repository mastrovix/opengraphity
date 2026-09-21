/**
 * Ondata 7: ogni pagina ha la sua riga di permessi, e ogni voce di menu porta a
 * una pagina con una riga. Una rotta nuova senza riga fa fallire questo test
 * (e `routePermissions` lancia a voce alta nel browser).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PERMISSIONS } from '@opengraphity/types'
import { ROUTE_PERMISSIONS, routePermissions } from './routePermissions'
import { MENU_SECTIONS } from '@/components/layout/menu'

const main = readFileSync(join(import.meta.dirname, '..', 'main.tsx'), 'utf8')
const GUARDED = [...main.matchAll(/guarded\('([^']+)'/g)].map((m) => m[1]!)

describe('permessi delle pagine', () => {
  it('ogni rotta con guardia ha una riga, e ogni riga una rotta', () => {
    expect(GUARDED.length).toBeGreaterThan(60)
    expect(GUARDED.filter((p) => !(p in ROUTE_PERMISSIONS))).toEqual([])
    const rows = Object.keys(ROUTE_PERMISSIONS).filter((k) => k !== '')
    expect(rows.filter((k) => !GUARDED.includes(k))).toEqual([])
  })

  it('ogni rotta di main.tsx che mostra una pagina ha la guardia (i soli redirect ne sono senza)', () => {
    const unguarded = [...main.matchAll(/\{ path: '([^']+)',\s*element: ([^\n]*)/g)]
      .filter((m) => !/Navigate|Redirect typeName|<AppLayout/.test(m[2]!))
      .map((m) => m[1])
    expect(unguarded).toEqual([])
  })

  it('ogni voce di menu ha una riga', () => {
    for (const { items } of MENU_SECTIONS) for (const { to } of items) expect(() => routePermissions(to), to).not.toThrow()
  })

  it('ogni permesso citato è nel catalogo', () => {
    for (const [route, perms] of Object.entries(ROUTE_PERMISSIONS)) {
      expect(perms.length, route).toBeGreaterThan(0)
      for (const p of perms) expect(PERMISSIONS, route).toContain(p)
    }
  })
})
