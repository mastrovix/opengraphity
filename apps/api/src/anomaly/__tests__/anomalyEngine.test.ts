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
  buildAnomalyRule: vi.fn((key: string, settings: { severity: string }) => ({
    key,
    title:  'Test Rule',
    description: 'desc',
    cypher: 'MATCH (n) RETURN n.id AS entityId, "server" AS entityType, "" AS entitySubtype, n.name AS entityName, "desc" AS description, {} AS params, $severity AS severity',
    params: { severity: settings.severity, threshold: null, incidentSeverities: [] },
  })),
}))

// Ondata 5 di «Nulla cablato»: le regole vengono dalla configurazione del
// cliente. Una accesa e una spenta: la spenta non esegue query ma chiude le
// sue anomalie aperte (una scrittura).
vi.mock('../ruleConfig.js', () => {
  const base = { severity: 'medium', ciTypes: [], relations: [], threshold: null, incidentSeverities: [], forbidden: [], isDefault: false, updatedAt: null }
  return {
    loadAnomalyRuleConfigs: vi.fn(async () => [
      { ...base, ruleKey: 'orphan_ci', enabled: true },
      { ...base, ruleKey: 'missing_owner', enabled: false },
    ]),
    anomalyRuleOptions: vi.fn(async () => ({ ciTypes: [], relations: [], incidentSeverities: [] })),
    anomalyRuleProblem: vi.fn(() => null),
  }
})

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

  // Per scanned tenant (no hits): autoResolveStale della regola accesa + chiusura
  // di quella spenta + persistScanStatus = 3 executeWrite
  const WRITES_PER_TENANT = 3
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

  it('una regola spenta non esegue query e chiude le sue anomalie aperte con il motivo', async () => {
    const runs: Array<{ q: string; p: Record<string, unknown> }> = []
    executeWrite.mockImplementation(async (fn: (tx: { run: (q: string, p: Record<string, unknown>) => Promise<{ records: unknown[] }> }) => unknown) =>
      fn({ run: async (q: string, p: Record<string, unknown>) => { runs.push({ q, p }); return { records: [] } } }) as never)
    await anomalyScannerProcessor({ name: 'scan-manual', data: { tenantId: 'tenant-a' } } as never)
    const disabled = runs.find((r) => r.p['ruleKey'] === 'missing_owner')
    expect(disabled?.p).toMatchObject({ reason: 'rule_disabled', currentEntityIds: [] })
    expect(runs.find((r) => r.p['ruleKey'] === 'orphan_ci')?.p).toMatchObject({ reason: 'not_detected' })
  })
})
