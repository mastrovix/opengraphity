/**
 * I tipi di change pre-approvati come dato del cliente (ondata 8: l'ultimo
 * letterale di dominio del programma).
 *
 * Il codice diceva `if (changeType === 'standard') return` in quattro punti.
 * Con i vocabolari rinominabili, chi chiamava `standard` in altro modo
 * perdeva la pre-approvazione — in una direzione «sicura» (più approvazione,
 * non meno), ma comunque senza saperlo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeRead = vi.fn()
const executeWrite = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
const assertDomainValue = vi.fn()
const domainVocabulary = vi.fn()

vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ executeRead, executeWrite, close }) }))
vi.mock('../domainMatrix.js', () => ({ assertDomainValue, domainVocabulary }))

const {
  DEFAULT_PRE_APPROVED_CHANGE_TYPES, preApprovedChangeTypes, isPreApprovedChangeType,
  setPreApprovedChangeTypes, invalidatePreApprovedChangeTypes,
} = await import('../changePolicy.js')
const { registeredMetamodelCacheClearers, invalidateSchema } = await import('../schemaInvalidator.js')

const rec = (m: Record<string, unknown>) => ({ get: (k: string) => (k in m ? m[k] : null) })
const tenantHas = (types: unknown) => {
  executeRead.mockReset()
  executeRead.mockResolvedValue({ records: [rec({ types })] })
}

beforeEach(() => {
  vi.clearAllMocks()
  invalidatePreApprovedChangeTypes()
  assertDomainValue.mockImplementation((_t: string, _v: string, value: unknown) =>
    ['standard', 'normal', 'emergency', 'preautorizzata'].includes(String(value))
      ? Promise.resolve(value)
      : Promise.reject(new Error(`change_type: "${String(value)}" non è nel vocabolario di questo cliente.`)))
})

describe('la lista viene dal tenant', () => {
  it('il valore iniziale è esattamente il letterale che il codice usava', () => {
    expect(DEFAULT_PRE_APPROVED_CHANGE_TYPES).toEqual(['standard'])
  })

  it('legge la lista del cliente, e il tipo RINOMINATO è pre-approvato', async () => {
    tenantHas(['preautorizzata'])
    expect(await preApprovedChangeTypes('c-one')).toEqual(['preautorizzata'])
    expect(await isPreApprovedChangeType('c-one', 'preautorizzata')).toBe(true)
    // e il letterale di prima non lo è più: è una scelta del cliente, esplicita
    expect(await isPreApprovedChangeType('c-one', 'standard')).toBe(false)
  })

  it('una lista vuota significa «nessun tipo pre-approvato», e va rispettata', async () => {
    tenantHas([])
    expect(await isPreApprovedChangeType('c-one', 'standard')).toBe(false)
  })

  it('proprietà ASSENTE = valore di fabbrica, non lista vuota (sarebbe il contrario di prima)', async () => {
    tenantHas(null)
    expect(await preApprovedChangeTypes('c-one')).toEqual(['standard'])
    expect(await isPreApprovedChangeType('c-one', 'standard')).toBe(true)
  })

  it('un tipo assente o non testuale non è pre-approvato, e non interroga il grafo', async () => {
    executeRead.mockReset()
    expect(await isPreApprovedChangeType('c-one', null)).toBe(false)
    expect(await isPreApprovedChangeType('c-one', '')).toBe(false)
    expect(executeRead).not.toHaveBeenCalled()
  })

  it('un tenant inesistente è un errore, non una lista vuota', async () => {
    executeRead.mockReset()
    executeRead.mockResolvedValue({ records: [] })
    await expect(preApprovedChangeTypes('fantasma')).rejects.toThrow(/inesistente/)
  })

  it('un valore non testuale nella proprietà è un errore che lo mostra', async () => {
    tenantHas([1, 2])
    await expect(preApprovedChangeTypes('c-one')).rejects.toThrow(/non è una lista di stringhe/)
  })

  it('legge una volta per tenant, e di nuovo dopo l\'invalidazione del metamodello', async () => {
    tenantHas(['standard'])
    await preApprovedChangeTypes('c-one')
    await preApprovedChangeTypes('c-one')
    expect(executeRead).toHaveBeenCalledTimes(1)
    expect(registeredMetamodelCacheClearers()).toContain('pre-approved-change-types')
    invalidateSchema('c-one')
    await preApprovedChangeTypes('c-one')
    expect(executeRead).toHaveBeenCalledTimes(2)
  })
})

describe('la scrittura valida contro il vocabolario del cliente', () => {
  it('salva i tipi validi, valida ognuno, e la lettura dopo vede il valore nuovo', async () => {
    executeWrite.mockResolvedValue({ records: [rec({ types: ['standard', 'preautorizzata'] })] })
    expect(await setPreApprovedChangeTypes('c-one', ['standard', 'preautorizzata'])).toEqual(['standard', 'preautorizzata'])
    expect(executeWrite).toHaveBeenCalledTimes(1)
    // ogni valore è passato dal punto unico di validazione
    expect(assertDomainValue.mock.calls.map((c) => [c[1], c[2]]))
      .toEqual([['change_type', 'standard'], ['change_type', 'preautorizzata']])
    // la cache è stata svuotata: la lettura successiva torna al grafo
    tenantHas(['standard', 'preautorizzata'])
    expect(await preApprovedChangeTypes('c-one')).toEqual(['standard', 'preautorizzata'])
    expect(executeRead).toHaveBeenCalledTimes(1)
  })

  it('un tipo fuori vocabolario è un rifiuto: sarebbe una pre-approvazione che non si applica a nulla', async () => {
    await expect(setPreApprovedChangeTypes('c-one', ['inventato'])).rejects.toThrow(/non è nel vocabolario/)
    expect(executeWrite).not.toHaveBeenCalled()
  })

  it('un doppione è un rifiuto che lo nomina', async () => {
    await expect(setPreApprovedChangeTypes('c-one', ['standard', 'standard'])).rejects.toThrow(/"standard" compare due volte/)
    expect(executeWrite).not.toHaveBeenCalled()
  })

  it('una lista vuota è legittima: il cliente può non volere pre-approvazioni', async () => {
    executeWrite.mockResolvedValue({ records: [rec({ types: [] })] })
    expect(await setPreApprovedChangeTypes('c-one', [])).toEqual([])
  })
})

/**
 * Revisione delle otto ondate · D-N1. `setPreApprovedChangeTypes` svuotava
 * **solo la sua** cache locale, e quella cache non aveva scadenza: il worker
 * che decide se una change salta la catena di approvazioni restava sulla lista
 * vecchia fino al riavvio. Ora tira la leva unica, che svuota tutte le cache
 * del metamodello di questo processo e pubblica sul canale per gli altri.
 */
