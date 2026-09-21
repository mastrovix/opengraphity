/**
 * IL SEME DELLA LINGUA (17 set 2026).
 *
 * `default_language_not_set` stava addosso a ogni tenant appena creato:
 * l'inglese si vedeva già — è la lingua che il prodotto mostra a chi non ha
 * scelto — ma nessuno l'aveva dichiarata, quindi «in che lingua parla questo
 * cliente?» era una domanda che rimbalzava su un ripiego.
 *
 * La cosa da non sbagliare mai: **un cliente che ha scelto l'italiano non
 * torna all'inglese**. È il difetto peggiore che un seme può fare, e qui è
 * pinnato.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const scritture: Array<Record<string, unknown>> = []
/** `false` = la lingua è già scritta, quindi il `WHERE … IS NULL` non trova righe. */
let daSeminare = true
/** Quello che c'è sul nodo: `null` finché nessuno ha scelto. */
let scritta: string | null = null

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => undefined }),
  runQuery: vi.fn(async () => []),
  runQueryOne: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    if (cypher.includes('WHERE t.default_language IS NULL')) {
      if (!daSeminare) return null
      scritture.push(params)
      scritta = params['lingua'] as string
      return { id: params['tenantId'] }
    }
    // La lettura di `tenantDefaultLanguage`: risponde quello che c'è scritto.
    if (cypher.includes('RETURN t.default_language AS lingua')) return { lingua: scritta }
    return null
  }),
}))
const invalidateSchema = vi.fn()
vi.mock('../schemaInvalidator.js', () => ({
  registerMetamodelCacheClearer: vi.fn(),
  invalidateSchema: (t?: string) => invalidateSchema(t),
}))
vi.mock('../logger.js', () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }))

const { seedDefaultLanguage, tenantDefaultLanguage, LINGUA_DI_ULTIMA_ISTANZA } = await import('../tenantLanguage.js')

beforeEach(() => { scritture.length = 0; daSeminare = true; scritta = null; invalidateSchema.mockClear() })

describe('seedDefaultLanguage', () => {
  it('dichiara la lingua del prodotto, che è l\'inglese', async () => {
    const esito = await seedDefaultLanguage({} as never, 'nuovo')
    expect(LINGUA_DI_ULTIMA_ISTANZA).toBe('en')
    expect(esito.seeded).toBe('en')
    expect(scritture[0]).toMatchObject({ tenantId: 'nuovo', lingua: 'en' })
  })

  it('NON tocca chi ha già scelto: un cliente in italiano resta in italiano', async () => {
    daSeminare = false
    const esito = await seedDefaultLanguage({} as never, 'italiano')
    expect(esito.seeded).toBeNull()
    expect(scritture).toHaveLength(0)
  })

  it('scrive solo dove la proprietà è ASSENTE, e lo dice nella query', async () => {
    // La condizione sta nel Cypher e non in un `if` sul risultato di una
    // lettura: fra la lettura e la scrittura ci sta una scelta di una persona.
    const runQueryOne = vi.mocked((await import('@opengraphity/neo4j')).runQueryOne)
    await seedDefaultLanguage({} as never, 'nuovo')
    expect(runQueryOne.mock.calls[0]![1]).toContain('WHERE t.default_language IS NULL')
  })

  it('svuota la cache, che tiene anche i «non scelta»', async () => {
    // Senza, il tenant risulterebbe senza lingua per tutto il TTL: la
    // diagnostica continuerebbe a segnalare un rilievo appena chiuso, e chi
    // guarda concluderebbe che il rimedio non ha funzionato.
    expect(await tenantDefaultLanguage('fresco')).toBeNull()   // la cache ricorda questo null
    await seedDefaultLanguage({} as never, 'fresco')
    expect(await tenantDefaultLanguage('fresco')).toBe('en')
  })
})
