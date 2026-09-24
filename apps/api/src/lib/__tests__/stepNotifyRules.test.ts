/**
 * The «notify on enter» of a step, published from the engine's hook for every
 * path and ticket type (review of 23 Sep 2026). Moved here from the resolver,
 * with the cases it had there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let row: Record<string, unknown> | null = null
const queries: Array<{ cypher: string; params: Record<string, unknown> }> = []
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn() })),
  runQueryOne: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => { queries.push({ cypher, params }); return row }),
}))
const publish = vi.fn()
vi.mock('@opengraphity/events', () => ({ publish: (...a: unknown[]) => publish(...a) }))

const { publishStepNotifyRules } = await import('../stepNotifyRules.js')

const base = { tenantId: 't-1', instanceId: 'wi-1', stepName: 'fulfilled', actorId: 'u-1', entityType: 'service_request', entityId: 'sr-1' }

beforeEach(() => { row = null; queries.length = 0; publish.mockReset() })

describe('publishStepNotifyRules', () => {
  it('each notify_rule publishes workflow.step.entered, with the step label as fallback title', async () => {
    row = { enterActions: JSON.stringify([{ type: 'notify_rule', params: { title_key: 'k' } }, { type: 'publish_event' }, { type: 'notify_rule' }]), stepLabel: 'Fulfilled' }
    await expect(publishStepNotifyRules(base)).resolves.toBe(2)
    expect(queries[0]!.params).toEqual({ instanceId: 'wi-1', stepName: 'fulfilled', tenantId: 't-1' })
    expect(publish.mock.calls[0]![0]).toMatchObject({
      type: 'workflow.step.entered', tenant_id: 't-1', actor_id: 'u-1',
      payload: { stepName: 'fulfilled', stepLabel: 'Fulfilled', entityType: 'service_request', entityId: 'sr-1', notifyRule: { title_key: 'k' } },
    })
    expect(publish.mock.calls[1]![0]).toMatchObject({ payload: { notifyRule: {} } })
  })

  it('a step without a label uses its name; without enter actions, or without the step, nothing is published', async () => {
    row = { enterActions: JSON.stringify([{ type: 'notify_rule' }]), stepLabel: null }
    await publishStepNotifyRules(base)
    expect(publish.mock.calls[0]![0]).toMatchObject({ payload: { stepLabel: 'fulfilled' } })
    publish.mockReset()
    row = { enterActions: null, stepLabel: 'R' }
    await expect(publishStepNotifyRules(base)).resolves.toBe(0)
    row = null
    await expect(publishStepNotifyRules(base)).resolves.toBe(0)
    expect(publish).not.toHaveBeenCalled()
  })

  it('corrupt enter_actions are said, naming the step', async () => {
    row = { enterActions: '[oops', stepLabel: 'R' }
    await expect(publishStepNotifyRules(base)).rejects.toThrow(/Corrupt enter_actions JSON on step "fulfilled"/)
  })
})
