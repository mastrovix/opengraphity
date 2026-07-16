import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

// ── Session mock usato da withSession ─────────────────────────────────────────

const mockSession = {
  executeRead:  vi.fn().mockResolvedValue({ records: [] }),
  executeWrite: vi.fn().mockResolvedValue({ records: [] }),
  close:        vi.fn().mockResolvedValue(undefined),
}

// ── Mocks ─────────────────────────────────────────────────────────────────────
// ci-utils viene mockato solo per withSession/runQuery/runQueryOne:
// mapCI e ciTypeFromLabels restano quelli reali, così i test verificano il
// mapping vero label → type (DynamicCIGroup incluso).

vi.mock('../ci-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ci-utils.js')>()
  return {
    ...actual,
    withSession: vi.fn().mockImplementation(
      async (fn: (s: unknown) => Promise<unknown>, _write?: boolean) => fn(mockSession),
    ),
    runQuery:    vi.fn().mockResolvedValue([]),
    runQueryOne: vi.fn().mockResolvedValue(null),
  }
})

// ── Import after mocks ────────────────────────────────────────────────────────

const { ciGroupResolvers, criteriaTypesToLabels } = await import('../ciGroup.js')
const { runQuery, runQueryOne } = await import('../ci-utils.js')

const ciGroupMembers = ciGroupResolvers.Query.ciGroupMembers

// ── Test context / helpers ────────────────────────────────────────────────────

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'user@test.io', role: 'operator' }

type Row = Record<string, unknown>

function primeGroup(props: Row | null) {
  vi.mocked(runQueryOne).mockResolvedValue(props ? { props } : null)
}

function primeMembers(rows: { props: Row; nodeLabels: string[] }[]) {
  vi.mocked(runQuery).mockResolvedValue(rows as never)
}

/** Cypher e params dell'unica chiamata runQuery (la member query). */
function memberQueryCall(): { cypher: string; params: Record<string, unknown> } {
  expect(vi.mocked(runQuery)).toHaveBeenCalledTimes(1)
  const call = vi.mocked(runQuery).mock.calls[0]!
  return { cypher: call[1] as string, params: call[2] as Record<string, unknown> }
}

