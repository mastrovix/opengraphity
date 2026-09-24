import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
}))

vi.mock('../../../lib/navigableGraph.js', () => ({
  getNavigableEntities: vi.fn().mockResolvedValue([
    { entityType: 'Application', label: 'Application', neo4jLabel: 'Application', fields: [], relations: [] },
  ]),
  getNavigableRelations: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../../lib/reportExecutor.js', () => ({
  executeReportSection: vi.fn().mockResolvedValue({ rows: [] }),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { customReportResolvers } = await import('../customReports.js')
const { getSession } = await import('@opengraphity/neo4j')

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(readRecords: Record<string, unknown>[][] = []) {
  let call = 0
  return {
    executeRead: vi.fn().mockImplementation(() =>
      Promise.resolve({
        records: (readRecords[call++] ?? []).map(r => ({ get: (k: string) => r[k] })),
      }),
    ),
    executeWrite: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

const mockCtx = {
  tenantId: 'tenant-1',
  userId:   'user-1',
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('reachableEntities — whitelist validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('label valida nella whitelist statica → non lancia errore', async () => {
    const session = makeSession([[]])
    vi.mocked(getSession).mockReturnValue(session as never)

    await expect(
      customReportResolvers.Query.reachableEntities(undefined, { fromNeo4jLabel: 'Application' }, mockCtx),
    ).resolves.toBeDefined()
  })

  it('label valida nel whitelist statico (Server) → non lancia errore', async () => {
    const session = makeSession([[]])
    vi.mocked(getSession).mockReturnValue(session as never)

    await expect(
      customReportResolvers.Query.reachableEntities(undefined, { fromNeo4jLabel: 'Server' }, mockCtx),
    ).resolves.toBeDefined()
  })

  it('label non in whitelist → lancia GraphQLError con code BAD_USER_INPUT', async () => {
    const session = makeSession([[]])
    vi.mocked(getSession).mockReturnValue(session as never)

    await expect(
      customReportResolvers.Query.reachableEntities(undefined, { fromNeo4jLabel: 'EVIL; DROP DATABASE' }, mockCtx),
    ).rejects.toThrow(GraphQLError)
  })

  it('label non in whitelist → messaggio errore contiene Invalid entity type', async () => {
    const session = makeSession([[]])
    vi.mocked(getSession).mockReturnValue(session as never)

    let thrown: GraphQLError | undefined
    try {
      await customReportResolvers.Query.reachableEntities(
        undefined,
        { fromNeo4jLabel: 'NotAllowed' },
        mockCtx,
      )
    } catch (err) {
      thrown = err as GraphQLError
    }

    expect(thrown).toBeInstanceOf(GraphQLError)
    expect(thrown!.message).toContain('Invalid entity type')
    expect(thrown!.extensions?.code).toBe('BAD_USER_INPUT')
  })

  it('label nel whitelist dinamico (da getNavigableEntities) → non lancia errore', async () => {
    // getNavigableEntities restituisce un label che è nella whitelist statica
    // (Application): verifica che il path dinamico funzioni
    const { getNavigableEntities } = await import('../../../lib/navigableGraph.js')
    vi.mocked(getNavigableEntities).mockResolvedValue([
      { entityType: 'Application', label: 'Application', neo4jLabel: 'Application', fields: [], relations: [] },
    ])

    const session = makeSession([[]])
    vi.mocked(getSession).mockReturnValue(session as never)

    await expect(
      customReportResolvers.Query.reachableEntities(undefined, { fromNeo4jLabel: 'Application' }, mockCtx),
    ).resolves.toBeDefined()
  })

  it('reachableEntities chiama getSession e poi executeRead', async () => {
    const session = makeSession([[], []])
    vi.mocked(getSession).mockReturnValue(session as never)

    await customReportResolvers.Query.reachableEntities(
      undefined,
      { fromNeo4jLabel: 'Incident' },
      mockCtx,
    )

    expect(getSession).toHaveBeenCalled()
    // executeRead può essere chiamato più volte (navigableEntities + query graph)
    expect(session.executeRead).toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()
  })

  it('restituisce array vuoto se nessuna relazione trovata', async () => {
    const session = makeSession([[]])
    vi.mocked(getSession).mockReturnValue(session as never)

    const result = await customReportResolvers.Query.reachableEntities(
      undefined,
      { fromNeo4jLabel: 'Change' },
      mockCtx,
    )

    expect(result).toEqual([])
  })
})

describe('reachableEntities — solo entità che il costruttore sa descrivere (#12)', () => {
  it('scarta i nodi tecnici collegati (audit, istanze di workflow), tiene i tipi navigabili', async () => {
    const session = makeSession([[
      { targetLabel: 'ChangeAuditEntry', relType: 'HAS_AUDIT', direction: 'outgoing' },
      { targetLabel: 'WorkflowInstance', relType: 'HAS_WORKFLOW', direction: 'outgoing' },
      { targetLabel: 'Application',      relType: 'DEPENDS_ON', direction: 'incoming' },
    ], [{ cnt: 3 }]])
    vi.mocked(getSession).mockReturnValue(session as never)
    const result = await customReportResolvers.Query.reachableEntities(undefined, { fromNeo4jLabel: 'Application' }, mockCtx)
    expect(result.map((r) => r.neo4jLabel)).toEqual(['Application'])
  })
})

describe('ALLOWED_NEO4J_LABELS — copertura etichette attese', () => {
  const EXPECTED_LABELS = [
    'ConfigurationItem', 'Application', 'Server', 'Database', 'DatabaseInstance',
    'Certificate', 'Incident', 'Change', 'Problem', 'ServiceRequest',
    'Team', 'User', 'WorkflowDefinition', 'WorkflowInstance', 'ReportTemplate',
  ]

  it.each(EXPECTED_LABELS)('label "%s" è nella whitelist', async (label) => {
    const session = makeSession([[]])
    vi.mocked(getSession).mockReturnValue(session as never)

    await expect(
      customReportResolvers.Query.reachableEntities(undefined, { fromNeo4jLabel: label }, mockCtx),
    ).resolves.toBeDefined()
  })
})

// Review of 23 Sep 2026: the schedule form read notificationChannels (config.notifications).
describe('reportDeliveryChannels — what a scheduled report can be sent to', () => {
  it('only the tenant\'s active Slack channels, id and name, never the webhook', async () => {
    const run = vi.fn().mockResolvedValue({ records: [{ get: (k: string) => ({ id: 'ch1', name: '#ops' } as Record<string, string>)[k] }] })
    const session = { executeRead: vi.fn((fn: (tx: unknown) => unknown) => fn({ run })), close: vi.fn().mockResolvedValue(undefined) }
    vi.mocked(getSession).mockReturnValue(session as never)
    const out = await customReportResolvers.Query.reportDeliveryChannels(undefined, {}, mockCtx as never)
    expect(out).toEqual([{ id: 'ch1', name: '#ops' }])
    const [cypher, params] = run.mock.calls[0]!
    expect(cypher).toContain("c.platform = 'slack' AND c.active = true")
    expect(cypher).not.toContain('webhook')
    expect(params).toEqual({ tenantId: 'tenant-1' })
  })
})
