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
import { UPDATE_FIELD_ALLOWED } from '@opengraphity/types'

vi.mock('@opengraphity/events', () => ({ publish: vi.fn().mockResolvedValue(undefined), getRedisOptions: vi.fn(() => ({})) }))
// Vocabolario del motore COMPLETO per la parte che serve qui: `update_field`
// deve superare il controllo di tipo e arrivare a quello sul campo.
const ACTIONS = ['publish_event', 'notify_rule', 'update_field', 'sla_start'] as const
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
  it('i campi ammessi passano', () => {
    for (const field of UPDATE_FIELD_ALLOWED) {
      expect(() => assertStepActions(json(field), 'enter_actions')).not.toThrow()
    }
  })

  it('status è rifiutato in scrittura, e il rifiuto indica la transizione', () => {
    const err = thrown(json('status'))
    expect(err).toBeInstanceOf(GraphQLError)
    expect(err.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err.message).toContain('enter_actions dello step "chiusura"[0]')
    expect(err.message).toContain('lo scrive il motore dei workflow')
    expect(err.message).toContain('usa una transizione')
    expect(err.extensions['allowedFields']).toEqual([...UPDATE_FIELD_ALLOWED])
  })

  it('workflow_step e workflow_instance_id, che sono del motore, ricevono lo stesso rifiuto', () => {
    for (const field of ['workflow_step', 'workflow_instance_id']) {
      expect(thrown(json(field)).message).toContain('lo scrive il motore dei workflow')
    }
  })

  it('un campo qualunque fuori lista è rifiutato nominando i campi ammessi', () => {
    const err = thrown(json('tenant_id'))
    expect(err.message).toContain('non è fra quelli che update_field può scrivere')
    expect(err.message).toContain(UPDATE_FIELD_ALLOWED.join(', '))
  })

  it('update_field senza campo è configurazione incompleta, non un no-op', () => {
    expect(thrown(JSON.stringify([{ type: 'update_field', params: {} }])).message).toContain('richiede il campo da scrivere')
    expect(thrown(JSON.stringify([{ type: 'update_field', params: { field: '  ' } }])).message).toContain('richiede il campo da scrivere')
  })

  it('le altre azioni non sono toccate da questo controllo', () => {
    expect(() => assertStepActions(JSON.stringify([{ type: 'sla_start', params: { sla_type: 'resolve' } }]), 'x')).not.toThrow()
  })
})
