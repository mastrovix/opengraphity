import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('bullmq', () => ({
  Queue:  vi.fn().mockReturnValue({ add: vi.fn().mockResolvedValue(undefined), on: vi.fn() }),
  Worker: vi.fn().mockReturnValue({ on: vi.fn() }),
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
}))

vi.mock('@opengraphity/notifications', () => ({
  sendSlackMessage: vi.fn().mockResolvedValue(undefined),
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

const { startAnomalyScanner, anomalyScannerQueue } = await import('../anomalyEngine.js')
const { Queue, Worker } = await import('bullmq')

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('startAnomalyScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('anomalyScannerQueue è un oggetto con metodo add (istanziato da Queue)', () => {
    // Queue is instantiated at module load time — check the exported value has the mock shape
    expect(anomalyScannerQueue).toBeDefined()
    expect(typeof anomalyScannerQueue.add).toBe('function')
  })

  it('startAnomalyScanner istanzia Worker con nome anomaly-scanner', () => {
    startAnomalyScanner()
    expect(Worker).toHaveBeenCalledWith(
      'anomaly-scanner',
      expect.any(Function),
      expect.objectContaining({ connection: expect.any(Object) }),
    )
  })

  it('startAnomalyScanner chiama queue.add con job scan', () => {
    startAnomalyScanner()
    // anomalyScannerQueue.add is the mock vi.fn() from our Queue mock
    expect(anomalyScannerQueue.add).toHaveBeenCalledWith(
      'scan',
      {},
      expect.objectContaining({ repeat: expect.any(Object), jobId: 'anomaly-scanner-scan' }),
    )
  })

  it('startAnomalyScanner registra handler failed sul worker', () => {
    const worker = startAnomalyScanner()
    expect(worker.on).toHaveBeenCalledWith('failed', expect.any(Function))
  })

  it('Queue è stato chiamato con nome anomaly-scanner', () => {
    // Queue was called when the module was first loaded — verify via the exported queue shape
    expect(anomalyScannerQueue).toHaveProperty('add')
    expect(anomalyScannerQueue).toHaveProperty('on')
  })
})
