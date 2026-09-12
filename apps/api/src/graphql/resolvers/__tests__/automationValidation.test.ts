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

// Ondata 8 · B-18: i bersagli di passo si validano contro i passi VERI del
// tenant. Il nucleo (`getWorkflowSteps`) è mockato: qui si prova la porta di
// scrittura, non la lettura dei metadata.
vi.mock('../../../lib/workflowHelpers.js', () => ({
  getWorkflowSteps: vi.fn(async (_s: unknown, _t: string, entityType: string) =>
    entityType === 'change'
      ? [{ name: 'valutazione' }, { name: 'cab_settimanale' }, { name: 'in_calendario' }, { name: 'archiviata' }]
      : [{ name: 'nuovo' }, { name: 'in_lavorazione' }, { name: 'sistemato' }]),
}))

const { assertConditionsJson, assertActionsJson, assertStepTargets, automationResolvers } = await import('../automation.js')
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

// ── Bersagli di passo (ondata 8 · B-18) ──────────────────────────────────────
// Dal vivo: una business rule «Change emergency → approvazione immediata» punta
// al passo `approved`, che la definizione change non ha mai avuto. La regola
// risultava attiva e sana, e l'auto-approvazione non è mai avvenuta: il motore
// rifiutava la transizione e l'esito veniva ignorato.

describe('assertStepTargets', () => {
  const session = {} as never

  it('non legge i passi se non c\'è niente da validare', async () => {
    const { getWorkflowSteps } = await import('../../../lib/workflowHelpers.js')
    vi.mocked(getWorkflowSteps).mockClear()
    await assertStepTargets(session, 't', 'change', { actions: '[{"type":"assign_team","params":{"team_id":"t1"}}]', conditions: '[]' })
    expect(getWorkflowSteps).not.toHaveBeenCalled()
  })

  it('to_step di un passo RINOMINATO è accettato; un passo inesistente è rifiutato nominando quelli veri', async () => {
    await expect(assertStepTargets(session, 't', 'change', { actions: '[{"type":"transition_workflow","params":{"to_step":"in_calendario"}}]' }))
      .resolves.toBeUndefined()
    await expect(assertStepTargets(session, 't', 'change', { actions: '[{"type":"transition_workflow","params":{"to_step":"approved"}}]' }))
      .rejects.toThrow(/nomina il passo "approved", che non esiste nel workflow "change"[\s\S]*valutazione, cab_settimanale, in_calendario, archiviata/)
  })

  it('to_step vuoto → rifiutato (una regola che non dice dove andare non è configurata)', async () => {
    await expect(assertStepTargets(session, 't', 'change', { actions: '[{"type":"transition_workflow","params":{}}]' }))
      .rejects.toThrow(/richiede il passo di arrivo/)
  })

  it('condizione status equals/not_equals: il valore deve essere un passo; contains e is_null non si toccano', async () => {
    await expect(assertStepTargets(session, 't', 'incident', { conditions: '[{"field":"status","operator":"equals","value":"nuovo"}]' }))
      .resolves.toBeUndefined()
    await expect(assertStepTargets(session, 't', 'incident', { conditions: '[{"field":"status","operator":"equals","value":"open"}]' }))
      .rejects.toThrow(/nomina il passo "open", che non esiste nel workflow "incident"/)
    await expect(assertStepTargets(session, 't', 'incident', { conditions: '[{"field":"status","operator":"not_equals","value":"closed"}]' }))
      .rejects.toThrow(/nomina il passo "closed"/)
    await expect(assertStepTargets(session, 't', 'incident', { conditions: '[{"field":"status","operator":"contains","value":"lavor"}]' }))
      .resolves.toBeUndefined()
    await expect(assertStepTargets(session, 't', 'incident', { conditions: '[{"field":"status","operator":"is_null"}]' }))
      .resolves.toBeUndefined()
  })

  it('tenant senza definizione di workflow → il rifiuto lo dice, invece di elencare «(nessuno)»', async () => {
    const { getWorkflowSteps } = await import('../../../lib/workflowHelpers.js')
    vi.mocked(getWorkflowSteps).mockResolvedValueOnce([])
    await expect(assertStepTargets(session, 't', 'problem', { actions: '[{"type":"transition_workflow","params":{"to_step":"x"}}]' }))
      .rejects.toThrow(/non ha nessun passo: crea la definizione di workflow/)
  })
})
