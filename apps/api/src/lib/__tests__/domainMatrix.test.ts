/**
 * Matrici di dominio e punto unico di validazione (ondata 7).
 *
 * La decisione dell'utente: i valori dei vocabolari — severità, priorità,
 * impatto, urgenza comprese — sono **rinominabili dal cliente**. Da lì segue
 * tutto: il codice non può più avere le sue liste (`isImpactUrgency`,
 * `SEVERITY_MAP`, le copie di `SERVICE_CRITICALITIES`) né ripiegare su
 * `medium` quando non riconosce un valore, perché quel valore è una
 * configurazione legittima e il ripiego è silenzioso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeRead = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
const loadTenantEnumOverrides = vi.fn()

vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ executeRead, close }) }))
vi.mock('../enumScope.js', () => ({ loadTenantEnumOverrides }))

const {
  DOMAIN_MATRIX_KINDS, DOMAIN_MATRIX_SEEDS, isDomainMatrixKind, matrixKey,
  loadDomainMatrix, resolveDomainMatrix, assertDomainValue, isDomainValue, domainVocabulary,
  invalidateDomainMatrix, clearDomainCaches,
} = await import('../domainMatrix.js')

const rec = (m: Record<string, unknown>) => ({ get: (k: string) => (k in m ? m[k] : null) })
/** La sessione risponde con `records` alla prossima lettura. */
const reads = (...batches: Array<Array<Record<string, unknown>>>) => {
  executeRead.mockReset()
  for (const b of batches) executeRead.mockResolvedValueOnce({ records: b.map(rec) })
  executeRead.mockResolvedValue({ records: [] })
}

beforeEach(() => { vi.clearAllMocks(); clearDomainCaches(); loadTenantEnumOverrides.mockResolvedValue(new Map()) })

describe('il vocabolario delle matrici', () => {
  it('ogni matrice dichiara le dimensioni d\'ingresso e l\'uscita, e ha un seme completo', () => {
    for (const [kind, spec] of Object.entries(DOMAIN_MATRIX_KINDS)) {
      expect(isDomainMatrixKind(kind)).toBe(true)
      expect(spec.inputs.length).toBeGreaterThan(0)
      expect(spec.output).toBeTruthy()
      const seed = DOMAIN_MATRIX_SEEDS[kind as keyof typeof DOMAIN_MATRIX_SEEDS]
      expect(Object.keys(seed).length).toBeGreaterThan(0)
      // la chiave di una matrice a due dimensioni ha un separatore per dimensione
      for (const key of Object.keys(seed)) expect(key.split('|')).toHaveLength(spec.inputs.length)
    }
    expect(isDomainMatrixKind('inventata')).toBe(false)
  })

  it('il seme della priorità è la matrice ITIL che il codice usava', () => {
    expect(DOMAIN_MATRIX_SEEDS.priority[matrixKey('high', 'high')]).toBe('critical')
    expect(DOMAIN_MATRIX_SEEDS.priority[matrixKey('low', 'low')]).toBe('low')
    expect(DOMAIN_MATRIX_SEEDS.priority[matrixKey('medium', 'high')]).toBe('high')
  })
})

describe('loadDomainMatrix', () => {
  it('senza nodo salvato usa il seme e lo DICE (isDefault), senza inventare', async () => {
    reads([])
    const m = await loadDomainMatrix('c-one', 'priority')
    expect(m.isDefault).toBe(true)
    expect(m.entries).toEqual(DOMAIN_MATRIX_SEEDS.priority)
  })

  it('col nodo salvato vince il dato del cliente, anche come JSON', async () => {
    reads([{ entries: '{"alto|urgente":"p1"}', updatedAt: '2026-09-17T10:00:00Z' }])
    const m = await loadDomainMatrix('c-one', 'priority')
    expect(m.isDefault).toBe(false)
    expect(m.entries).toEqual({ 'alto|urgente': 'p1' })
    expect(m.updatedAt).toBe('2026-09-17T10:00:00Z')
  })

  it('entries corrotte → errore che nomina la matrice, e niente resta in cache', async () => {
    reads([{ entries: '{non json', updatedAt: null }])
    await expect(loadDomainMatrix('c-one', 'priority')).rejects.toThrow(/Matrice "priority".*non è JSON valido/)
    reads([])
    expect((await loadDomainMatrix('c-one', 'priority')).isDefault).toBe(true)
  })

  it('una cella non testuale è un errore che la nomina', async () => {
    reads([{ entries: '{"high|high": 3}', updatedAt: null }])
    await expect(loadDomainMatrix('c-one', 'priority')).rejects.toThrow(/la cella "high\|high" non è una stringa/)
  })

  it('legge una volta per tenant e tipo, e di nuovo dopo l\'invalidazione', async () => {
    reads([], [])
    await loadDomainMatrix('c-one', 'priority')
    await loadDomainMatrix('c-one', 'priority')
    expect(executeRead).toHaveBeenCalledTimes(1)
    invalidateDomainMatrix('c-one', 'priority')
    await loadDomainMatrix('c-one', 'priority')
    expect(executeRead).toHaveBeenCalledTimes(2)
  })
})

