/** Secondo giro UI del 15 set 2026 · V-19: l'operatore «è cambiato» e i campi cambiati visti solo dalle condizioni. */
import { describe, it, expect } from 'vitest'
import { CHANGED_FIELDS_KEY, evaluateConditions } from '../conditionEvaluator.js'

describe('operatore «changed»', () => {
  const conds = [{ field: 'urgency', operator: 'changed' as const }, { field: 'urgency', operator: 'equals' as const, value: 'high' }]
  it('vero solo se il campo è fra quelli cambiati dall\'aggiornamento', () => {
    expect(evaluateConditions(conds, { urgency: 'high', [CHANGED_FIELDS_KEY]: ['urgency'] })).toBe(true)
    expect(evaluateConditions(conds, { urgency: 'high', [CHANGED_FIELDS_KEY]: ['description'] })).toBe(false)
    // senza campi cambiati (creazione, transizione) non è mai vero
    expect(evaluateConditions(conds, { urgency: 'high' })).toBe(false)
  })
})
