/**
 * workflow.ts — THE WAY OUT OF A TENANT WITHOUT WORKFLOWS, AND THE LABEL CONTRACT.
 *
 * `provisionTenantData` / `tenantProvisioningGaps` are the page-level remedy
 * for a tenant that cannot open tickets (no workflow definition, no roles…).
 * What must hold:
 *  - only a system administrator may read the gaps or run the provisioning:
 *    it writes roles, workflows and domain matrices for the whole tenant;
 *  - provisioning runs in a WRITE session, then invalidates BOTH the workflow
 *    step cache and the metamodel schema (it seeds domain matrices too: a
 *    stale schema kept the old matrices until restart);
 *  - it is audited, and it answers with the gaps that are STILL open, read
 *    after the write, so the page does not claim "all fixed" on stale data.
 *
 * The `labels` field resolvers refuse a parent whose producer forgot to load
 * the translated labels: an empty list would silently show only the base
 * label in every language.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const h = vi.hoisted(() => ({
  events: [] as string[],
  sessionModes: [] as boolean[],
  gaps: [] as Array<{ kind: string; params?: Record<string, string> }>,
}))

vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>, write = false) => {
    h.sessionModes.push(write)
    return fn({ fake: 'session' })
  }),
  getSession: vi.fn(),
}))

vi.mock('../../../lib/provisionTenantData.js', () => ({
  provisionTenantData: vi.fn(async (_s: unknown, tenantId: string, opts: { userId: string }) => {
    h.events.push(`provision:${tenantId}:${opts.userId}`)
    // After provisioning only one gap is left.
    h.gaps = [{ kind: 'no_teams' }]
    return {
      rolesCreated: ['admin'], dashboardCreated: true, notificationRulesCreated: 3,
      matricesCreated: ['impact'], portalSeveritiesSeeded: null, defaultLanguageSeeded: null,
      workflows: [{ name: 'Incident', created: true }, { name: 'Change', created: null }],
    }
  }),
  tenantProvisioningGaps: vi.fn(async (_s: unknown, tenantId: string) => {
    h.events.push(`gaps:${tenantId}`)
    return h.gaps
  }),
}))

vi.mock('../../../lib/workflowHelpers.js', () => ({
  invalidateWorkflowCache: vi.fn((t: string) => { h.events.push(`invalidateWorkflow:${t}`) }),
}))
vi.mock('../../../lib/schemaInvalidator.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invalidateSchema: vi.fn((t: string) => { h.events.push(`invalidateSchema:${t}`) }),
}))
vi.mock('../../../lib/audit.js', () => ({
  audit: vi.fn(async (_c: unknown, action: string, _e: string, _id: string, details: unknown) => {
    h.events.push(`audit:${action}:${JSON.stringify(details)}`)
  }),
}))
const fakeLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fakeLog() })
vi.mock('../../../lib/logger.js', () => ({ logger: fakeLog(), workflowLogger: fakeLog() }))
vi.mock('@opengraphity/events', () => ({ publish: vi.fn(), getRedisOptions: vi.fn(() => ({})) }))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn(), transition: vi.fn(), registerCondition: vi.fn(), getAvailableTransitions: vi.fn() },
  WORKFLOW_ACTION_TYPES: [],
  isWorkflowActionType: () => false,
}))
vi.mock('@opengraphity/notifications', () => ({ sseManager: { sendToUser: vi.fn() } }))
vi.mock('../../../services/incidentService.js', () => ({ publishIncidentTransition: vi.fn() }))

const { workflowResolvers } = await import('../workflow.js')

const admin: GraphQLContext = { tenantId: 'c-two', userId: 'user-1', userEmail: 'a@test.io', role: 'admin', permissions: perms('admin') }
const operator: GraphQLContext = { ...admin, userId: 'user-2', role: 'operator', permissions: perms('operator') }

beforeEach(() => {
  h.events.length = 0
  h.sessionModes.length = 0
  h.gaps = [{ kind: 'no_workflows', params: { entity: 'incident' } }, { kind: 'no_teams' }]
})

describe('tenantProvisioningGaps', () => {
  it('lists what this tenant is missing, with params as name/value pairs', async () => {
    const out = await workflowResolvers.Query.tenantProvisioningGaps(null, {}, admin)
    expect(out).toEqual([
      { kind: 'no_workflows', params: [{ name: 'entity', value: 'incident' }] },
      { kind: 'no_teams', params: [] },
    ])
    expect(h.events).toEqual(['gaps:c-two'])
  })

  it('is refused to a user without admin.system, before reading anything', async () => {
    await expect(workflowResolvers.Query.tenantProvisioningGaps(null, {}, operator)).rejects.toThrow()
    expect(h.events).toEqual([])
  })
})

describe('provisionTenantData', () => {
  it('provisions in a write session, invalidates both caches, audits, then reports the gaps still open', async () => {
    const out = await workflowResolvers.Mutation.provisionTenantData(null, {}, admin)

    expect(out).toEqual({
      rolesCreated: ['admin'],
      dashboardCreated: true,
      notificationRulesCreated: 3,
      matricesCreated: ['impact'],
      workflows: ['Incident', 'Change'],
      remainingGaps: [{ kind: 'no_teams', params: [] }],
    })
    expect(h.sessionModes[0]).toBe(true)
    expect(h.events).toEqual([
      'provision:c-two:user-1',
      'invalidateWorkflow:c-two',
      'invalidateSchema:c-two',
      `audit:tenant.provisioned:${JSON.stringify({ roles: ['admin'], dashboard: true, notificationRules: 3, matrices: ['impact'], workflows: ['Incident', 'Change'] })}`,
      // Gaps are read AFTER the write, so the answer reflects the new state.
      'gaps:c-two',
    ])
  })

  it('is refused to a user without admin.system, and writes nothing', async () => {
    await expect(workflowResolvers.Mutation.provisionTenantData(null, {}, operator)).rejects.toThrow()
    expect(h.events).toEqual([])
  })
})

describe('labels field resolvers', () => {
  const cases = [
    ['WorkflowStep', workflowResolvers.WorkflowStep.labels],
    ['WorkflowTransition', workflowResolvers.WorkflowTransition.labels],
    ['WorkflowTransitionDef', workflowResolvers.WorkflowTransitionDef.labels],
  ] as const

  it.each(cases)('%s returns the labels its producer loaded', (_name, resolve) => {
    const labels = [{ locale: 'it', label: 'Nuovo' }]
    expect(resolve({ label: 'New', labels })).toBe(labels)
    // An explicitly empty list is a loaded answer ("no translations"), not a mistake.
    expect(resolve({ label: 'New', labels: [] })).toEqual([])
  })

  it.each(cases)('%s refuses a parent whose labels were never loaded, naming it', (name, resolve) => {
    expect(() => resolve({ label: 'New' })).toThrow(`${name} "New": the producer did not load its labels`)
  })
})
