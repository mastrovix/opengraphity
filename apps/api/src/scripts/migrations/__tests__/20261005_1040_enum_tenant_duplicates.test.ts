/**
 * Migrazione 20261005_1040: via le copie di un vocabolario spedito che non
 * dicono niente di diverso.
 *
 * Quello che si pinna qui è la CONDIZIONE, cioè cosa NON si cancella. Una
 * migrazione che cancella dati di un cliente si giudica da lì: il confronto
 * largo — solo i valori — avrebbe buttato `ci_status`, `priority` e `severity`
 * di `c-one`, che hanno gli stessi valori dello spedito e **colori diversi**.
 * Tre personalizzazioni vere, perse in silenzio.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { enumTenantDuplicates } from '../20261005_1040_enum_tenant_duplicates.js'
import { MIGRATIONS } from '../index.js'

/** Le righe che la migrazione scrive nel log: è lì che racconta cosa ha toccato. */
let righe: string[] = []
beforeEach(() => {
  righe = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { righe.push(a.join(' ')) })
})

/** Una sessione finta che registra le query e risponde con i candidati dati. */
function sessione(candidati: { id: string; tenantId: string; name: string }[]) {
  const cyphers: string[] = []
  const params: Record<string, unknown>[] = []
  const run = vi.fn(async (c: string, p?: Record<string, unknown>) => {
    cyphers.push(c)
    if (p) params.push(p)
    if (c.includes('DELETE c')) {
      return { records: [{ get: () => (p?.['ids'] as string[] | undefined)?.length ?? 0 }] }
    }
    return {
      records: candidati.map((k) => ({
        get: (campo: string) => (campo === 'id' ? k.id : campo === 'tenantId' ? k.tenantId : k.name),
      })),
    }
  })
  return { session: { run }, cyphers, params }
}

describe('20261005_1040_enum_tenant_duplicates', () => {
  it('è registrata dopo la 1030', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20261005_1040_enum_tenant_duplicates'))
      .toBe(ids.indexOf('20261005_1030_deploy_plan_window_envelope') + 1)
  })

  it('confronta TUTTO, non solo i valori: etichette, colori, default, nome visibile, scope', async () => {
    // Il confronto largo è il difetto che questo test impedisce di
    // reintrodurre: su c-one tre copie differiscono SOLO nei colori.
    const { session, cyphers } = sessione([{ id: 'e-1', tenantId: 'c-one', name: 'category' }])
    await enumTenantDuplicates.up(session as never)
    const lettura = cyphers[0]!
    for (const pezzo of ['c.values = s.values', 'value_labels', 'value_colors', 'default_value', 'c.label', 'c.scope']) {
      expect(lettura, pezzo).toContain(pezzo)
    }
  })

  it('e pretende ZERO relazioni: una copia che qualcuno usa non si tocca', async () => {
    const { session, cyphers } = sessione([{ id: 'e-1', tenantId: 'c-one', name: 'category' }])
    await enumTenantDuplicates.up(session as never)
    expect(cyphers[0]).toContain('NOT (c)--()')
  })

  it('cancella con DELETE e non con DETACH DELETE', async () => {
    // `DETACH` staccherebbe in silenzio una relazione comparsa dopo la
    // lettura: su un vocabolario vuol dire togliere i valori a un campo.
    const { session, cyphers } = sessione([{ id: 'e-1', tenantId: 'c-one', name: 'category' }])
    await enumTenantDuplicates.up(session as never)
    const scrittura = cyphers[1]!
    expect(scrittura).toContain('DELETE c')
    expect(scrittura).not.toContain('DETACH')
  })

  it('non guarda MAI il nodo di sistema come candidato', async () => {
    const { session, cyphers } = sessione([])
    await enumTenantDuplicates.up(session as never)
    expect(cyphers[0]).toContain("c.tenant_id <> 'system'")
  })

  it('senza doppioni non scrive niente, e lo dice', async () => {
    const { session, cyphers } = sessione([])
    await enumTenantDuplicates.up(session as never)
    expect(cyphers).toHaveLength(1)
    expect(righe.join('\n')).toMatch(/nothing to remove/)
  })

  it('il messaggio NOMINA tenant e vocabolari: di una cancellazione si deve poter rispondere sei mesi dopo', async () => {
    const { session, params } = sessione([
      { id: 'e-1', tenantId: 'c-one', name: 'category' },
      { id: 'e-2', tenantId: 'c-one', name: 'environment' },
      { id: 'e-3', tenantId: 'altro', name: 'risk' },
    ])
    await enumTenantDuplicates.up(session as never)
    const log = righe.join('\n')
    expect(log).toContain('c-one: category, environment')
    expect(log).toContain('altro: risk')
    expect(log).toMatch(/removed 3 identical tenant copies/)
    // Cancella per id, cioè esattamente quelli letti: nessuna seconda
    // valutazione della condizione fra la lettura e la scrittura.
    expect(params[0]).toEqual({ ids: ['e-1', 'e-2', 'e-3'] })
  })

  it('con UN solo doppione la frase resta grammaticale', async () => {
    const { session } = sessione([{ id: 'e-1', tenantId: 'c-one', name: 'category' }])
    await enumTenantDuplicates.up(session as never)
    expect(righe.join('\n')).toMatch(/removed 1 identical tenant copy/)
  })
})