describe('resolveDomainMatrix — mai un default silenzioso', () => {
  it('traduce la combinazione presente', async () => {
    reads([])
    expect(await resolveDomainMatrix('c-one', 'priority', 'high', 'high')).toBe('critical')
  })

  it('una cella mancante è un errore che nomina matrice, combinazione e la strada', async () => {
    reads([])
    const err = await resolveDomainMatrix('c-one', 'priority', 'alto', 'urgente').then(() => null, (e: unknown) => e)
    expect(String((err as Error).message)).toMatch(/Matrice "priority"/)
    expect(String((err as Error).message)).toMatch(/impact="alto", urgency="urgente"/)
    expect(String((err as Error).message)).toMatch(/Matrici di dominio/)
    // e dice che la matrice è ancora quella di fabbrica: è l'indizio vero
    expect(String((err as Error).message)).toMatch(/di fabbrica/)
  })

  it('il numero di valori deve corrispondere alle dimensioni', async () => {
    reads([])
    await expect(resolveDomainMatrix('c-one', 'priority', 'high')).rejects.toThrow(/attesi 2 valori \(impact, urgency\)/)
  })

  it('una matrice a una dimensione si risolve con un valore solo, con le chiavi VERE del vocabolario', async () => {
    reads([])
    // Le criticità spedite col prodotto sono `mission_critical`,
    // `business_critical`, `business_operational`, `office_productivity`: il
    // seme le usa come chiavi, perché un seme si copia dal codice che
    // sostituisce. Con chiavi inventate (`critical/high/…`) ogni incident di
    // servizio resterebbe senza impatto dal primo giorno.
    expect(await resolveDomainMatrix('c-one', 'service_impact', 'mission_critical')).toBe('high')
    reads([])
    expect(await resolveDomainMatrix('c-one', 'service_impact', 'office_productivity')).toBe('medium')
    reads([])
    await expect(resolveDomainMatrix('c-one', 'service_impact', 'critical')).rejects.toThrow(/nessun valore per service_criticality="critical"/)
  })
})

describe('assertDomainValue — il punto unico', () => {
  it('il vocabolario del cliente vince su quello di sistema', async () => {
    loadTenantEnumOverrides.mockResolvedValue(new Map([['severity', { id: 'e1', name: 'severity', values: ['p1', 'p2'] }]]))
    expect(await assertDomainValue('c-one', 'severity', 'p1')).toBe('p1')
    await expect(assertDomainValue('c-one', 'severity', 'critical')).rejects.toThrow(/"critical" non è nel vocabolario di questo cliente. Ammessi: p1, p2/)
  })

  it('senza vocabolario proprio usa quello di sistema', async () => {
    reads([{ values: ['critical', 'high', 'medium', 'low'] }])
    expect(await assertDomainValue('c-one', 'severity', 'high')).toBe('high')
  })

  it('un valore assente non passa (chi lo accetta deve dirlo prima)', async () => {
    reads([{ values: ['high'] }])
    await expect(assertDomainValue('c-one', 'severity', null)).rejects.toThrow(/valore assente o non testuale/)
  })

  it('un vocabolario che non esiste da nessuna parte è un errore, non un elenco vuoto', async () => {
    reads([])
    await expect(domainVocabulary('c-one', 'inventato')).rejects.toThrow(/Vocabolario "inventato" inesistente/)
  })

  it('isDomainValue risponde senza lanciare, per i rami che devono decidere', async () => {
    reads([{ values: ['active', 'dismesso'] }])
    expect(await isDomainValue('c-one', 'ci_status', 'dismesso')).toBe(true)
    expect(await isDomainValue('c-one', 'ci_status', 'decommissioned')).toBe(false)
    expect(await isDomainValue('c-one', 'ci_status', undefined)).toBe(false)
  })
})
