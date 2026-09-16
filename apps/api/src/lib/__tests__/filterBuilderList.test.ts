/**
 * Gli operatori di LISTA del costruttore di filtri (moduli del catalogo,
 * ondata 4).
 *
 * Il difetto che li ha resi necessari: un campo a selezione multipla sta sul
 * nodo come lista di stringhe, ma il filtro lo trattava come un testo. Non
 * dava errore — non trovava MAI niente, che è il modo peggiore di sbagliare:
 * la lista tornava vuota e sembrava una risposta.
 */
import { describe, it, expect } from 'vitest'
import { buildAdvancedWhere } from '../filterBuilder.js'

const campi = new Set(['sistemi'])
const regola = (operator: string, value: unknown) =>
  JSON.stringify({ rules: [{ field: 'sistemi', operator, value, logic: 'AND' }] })

describe('operatori di lista', () => {
  it('«contiene uno di»: basta un valore in comune', () => {
    const params: Record<string, unknown> = {}
    const where = buildAdvancedWhere(regola('has_any', ['crm', 'erp']), params, campi)
    expect(where).toBe('(n.sistemi IS NOT NULL AND ANY(_v IN $af_0 WHERE _v IN n.sistemi))')
    expect(params['af_0']).toEqual(['crm', 'erp'])
  })

  it('«contiene tutti»: devono esserci tutti quelli chiesti', () => {
    const where = buildAdvancedWhere(regola('has_all', ['crm', 'erp']), {}, campi)
    expect(where).toContain('ALL(_v IN $af_0 WHERE _v IN n.sistemi)')
  })

  it('«non contiene nessuno di» accetta il campo MAI compilato: un null non contiene niente', () => {
    const where = buildAdvancedWhere(regola('has_none', ['crm']), {}, campi)
    expect(where).toBe('(n.sistemi IS NULL OR NONE(_v IN $af_0 WHERE _v IN n.sistemi))')
  })

  it('«vuoto» su una lista guarda la dimensione, non la stringa vuota', () => {
    expect(buildAdvancedWhere(regola('list_is_empty', null), {}, campi)).toBe('(n.sistemi IS NULL OR size(n.sistemi) = 0)')
    expect(buildAdvancedWhere(regola('list_is_not_empty', null), {}, campi)).toBe('(n.sistemi IS NOT NULL AND size(n.sistemi) > 0)')
  })

  it('il campo resta nella lista bianca: un nome non ammesso viene rifiutato, non ignorato', () => {
    expect(() => buildAdvancedWhere(regola('has_any', ['x']), {}, new Set(['altro'])))
      .toThrow(/Filter field not allowed/)
  })
})
