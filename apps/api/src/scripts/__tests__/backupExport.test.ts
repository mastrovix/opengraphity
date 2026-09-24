/**
 * THE BACKUP'S GRAPH EXPORT (review of 23 Sep 2026), on a fake driver.
 *
 * What these tests pin:
 *  - a relationship whose endpoint the node stream did not carry (committed
 *    while the backup ran) writes that endpoint too, and the manifest counts
 *    it: the restore of a live backup no longer ends INCOMPLETE;
 *  - `tenant` exports one tenant: its own statements and parameter, an
 *    archive named so that the nightly rotation never counts it, the scope in
 *    the manifest; a tenant that does not exist, or a slug that is not one,
 *    is refused before anything is read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Row = Record<string, unknown>
const rec = (o: Row) => ({ get: (k: string) => o[k], toObject: () => o })

/** A Result: awaitable (counts) and async-iterable (streams). */
function result(rows: Row[]) {
  const records = rows.map(rec)
  return {
    then: (res: (v: { records: unknown[] }) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ records }).then(res, rej),
    async *[Symbol.asyncIterator]() { for (const r of records) yield r },
  }
}

const fake = vi.hoisted(() => ({
  counts: [] as Array<{ nodes: number; rels: number }>,
  nodes: [] as Row[],
  rels: [] as Row[],
  tenantExists: true,
  txCalls: [] as Array<{ cypher: string; params: unknown }>,
  txConfigs: [] as unknown[],
}))

vi.mock('@opengraphity/neo4j', () => ({
  toNative: (v: unknown) => v,
  MAINTENANCE_TX_CONFIG: { timeout: 7_200_000 },
  getDriver: () => ({
    session: () => ({
      beginTransaction: (txConfig?: unknown) => (fake.txConfigs.push(txConfig), {
        run: (cypher: string, params: unknown) => {
          fake.txCalls.push({ cypher, params })
          if (cypher.includes('count(r) AS rels')) return result([fake.counts.shift()!])
          if (cypher.includes('type(r) AS relType')) return result(fake.rels)
          return result(fake.nodes)
        },
        commit: async () => {},
        rollback: async () => {},
      }),
      run: async (cypher: string) => {
        if (cypher.includes('MATCH (t:Tenant {id: $tenant})')) return { records: [rec({ n: fake.tenantExists ? 1 : 0 })] }
        if (cypher.includes('dbms.components')) return { records: [rec({ name: 'Neo4j Kernel', versions: ['5.26.0'] })] }
        return { records: [] }
      },
      close: async () => {},
    }),
  }),
}))

const { runBackup } = await import('../backup-neo4j.js')
const exec = promisify(execFile)

let out: string
beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), 'og-backup-export-'))
  fake.txCalls = []
  fake.txConfigs = []
  fake.tenantExists = true
  fake.nodes = [{ id: '4:d:1', labels: ['User'], props: { id: 'u1', tenant_id: 'acme' } }]
  fake.rels = [{
    startId: '4:d:1', startLabels: ['User'], startProps: { id: 'u1', tenant_id: 'acme' },
    relType: 'MEMBER_OF', relProps: {},
    endId: '4:d:2', endLabels: ['Team'], endProps: { id: 't1', tenant_id: 'acme' },
  }]
  fake.counts = [{ nodes: 1, rels: 1 }, { nodes: 2, rels: 1 }]
})
afterEach(async () => { await rm(out, { recursive: true, force: true }) })

const silent = { info: () => {}, warn: () => {} }
const opts = (over: Record<string, unknown> = {}) => ({ outputDir: out, skipKeycloak: true, skipAttachments: true, appVersion: '9.9.9', log: silent, ...over })

