/**
 * Dal nome del tipo all'etichetta, per tenant (ondata 6: A-9 / C-2 / D-7).
 * Prima questa traduzione era una tabella fissa (`TYPE_TO_LABEL`) o una
 * PascalCase fatta a mano, e i nomi ignoti venivano **scartati in silenzio**:
 * un gruppo dinamico «solo bilanciatori» restituiva i CI di tutti i tipi, e un
 * filtro della topologia su un tipo del cliente non trovava nulla.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const loadMetamodel = vi.fn()
vi.mock('@opengraphity/schema-generator', () => ({ loadMetamodel }))

const { ciLabelForTypeName, ciLabelsForTypeNames, ciTypeNamesForTenant, clearCITypeNameCache } =
  await import('../ciTypeNameToLabel.js')
const { clearCILabelCache } = await import('../ciLabelsForTenant.js')
const { invalidateSchema } = await import('../schemaInvalidator.js')

const type = (name: string, neo4jLabel: string) => ({ name, neo4jLabel, scope: 'tenant', active: true })

beforeEach(() => {
  vi.clearAllMocks()
  clearCITypeNameCache()
  clearCILabelCache()
  loadMetamodel.mockResolvedValue([type('server', 'Server'), type('load_balancer', 'LoadBalancer')])
})

describe('ciLabelForTypeName', () => {
  it('risolve un tipo del cliente e un tipo spedito col prodotto', async () => {
    expect(await ciLabelForTypeName('c-one', 'load_balancer')).toBe('LoadBalancer')
    expect(await ciLabelForTypeName('c-one', 'server')).toBe('Server')
  })

  it('ignora spazi e maiuscole (il parametro REST arriva come lo scrive il client)', async () => {
    expect(await ciLabelForTypeName('c-one', '  LOAD_Balancer ')).toBe('LoadBalancer')
  })

  it('gli alias storici dei tipi spediti restano validi (nessun client REST rotto)', async () => {
    // `db_instance` e `virtual_machine` non hanno una CITypeDefinition nel
    // grafo: vengono dal seme dei tipi spediti col prodotto.
    expect(await ciLabelForTypeName('c-one', 'db_instance')).toBe('DatabaseInstance')
    expect(await ciLabelForTypeName('c-one', 'virtual_machine')).toBe('VirtualMachine')
  })

  it('un nome che questo cliente non ha → null (non un\'etichetta inventata)', async () => {
    expect(await ciLabelForTypeName('c-one', 'bilanciatore')).toBeNull()
    expect(await ciLabelForTypeName('c-one', 'MALICIOUS) DETACH DELETE (n')).toBeNull()
  })

  it('due clienti non si vedono i tipi', async () => {
    loadMetamodel.mockImplementation(async (t: string) =>
      t === 'c-one' ? [type('load_balancer', 'LoadBalancer')] : [type('filiale', 'Filiale')])
    expect(await ciLabelForTypeName('c-one', 'load_balancer')).toBe('LoadBalancer')
    expect(await ciLabelForTypeName('c-two', 'load_balancer')).toBeNull()
    expect(await ciLabelForTypeName('c-two', 'filiale')).toBe('Filiale')
  })
})

describe('ciLabelsForTypeNames', () => {
  it('deduplica nell\'ordine della richiesta', async () => {
    expect(await ciLabelsForTypeNames('c-one', ['server', 'load_balancer', 'server'], 'x'))
      .toEqual(['Server', 'LoadBalancer'])
  })

  it('un tipo ignoto FERMA l\'operazione, col nome e i tipi ammessi', async () => {
    await expect(ciLabelsForTypeNames('c-one', ['server', 'bilanciatore'], 'criteri del gruppo'))
      .rejects.toThrow(/criteri del gruppo: "bilanciatore" non è un tipo di CI di questo cliente \(ammessi: .*load_balancer.*server/)
  })

  it('elenco vuoto o voci vuote → nessuna etichetta, nessun errore', async () => {
    expect(await ciLabelsForTypeNames('c-one', [], 'x')).toEqual([])
    expect(await ciLabelsForTypeNames('c-one', ['', '  '], 'x')).toEqual([])
  })
})

describe('cache', () => {
  it('una lettura del metamodello per tenant, e di nuovo dopo un\'invalidazione', async () => {
    await ciLabelForTypeName('c-one', 'server')
    await ciLabelForTypeName('c-one', 'load_balancer')
    // una per il nucleo (etichette) e una per i nomi, non una per chiamata
    const first = loadMetamodel.mock.calls.length
    expect(first).toBeLessThanOrEqual(2)

    invalidateSchema('c-one')
    await ciLabelForTypeName('c-one', 'server')
    expect(loadMetamodel.mock.calls.length).toBeGreaterThan(first)
  })

  it('se il metamodello non si legge l\'errore ESCE e non resta in cache', async () => {
    loadMetamodel.mockRejectedValueOnce(new Error('neo4j giù'))
    await expect(ciLabelForTypeName('c-one', 'server')).rejects.toThrow('neo4j giù')
    loadMetamodel.mockResolvedValue([type('load_balancer', 'LoadBalancer')])
    clearCILabelCache()
    expect(await ciLabelForTypeName('c-one', 'load_balancer')).toBe('LoadBalancer')
  })
})

describe('ciTypeNamesForTenant', () => {
  it('i nomi ammessi, in ordine stabile (è l\'elenco che finisce nei messaggi d\'errore)', async () => {
    const names = await ciTypeNamesForTenant('c-one')
    expect(names).toContain('load_balancer')
    expect(names).toContain('server')
    expect([...names]).toEqual([...names].sort())
  })
})
