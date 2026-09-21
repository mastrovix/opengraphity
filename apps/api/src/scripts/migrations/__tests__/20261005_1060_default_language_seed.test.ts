/**
 * Migrazione 20261005_1060: la lingua sui tenant nati prima del seme.
 *
 * Come la 1050: chiama la funzione del provisioning invece di riscriverne la
 * regola, e non tocca chi ha già scelto. Il caso da non sbagliare è l'ultimo:
 * un cliente in italiano che torna all'inglese sarebbe un danno fatto da una
 * migrazione, cioè il tipo di danno che nessuno si aspetta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const seedDefaultLanguage = vi.fn<(s: unknown, t: string) => Promise<{ seeded: string | null }>>(
  async () => ({ seeded: 'en' }),
)
vi.mock('../../../lib/tenantLanguage.js', () => ({
  seedDefaultLanguage: (s: unknown, t: string) => seedDefaultLanguage(s, t),
}))

const { defaultLanguageSeed } = await import('../20261005_1060_default_language_seed.js')
const { MIGRATIONS } = await import('../index.js')

let righe: string[] = []
beforeEach(() => {
  righe = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { righe.push(a.join(' ')) })
  seedDefaultLanguage.mockReset()
  seedDefaultLanguage.mockResolvedValue({ seeded: 'en' })
})

function sessione(tenantIds: string[]) {
  const cyphers: string[] = []
  const run = vi.fn(async (c: string) => {
    cyphers.push(c)
    return { records: tenantIds.map((id) => ({ get: () => id })) }
  })
  return { session: { run }, cyphers }
}

describe('20261005_1060_default_language_seed', () => {
  it('è registrata dopo la 1050', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20261005_1060_default_language_seed'))
      .toBe(ids.indexOf('20261005_1050_portal_severities_seed') + 1)
  })

  it('guarda SOLO i tenant senza lingua dichiarata', async () => {
    const { session, cyphers } = sessione(['a'])
    await defaultLanguageSeed.up(session as never)
    expect(cyphers[0]).toContain('t.default_language IS NULL')
  })

  it('usa la funzione del provisioning, una volta per tenant', async () => {
    const { session } = sessione(['demo-opengrafo', 'prova-due'])
    await defaultLanguageSeed.up(session as never)
    expect(seedDefaultLanguage.mock.calls.map((c) => c[1])).toEqual(['demo-opengrafo', 'prova-due'])
  })

  it('il log dice chi e con che lingua, e che a schermo non cambia niente', async () => {
    const { session } = sessione(['demo-opengrafo'])
    await defaultLanguageSeed.up(session as never)
    const log = righe.join('\n')
    expect(log).toContain('demo-opengrafo → en')
    expect(log).toMatch(/Nothing changes on screen/)
  })

  it('un tenant che aveva già scelto non finisce nel conto', async () => {
    seedDefaultLanguage.mockResolvedValue({ seeded: null })
    const { session } = sessione(['italiano'])
    await defaultLanguageSeed.up(session as never)
    expect(righe.join('\n')).toContain('language declared for 0 tenant(s)')
  })
})
