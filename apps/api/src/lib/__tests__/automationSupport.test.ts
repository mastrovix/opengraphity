/**
 * AU-1: la tabella evento × ticket è quella che il consumatore esegue, e la
 * validazione in scrittura rifiuta le combinazioni che non girano.
 */
import { describe, it, expect, vi } from 'vitest'
import { AUTOMATION_EVENT_ENTITIES, TRIGGER_EVENT_TYPES, RULE_EVENT_TYPES } from '@opengraphity/types'

vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), getSession: vi.fn() }))
vi.mock('@opengraphity/sla', () => ({ selectSLAForEntity: vi.fn(), getTenantTimezone: vi.fn() }))

const { assertEventSupported } = await import('../../graphql/resolvers/automation.js')

describe('combinazioni evento × ticket', () => {
  it('ogni evento offerto ha almeno un ticket su cui gira', () => {
    for (const e of [...TRIGGER_EVENT_TYPES, ...RULE_EVENT_TYPES]) expect(AUTOMATION_EVENT_ENTITIES[e].length, e).toBeGreaterThan(0)
  })
  it('una combinazione che non gira è rifiutata nominando dove gira', () => {
    expect(() => assertEventSupported('on_update', 'change')).toThrow(/runs for incident, problem, service_request/)
    expect(() => assertEventSupported('on_sla_breach', 'change')).toThrow()
    expect(() => assertEventSupported('on_transition', 'change')).not.toThrow()
    expect(() => assertEventSupported('on_create', 'service_request')).not.toThrow()
  })
})