const serverRow = (id: string, name: string): { props: Row; nodeLabels: string[] } => ({
  props: { id, name, status: 'active', environment: 'production', created_at: '2026-01-01T00:00:00Z' },
  nodeLabels: ['Server'],
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ciGroupMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQuery).mockResolvedValue([])
    vi.mocked(runQueryOne).mockResolvedValue(null)
  })

  it('gruppo inesistente → GraphQLError NOT_FOUND, nessuna member query', async () => {
    primeGroup(null)
    await expect(ciGroupMembers(null, { groupId: 'missing' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(runQuery).not.toHaveBeenCalled()
    // il lookup del gruppo è tenant-scoped
    const lookup = vi.mocked(runQueryOne).mock.calls[0]!
    expect(lookup[1]).toContain('DynamicCIGroup')
    expect(lookup[2]).toMatchObject({ groupId: 'missing', tenantId: 'tenant-1' })
  })

  it('manual → traversa HAS_MEMBER, tenant-scoped, membri mappati con type dai label', async () => {
    primeGroup({ id: 'g1', membership_type: 'manual' })
    primeMembers([
      { props: { id: 'ci-1', name: 'billing-db', status: 'active', environment: 'production', created_at: '2026-01-01T00:00:00Z' }, nodeLabels: ['Database'] },
      serverRow('ci-2', 'srv-billing-01'),
    ])

    const result = await ciGroupMembers(null, { groupId: 'g1' }, ctx)

    const { cypher, params } = memberQueryCall()
    expect(cypher).toContain('[:HAS_MEMBER]->(m)')
    expect(cypher).toContain('m.tenant_id = $tenantId')
    expect(params).toMatchObject({ groupId: 'g1', tenantId: 'tenant-1' })

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ id: 'ci-1', name: 'billing-db', type: 'database' })
    expect(result[1]).toMatchObject({ id: 'ci-2', name: 'srv-billing-01', type: 'server' })
  })

  it('dynamic → label whitelist dai criteri, type sconosciuti ignorati silenziosamente', async () => {
    primeGroup({
      id: 'g2',
      membership_type:    'dynamic',
      criteria_ci_types:  'server, nonexistent_type, application',
      criteria_environment: 'production',
      criteria_status:      'active',
      criteria_name_contains: 'prod',
    })
    primeMembers([serverRow('ci-9', 'prod-srv')])

    const result = await ciGroupMembers(null, { groupId: 'g2' }, ctx)

    const { cypher, params } = memberQueryCall()
    expect(cypher).toContain('m:Server')
    expect(cypher).toContain('m:Application')
    // il type sconosciuto non produce alcun label (né Cypher injection)
    expect(cypher).not.toContain('nonexistent')
    expect(cypher).not.toContain('HAS_MEMBER')
    expect(params).toMatchObject({
      tenantId:     'tenant-1',
      environment:  'production',
      status:       'active',
      nameContains: 'prod',
    })
    expect(result).toEqual([expect.objectContaining({ id: 'ci-9', type: 'server' })])
  })

  it('dynamic con ciTypes vuoto → tutte le label CI, ma MAI DynamicCIGroup (no gruppi di gruppi)', async () => {
    primeGroup({ id: 'g3', membership_type: 'dynamic', criteria_ci_types: '' })
    primeMembers([])

    await ciGroupMembers(null, { groupId: 'g3' }, ctx)

    const { cypher, params } = memberQueryCall()
    // tutte le label note...
    expect(cypher).toContain('m:Server')
    expect(cypher).toContain('m:Application')
    expect(cypher).toContain('m:Database')
    // ...ma i gruppi sono esclusi: l'unica occorrenza di m:DynamicCIGroup è
    // la clausola di esclusione, mai il predicato label
    expect(cypher).toContain('NOT m:DynamicCIGroup')
    expect((cypher.match(/m:DynamicCIGroup/g) ?? []).length).toBe(1)
    // criteri non valorizzati → param null (nessun filtro)
    expect(params).toMatchObject({ environment: null, status: null, nameContains: null })
    expect(params['tenantId']).toBe('tenant-1')
  })

  it('dynamic che chiede esplicitamente dynamic_ci_group → label esclusa comunque', async () => {
    primeGroup({ id: 'g4', membership_type: 'dynamic', criteria_ci_types: 'dynamic_ci_group,server' })
    primeMembers([])

    await ciGroupMembers(null, { groupId: 'g4' }, ctx)

    const { cypher } = memberQueryCall()
    expect(cypher).toContain('m:Server')
    // solo la clausola NOT, mai nel predicato label
    expect((cypher.match(/m:DynamicCIGroup/g) ?? []).length).toBe(1)
  })

  it('membershipType assente → fallback manual (HAS_MEMBER)', async () => {
    primeGroup({ id: 'g5' })
    primeMembers([])

    await ciGroupMembers(null, { groupId: 'g5' }, ctx)

    const { cypher } = memberQueryCall()
    expect(cypher).toContain('HAS_MEMBER')
  })
})

describe('criteriaTypesToLabels', () => {
  it('CSV → label dedupe, whitelist-only, gruppo escluso', () => {
    expect(criteriaTypesToLabels('server, application , server')).toEqual(['Server', 'Application'])
    expect(criteriaTypesToLabels('bogus, MALICIOUS) DETACH DELETE (n')).toEqual([])
    expect(criteriaTypesToLabels('dynamic_ci_group')).toEqual([])
    expect(criteriaTypesToLabels(null)).toEqual([])
    expect(criteriaTypesToLabels('SERVER')).toEqual(['Server'])
  })
})
