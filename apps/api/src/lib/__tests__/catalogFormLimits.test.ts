/**
 * Il TETTO sui moduli (ondata 4): tecnico, configurabile, e mai inventato.
 *
 * Le due cose che questo test tiene ferme: un tenant senza i numeri è un
 * errore che nomina la migrazione (non un limite di comodo deciso a runtime),
 * e il numero scritto dall'amministratore sta dentro i suoi binari.
 */
import { describe, it, expect } from 'vitest'
import {
  assertLimitValue, assertLibraryRoom, catalogFormLimits,
  CATALOG_FORM_LIMIT_MAX, CATALOG_FORM_LIMIT_MIN, CATALOG_FORM_LIMIT_DEFAULTS,
} from '../catalogFormLimits.js'

describe('assertLimitValue', () => {
  it('accetta un intero dentro i binari', () => {
    expect(assertLimitValue('x', 10)).toBe(10)
    expect(assertLimitValue('x', CATALOG_FORM_LIMIT_MIN)).toBe(CATALOG_FORM_LIMIT_MIN)
    expect(assertLimitValue('x', CATALOG_FORM_LIMIT_MAX)).toBe(CATALOG_FORM_LIMIT_MAX)
  })

  it('rifiuta lo zero, il negativo, il non intero e lo zero di troppo', () => {
    for (const v of [0, -1, 2.5, CATALOG_FORM_LIMIT_MAX + 1, Number.NaN]) {
      expect(() => assertLimitValue('x', v)).toThrow(/whole number between/)
    }
  })
})

describe('i valori con cui nasce un tenant', () => {
  it('sono gli stessi per ogni piano: il tetto è tecnico, non commerciale', () => {
    expect(CATALOG_FORM_LIMIT_DEFAULTS.maxLibraryFields).toBeGreaterThan(CATALOG_FORM_LIMIT_DEFAULTS.maxFieldsPerForm)
    expect(CATALOG_FORM_LIMIT_DEFAULTS.maxLibraryFields).toBeLessThanOrEqual(CATALOG_FORM_LIMIT_MAX)
    expect(CATALOG_FORM_LIMIT_DEFAULTS.maxFieldsPerForm).toBeGreaterThanOrEqual(CATALOG_FORM_LIMIT_MIN)
    expect(CATALOG_FORM_LIMIT_DEFAULTS.maxTableRows).toBeGreaterThanOrEqual(CATALOG_FORM_LIMIT_MIN)
    expect(CATALOG_FORM_LIMIT_DEFAULTS.maxTableRows).toBeLessThanOrEqual(CATALOG_FORM_LIMIT_MAX)
  })
})

describe('nessun limite inventato a runtime', () => {
  const sessioneChe = (row: Record<string, unknown> | null) => ({
    run: async () => ({ records: row === null ? [] : [{ get: (k: string) => row[k], keys: Object.keys(row), toObject: () => row }] }),
  })

  it('tenant senza nodo: errore che dice cosa fare', async () => {
    await expect(catalogFormLimits(sessioneChe(null) as never, 't')).rejects.toThrow(/has no :Tenant node/)
  })

  it('tenant non migrato: errore che NOMINA la migrazione', async () => {
    await expect(catalogFormLimits(sessioneChe({ maxLibraryFields: null, maxFieldsPerForm: null, maxTableRows: null }) as never, 't'))
      .rejects.toThrow(/20261003_1020_catalog_form_limits/)
  })

  /**
   * Il tetto sulle RIGHE è dell'ondata 7: un tenant migrato fino all'ondata 4 ha
   * i primi due e non il terzo, e deve sentirsi dire QUALE migrazione manca —
   * non quella dei primi due, che ha già fatto.
   */
  it('tenant migrato a metà: l\'errore nomina la migrazione delle RIGHE, non quella dei campi', async () => {
    await expect(catalogFormLimits(sessioneChe({ maxLibraryFields: 120, maxFieldsPerForm: 60, maxTableRows: null }) as never, 't'))
      .rejects.toThrow(/20261004_1010_form_table_rows_limit/)
  })

  it('libreria piena: il rifiuto dice il tetto, quanti ce ne sono e dove alzarlo', async () => {
    let chiamata = 0
    const s = {
      run: async () => {
        chiamata++
        const row = chiamata === 1 ? { maxLibraryFields: 3, maxFieldsPerForm: 10, maxTableRows: 50 } : { n: 3 }
        return { records: [{ get: (k: string) => (row as Record<string, unknown>)[k], keys: Object.keys(row), toObject: () => row }] }
      },
    }
    await expect(assertLibraryRoom(s as never, 't')).rejects.toThrow(/library is full: 3 fields is the limit, 3 already exist/)
  })
})
