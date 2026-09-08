import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  toWorkflowOperator, fromWorkflowOperator,
  operatorsForFieldType, operatorLabel, fieldTypeLabel, automationActionLabel,
  ALL_OPERATORS, OPERATOR_LABELS, NO_VALUE_OPERATORS, ITIL_ENTITIES, isITILEntity,
  WORKFLOW_STEP_ACTION_TYPES, AUTOMATION_ACTION_TYPES,
  type AutomationOperator, type WorkflowStepOperator,
} from './automationOperators'

let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => { consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('toWorkflowOperator (UI → persistito)', () => {
  const table: [AutomationOperator, WorkflowStepOperator][] = [
    ['equals', 'eq'], ['not_equals', 'ne'], ['greater_than', 'gt'], ['less_than', 'lt'],
    ['contains', 'contains'], ['is_null', 'is_null'], ['is_not_null', 'is_not_null'],
  ]
  it.each(table)('%s → %s', (ui, wf) => {
    expect(toWorkflowOperator(ui)).toBe(wf)
  })

  it.each(['gte', 'in', 'not_in', '', 'EQUALS', 'like'])('"%s" non mappabile → throw', (op) => {
    expect(() => toWorkflowOperator(op)).toThrow(`[automationOperators] operatore UI non mappabile su workflow: "${op}"`)
  })
})

describe('fromWorkflowOperator (persistito → UI)', () => {
  it.each([
    ['eq', 'equals'], ['ne', 'not_equals'], ['gt', 'greater_than'], ['lt', 'less_than'],
    ['contains', 'contains'], ['is_null', 'is_null'], ['is_not_null', 'is_not_null'],
  ])('%s → ok %s', (wf, ui) => {
    expect(fromWorkflowOperator(wf)).toEqual({ ok: true, value: ui })
  })

  it.each(['gte', 'lte', 'in', 'not_in', 'bogus'])('"%s" senza equivalente → { ok: false, raw } (mai riscritto in silenzio)', (op) => {
    expect(fromWorkflowOperator(op)).toEqual({ ok: false, raw: op })
  })

  it('round-trip UI → workflow → UI è l\'identità', () => {
    for (const o of ALL_OPERATORS) {
      const r = fromWorkflowOperator(toWorkflowOperator(o.value))
      expect(r).toEqual({ ok: true, value: o.value })
    }
  })
})

describe('operatorsForFieldType', () => {
  it.each([
    ['enum',    ['equals', 'not_equals', 'is_null', 'is_not_null']],
    ['string',  ['equals', 'not_equals', 'contains', 'is_null', 'is_not_null']],
    ['number',  ['equals', 'not_equals', 'greater_than', 'less_than', 'is_null', 'is_not_null']],
    ['date',    ['equals', 'not_equals', 'greater_than', 'less_than', 'is_null', 'is_not_null']],
    ['boolean', ['equals', 'is_null', 'is_not_null']],
    ['user',    ['equals', 'not_equals', 'is_null', 'is_not_null']],
    ['team',    ['equals', 'not_equals', 'is_null', 'is_not_null']],
  ])('%s', (type, values) => {
    expect(operatorsForFieldType(type).map((o) => o.value)).toEqual(values)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('le date hanno etichette "dopo"/"prima" per > e <', () => {
    const labels = Object.fromEntries(operatorsForFieldType('date').map((o) => [o.value, o.label]))
    expect(labels['greater_than']).toBe('dopo')
    expect(labels['less_than']).toBe('prima')
  })

  it('tipo sconosciuto → console.error e tutti gli operatori (fallback visibile)', () => {
    expect(operatorsForFieldType('geo')).toBe(ALL_OPERATORS)
    expect(consoleError).toHaveBeenCalledWith('[OPERATORS_BY_FIELD_TYPE] valore sconosciuto: "geo"')
  })
})

describe('etichette', () => {
  it('operatorLabel copre tutti gli operatori; sconosciuto → "?op" + log', () => {
    for (const o of ALL_OPERATORS) expect(operatorLabel(o.value)).toBe(OPERATOR_LABELS[o.value])
    expect(operatorLabel('nope')).toBe('?nope')
    expect(consoleError).toHaveBeenCalledWith('[OPERATOR_LABELS] valore sconosciuto: "nope"')
  })
  it('fieldTypeLabel / automationActionLabel: noto → etichetta, ignoto → "?x"', () => {
    expect(fieldTypeLabel('string')).toBe('testo')
    expect(fieldTypeLabel('blob')).toBe('?blob')
    expect(automationActionLabel('set_field')).toBe('Imposta campo')
    expect(automationActionLabel('fly')).toBe('?fly')
    expect(consoleError).toHaveBeenCalledTimes(2)
  })
})

describe('vocabolari', () => {
  it('NO_VALUE_OPERATORS contiene solo is_null / is_not_null', () => {
    expect([...NO_VALUE_OPERATORS].sort()).toEqual(['is_not_null', 'is_null'])
  })
  it('ITIL_ENTITIES / isITILEntity', () => {
    expect([...ITIL_ENTITIES].sort()).toEqual(['change', 'incident', 'problem', 'service_request'])
    expect(isITILEntity('incident')).toBe(true)
    expect(isITILEntity('server')).toBe(false)
  })
  it('i tipi azione dei due vocabolari non si sovrappongono se non per call_webhook', () => {
    const overlap = WORKFLOW_STEP_ACTION_TYPES.filter((t) => AUTOMATION_ACTION_TYPES.includes(t))
    expect(overlap).toEqual(['call_webhook'])
  })
})
