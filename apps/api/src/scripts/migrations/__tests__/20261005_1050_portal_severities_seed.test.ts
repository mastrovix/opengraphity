/**
 * Migrazione 20261005_1050: le severità del portale sui tenant nati prima del
 * seme.
 *
 * Quello che conta qui è che la migrazione NON riscriva la regola: chiama la
 * stessa funzione del provisioning. Una seconda copia avrebbe dichiarato
 * severità diverse da quelle di un tenant nuovo, e nessun test l'avrebbe
 * visto — è lo stesso schema che aveva già prodotto due modi di far nascere
 * un tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const seedPortalSeverityOptions = vi.fn<(s: unknown, t: string) => Promise<{ seeded: readonly string[] | null; reason?: string }>>(
  async () => ({ seeded: ['low', 'high'] }),
)
vi.mock('../../../lib/portalSeverityOptions.js', () => ({
  seedPortalSeverityOptions: (s: unknown, t: string) => seedPortalSeverityOptions(s, t),
}))

const { portalSeveritiesSeed } = await import('../20261005_1050_portal_severities_seed.js')
const { MIGRATIONS } = await import('../index.js')

let righe: string[] = []
beforeEach(() => {
  righe = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { righe.push(a.join(' ')) })
  seedPortalSeverityOptions.mockReset()
  seedPortalSeverityOptions.mockResolvedValue({ seeded: ['low', 'high'] })
})

/** Una sessione finta che risponde con i tenant dati. */
function sessione(tenantIds: string[]) {
  const cyphers: string[] = []
  const run = vi.fn(async (c: string) => {
    cyphers.push(c)
    return { records: tenantIds.map((id) => ({ get: () => id })) }
  })
  return { session: { run }, cyphers }
}

describe('20261005_1050_portal_severities_seed', () => {
  it('è registrata dopo la 1040', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20261005_1050_portal_severities_seed'))
      .toBe(ids.indexOf('20261005_1040_enum_tenant_duplicates') + 1)
  })

  it('guarda SOLO i tenant che non hanno mai scelto', async () => {
    const { session, cyphers } = sessione(['a', 'b'])
    await portalSeveritiesSeed.up(session as never)
    expect(cyphers[0]).toContain('t.portal_severity_options IS NULL')
  })

  it('usa la funzione del provisioning per ogni tenant, una volta', async () => {
    const { session } = sessione(['demo-opengrafo', 'prova-cons'])
    await portalSeveritiesSeed.up(session as never)
    expect(seedPortalSeverityOptions).toHaveBeenCalledTimes(2)
    expect(seedPortalSeverityOptions.mock.calls.map((c) => c[1])).toEqual(['demo-opengrafo', 'prova-cons'])
  })

  it('il log NOMINA i tenant e le severità dichiarate', async () => {
    const { session } = sessione(['demo-opengrafo'])
    await portalSeveritiesSeed.up(session as never)
    expect(righe.join('\n')).toContain('demo-opengrafo (low, high)')
  })

  it('un tenant senza vocabolario resta scoperto, col MOTIVO nel log', async () => {
    // Non prende una lista vuota: il suo portale continua a dire che manca la
    // configurazione, che è vero, invece di offrire una tendina senza scelte.
    seedPortalSeverityOptions.mockResolvedValue({ seeded: null, reason: 'no "severity" vocabulary with values for tenant x' })
    const { session } = sessione(['x'])
    await portalSeveritiesSeed.up(session as never)
    const log = righe.join('\n')
    expect(log).toContain('declared for 0 tenant(s)')
    expect(log).toContain('x: no "severity" vocabulary')
  })

  it('nessun tenant da seminare: non chiama niente', async () => {
    const { session } = sessione([])
    await portalSeveritiesSeed.up(session as never)
    expect(seedPortalSeverityOptions).not.toHaveBeenCalled()
    expect(righe.join('\n')).toContain('declared for 0 tenant(s)')
  })
})
