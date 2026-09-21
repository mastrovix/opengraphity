/**
 * Lint statico (D-26): il vocabolario dei permessi delle chiavi API non può
 * mentire in nessuna delle due direzioni.
 *
 * ## Il difetto
 * `IntegrationsPage.tsx` aveva la lista scritta a mano, e non coincideva con
 * quella applicata dalle rotte: offriva `ci:write`, che **nessuna** rotta REST
 * richiede (nessun endpoint scrive CI) — una capacità promessa e inesistente; e
 * non offriva `kb:write`, che `POST /api/v1/import/kb-articles` richiede — la
 * chiave creata dall'interfaccia prendeva 403 «Missing permissions: kb:write» e
 * l'unico modo di ottenerla era la mutation GraphQL a mano. Sopra a tutto,
 * `createApiKey` salvava i permessi senza validarli.
 *
 * ## La regola, meccanica
 * `API_KEY_PERMISSIONS` (`@opengraphity/types`) è la sorgente unica. Questo
 * lint confronta l'elenco coi letterali di `requirePermission(...)` nelle rotte
 * REST, nei due versi: un permesso applicato e non offerto è un 403 senza
 * rimedio; un permesso offerto e non applicato è una promessa vuota.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_KEY_PERMISSIONS } from '@opengraphity/types'

const here    = dirname(fileURLToPath(import.meta.url))
const restSrc = join(here, '..')

function listFiles(root: string): string[] {
  const out: string[] = []
  for (const f of readdirSync(root)) {
    const child = join(root, f)
    if (statSync(child).isDirectory()) {
      if (f !== '__tests__') out.push(...listFiles(child))
    } else if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')) {
      out.push(child)
    }
  }
  return out
}

/** Ogni letterale dentro un `requirePermission(...)`, col file dove sta. */
function appliedPermissions(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const file of listFiles(restSrc)) {
    const content = readFileSync(file, 'utf8')
    const calls = content.matchAll(/requirePermission\(([^)]*)\)/g)
    for (const call of calls) {
      for (const lit of (call[1] ?? '').matchAll(/'([^']+)'/g)) {
        const perm = lit[1]!
        out.set(perm, [...(out.get(perm) ?? []), relative(restSrc, file)])
      }
    }
  }
  return out
}

describe('permessi delle chiavi API: la lista offerta e quella applicata coincidono', () => {
  const applied = appliedPermissions()

  it('il perimetro non è vuoto (le rotte REST usano requirePermission)', () => {
    expect(applied.size).toBeGreaterThan(4)
  })

  it('ogni permesso richiesto da una rotta è nell\'elenco offerto', () => {
    const missing = [...applied.entries()]
      .filter(([p]) => !(API_KEY_PERMISSIONS as readonly string[]).includes(p))
      .map(([p, files]) => `${p} (richiesto da ${files.join(', ')}) non è in API_KEY_PERMISSIONS`)
    expect(missing).toEqual([])
  })

  it('ogni permesso offerto è richiesto da almeno una rotta', () => {
    const unused = API_KEY_PERMISSIONS
      .filter((p) => !applied.has(p))
      .map((p) => `${p} è offerto ma nessuna rotta lo richiede`)
    expect(unused).toEqual([])
  })

  it('i permessi sono in forma `risorsa:azione`, senza duplicati', () => {
    expect(API_KEY_PERMISSIONS.filter((p) => !/^[a-z]+:(read|write)$/.test(p))).toEqual([])
    expect(new Set(API_KEY_PERMISSIONS).size).toBe(API_KEY_PERMISSIONS.length)
  })
})
