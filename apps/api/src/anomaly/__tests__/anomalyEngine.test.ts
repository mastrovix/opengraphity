import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────────

const queueAdd = vi.fn().mockResolvedValue(undefined)
const workerOn = vi.fn()

// vitest 4: a mock is constructible (`new Queue(...)`) only when its
// implementation is a `function`/class, not an arrow function.
vi.mock('bullmq', () => ({
  Queue:  vi.fn(function () { return { add: queueAdd, on: vi.fn(), close: vi.fn().mockResolvedValue(undefined), name: 'anomaly-scanner' } }),
  Worker: vi.fn(function () { return { on: workerOn, close: vi.fn().mockResolvedValue(undefined) } }),
}))

vi.mock('ioredis', () => ({ Redis: vi.fn() }))

// Sessions: `MATCH (t:Tenant)` → two tenants; every other query → no rows.
const executeRead = vi.fn(async (fn: (tx: { run: (q: string) => Promise<{ records: unknown[] }> }) => unknown) =>
  fn({ run: async (q: string) => ({
    records: q.includes('(t:Tenant)')
      ? [{ get: () => 'tenant-a' }, { get: () => 'tenant-b' }]
      : [],
  }) }),
)
const executeWrite = vi.fn(async (fn: (tx: { run: () => Promise<{ records: unknown[] }> }) => unknown) =>
  fn({ run: async () => ({ records: [] }) }),
)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ executeRead, executeWrite, close: vi.fn().mockResolvedValue(undefined) })),
}))

vi.mock('@opengraphity/notifications', () => ({
  sendSlackMessage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/workflowHelpers.js', () => ({
  getTerminalStepNames: vi.fn().mockResolvedValue(['closed']),
}))

vi.mock('../rules.js', () => ({
  ANOMALY_RULES: [
    {
      key:    'test_rule',
      title:  'Test Rule',
      cypher: 'MATCH (n) RETURN n.id AS entityId, "server" AS entityType, "" AS entitySubtype, n.name AS entityName, "desc" AS description, "medium" AS severity',
    },
  ],
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { startAnomalyScanner, getAnomalyScannerQueue, enqueueTenantScan, anomalyScannerProcessor } = await import('../anomalyEngine.js')
const { Worker } = await import('bullmq')

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('startAnomalyScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getAnomalyScannerQueue restituisce il singleton con metodo add', () => {
    const q = getAnomalyScannerQueue()
    expect(typeof q.add).toBe('function')
    expect(getAnomalyScannerQueue()).toBe(q)
  })

  it('istanzia Worker con nome anomaly-scanner e connection', async () => {
    await startAnomalyScanner()
    expect(Worker).toHaveBeenCalledWith(
      'anomaly-scanner',
      expect.any(Function),
      expect.objectContaining({ connection: expect.any(Object) }),
    )
  })

  it('registra il job ripetibile scan (tutti i tenant) e lo attende', async () => {
    await startAnomalyScanner()
    expect(queueAdd).toHaveBeenCalledWith(
      'scan',
      {},
      expect.objectContaining({ repeat: expect.any(Object), jobId: 'anomaly-scanner-scan' }),
    )
  })

  it('registra gli handler failed E error sul worker (A-06)', async () => {
    await startAnomalyScanner()
    const events = workerOn.mock.calls.map(c => c[0])
    expect(events).toContain('failed')
    expect(events).toContain('error')
  })
})

describe('enqueueTenantScan (C-18)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accoda scan-manual con il SOLO tenantId del chiamante', async () => {
    await enqueueTenantScan('tenant-a')
    expect(queueAdd).toHaveBeenCalledWith(
      'scan-manual',
      { tenantId: 'tenant-a' },
      expect.objectContaining({ jobId: expect.stringMatching(/^manual-tenant-a-\d+$/) }),
    )
  })
})

describe('anomalyScannerProcessor (C-18)', () => {
  beforeEach(() => vi.clearAllMocks())

  // Per scanned tenant (no hits): autoResolveStale + persistScanStatus = 2 executeWrite
  const WRITES_PER_TENANT = 2
  const tenantsScanned = () => executeWrite.mock.calls.length / WRITES_PER_TENANT

  it('con tenantId scansiona SOLO quel tenant', async () => {
    await anomalyScannerProcessor({ name: 'scan-manual', data: { tenantId: 'tenant-a' } } as never)
    expect(tenantsScanned()).toBe(1)
    // loadTenants must NOT have been called: the only executeRead is the rule query
    expect(executeRead.mock.calls.length).toBe(1)
  })

  it('senza tenantId (job schedulato) scansiona tutti i tenant', async () => {
    await anomalyScannerProcessor({ name: 'scan', data: {} } as never)
    expect(tenantsScanned()).toBe(2)
    expect(executeRead.mock.calls.length).toBe(1 + 2)  // loadTenants + one rule query per tenant
  })
})
