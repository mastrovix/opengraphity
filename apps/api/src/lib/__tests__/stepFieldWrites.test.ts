/**
 * Verifica «Cosa resta cablato», ondata 3: un passo scrive «ogni campo non
 * riservato». Prima erano quattro campi scritti nel codice (severity, priority,
 * description, category); ora il campo lo decide il metamodello del cliente e
 * il valore il suo vocabolario.
 */
import { describe, it, expect } from 'vitest'
import { GraphQLError } from 'graphql'
import { assertStepFieldValue, isTemplateValue, type StepFieldMeta } from '../stepFieldWrites.js'

const metas = new Map<string, StepFieldMeta>([
  ['outcome',     { name: 'outcome',     fieldType: 'enum',    enumValues: ['successful', 'failed'], enumTypeName: 'change_outcome' }],
  ['severity',    { name: 'severity',    fieldType: 'enum',    enumValues: ['low', 'high'],          enumTypeName: 'severity' }],
  ['description', { name: 'description', fieldType: 'string',  enumValues: [],                       enumTypeName: null }],
  ['effort',      { name: 'effort',      fieldType: 'number',  enumValues: [],                       enumTypeName: null }],
  ['billable',    { name: 'billable',    fieldType: 'boolean', enumValues: [],                       enumTypeName: null }],
  ['due_on',      { name: 'due_on',      fieldType: 'date',    enumValues: [],                       enumTypeName: null }],
  ['owner',       { name: 'owner',       fieldType: 'user',    enumValues: [],                       enumTypeName: null }],
  ['priority',    { name: 'priority',    fieldType: 'enum',    enumValues: ['low', 'high'],          enumTypeName: 'priority' }],
  ['status',      { name: 'status',      fieldType: 'enum',    enumValues: ['new', 'closed'],        enumTypeName: 'status_change' }],
])

const check = (entityType: string, field: string, value: unknown, allowTemplate = false) =>
  assertStepFieldValue(metas, entityType, field, value, 'deadline of step "Review"', { allowTemplate })

const failure = (fn: () => unknown): GraphQLError => {
  try { fn() } catch (e) { return e as GraphQLError }
  throw new Error('non ha lanciato')
}
const keyOf = (e: GraphQLError) => (e.extensions['i18n'] as { key: string }).key

describe('assertStepFieldValue', () => {
  it('un campo del cliente, con un valore del suo vocabolario, passa', () => {
    expect(check('change', 'outcome', 'successful')).toBe('successful')
  })

  it('un valore fuori vocabolario è rifiutato nominando i valori ammessi', () => {
    const e = failure(() => check('change', 'outcome', 'riuscita'))
    expect(keyOf(e)).toBe('errors.stepField.valueNotInVocabulary')
    expect(e.message).toContain('successful, failed')
    expect(e.message).toContain('deadline of step "Review"')
  })

  it('un campo che il metamodello non ha è rifiutato', () => {
    expect(keyOf(failure(() => check('change', 'esito', 'x')))).toBe('errors.stepField.notInMetamodel')
  })

  it('i campi riservati sono rifiutati prima del metamodello, anche se ci sono', () => {
    expect(keyOf(failure(() => check('change', 'status', 'closed')))).toBe('errors.stepField.engine_owned')
    // La priorità di una change viene da tipo × rischio: per una change è derivata.
    expect(keyOf(failure(() => check('change', 'priority', 'high')))).toBe('errors.stepField.derived')
    // Per un incident no.
    expect(check('incident', 'priority', 'high')).toBe('high')
  })

  it('una relazione (utente, team) si assegna, non si scrive', () => {
    expect(keyOf(failure(() => check('incident', 'owner', 'u-1')))).toBe('errors.stepField.relation')
  })

  it('numero, sì/no e data si convertono o si rifiutano', () => {
    expect(check('incident', 'effort', '2.5')).toBe(2.5)
    expect(keyOf(failure(() => check('incident', 'effort', 'tanto')))).toBe('errors.stepField.notNumber')
    expect(check('incident', 'billable', 'false')).toBe(false)
    expect(keyOf(failure(() => check('incident', 'billable', 'no')))).toBe('errors.stepField.notBoolean')
    expect(check('incident', 'due_on', '2026-10-01')).toBe('2026-10-01')
    expect(keyOf(failure(() => check('incident', 'due_on', 'domani')))).toBe('errors.stepField.notDate')
  })

  it('un valore vuoto è rifiutato', () => {
    expect(keyOf(failure(() => check('incident', 'description', '  ')))).toBe('errors.stepField.valueRequired')
  })

  it('un segnaposto passa solo dove si risolve a runtime (update_field), non in una scadenza', () => {
    expect(isTemplateValue('Escalated: {title}')).toBe(true)
    expect(check('incident', 'severity', '{severity}', true)).toBe('{severity}')
    expect(keyOf(failure(() => check('incident', 'severity', '{severity}', false)))).toBe('errors.stepField.valueNotInVocabulary')
  })
})
