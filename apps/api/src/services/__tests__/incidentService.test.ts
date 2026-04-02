import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Session mock usato da withSession ─────────────────────────────────────────

const mockSession = {
  executeRead:  vi.fn().mockResolvedValue({ records: [] }),
  executeWrite: vi.fn().mockResolvedValue({ records: [] }),
  close:        vi.fn().mockResolvedValue(undefined),
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@opengraphity/events', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance: vi.fn().mockResolvedValue({ id: 'wi-1' }),
    transition:     vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
  runQuery:   vi.fn(),
}))

vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(
    async (fn: (s: unknown) => Promise<unknown>, _write?: boolean) => fn(mockSession),
  ),
  getSession: vi.fn(),
}))

vi.mock('../../lib/mappers.js', () => ({
  mapIncident: vi.fn((props: Record<string, unknown>) => ({
    id:       props['id'],
    title:    props['title'],
    severity: props['severity'],
    status:   props['status'],
  })),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { createIncident, resolveIncident, escalateIncident } = await import('../incidentService.js')
const { publish } = await import('@opengraphity/events')
const { workflowEngine } = await import('@opengraphity/workflow')
const { runQuery } = await import('@opengraphity/neo4j')

// ── Test context ──────────────────────────────────────────────────────────────

const ctx = { tenantId: 'tenant-1', userId: 'user-1' }

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('createIncident', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // runQuery must return an array with a row that mapIncident can use
    vi.mocked(runQuery).mockResolvedValue([
      { props: { id: 'inc-1', title: 'Test incident', severity: 'high', status: 'open' } },
    ])
  })

  it('chiama publish con type incident.created', async () => {
    await createIncident(
      { title: 'Test incident', severity: 'high' },
      ctx,
    )

    expect(publish).toHaveBeenCalledOnce()
    const event = vi.mocked(publish).mock.calls[0]![0] as { type: string }
    expect(event.type).toBe('incident.created')
  })

  it('chiama workflowEngine.createInstance', async () => {
    await createIncident(
      { title: 'Test incident', severity: 'high' },
      ctx,
    )

    expect(workflowEngine.createInstance).toHaveBeenCalledOnce()
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(
      mockSession,
      ctx.tenantId,
      expect.any(String),  // generated uuid
      'incident',
    )
  })

  it('include tenantId e severity nell\'evento', async () => {
    await createIncident(
      { title: 'Alert critico', severity: 'critical' },
      ctx,
    )

    const event = vi.mocked(publish).mock.calls[0]![0] as { tenant_id: string; payload: { severity: string } }
    expect(event.tenant_id).toBe('tenant-1')
    expect(event.payload.severity).toBe('critical')
  })
})

describe('resolveIncident', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQuery).mockResolvedValue([
      { props: { id: 'inc-1', title: 'Test incident', severity: 'high', status: 'resolved' } },
    ])
    mockSession.executeRead.mockResolvedValue({ records: [] })
  })

  it('chiama publish con type incident.resolved', async () => {
    await resolveIncident('inc-1', ctx, 'Root cause identificata')

    expect(publish).toHaveBeenCalledOnce()
    const event = vi.mocked(publish).mock.calls[0]![0] as { type: string }
    expect(event.type).toBe('incident.resolved')
  })

  it('include resolved_at nel payload', async () => {
    await resolveIncident('inc-1', ctx)

    const event = vi.mocked(publish).mock.calls[0]![0] as { payload: { resolved_at?: string } }
    expect(event.payload.resolved_at).toBeDefined()
  })
})

describe('escalateIncident', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.executeRead.mockResolvedValue({ records: [] })
  })

  it('chiama publish con type incident.escalated', async () => {
    await escalateIncident('inc-1', ctx)

    expect(publish).toHaveBeenCalledOnce()
    const event = vi.mocked(publish).mock.calls[0]![0] as { type: string }
    expect(event.type).toBe('incident.escalated')
  })

  it('include actor_id nell\'evento', async () => {
    await escalateIncident('inc-2', { tenantId: 'tenant-1', userId: 'admin-99' })

    const event = vi.mocked(publish).mock.calls[0]![0] as { actor_id: string }
    expect(event.actor_id).toBe('admin-99')
  })
})
