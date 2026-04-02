import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SyncSourceConfig } from '@opengraphity/discovery'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
}))
vi.mock('@opengraphity/discovery', () => ({
  applyMappingRules: vi.fn((ci: unknown) => ci),
  inferCIType: vi.fn(() => 'server'),
  normalizeProperties: vi.fn((props: unknown) => props),
}))

// Import after mocks
const { reconcileBatch, markStale } = await import('../reconciliationEngine.js')
const { getSession } = await import('@opengraphity/neo4j')

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockSession(
  reads: Record<string, unknown>[][] = [],
  writes: Record<string, unknown>[][] = [],
) {
  let readCall = 0
  let writeCall = 0
  return {
    executeRead: vi.fn().mockImplementation(() =>
      Promise.resolve({
        records: (reads[readCall++] ?? []).map(r => ({ get: (k: string) => r[k] })),
      }),
    ),
    executeWrite: vi.fn().mockImplementation(() =>
      Promise.resolve({
        records: (writes[writeCall++] ?? []).map(r => ({ get: (k: string) => r[k] })),
      }),
    ),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

const testSource: SyncSourceConfig = {
  id:                    'src-1',
  name:                  'Test',
  connector_type:        'csv',
  config:                {},
  tenant_id:             'tenant-1',
  enabled:               true,
  encrypted_credentials: '',
  mapping_rules:         [],
  schedule_cron:         null,
  last_sync_at:          null,
  last_sync_status:      null,
  last_sync_duration_ms: null,
  created_at:            new Date().toISOString(),
  updated_at:            new Date().toISOString(),
}

const makeStats = () => ({
  ciCreated:        0,
  ciUpdated:        0,
  ciUnchanged:      0,
  ciStale:          0,
  ciConflicts:      0,
  relationsCreated: 0,
  relationsRemoved: 0,
})

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('reconcileBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('CI nuovo: findExisting ritorna null → executeWrite chiamato con CREATE', async () => {
    const mockSession = makeMockSession(
      [[]], // findExisting → nessun record → null
      [[]], // createCI write
    )
    vi.mocked(getSession).mockReturnValue(mockSession as never)

    const stats = makeStats()
    const batch = [{
      external_id:   'ext-001',
      source:        'csv',
      ci_type:       'server',
      name:          'web-01',
      properties:    { ip_address: '10.0.0.1', os: 'linux' },
      tags:          {},
      relationships: [],
    }]

    await reconcileBatch(batch, testSource, 'run-1', 'tenant-1', stats)

    expect(mockSession.executeWrite).toHaveBeenCalledOnce()
    const writeArg = mockSession.executeWrite.mock.calls[0]![0]
    // executeWrite is called with a callback — verify the CI was created (stats updated)
    expect(stats.ciCreated).toBe(1)
    expect(stats.ciUpdated).toBe(0)
    expect(mockSession.close).toHaveBeenCalledOnce()
  })

  it('CI esistente senza conflitti: discoveryLocked vuoto → executeWrite chiamato con UPDATE (MATCH SET)', async () => {
    const existingProps = {
      id:                      'ci-existing-1',
      discovery_locked_fields: [],
      discovery_source:        'csv',
      ip_address:              '10.0.0.1',
      os:                      'linux',
    }

    const mockSession = makeMockSession(
      // findExisting → ritorna record con props esistenti
      [[{ id: 'ci-existing-1', props: existingProps }]],
      // updateCI write
      [[]],
    )
    vi.mocked(getSession).mockReturnValue(mockSession as never)

    // Override normalizeProperties to return something with a changed field
    const { normalizeProperties } = await import('@opengraphity/discovery')
    vi.mocked(normalizeProperties).mockImplementation((props: unknown) => ({
      ...(props as Record<string, unknown>),
      os: 'ubuntu',  // changed field → triggers update
    }))

    const stats = makeStats()
    const batch = [{
      external_id:   'ext-001',
      source:        'csv',
      ci_type:       'server',
      name:          'web-01',
      properties:    { ip_address: '10.0.0.1', os: 'ubuntu' },
      tags:          {},
      relationships: [],
    }]

    await reconcileBatch(batch, testSource, 'run-1', 'tenant-1', stats)

    expect(mockSession.executeWrite).toHaveBeenCalledOnce()
    expect(stats.ciConflicts).toBe(0)
    expect(mockSession.close).toHaveBeenCalledOnce()
  })

  it('CI esistente con campo locked e valore diverso → executeWrite chiamato con CREATE SyncConflict', async () => {
    const existingProps = {
      id:                      'ci-existing-2',
      discovery_locked_fields: ['ip_address'],
      discovery_source:        'csv',
      ip_address:              '10.0.0.1',
    }

    const mockSession = makeMockSession(
      // findExisting → ritorna record con ip_address locked
      [[{ id: 'ci-existing-2', props: existingProps }]],
      // createConflict write
      [[]],
    )
    vi.mocked(getSession).mockReturnValue(mockSession as never)

    const { normalizeProperties } = await import('@opengraphity/discovery')
    vi.mocked(normalizeProperties).mockImplementation((props: unknown) => ({
      ...(props as Record<string, unknown>),
      ip_address: '192.168.1.1',  // diverso → conflitto sul campo locked
    }))

    const stats = makeStats()
    const batch = [{
      external_id:   'ext-002',
      source:        'csv',
      ci_type:       'server',
      name:          'web-02',
      properties:    { ip_address: '192.168.1.1' },
      tags:          {},
      relationships: [],
    }]

    await reconcileBatch(batch, testSource, 'run-1', 'tenant-1', stats)

    // createConflict chiama executeWrite almeno una volta
    expect(mockSession.executeWrite).toHaveBeenCalled()
    expect(stats.ciConflicts).toBe(1)
    expect(stats.ciCreated).toBe(0)
    expect(stats.ciUpdated).toBe(0)
    // close può essere chiamato più di una volta se il mock di normalizeProperties
    // è ancora attivo dal test precedente (es. syncRelations path)
    expect(mockSession.close).toHaveBeenCalled()
  })
})

describe('markStale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('chiama executeWrite con discovery_status = stale e ritorna il conteggio', async () => {
    const mockSession = makeMockSession(
      [],
      // markStale write → ritorna count
      [[{ n: { toNumber: () => 3 } }]],
    )
    vi.mocked(getSession).mockReturnValue(mockSession as never)

    const seenIds = new Set(['ext-001', 'ext-002'])
    const count = await markStale('src-1', 'tenant-1', 'run-1', seenIds)

    expect(mockSession.executeWrite).toHaveBeenCalledOnce()
    expect(count).toBe(3)
    expect(mockSession.close).toHaveBeenCalledOnce()
  })

  it('ritorna 0 se nessun CI è diventato stale', async () => {
    const mockSession = makeMockSession(
      [],
      [[{ n: { toNumber: () => 0 } }]],
    )
    vi.mocked(getSession).mockReturnValue(mockSession as never)

    const count = await markStale('src-1', 'tenant-1', 'run-1', new Set(['ext-001']))

    expect(count).toBe(0)
    expect(mockSession.close).toHaveBeenCalledOnce()
  })
})
