/**
 * Tenant lifecycle — the paths the main suite does not reach.
 *
 * - When the admin list cannot be read the console must still list tenants,
 *   with an EMPTY admin list and a warning, rather than failing the page.
 * - `tenantFootprint` is what the purge confirmation shows: the operator reads
 *   these numbers before deleting a customer, so they must be per label,
 *   numeric and scoped to that tenant only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const warn = vi.fn()
vi.mock('../logger.js', () => ({ logger: { child: () => ({ warn: (...a: unknown[]) => warn(...a), info: vi.fn(), error: vi.fn() }) } }))
vi.mock('../config.js', () => ({ config: { tenantUrlTemplate: 'https://{slug}.example.io', portalUrlTemplate: '' } }))

let adminsFail = false
let footprint: Array<Record<string, unknown>> = []
const calls: Array<{ q: string; p: Record<string, unknown> }> = []
vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, q: string, p: Record<string, unknown>) => {
    calls.push({ q, p })
    if (q.includes('MATCH (t:Tenant)')) return [{ id: 'acme', slug: null, name: null, plan: null, timezone: null, suspendedAt: null, createdAt: null }]
    if (q.includes("u.role = 'admin'")) { if (adminsFail) throw new Error('neo4j busy'); return [] }
    if (q.includes('labels(n)[0]')) return footprint
    return []
  }),
  runQueryOne: vi.fn(async () => ({ utenti: 1, ticket: 4 })),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))

const { listTenants, tenantFootprint } = await import('../tenantLifecycle.js')

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  adminsFail = false
})

describe('listTenants when the admins cannot be read', () => {
  it('still lists the tenant, with no admins, and warns', async () => {
    adminsFail = true
    const [row] = await listTenants({} as never)
    expect(row).toMatchObject({ id: 'acme', slug: 'acme', name: 'acme', admins: [], utenti: 1, ticket: 4, stato: 'active' })
    expect(warn).toHaveBeenCalledWith({ err: expect.any(Error) }, 'tenant admins unavailable')
  })

  it('builds the app URL from the template and no portal URL from an empty one', async () => {
    const [row] = await listTenants({} as never)
    expect(row!.appUrl).toBe('https://acme.example.io')
    expect(row!.portalUrl).toBeNull()
  })
})

describe('tenantFootprint', () => {
  it('returns node counts per label for that tenant only, as numbers', async () => {
    footprint = [{ etichetta: 'Incident', quanti: '12' }, { etichetta: 'User', quanti: 3 }]
    expect(await tenantFootprint({} as never, 'acme')).toEqual({ Incident: 12, User: 3 })
    const q = calls.find((c) => c.q.includes('labels(n)[0]'))!
    expect(q.q).toContain('MATCH (n {tenant_id: $id})')
    expect(q.p).toEqual({ id: 'acme' })
  })

  it('an empty tenant has an empty footprint', async () => {
    footprint = []
    expect(await tenantFootprint({} as never, 'empty')).toEqual({})
  })
})
