import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SyncSourceConfig } from '@opengraphity/discovery'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
}))
vi.mock('@opengraphity/discovery', () => ({
  applyMappingRules: vi.fn((ci: unknown) => ci),
  // vero: serve al test dell'alias di tipo (ondata 6 · A-11)
  ciTypeAliases: vi.fn((rules: Array<{ kind?: string; source_field: string; target_field: string }>) =>
    new Map(rules.filter((r) => r.kind === 'ci_type').map((r) => [r.source_field.toLowerCase(), r.target_field]))),
  inferCIType: vi.fn(() => 'server'),
  normalizeProperties: vi.fn((props: unknown) => props),
}))
vi.mock('@opengraphity/schema-generator', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Ondata 6 · A-11: il tipo in arrivo si risolve contro i tipi ATTIVI del
  // cliente. Il tenant di prova ha `server` (i lotti dei test sono di server).
  loadMetamodel: vi.fn(async () => [
    { name: 'server', neo4jLabel: 'Server', scope: 'base', active: true },
    { name: 'application', neo4jLabel: 'Application', scope: 'base', active: true },
  ]),
}))

vi.mock('../../services/serviceImpact/sync.js', () => ({ notifyCIGraphChanged: vi.fn().mockResolvedValue(0) }))

// Import after mocks
const { reconcileBatch, markStale } = await import('../reconciliationEngine.js')
const { getSession } = await import('@opengraphity/neo4j')
const { notifyCIGraphChanged } = await import('../../services/serviceImpact/sync.js')

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

  it('CI nuovo: findExisting ritorna null → executeWrite chiamato con MERGE (created=true)', async () => {
    const mockSession = makeMockSession(
      [[]],                 // findExisting → nessun record → null
      [[{ created: true }]], // createCI MERGE → ON CREATE
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
    // executeWrite is called with a callback — verify the CI was created (stats updated)
    expect(stats.ciCreated).toBe(1)
    expect(stats.ciUpdated).toBe(0)
    expect(mockSession.close).toHaveBeenCalledOnce()
  })

  it('B-03: findExisting null ma MERGE trova il nodo (run concorrente) → nessun duplicato, ciUnchanged', async () => {
    const mockSession = makeMockSession(
      [[]],                  // findExisting → null (l'altro run non aveva ancora scritto)
      [[{ created: false }]], // MERGE → ON MATCH: il nodo esiste già
    )
    vi.mocked(getSession).mockReturnValue(mockSession as never)

    const stats = makeStats()
    await reconcileBatch([{
      external_id: 'ext-race', source: 'csv', ci_type: 'server', name: 'web-race',
      properties: { os: 'linux' }, tags: {}, relationships: [],
    }], testSource, 'run-2', 'tenant-1', stats)

    expect(mockSession.executeWrite).toHaveBeenCalledOnce()
    expect(stats.ciCreated).toBe(0)
    expect(stats.ciUnchanged).toBe(1)
    expect(stats.ciUpdated).toBe(0)
  })

  it('B-03: MERGE senza riga di ritorno → errore esplicito (mai un conteggio inventato)', async () => {
    const mockSession = makeMockSession([[]], [[]])
    vi.mocked(getSession).mockReturnValue(mockSession as never)

    await expect(reconcileBatch([{
      external_id: 'ext-x', source: 'csv', ci_type: 'server', name: 'x',
      properties: {}, tags: {}, relationships: [],
    }], testSource, 'run-3', 'tenant-1', makeStats())).rejects.toThrow(/MERGE for CI ext-x/)
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
      // updateCI write (MATCH SET)
      [[]],
      // SyncChangeRecord write (storico sync)
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

    // 2 write: UPDATE del CI + creazione SyncChangeRecord per lo storico sync
    expect(mockSession.executeWrite).toHaveBeenCalledTimes(2)
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

  // ── Servizi monitorati, ondata 5 (mappa viva) ─────────────────────────────
  it('relazioni riconciliate: UNA notifica per LOTTO con tutti i CI toccati (non una per relazione), dopo la chiusura della sessione', async () => {
    const mockSession = makeMockSession(
      // CI-1: findExisting → nessuno; poi syncRelations legge il CI e il target
      [[], [{ id: 'app-3' }], [{ id: 'srv-9' }], [], [{ id: 'app-4' }], [{ id: 'srv-9' }]],
      [[{ created: true }], [{ createdAt: 'T' }], [{ created: true }], [{ createdAt: 'T' }]],
    )
    vi.mocked(getSession).mockReturnValue(mockSession as never)

    const stats = makeStats()
    const rel = (target: string) => [{ target_external_id: target, relation_type: 'depends_on', direction: 'outgoing' as const }]
    await reconcileBatch([
      { external_id: 'ext-1', source: 'csv', ci_type: 'server', name: 'app-3', properties: {}, tags: {}, relationships: rel('ext-9') },
      { external_id: 'ext-2', source: 'csv', ci_type: 'server', name: 'app-4', properties: {}, tags: {}, relationships: rel('ext-9') },
    ], testSource, 'run-1', 'tenant-1', stats)

    expect(notifyCIGraphChanged).toHaveBeenCalledTimes(1)
    const [tenantId, ids, reason] = vi.mocked(notifyCIGraphChanged).mock.calls[0]!
    expect(tenantId).toBe('tenant-1')
    expect([...ids].sort()).toEqual(['app-3', 'app-4', 'srv-9'])   // entrambi i capi, senza doppioni
    expect(reason).toBe('discovery.reconciled:src-1')
    expect(vi.mocked(notifyCIGraphChanged).mock.invocationCallOrder[0]!).toBeGreaterThan(mockSession.close.mock.invocationCallOrder[0]!)
  })

  it('lotto senza relazioni: nessun id toccato (la notifica non accoda nulla)', async () => {
    const mockSession = makeMockSession([[]], [[{ created: true }]])
    vi.mocked(getSession).mockReturnValue(mockSession as never)
    await reconcileBatch([{ external_id: 'ext-1', source: 'csv', ci_type: 'server', name: 'web-01', properties: {}, tags: {}, relationships: [] }], testSource, 'run-1', 'tenant-1', makeStats())
    expect(notifyCIGraphChanged).toHaveBeenCalledWith('tenant-1', [], 'discovery.reconciled:src-1')
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

// ── Ondata 6 · A-11: un ci_type che non esiste non crea più un CI ───────────
// Prima l'etichetta era il PascalCase della stringa in arrivo: un CSV con
// `ci_type = "Bilanciatore"` creava `:ConfigurationItem:Bilanciatore`, che
// nessuna pagina mostra, e il run lo contava «creato».

describe('reconcileBatch: ci_type sconosciuto (A-11)', () => {
  const unknownBatch = [{
    external_id: 'ext-900', source: 'csv', ci_type: 'Bilanciatore', name: 'lb-01',
    properties: {}, tags: {}, relationships: [],
  }]

  beforeEach(() => vi.clearAllMocks())

  it('nessun CI creato, un SyncConflict unknown_ci_type con il motivo, e il conteggio fra i conflitti', async () => {
    const writes: Array<{ query: string; params: Record<string, unknown> }> = []
    const mockSession = {
      executeRead:  vi.fn().mockResolvedValue({ records: [] }),
      executeWrite: vi.fn().mockImplementation(async (fn: (tx: { run: (q: string, p: Record<string, unknown>) => unknown }) => unknown) =>
        fn({ run: (query, params) => { writes.push({ query, params }); return { records: [] } } })),
      close: vi.fn().mockResolvedValue(undefined),
    }
    vi.mocked(getSession).mockReturnValue(mockSession as never)

    const stats = makeStats()
    await reconcileBatch(unknownBatch, testSource, 'run-9', 'tenant-1', stats)

    expect(stats.ciCreated).toBe(0)
    expect(stats.ciConflicts).toBe(1)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.query).toContain('MERGE (c:SyncConflict')
    expect(writes[0]!.query).toContain("conflict_kind: 'unknown_ci_type'")
    expect(writes[0]!.query).not.toContain('ON CREATE SET ci:')
    expect(writes[0]!.params).toMatchObject({ externalId: 'ext-900', ciType: 'Bilanciatore', tenantId: 'tenant-1', runId: 'run-9' })
    expect(String(writes[0]!.params['message'])).toContain('non è un tipo di CI di questo cliente')
    // idempotente: due passate dello stesso run non fanno due conflitti (MERGE sulla chiave)
    expect(writes[0]!.query).toContain('external_id: $externalId')
  })

  it('con un alias nelle regole della sorgente lo stesso lotto crea il CI, con l\'etichetta del tipo vero', async () => {
    const mockSession = makeMockSession([[]], [[{ created: true }]])
    vi.mocked(getSession).mockReturnValue(mockSession as never)
    const stats = makeStats()
    await reconcileBatch(
      unknownBatch,
      { ...testSource, mapping_rules: [{ kind: 'ci_type', source_field: 'Bilanciatore', target_field: 'application' }] as never },
      'run-9', 'tenant-1', stats,
    )
    expect(stats.ciConflicts).toBe(0)
    expect(stats.ciCreated).toBe(1)
  })
})
