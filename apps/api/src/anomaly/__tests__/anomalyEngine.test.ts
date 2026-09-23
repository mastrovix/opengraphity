import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────────

/*
 * Le code del tenant (23 set 2026): ogni tenant ha `anomaly-scanner@<tenant>`,
 * il suo worker e la sua scansione oraria. I gestori `error` e `failed` dei
 * worker sono del pool (packages/events, tenantQueues.test.ts — A-06).
 */
const queueAdd = vi.fn().mockResolvedValue(undefined)
const getTenantQueue = vi.fn((_base: string, _tenantId: string) => ({ add: queueAdd }))
const createTenantWorkers = vi.fn((..._a: unknown[]) => ({ pool: true }))
vi.mock('../../lib/bullmq.js', () => ({
  getTenantQueue: (base: string, tenantId: string) => getTenantQueue(base, tenantId),
  createTenantWorkers: (...a: unknown[]) => createTenantWorkers(...a),
}))

// Sessions: `MATCH (t:Tenant)` → two tenants (a scan that still read the list
// would show up as an extra read); every other query → no rows.
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
vi.mock('../ruleConfig.js', async (importOriginal) => {
  const base = { severity: 'medium', ciTypes: [], relations: [], threshold: null, incidentSeverities: [], forbidden: [], isDefault: false, updatedAt: null }
  return {
    ANOMALY_RULE_SPECS: (await importOriginal<typeof import('../ruleConfig.js')>()).ANOMALY_RULE_SPECS,
    loadAnomalyRuleConfigs: vi.fn(async () => [
      { ...base, ruleKey: 'orphan_ci', enabled: true },
      { ...base, ruleKey: 'missing_owner', enabled: false },
    ]),
    anomalyRuleOptions: vi.fn(async () => ({ ciTypes: [], relations: [], incidentSeverities: [] })),
    anomalyRuleProblem: vi.fn(() => null),
  }
})

// ── Import after mocks ────────────────────────────────────────────────────────

const { startAnomalyScanner, scheduleAnomalyScan, enqueueTenantScan, anomalyScannerProcessor, entitySubtypeOf } = await import('../anomalyEngine.js')

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('startAnomalyScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('un worker per tenant su anomaly-scanner, ognuno con la scansione oraria del suo tenant, una scansione alla volta nel processo', () => {
    startAnomalyScanner()
    // Le scansioni di tutti i tenant scattano insieme: a turno, come quando un job solo le faceva in fila.
    expect(createTenantWorkers).toHaveBeenCalledWith('anomaly-scanner', anomalyScannerProcessor, { schedule: scheduleAnomalyScan, processLimit: 1 })
  })

  it('la scansione oraria di un tenant ha un id fisso e porta il SUO tenant', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined)
    await scheduleAnomalyScan({ upsertJobScheduler } as never, 'tenant-a')
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      'anomaly-scanner-scan',
      { every: 60 * 60_000 },
      { name: 'scan', data: { tenantId: 'tenant-a' }, opts: { removeOnComplete: true } },
    )
  })
})

describe('enqueueTenantScan (C-18)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accoda scan-manual nella coda del chiamante, con il SOLO suo tenantId', async () => {
    await enqueueTenantScan('tenant-a')
    expect(getTenantQueue).toHaveBeenCalledWith('anomaly-scanner', 'tenant-a')
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

  it('la scansione manuale scansiona SOLO il tenant del job', async () => {
    await anomalyScannerProcessor({ name: 'scan-manual', data: { tenantId: 'tenant-a' } } as never)
    expect(tenantsScanned()).toBe(1)
    // The only executeRead is the rule query: no list of tenants is read.
    expect(executeRead.mock.calls.length).toBe(1)
  })

  it('anche quella oraria: il tenant è quello della sua coda, e nessun altro viene toccato', async () => {
    await anomalyScannerProcessor({ name: 'scan', data: { tenantId: 'tenant-b' } } as never)
    expect(tenantsScanned()).toBe(1)
    expect(executeRead.mock.calls.length).toBe(1)
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

/** Secondo giro UI del 15 set 2026 · V-3: «CI Senza Owner · Portale clienti · businessapplication». */
describe('entitySubtypeOf', () => {
  it('le label del CI diventano il nome del tipo; una stringa resta; altro è un errore', () => {
    expect(entitySubtypeOf('t1', ['BusinessApplication'])).toBe('business_application')
    expect(entitySubtypeOf('t1', ['DatabaseInstance', 'ConfigurationItem'])).toBe('database_instance')
    expect(entitySubtypeOf('t1', [])).toBe('')
    expect(entitySubtypeOf('t1', null)).toBe('')
    expect(entitySubtypeOf('t1', 'team')).toBe('team')
    expect(() => entitySubtypeOf('t1', 42)).toThrow(/unreadable entitySubtype/)
  })
})
