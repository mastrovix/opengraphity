/**
 * sync.ts — credenziali: cifrate PRIMA di scrivere (encryptCredentials mockata)
 * e mai esposte dalle query (syncSources/syncSource non hanno campi
 * credentials/encrypted_credentials); triggerSync accoda con il tenant del
 * contesto; source di altro tenant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

const mockSession = { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('@opengraphity/discovery', () => ({
  encryptCredentials: vi.fn().mockReturnValue('ENC:opaque'),
  decryptCredentials: vi.fn(),
  getAllConnectors:   vi.fn().mockReturnValue([]),
  getConnector:       vi.fn(),
}))
vi.mock('../../../discovery/syncWorker.js', () => ({ syncQueue: { add: vi.fn().mockResolvedValue({ id: 'job-1' }) } }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))

const { syncResolvers } = await import('../sync.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { encryptCredentials } = await import('@opengraphity/discovery')
const { syncQueue } = await import('../../../discovery/syncWorker.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin' }

const SOURCE_PROPS = {
  id: 's-1', tenant_id: 'tenant-1', name: 'AWS prod', connector_type: 'aws', config: '{"region":"eu-west-1"}',
  mapping_rules: '[]', schedule_cron: null, enabled: true, encrypted_credentials: 'ENC:opaque-from-db',
  last_sync_at: null, last_sync_status: null, last_sync_duration_ms: null, created_at: 'c', updated_at: 'u',
}

const txRun = vi.fn().mockResolvedValue({ records: [] })
mockSession.executeWrite.mockImplementation(async (fn: (tx: { run: typeof txRun }) => unknown) => fn({ run: txRun }))

function lastWrite(): { cypher: string; params: Record<string, unknown> } {
  const call = txRun.mock.calls.at(-1)!
  return { cypher: call[0] as string, params: call[1] as Record<string, unknown> }
}

describe('lettura sorgenti — le credenziali cifrate non escono mai', () => {
  beforeEach(() => vi.clearAllMocks())

  it('syncSources: query scoped per tenant, il mapper non espone credentials/encrypted_credentials', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ p: SOURCE_PROPS }] as never)

    const out = await syncResolvers.Query.syncSources(null, null, ctx)

    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('MATCH (n:SyncSource {tenant_id: $tenantId})')
    expect(params).toEqual({ tenantId: 'tenant-1' })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 's-1', tenantId: 'tenant-1', connectorType: 'aws', enabled: true })
    expect(out[0]).not.toHaveProperty('credentials')
    expect(out[0]).not.toHaveProperty('encryptedCredentials')
    expect(out[0]).not.toHaveProperty('encrypted_credentials')
    expect(JSON.stringify(out)).not.toContain('ENC:opaque-from-db')
  })

  it('syncSource(id): scoped per tenant; id di altro tenant → null', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ p: SOURCE_PROPS } as never).mockResolvedValueOnce(null as never)

    const mine = await syncResolvers.Query.syncSource(null, { id: 's-1' }, ctx)
    expect(JSON.stringify(mine)).not.toContain('ENC:')
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('MATCH (n:SyncSource {id: $id, tenant_id: $tenantId})')
    expect(params).toEqual({ id: 's-1', tenantId: 'tenant-1' })

    await expect(syncResolvers.Query.syncSource(null, { id: 's-altrui' }, ctx)).resolves.toBeNull()
  })
})

describe('createSyncSource / updateSyncSource — cifratura prima della scrittura', () => {
  const ORIGINAL_KEY = process.env['DISCOVERY_ENCRYPTION_KEY']
  beforeEach(() => {
    vi.clearAllMocks()
    process.env['DISCOVERY_ENCRYPTION_KEY'] = 'test-key-32-bytes-long-xxxxxxxxxxxx'
    vi.mocked(runQueryOne).mockResolvedValue({ p: SOURCE_PROPS } as never)
  })
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env['DISCOVERY_ENCRYPTION_KEY']
    else process.env['DISCOVERY_ENCRYPTION_KEY'] = ORIGINAL_KEY
  })

  it('createSyncSource: encryptCredentials(creds, key) e nei parametri Cypher finisce SOLO il cifrato, con tenant_id del contesto', async () => {
    const creds = { accessKeyId: 'AKIA123', secretAccessKey: 'wJalrXUtnFEMI-super-secret' }

    const out = await syncResolvers.Mutation.createSyncSource(null, { input: {
      name: 'AWS prod', connectorType: 'aws', credentials: JSON.stringify(creds), config: '{"region":"eu-west-1"}',
    } }, ctx)

    expect(encryptCredentials).toHaveBeenCalledWith(creds, 'test-key-32-bytes-long-xxxxxxxxxxxx')
    const { cypher, params } = lastWrite()
    expect(cypher).toContain('CREATE (n:SyncSource {')
    expect(cypher).toContain('encrypted_credentials: $encryptedCreds')
    expect(params).toMatchObject({ tenantId: 'tenant-1', encryptedCreds: 'ENC:opaque', connectorType: 'aws', enabled: true, mappingRules: '[]', scheduleCron: null })
    const serialized = JSON.stringify(params)
    expect(serialized).not.toContain('wJalrXUtnFEMI-super-secret')
    expect(serialized).not.toContain('AKIA123')
    expect(params).not.toHaveProperty('credentials')
    expect(out).toMatchObject({ id: 's-1', name: 'AWS prod' })
    expect(out).not.toHaveProperty('credentials')
  })

  it('DISCOVERY_ENCRYPTION_KEY assente → errore esplicito PRIMA di qualunque scrittura', async () => {
    delete process.env['DISCOVERY_ENCRYPTION_KEY']
    await expect(syncResolvers.Mutation.createSyncSource(null, { input: {
      name: 'x', connectorType: 'aws', credentials: '{"a":"b"}', config: '{}',
    } }, ctx)).rejects.toThrow(/DISCOVERY_ENCRYPTION_KEY is not set/)
    expect(encryptCredentials).not.toHaveBeenCalled()
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('cron non valido → ValidationError prima di cifrare/scrivere', async () => {
    await expect(syncResolvers.Mutation.createSyncSource(null, { input: {
      name: 'x', connectorType: 'aws', credentials: '{"a":"b"}', config: '{}', scheduleCron: 'ogni ora',
    } }, ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    expect(encryptCredentials).not.toHaveBeenCalled()
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('updateSyncSource con nuove credenziali → SET encrypted_credentials col cifrato, MATCH scoped per tenant', async () => {
    await syncResolvers.Mutation.updateSyncSource(null, { id: 's-1', input: { credentials: '{"token":"plain-token"}', enabled: false } }, ctx)

    expect(encryptCredentials).toHaveBeenCalledWith({ token: 'plain-token' }, expect.any(String))
    const { cypher, params } = lastWrite()
    expect(cypher).toContain('MATCH (n:SyncSource {id: $id, tenant_id: $tenantId}) SET')
    expect(cypher).toContain('n.encrypted_credentials = $encryptedCreds')
    expect(params).toMatchObject({ id: 's-1', tenantId: 'tenant-1', encryptedCreds: 'ENC:opaque', enabled: false })
    expect(JSON.stringify(params)).not.toContain('plain-token')
  })

  it('updateSyncSource senza credenziali → nessuna cifratura, SET solo dei campi passati', async () => {
    await syncResolvers.Mutation.updateSyncSource(null, { id: 's-1', input: { name: 'Nuovo nome' } }, ctx)
    expect(encryptCredentials).not.toHaveBeenCalled()
    const { cypher } = lastWrite()
    expect(cypher).not.toContain('encrypted_credentials')
    expect(cypher).toContain('n.name = $name')
  })
})

describe('triggerSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQueryOne).mockResolvedValue({ p: { id: 'run-x', source_id: 's-1', tenant_id: 'tenant-1', sync_type: 'manual', status: 'queued', started_at: 'now' } } as never)
  })

  it('crea il SyncRun con tenant_id del contesto e accoda il job con lo stesso tenantId e jobId sync-<runId>', async () => {
    const out = await syncResolvers.Mutation.triggerSync(null, { sourceId: 's-1' }, ctx)

    const { cypher, params } = lastWrite()
    expect(cypher).toContain('CREATE (r:SyncRun {')
    expect(cypher).toContain("status: 'queued'")
    expect(params).toMatchObject({ sourceId: 's-1', tenantId: 'tenant-1', syncType: 'manual' })
    const runId = params['runId'] as string

    expect(syncQueue.add).toHaveBeenCalledOnce()
    expect(syncQueue.add).toHaveBeenCalledWith('sync', { runId, sourceId: 's-1', tenantId: 'tenant-1', syncType: 'manual' }, { jobId: `sync-${runId}` })
    expect(out).toMatchObject({ sourceId: 's-1', tenantId: 'tenant-1', status: 'queued' })
  })

  it('syncType esplicito viene propagato al job', async () => {
    await syncResolvers.Mutation.triggerSync(null, { sourceId: 's-1', syncType: 'full' }, ctx)
    expect(vi.mocked(syncQueue.add).mock.calls[0]![1]).toMatchObject({ syncType: 'full', tenantId: 'tenant-1' })
  })

  it('coda non disponibile → l\'errore propaga (nessun false silenzioso)', async () => {
    vi.mocked(syncQueue.add).mockRejectedValueOnce(new Error('ECONNREFUSED redis'))
    await expect(syncResolvers.Mutation.triggerSync(null, { sourceId: 's-1' }, ctx)).rejects.toThrow(/ECONNREFUSED/)
  })

  it.todo('triggerSync su source di un altro tenant → NotFound — GAP: nessuna verifica di esistenza della source nel tenant prima di creare il SyncRun e accodare (sync.ts:364-398)')

  it('testSyncConnection su source di un altro tenant → { ok:false, "Source not found" } senza toccare il connettore', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null as never)
    const { getConnector } = await import('@opengraphity/discovery')
    await expect(syncResolvers.Mutation.testSyncConnection(null, { sourceId: 's-altrui' }, ctx)).resolves.toEqual({ ok: false, message: 'Source not found', details: null })
    expect(getConnector).not.toHaveBeenCalled()
  })
})
