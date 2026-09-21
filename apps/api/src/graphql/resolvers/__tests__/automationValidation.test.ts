/**
 * C-16: business rules / auto triggers are validated at write time with the
 * same parsers the runtime uses, plus the enums.
 */
import { describe, it, expect, vi } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), getSession: vi.fn() }))
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn() }))
vi.mock('../../../lib/triggerEngine.js', () => ({ invalidateTriggerCache: vi.fn() }))
vi.mock('../../../lib/rulesEngine.js', () => ({ invalidateRulesCache: vi.fn() }))
vi.mock('../../../lib/filterBuilder.js', () => ({ buildAdvancedWhere: vi.fn() }))
// C-4: i campi scrivibili vengono dal metamodello del cliente.
vi.mock('../../../lib/stepFieldWrites.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/stepFieldWrites.js')>()),
  stepFieldMetas: vi.fn(async () => new Map([
    ['category', { name: 'category', fieldType: 'enum', enumValues: ['network', 'hardware'], enumTypeName: 'category' }],
    ['severity', { name: 'severity', fieldType: 'enum', enumValues: ['critical', 'high', 'medium', 'low'], enumTypeName: 'severity' }],
    ['notes',    { name: 'notes',    fieldType: 'text', enumValues: [], enumTypeName: null }],
  ])),
}))
/*
 * ONDATA 8: `set_field` su una RICHIESTA può scrivere una risposta al modulo.
 * La validazione somma questi campi a quelli del metamodello; qui si finge la
 * libreria del tenant, perché il test riguarda la porta di scrittura.
 */
vi.mock('../../../lib/catalogForm.js', () => ({
  formFieldAutomationMetas: vi.fn(async (_s: unknown, _t: string, entityType: string) =>
    entityType === 'service_request'
      ? new Map([
          ['modello_richiesto', { name: 'modello_richiesto', fieldType: 'string', enumValues: [], enumTypeName: null }],
          ['ambiente_uso',      { name: 'ambiente_uso', fieldType: 'enum', enumValues: ['production', 'test'], enumTypeName: 'ambienti' }],
        ])
      : new Map()),
}))
const selectSLAForEntity = vi.fn(async (..._a: unknown[]) => null as null | { id: string; name: string })
vi.mock('@opengraphity/sla', () => ({ selectSLAForEntity, getTenantTimezone: vi.fn(async () => 'Europe/Rome') }))

// Ondata 8 · B-18: i bersagli di passo si validano contro i passi VERI del
// tenant. Il nucleo (`getWorkflowSteps`) è mockato: qui si prova la porta di
// scrittura, non la lettura dei metadata.
vi.mock('../../../lib/workflowHelpers.js', () => ({
  getWorkflowSteps: vi.fn(async (_s: unknown, _t: string, entityType: string) =>
    entityType === 'change'
      ? [{ name: 'valutazione' }, { name: 'cab_settimanale' }, { name: 'in_calendario' }, { name: 'archiviata' }]
      : [{ name: 'nuovo' }, { name: 'in_lavorazione' }, { name: 'sistemato' }]),
}))

