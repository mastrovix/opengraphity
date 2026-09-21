/**
 * `lib/metamodelCache.ts` — la forma unica delle cache del metamodello, con la
 * scadenza dentro (revisione delle otto ondate · D-N3).
 *
 * Cosa pinna, e perché ognuna di queste righe corrisponde a un difetto vero:
 *  - **la scadenza esiste**: sette cache su nove non l'avevano, e il prodotto
 *    diceva il contrario in tre punti. Una cache del metamodello senza TTL
 *    resta sbagliata fino al riavvio del processo se il canale tace;
 *  - **il canale resta la via normale**: il clearer registrato svuota subito,
 *    senza aspettare la scadenza;
 *  - **l'invalidazione è per tenant**: svuotare un tenant non tocca gli altri
 *    (era il difetto A-17, una mappa globale per tutti i clienti);
 *  - **un fallimento non si mette in cache**: era il comportamento di tutti e
 *    cinque i moduli convertiti, e per le etichette dei CI è deliberato — una
 *    lista incompleta fa sparire dei CI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMetamodelCache, METAMODEL_CACHE_TTL_MS } from '../metamodelCache.js'
import { clearLocalMetamodelCaches, registeredMetamodelCacheClearers } from '../schemaInvalidator.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createMetamodelCache', () => {
  it('carica una volta e riusa, per tenant e sottochiave', async () => {
    const load = vi.fn(async (tenantId: string, sub: string) => `${tenantId}/${sub}`)
    const c = createMetamodelCache({ name: 'test-riuso', load })

    expect(await c.get('c-one', 'impact')).toBe('c-one/impact')
    expect(await c.get('c-one', 'impact')).toBe('c-one/impact')
    expect(load).toHaveBeenCalledTimes(1)

    await c.get('c-one', 'urgency')
    await c.get('c-two', 'impact')
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('scade: dopo il TTL ricarica (la rete quando il canale tace)', async () => {
    const load = vi.fn(async () => 'v')
    const c = createMetamodelCache({ name: 'test-ttl', load, ttlMs: 1_000 })

    await c.get('c-one')
    vi.advanceTimersByTime(999)
    await c.get('c-one')
    expect(load).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2)
    await c.get('c-one')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('il TTL di serie è di 60 secondi', async () => {
    const load = vi.fn(async () => 'v')
    const c = createMetamodelCache({ name: 'test-ttl-default', load })

    await c.get('c-one')
    vi.advanceTimersByTime(METAMODEL_CACHE_TTL_MS - 1)
    await c.get('c-one')
    expect(load).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2)
    await c.get('c-one')
    expect(load).toHaveBeenCalledTimes(2)
    expect(METAMODEL_CACHE_TTL_MS).toBe(60_000)
  })

  it('si registra nel registro dei clearer, e il canale la svuota SUBITO', async () => {
    const load = vi.fn(async () => 'v')
    const c = createMetamodelCache({ name: 'test-clearer', load })
    expect(registeredMetamodelCacheClearers()).toContain('test-clearer')

    await c.get('c-one')
    expect(load).toHaveBeenCalledTimes(1)

    // Quello che fa il ricevitore del canale del metamodello negli altri processi.
    const outcome = clearLocalMetamodelCaches('c-one')
    expect(outcome.cleared).toContain('test-clearer')
    expect(outcome.failed).toEqual([])

    await c.get('c-one')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('svuotare un tenant non tocca gli altri (A-17)', async () => {
    const load = vi.fn(async (tenantId: string) => tenantId)
    const c = createMetamodelCache({ name: 'test-isolamento', load })

    await c.get('c-one')
    await c.get('c-two')
    expect(load).toHaveBeenCalledTimes(2)

    c.invalidate('c-one')
    await c.get('c-two')
    expect(load).toHaveBeenCalledTimes(2)
    await c.get('c-one')
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('invalidare una sottochiave non tocca le sorelle dello stesso tenant', async () => {
    const load = vi.fn(async (tenantId: string, sub: string) => `${tenantId}/${sub}`)
    const c = createMetamodelCache({ name: 'test-sottochiave', load })

    await c.get('c-one', 'priority')
    await c.get('c-one', 'service_impact')
    c.invalidate('c-one', 'priority')

    await c.get('c-one', 'service_impact')
    expect(load).toHaveBeenCalledTimes(2)
    await c.get('c-one', 'priority')
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('un tenant con un prefisso in comune non viene svuotato per sbaglio', async () => {
    const load = vi.fn(async (tenantId: string) => tenantId)
    const c = createMetamodelCache({ name: 'test-prefisso', load })

    await c.get('c-one')
    await c.get('c-one-bis')
    c.invalidate('c-one')

    await c.get('c-one-bis')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('un fallimento non resta in cache: il prossimo ritenta, e l\'errore esce', async () => {
    let attempt = 0
    const load = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('metamodello non leggibile')
      return 'v'
    })
    const c = createMetamodelCache({ name: 'test-fallimento', load })

    await expect(c.get('c-one')).rejects.toThrow('metamodello non leggibile')
    expect(await c.get('c-one')).toBe('v')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('le voci scadute non restano in memoria per sempre', async () => {
    const c = createMetamodelCache({ name: 'test-pulizia', load: async () => 'v', ttlMs: 10 })
    for (let i = 0; i < 300; i += 1) await c.get(`t-${String(i)}`)
    const before = c.size()
    vi.advanceTimersByTime(11)
    await c.get('t-nuovo')
    expect(c.size()).toBeLessThan(before)
  })
})
