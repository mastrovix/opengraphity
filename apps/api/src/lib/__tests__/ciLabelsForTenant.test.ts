/**
 * Le etichette dei CI vengono dal metamodello del tenant (ondata 6: A-9 / C-1
 * / C-2 / D-7). Prima erano sedici, scritte a mano, e diciassette consumatori
 * ne dipendevano: un tipo creato dal cliente esisteva nel grafo e non contava
 * in nessuno di quei posti — impatto, mappe, ricerca, gruppi dinamici — quasi
 * sempre in silenzio.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const loadMetamodel = vi.fn()
vi.mock('@opengraphity/schema-generator', () => ({ loadMetamodel }))

const {
  ciLabelsForTenant, ciLabelPredicateForTenant, apocLabelFilterForTenant, ciTypeNameForLabel, clearCILabelCache,
} = await import('../ciLabelsForTenant.js')
const { registeredMetamodelCacheClearers, invalidateSchema } = await import('../schemaInvalidator.js')
const { ALL_CI_LABELS } = await import('../ciLabels.js')

const type = (name: string, neo4jLabel: string) => ({ name, neo4jLabel, scope: 'tenant', active: true })

beforeEach(() => { vi.clearAllMocks(); clearCILabelCache() })

describe('ciLabelsForTenant', () => {
  it('unisce le etichette spedite col prodotto a quelle dei tipi del cliente, in ordine stabile', async () => {
    loadMetamodel.mockResolvedValue([type('load_balancer', 'LoadBalancer'), type('erp_system', 'ErpSystem')])
    const labels = await ciLabelsForTenant('c-one')
    expect(labels).toContain('LoadBalancer')
    expect(labels).toContain('ErpSystem')
    for (const base of ALL_CI_LABELS) expect(labels).toContain(base)
    expect([...labels]).toEqual([...labels].sort())
  })

  it('due clienti non si vedono le etichette', async () => {
    loadMetamodel.mockImplementation(async (t: string) =>
      t === 'c-one' ? [type('load_balancer', 'LoadBalancer')] : [type('filiale', 'Filiale')])
    expect(await ciLabelsForTenant('c-one')).toContain('LoadBalancer')
    expect(await ciLabelsForTenant('c-two')).not.toContain('LoadBalancer')
    expect(await ciLabelsForTenant('c-two')).toContain('Filiale')
  })

  it('legge il metamodello una volta per tenant, e di nuovo dopo un\'invalidazione', async () => {
    loadMetamodel.mockResolvedValue([])
    await ciLabelsForTenant('c-one')
    await ciLabelsForTenant('c-one')
    expect(loadMetamodel).toHaveBeenCalledTimes(1)

    // Il canale del metamodello (ondata 5) svuota anche questa cache: il
    // modulo si registra fra i clearer, quindi funziona anche nei worker.
    expect(registeredMetamodelCacheClearers()).toContain('ci-labels-for-tenant')
    invalidateSchema('c-one')
    await ciLabelsForTenant('c-one')
    expect(loadMetamodel).toHaveBeenCalledTimes(2)
  })

  it('un tipo senza etichetta non entra (dato incompleto, non un buco silenzioso)', async () => {
    loadMetamodel.mockResolvedValue([{ name: 'rotto', neo4jLabel: '', scope: 'tenant', active: true }])
    expect(await ciLabelsForTenant('c-one')).toEqual([...ALL_CI_LABELS].sort())
  })

  it('se il metamodello non si legge l\'errore ESCE, e non resta in cache', async () => {
    loadMetamodel.mockRejectedValueOnce(new Error('neo4j giù'))
    await expect(ciLabelsForTenant('c-one')).rejects.toThrow('neo4j giù')
    // il fallimento non è stato trattenuto: il tentativo dopo rilegge
    loadMetamodel.mockResolvedValue([type('load_balancer', 'LoadBalancer')])
    expect(await ciLabelsForTenant('c-one')).toContain('LoadBalancer')
  })
})

describe('i predicati derivati', () => {
  beforeEach(() => loadMetamodel.mockResolvedValue([type('load_balancer', 'LoadBalancer')]))

  it('il predicato WHERE contiene il tipo del cliente', async () => {
    const p = await ciLabelPredicateForTenant('ci', 'c-one')
    expect(p.startsWith('(') && p.endsWith(')')).toBe(true)
    expect(p).toContain('ci:LoadBalancer')
    expect(p).toContain('ci:Server')
  })

  it('il filtro APOC è nella forma +Label|+Label', async () => {
    const f = await apocLabelFilterForTenant('c-one')
    expect(f).toContain('+LoadBalancer')
    expect(f.split('|').every((p) => p.startsWith('+'))).toBe(true)
  })

  it('dall\'etichetta si risale al nome del tipo, e un\'etichetta ignota dà null (non un nome inventato)', async () => {
    expect(await ciTypeNameForLabel('c-one', 'LoadBalancer')).toBe('load_balancer')
    expect(await ciTypeNameForLabel('c-one', 'Sconosciuto')).toBeNull()
  })
})