async function unpack(archive: string): Promise<{ manifest: Record<string, unknown>; nodes: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'og-backup-unpack-'))
  try {
    await exec('tar', ['-xzf', archive, '-C', dir])
    const [inner] = await readdir(dir)
    const manifest = JSON.parse(await readFile(join(dir, inner!, 'manifest.json'), 'utf8')) as Record<string, unknown>
    const nodes = (await readFile(join(dir, inner!, 'nodes.jsonl'), 'utf8')).trim().split('\n')
    return { manifest, nodes }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('runBackup — endpoints the node stream did not carry', () => {
  it('writes the endpoint of the relationship, counts it, and the archive has no dangling relationship', async () => {
    const res = await runBackup(opts())
    expect(res.archivePath).toMatch(/\/backup_\d{4}-\d{2}-\d{2}_\d{4}\.tar\.gz$/)
    const { manifest, nodes } = await unpack(res.archivePath)
    expect(nodes.map((l) => (JSON.parse(l) as { id: string }).id)).toEqual(['4:d:1', '4:d:2'])
    expect(manifest).toMatchObject({ node_count: 2, rel_count: 1, endpoint_nodes_added: 1, nodes_by_label: { User: 1, Team: 1 }, scope: { tenant: null } })
    // The whole installation: no tenant parameter.
    expect(fake.txCalls.every((c) => JSON.stringify(c.params) === '{}')).toBe(true)
    // One read transaction for the whole graph — 98 s on 24 Sep 2026 — with the maintenance limit, not the server's 120 s.
    expect(fake.txConfigs).toEqual([{ timeout: 7_200_000 }])
  })

  it('an endpoint already written is not written twice', async () => {
    fake.nodes.push({ id: '4:d:2', labels: ['Team'], props: { id: 't1', tenant_id: 'acme' } })
    fake.counts = [{ nodes: 2, rels: 1 }, { nodes: 2, rels: 1 }]
    const { manifest, nodes } = await unpack((await runBackup(opts())).archivePath)
    expect(nodes).toHaveLength(2)
    expect(manifest).toMatchObject({ node_count: 2, endpoint_nodes_added: 0 })
  })
})

/*
 * A live graph (24 Sep 2026): a relationship replaced while the stream ran
 * leaves the archive one short of both counts with nothing lost. The nightly
 * backup of the demo was refused for exactly that; now it is published, the
 * drift is logged and the manifest keeps the three numbers.
 */
describe('runBackup — the counts of a live graph', () => {
  it('one relationship short of both counts: published, said in the log, the numbers in the manifest', async () => {
    fake.nodes.push({ id: '4:d:2', labels: ['Team'], props: { id: 't1', tenant_id: 'acme' } })
    fake.counts = [{ nodes: 2, rels: 2 }, { nodes: 2, rels: 3 }]
    const warn = vi.fn()
    const res = await runBackup(opts({ log: { info: () => {}, warn } }))
    const { manifest } = await unpack(res.archivePath)
    expect(manifest['graph_counts']).toEqual({ nodes: { written: 2, before: 2, after: 2 }, rels: { written: 1, before: 2, after: 3 } })
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ outside: { nodes: 0, rels: 1 } }), expect.stringMatching(/outside the two counts by less than a live graph explains/))
  })

  it('a stream that lost a real part of the graph is still not published', async () => {
    fake.counts = [{ nodes: 500, rels: 1 }, { nodes: 500, rels: 1 }]
    await expect(runBackup(opts())).rejects.toThrow(/Backup NOT published .*nodes: 1 written, 500 counted .*explains up to 100/)
    expect((await readdir(out)).filter((f) => f.endsWith('.tar.gz'))).toEqual([])
  })
})

describe('runBackup — one tenant', () => {
  it('uses the tenant statements and parameter, names the archive for the tenant, and says so in the manifest', async () => {
    const res = await runBackup(opts({ tenant: 'acme' }))
    expect(res.archivePath).toMatch(/\/tenant_acme_\d{4}-\d{2}-\d{2}_\d{4}\.tar\.gz$/)
    expect(fake.txCalls.map((c) => c.params)).toEqual(Array(4).fill({ tenant: 'acme' }))
    expect(fake.txCalls[1]!.cypher).toContain('n.tenant_id = $tenant OR (n:Tenant AND n.id = $tenant)')
    // A relationship to another tenant's node is not exported.
    expect(fake.txCalls[2]!.cypher).toContain("a.tenant_id = 'system'")
    const { manifest } = await unpack(res.archivePath)
    expect(manifest['scope']).toEqual({ tenant: 'acme' })
  })

  it('a tenant that does not exist, or a slug that is not one, is refused before reading the graph', async () => {
    fake.tenantExists = false
    await expect(runBackup(opts({ tenant: 'ghost' }))).rejects.toThrow('Tenant "ghost" does not exist')
    await expect(runBackup(opts({ tenant: '../etc' }))).rejects.toThrow('Invalid tenant slug')
    expect(fake.txCalls).toEqual([])
    expect((await readdir(out)).filter((f) => f.endsWith('.tar.gz'))).toEqual([])
  })
})
