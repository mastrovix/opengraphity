/**
 * lib/labelReadAccess.ts — which node labels a role may not read (review of
 * 23 Sep 2026, wave 2). Roles are per area and per ticket type: the paths that
 * read the graph by label (report sections, the report AI) follow the same
 * rule as the GraphQL operations.
 */
import { describe, it, expect, vi } from 'vitest'

const ciLabelsForTenant = vi.fn(async (_t: string) => ['DatabaseInstance', 'Server', 'Turbine'])
vi.mock('../ciLabelsForTenant.js', () => ({ ciLabelsForTenant: (t: string) => ciLabelsForTenant(t) }))

const { labelsClosedTo } = await import('../labelReadAccess.js')

describe('labelsClosedTo', () => {
  it('closes each ticket type the role cannot read, and nothing it can', async () => {
    const closed = await labelsClosedTo('t1', new Set(['request.read', 'cmdb.read']))
    expect([...closed].sort()).toEqual(['Change', 'Incident', 'KBArticle', 'Problem'])
    expect(ciLabelsForTenant).not.toHaveBeenCalled()
  })

  it('without cmdb.read every CI label is closed, the tenant\'s own types included', async () => {
    const closed = await labelsClosedTo('t1', new Set(['incident.read', 'problem.read', 'change.read', 'request.read', 'kb.read']))
    expect([...closed].sort()).toEqual(['ConfigurationItem', 'DatabaseInstance', 'Server', 'Turbine'])
    expect(ciLabelsForTenant).toHaveBeenCalledWith('t1')
  })

  it('a role that reads everything has nothing closed', async () => {
    expect((await labelsClosedTo('t1', new Set(['incident.read', 'problem.read', 'change.read', 'request.read', 'kb.read', 'cmdb.read']))).size).toBe(0)
  })
})
