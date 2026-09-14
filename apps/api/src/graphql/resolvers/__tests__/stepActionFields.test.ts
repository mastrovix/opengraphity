/**
 * Personalizzazioni, ondata 8 — A8-2 (B-9): l'azione di passo `update_field`
 * non può scrivere lo stato.
 *
 * `status` è **derivato** dal passo di workflow: lo scrive il motore nella
 * stessa transazione della transizione. Con `status` nell'allow-list bastava
 * configurare un passo con `update_field(status = closed)` dal disegnatore per
 * far divergere `entity.status` da `WorkflowInstance.current_step`: liste e
 * portale mostravano il ticket chiuso, il processo lo teneva aperto, il
 * monitoraggio continuava ad agganciarci allarmi e lo SLA restava in corso.
 * Il rifiuto arriva ora **in scrittura** (questo file) e non solo a runtime:
 * altrimenti la configurazione era già salvata e l'errore compariva a ogni
 * ingresso nel passo, in un log.
 */
import { describe, it, expect, vi } from 'vitest'
import { GraphQLError } from 'graphql'

vi.mock('@opengraphity/events', () => ({ publish: vi.fn().mockResolvedValue(undefined), getRedisOptions: vi.fn(() => ({})) }))
// Vocabolario del motore COMPLETO per la parte che serve qui: `update_field`
// deve superare il controllo di tipo e arrivare a quello sul campo.
const ACTIONS = ['publish_event', 'notify_rule', 'update_field', 'sla_start', 'create_entity'] as const
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn(), transition: vi.fn(), registerCondition: vi.fn(), getAvailableTransitions: vi.fn() },
  WORKFLOW_ACTION_TYPES: ACTIONS,
  isWorkflowActionType: (t: unknown) => typeof t === 'string' && (ACTIONS as readonly string[]).includes(t),
}))
vi.mock('@opengraphity/notifications', () => ({ sseManager: { sendToUser: vi.fn() } }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn(), getSession: vi.fn() }))
vi.mock('../../../services/incidentService.js', () => ({ publishIncidentTransition: vi.fn() }))
vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  workflowLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/validateRequiredFields.js', () => ({ validateRequiredFields: vi.fn(), propsToFieldValues: vi.fn(() => ({})) }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ invalidateWorkflowCache: vi.fn() }))

const { assertStepActions } = await import('../workflowMutations.js')

const json = (field: string) => JSON.stringify([{ type: 'update_field', params: { field, value: 'x' } }])
const thrown = (raw: string): GraphQLError => {
  try { assertStepActions(raw, 'enter_actions dello step "chiusura"'); throw new Error('non ha lanciato') }
  catch (e) { return e as GraphQLError }
}

describe('assertStepActions — campi di update_field', () => {
  // Verifica «Cosa resta cablato», ondata 3: «ogni campo non riservato». La
  // forma dell'azione e le riserve si controllano qui, senza leggere il grafo;
  // il campo del metamodello e il vocabolario li controlla assertStepActionFields.
  it('un campo non riservato passa, anche se non è fra i quattro di prima', () => {
    for (const field of ['severity', 'priority', 'description', 'category', 'outcome', 'workaround']) {
      expect(() => assertStepActions(json(field), 'enter_actions')).not.toThrow()
    }
  })

  it('status è rifiutato in scrittura, e il rifiuto indica la transizione', () => {
    const err = thrown(json('status'))
    expect(err).toBeInstanceOf(GraphQLError)
    expect(err.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err.message).toContain('enter_actions dello step "chiusura"[0]')
    expect(err.message).toContain('is written by the workflow engine')
    expect(err.message).toContain('use a transition')
    expect((err.extensions['i18n'] as { key: string }).key).toBe('errors.stepField.engine_owned')
  })

  it('workflow_step, workflow_instance_id e le date del motore ricevono lo stesso rifiuto', () => {
    for (const field of ['workflow_step', 'workflow_instance_id', 'resolved_at', 'completed_at']) {
      expect(thrown(json(field)).message).toContain('is written by the workflow engine')
    }
  })

  it('identità e traccia sono rifiutate con la loro ragione', () => {
    for (const field of ['tenant_id', 'id', 'number', 'created_at']) {
      const err = thrown(json(field))
      expect(err.message).toContain('identifies or traces the ticket')
      expect((err.extensions['i18n'] as { key: string }).key).toBe('errors.stepField.identity')
    }
  })

  it('update_field senza campo è configurazione incompleta, non un no-op', () => {
    expect(thrown(JSON.stringify([{ type: 'update_field', params: {} }])).message).toContain('needs the field to write')
    expect(thrown(JSON.stringify([{ type: 'update_field', params: { field: '  ' } }])).message).toContain('needs the field to write')
  })

  it('le altre azioni non sono toccate da questo controllo', () => {
    expect(() => assertStepActions(JSON.stringify([{ type: 'sla_start', params: { sla_type: 'resolve' } }]), 'x')).not.toThrow()
  })
})

/** Verifica «Cosa resta cablato», ondata 1: una change creata da un passo non ha un tipo di ripiego. */
describe('assertStepActions — create_entity di una change', () => {
  const create = (params: Record<string, unknown>) => JSON.stringify([{ type: 'create_entity', params: { title_template: '{title}', link_to_current: true, ...params } }])

  it('senza change_type è rifiutata nel disegnatore, non a ticket aperto', () => {
    const err = thrown(create({ entity_type: 'change' }))
    expect(err.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err.message).toMatch(/needs the change type \(params\.change_type\)/)
  })

  it('con change_type, o per un altro tipo di ticket, passa', () => {
    expect(() => assertStepActions(create({ entity_type: 'change', change_type: 'normal' }), 'enter_actions')).not.toThrow()
    expect(() => assertStepActions(create({ entity_type: 'incident' }), 'enter_actions')).not.toThrow()
  })
})
