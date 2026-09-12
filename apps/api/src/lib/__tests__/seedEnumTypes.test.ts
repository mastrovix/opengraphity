/**
 * I vocabolari spediti col prodotto (personalizzazioni, ondata 1 — A-2 / C-6).
 *
 * Il seme è UNO e vive su `tenant_id = 'system'`. Prima ne scriveva una copia
 * per tenant (`is_system = true` su ogni cliente, `onboard-tenant` la creava a
 * ogni onboarding): è così che i campi condivisi sono finiti agganciati ai
 * vocabolari di `c-one` e ogni altro cliente vedeva i valori di c-one. Qui si
 * pinna che la funzione non prende più uno slug e non scrive su nessun tenant.
 */
import { describe, it, expect, vi } from 'vitest'
import { seedSystemEnumTypes, SYSTEM_ENUMS } from '../seedEnumTypes.js'
import { CI_LIFECYCLE_STATUSES } from '../eventVocabularies.js'

function fakeSession() {
  const calls: Array<{ cypher: string; params: Record<string, unknown> }> = []
  const run = vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
    calls.push({ cypher, params }); return { records: [] }
  })
  return { calls, session: { executeWrite: (fn: (tx: { run: typeof run }) => unknown) => fn({ run }) } as never }
}

describe('seedSystemEnumTypes', () => {
  it('scrive OGNI vocabolario spedito e SOLO su tenant_id = \'system\'', async () => {
    const { calls, session } = fakeSession()
    await seedSystemEnumTypes(session)

    expect(calls).toHaveLength(SYSTEM_ENUMS.length)
    expect(calls.map((c) => c.params['name'])).toEqual(SYSTEM_ENUMS.map((e) => e.name))
    for (const c of calls) {
      expect(c.params['tenantId']).toBe('system')
      expect(c.cypher).toContain('MERGE (e:EnumTypeDefinition {name: $name, tenant_id: $tenantId})')
    }
  })

  it('i nomi sono unici e i vocabolari agganciati dal metamodello spedito ci sono tutti', () => {
    const names = SYSTEM_ENUMS.map((e) => e.name)
    expect(new Set(names).size).toBe(names.length)
    // `seed-itil-metamodel.ts` (uses_enum) e `seed-metamodel.ts` (campi enum dei
    // tipi CMDB spediti): senza questi nomi la migrazione A1-1 si fermerebbe.
    for (const n of ['severity', 'category', 'priority', 'risk', 'impact', 'change_type',
      'status_incident', 'status_change', 'status_problem', 'status_service_request',
      'ci_status', 'environment', 'os', 'instance_type', 'certificate_type']) {
      expect(names).toContain(n)
    }
  })

  it('il ciclo di vita del CI viene da eventVocabularies (fonte unica), non riscritto a mano', () => {
    expect(SYSTEM_ENUMS.find((e) => e.name === 'ci_status')!.values).toEqual([...CI_LIFECYCLE_STATUSES])
  })
})
