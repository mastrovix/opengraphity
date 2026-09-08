/**
 * C-16: business rules / auto triggers are validated at write time with the
 * same parsers the runtime uses, plus the enums.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), getSession: vi.fn() }))
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn() }))
vi.mock('../../../lib/triggerEngine.js', () => ({ invalidateTriggerCache: vi.fn() }))
vi.mock('../../../lib/rulesEngine.js', () => ({ invalidateRulesCache: vi.fn() }))
vi.mock('../../../lib/filterBuilder.js', () => ({ buildAdvancedWhere: vi.fn() }))

const { assertConditionsJson, assertActionsJson, automationResolvers } = await import('../automation.js')
const { ValidationError } = await import('../../../lib/errors.js')

describe('assertConditionsJson', () => {
  it('accetta null/vuoto e un array valido', () => {
    expect(assertConditionsJson(null)).toBeNull()
    expect(assertConditionsJson('')).toBeNull()
    const ok = '[{"field":"severity","operator":"equals","value":"high"}]'
    expect(assertConditionsJson(ok)).toBe(ok)
  })
  it('rifiuta JSON corrotto, non-array, operatore sconosciuto, field mancante', () => {
    expect(() => assertConditionsJson('{not json')).toThrow(ValidationError)
    expect(() => assertConditionsJson('{"a":1}')).toThrow(/not an array/)
    expect(() => assertConditionsJson('[{"field":"x","operator":"like"}]')).toThrow(/unknown operator "like"/)
    expect(() => assertConditionsJson('[{"operator":"equals"}]')).toThrow(/has no field/)
    expect(() => assertConditionsJson(42)).toThrow(/JSON string/)
  })
})

describe('assertActionsJson', () => {
  it('accetta un array di azioni note', () => {
    const ok = '[{"type":"assign_team","params":{"team_id":"t1"}}]'
    expect(assertActionsJson(ok)).toBe(ok)
  })
  it('rifiuta tipo sconosciuto, params non oggetto, JSON corrotto', () => {
    expect(() => assertActionsJson('[{"type":"launch_rockets","params":{}}]')).toThrow(/unknown type "launch_rockets"/)
    expect(() => assertActionsJson('[{"type":"assign_team","params":[]}]')).toThrow(/params must be an object/)
    expect(() => assertActionsJson('[')).toThrow(ValidationError)
  })
})

describe('mutations: enum a scrittura', () => {
  const ctx = { tenantId: 't', userId: 'u', role: 'admin' } as never

  it('createAutoTrigger rifiuta eventType/entityType fuori enum PRIMA di toccare il DB', async () => {
    await expect(automationResolvers.Mutation.createAutoTrigger(null, { input: { name: 'x', entityType: 'incident', eventType: 'on_delete' } }, ctx))
      .rejects.toThrow(/Invalid eventType "on_delete"/)
    await expect(automationResolvers.Mutation.createAutoTrigger(null, { input: { name: 'x', entityType: 'ticket', eventType: 'on_create' } }, ctx))
      .rejects.toThrow(/Invalid entityType "ticket"/)
    await expect(automationResolvers.Mutation.createAutoTrigger(null, { input: { name: 'x', entityType: 'incident', eventType: 'on_timer' } }, ctx))
      .rejects.toThrow(/on_timer trigger requires timerDelayMinutes/)
  })

  it('createBusinessRule rifiuta eventType dei trigger (on_timer) e conditionLogic non valido', async () => {
    await expect(automationResolvers.Mutation.createBusinessRule(null, { input: { name: 'x', entityType: 'incident', eventType: 'on_timer' } }, ctx))
      .rejects.toThrow(/Invalid eventType "on_timer"/)
    await expect(automationResolvers.Mutation.createBusinessRule(null, { input: { name: 'x', entityType: 'incident', eventType: 'on_create', conditionLogic: 'xor' } }, ctx))
      .rejects.toThrow(/Invalid conditionLogic "xor"/)
  })

  it('updateAutoTrigger / updateBusinessRule validano i campi presenti', async () => {
    await expect(automationResolvers.Mutation.updateAutoTrigger(null, { id: '1', input: { actions: '[{"type":"nope"}]' } }, ctx))
      .rejects.toThrow(/unknown type "nope"/)
    await expect(automationResolvers.Mutation.updateBusinessRule(null, { id: '1', input: { conditions: 'garbage' } }, ctx))
      .rejects.toThrow(/Invalid conditions/)
  })
})