describe('la scrittura tira la leva dell\'invalidazione', () => {
  it('svuota la propria cache E le altre del metamodello di quel tenant', async () => {
    const svuotati: string[] = []
    const { registerMetamodelCacheClearer } = await import('../schemaInvalidator.js')
    registerMetamodelCacheClearer('test-altra-cache', (tenantId) => { svuotati.push(tenantId) })

    tenantHas(['standard'])
    expect(await preApprovedChangeTypes('c-one')).toEqual(['standard'])

    executeWrite.mockResolvedValue({ records: [rec({ types: ['standard', 'preautorizzata'] })] })
    await setPreApprovedChangeTypes('c-one', ['standard', 'preautorizzata'])

    // L'altra cache del metamodello è stata avvisata…
    expect(svuotati).toEqual(['c-one'])
    // …e la propria rilegge dal grafo invece di rendere la lista di prima.
    tenantHas(['standard', 'preautorizzata'])
    expect(await preApprovedChangeTypes('c-one')).toEqual(['standard', 'preautorizzata'])
  })

  it('una scrittura rifiutata dal vocabolario non invalida niente', async () => {
    const svuotati: string[] = []
    const { registerMetamodelCacheClearer } = await import('../schemaInvalidator.js')
    registerMetamodelCacheClearer('test-altra-cache-2', (tenantId) => { svuotati.push(tenantId) })

    await expect(setPreApprovedChangeTypes('c-one', ['inventata'])).rejects.toThrow(/non è nel vocabolario/)
    expect(svuotati).toEqual([])
    expect(executeWrite).not.toHaveBeenCalled()
  })
})