const { assertConditionsJson, assertActionsJson, assertStepTargets, automationResolvers, assertChangedOperatorEvent } = await import('../automation.js')
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
  const ctx = { tenantId: 't', userId: 'u', role: 'admin', permissions: perms('admin') } as never

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

  /**
   * Revisione totale · C-4: `set_field` scriveva QUALUNQUE proprietà non
   * compresa in una lista di dieci nomi, senza controllare che il campo fosse
   * del metamodello né che il valore stesse nel vocabolario — «deleted = true»
   * era un soft-delete di massa da una regola. Ora passa dalla stessa
   * validazione dell'azione di passo `update_field`, al salvataggio e alla
   * scrittura.
   */
  it('set_field: campo del metamodello e valore del vocabolario, o rifiuto al salvataggio (C-4)', async () => {
    const ok = '[{"type":"set_field","params":{"field":"category","value":"network"}}]'
    await expect(assertStepTargets(session, 't', 'incident', { actions: ok })).resolves.toBeUndefined()

    await expect(assertStepTargets(session, 't', 'incident', { actions: '[{"type":"set_field","params":{"field":"deleted","value":true}}]' }))
      .rejects.toThrow(/is not a field of incident in the metamodel|cannot be set by a step/)
    await expect(assertStepTargets(session, 't', 'incident', { actions: '[{"type":"set_field","params":{"field":"category","value":"xyz"}}]' }))
      .rejects.toThrow(/is not a value of the field "category"/)
    await expect(assertStepTargets(session, 't', 'incident', { actions: '[{"type":"set_field","params":{"value":"x"}}]' }))
      .rejects.toThrow(/needs the field name/)
    // Un segnaposto si risolve a runtime e lì viene validato.
    await expect(assertStepTargets(session, 't', 'incident', { actions: '[{"type":"set_field","params":{"field":"category","value":"{category}"}}]' }))
      .resolves.toBeUndefined()
  })

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
      .rejects.toThrow(/names the step "approved", which does not exist in the "change" workflow[\s\S]*valutazione, cab_settimanale, in_calendario, archiviata/)
  })

  it('to_step vuoto → rifiutato (una regola che non dice dove andare non è configurata)', async () => {
    await expect(assertStepTargets(session, 't', 'change', { actions: '[{"type":"transition_workflow","params":{}}]' }))
      .rejects.toThrow(/needs the destination step/)
  })

  it('condizione status equals/not_equals: il valore deve essere un passo; contains e is_null non si toccano', async () => {
    await expect(assertStepTargets(session, 't', 'incident', { conditions: '[{"field":"status","operator":"equals","value":"nuovo"}]' }))
      .resolves.toBeUndefined()
    await expect(assertStepTargets(session, 't', 'incident', { conditions: '[{"field":"status","operator":"equals","value":"open"}]' }))
      .rejects.toThrow(/names the step "open", which does not exist in the "incident" workflow/)
    await expect(assertStepTargets(session, 't', 'incident', { conditions: '[{"field":"status","operator":"not_equals","value":"closed"}]' }))
      .rejects.toThrow(/names the step "closed"/)
    await expect(assertStepTargets(session, 't', 'incident', { conditions: '[{"field":"status","operator":"contains","value":"lavor"}]' }))
      .resolves.toBeUndefined()
    await expect(assertStepTargets(session, 't', 'incident', { conditions: '[{"field":"status","operator":"is_null"}]' }))
      .resolves.toBeUndefined()
  })

  it('tenant senza definizione di workflow → il rifiuto lo dice, invece di elencare «(nessuno)»', async () => {
    const { getWorkflowSteps } = await import('../../../lib/workflowHelpers.js')
    vi.mocked(getWorkflowSteps).mockResolvedValueOnce([])
    await expect(assertStepTargets(session, 't', 'problem', { actions: '[{"type":"transition_workflow","params":{"to_step":"x"}}]' }))
      .rejects.toThrow(/has no step at all: create the workflow definition/)
  })
})

/**
 * slaCoverage: il form di creazione chiede se una policy coprirà il ticket.
 * Deve rispondere lo STESSO selettore del motore SLA, con gli stessi valori.
 */
describe('slaCoverage', () => {
  const ctx = { tenantId: 't1' } as never
  it('passa tipo, priorità, categoria e team al selettore del motore, e ne riporta la policy', async () => {
    selectSLAForEntity.mockResolvedValueOnce({ id: 'p1', name: 'Rete' })
    const r = await automationResolvers.Query.slaCoverage(null, { entityType: 'incident', priority: 'medium', category: 'network', teamId: 'tm1' }, ctx)
    expect(selectSLAForEntity).toHaveBeenCalledWith('t1', 'incident', 'medium', 'network', 'tm1')
    expect(r).toEqual({ policyId: 'p1', policyName: 'Rete' })
  })
  it('nessuna policy → null', async () => {
    selectSLAForEntity.mockResolvedValueOnce(null)
    expect(await automationResolvers.Query.slaCoverage(null, { entityType: 'incident', priority: 'low' }, ctx)).toBeNull()
    expect(selectSLAForEntity).toHaveBeenLastCalledWith('t1', 'incident', 'low', null, null)
  })
  it('tipo sconosciuto o priorità vuota → rifiuto, non «nessuna policy»', async () => {
    await expect(automationResolvers.Query.slaCoverage(null, { entityType: 'ticket', priority: 'low' }, ctx)).rejects.toThrow(/Invalid entityType/)
    await expect(automationResolvers.Query.slaCoverage(null, { entityType: 'incident', priority: ' ' }, ctx)).rejects.toThrow(/priority is required/)
  })
})

/**
 * Policy SLA che il motore non potrebbe mai applicare. Giro del 14 set 2026:
 * la pagina offriva «Change» e la categoria per ogni tipo; il motore non
 * gestisce le change, e problem e richieste non hanno categoria.
 */
describe('createSLAPolicy — solo policy applicabili', () => {
  const ctx = { tenantId: 't1' } as never
  it('una policy per le change è rifiutata con la sua chiave', async () => {
    await expect(automationResolvers.Mutation.createSLAPolicy(null, { input: { name: 'x', entityType: 'change', responseMinutes: 60, resolveMinutes: 120 } }, ctx))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.sla.entityTypeWithoutSla' } } })
  })
  // Ondata 2 della verifica «Cosa resta cablato»: problem e richieste hanno una categoria anche per lo SLA.
  it('una categoria su problem o service request è accettata: arriva al controllo successivo', async () => {
    for (const entityType of ['problem', 'service_request']) {
      await expect(automationResolvers.Mutation.createSLAPolicy(null, { input: { name: 'x', entityType, category: 'network', responseMinutes: 60, resolveMinutes: 120 } }, ctx))
        .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.compliance.target' } } })
    }
  })

  it('una policy senza obiettivo di conformità, o con la soglia sopra l\'obiettivo, è rifiutata', async () => {
    await expect(automationResolvers.Mutation.createSLAPolicy(null, { input: { name: 'x', entityType: 'incident', responseMinutes: 60, resolveMinutes: 120 } }, ctx))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.compliance.target' } } })
    await expect(automationResolvers.Mutation.createSLAPolicy(null, { input: { name: 'x', entityType: 'incident', responseMinutes: 60, resolveMinutes: 120, complianceTarget: 90, complianceWarning: 95 } }, ctx))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.compliance.warning' } } })
  })
})

/** Secondo giro UI del 15 set 2026 · V-19: una regola «aggiornato» scattava a ogni modifica finché la condizione restava vera. */
describe('operatore «è cambiato» (V-19)', () => {
  const changed = JSON.stringify([{ field: 'urgency', operator: 'changed' }, { field: 'urgency', operator: 'equals', value: 'high' }])
  it('è un operatore valido', () => {
    expect(assertConditionsJson(changed)).toBe(changed)
  })
  it('vale solo sugli aggiornamenti: su creazione o transizione è rifiutato, perché non scatterebbe mai', () => {
    expect(() => assertChangedOperatorEvent(changed, 'on_update')).not.toThrow()
    expect(() => assertChangedOperatorEvent(changed, 'on_field_change')).not.toThrow()
    expect(() => assertChangedOperatorEvent(changed, 'on_create')).toThrow(ValidationError)
    expect(() => assertChangedOperatorEvent(changed, 'on_transition')).toThrow(/only works when the ticket is updated/)
    expect(() => assertChangedOperatorEvent(JSON.stringify([{ field: 'a', operator: 'equals', value: 'x' }]), 'on_create')).not.toThrow()
  })
})


/**
 * UN CAMPO DEL MODULO IN UN'AZIONE (ondata 8). Il difetto che questi casi
 * chiudono: la tendina offriva `modello_richiesto` e il salvataggio rispondeva
 * «non è un campo di questo tipo di ticket», perché la validazione guardava
 * solo il metamodello. Visto dal vivo su c-test creando la regola.
 */
describe('set_field su una richiesta: i campi del modulo', () => {
  const session = {} as never
  it('accetta un campo della libreria e il valore del suo vocabolario', async () => {
    await expect(assertStepTargets(session, 't', 'service_request', {
      actions: '[{"type":"set_field","params":{"field":"modello_richiesto","value":"ThinkPad standard"}}]',
    })).resolves.toBeUndefined()
    await expect(assertStepTargets(session, 't', 'service_request', {
      actions: '[{"type":"set_field","params":{"field":"ambiente_uso","value":"production"}}]',
    })).resolves.toBeUndefined()
  })
  it('rifiuta un valore fuori dal vocabolario del campo', async () => {
    await expect(assertStepTargets(session, 't', 'service_request', {
      actions: '[{"type":"set_field","params":{"field":"ambiente_uso","value":"collaudo"}}]',
    })).rejects.toThrow(/is not a value of the field/)
  })
  it('rifiuta un campo che la libreria non ha', async () => {
    await expect(assertStepTargets(session, 't', 'service_request', {
      actions: '[{"type":"set_field","params":{"field":"costo_totale","value":"1"}}]',
    })).rejects.toThrow(/not a field of service_request/)
  })
  it('gli altri tipi di ticket non guadagnano quei campi', async () => {
    await expect(assertStepTargets(session, 't', 'incident', {
      actions: '[{"type":"set_field","params":{"field":"modello_richiesto","value":"x"}}]',
    })).rejects.toThrow(/not a field of incident/)
  })
})
