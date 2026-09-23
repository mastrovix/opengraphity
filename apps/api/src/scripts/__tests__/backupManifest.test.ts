import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateManifest, tallyNodes, tallyRels, compareCounts, manifestTenant, ElementIdSet, danglingRelations, MANIFEST_FORMAT } from '../lib/backupManifest.js'

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'og-manifest-test-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: MANIFEST_FORMAT, created_at: '2026-09-08T00:00:00.000Z', app_version: '0.1.0', neo4j_version: '5.26.0',
    node_count: 3, rel_count: 2,
    nodes_by_label: { Tenant: 1, User: 2 }, rels_by_type: { MEMBER_OF: 2 },
    constraints: [], indexes: [],
    attachments: { included: false, dir: null, file_count: 0, total_bytes: 0, reason: 'x' },
    keycloak: { included: false, realms: [], reason: 'x' },
    ...overrides,
  }
}

describe('validateManifest', () => {
  it('accepts a well-formed format-2 manifest', () => {
    expect(validateManifest(manifest()).node_count).toBe(3)
  })
  it('rejects wrong format, missing fields, bad counts and inconsistent rel sums', () => {
    expect(() => validateManifest(manifest({ format: 1 }))).toThrow(/unsupported format/)
    expect(() => validateManifest(manifest({ app_version: '' }))).toThrow(/app_version/)
    expect(() => validateManifest(manifest({ node_count: -1 }))).toThrow(/node_count/)
    expect(() => validateManifest(manifest({ nodes_by_label: { A: 'x' } }))).toThrow(/nodes_by_label/)
    expect(() => validateManifest(manifest({ rels_by_type: { MEMBER_OF: 1 } }))).toThrow(/sums to 1, rel_count is 2/)
    expect(() => validateManifest(manifest({ keycloak: { included: true } }))).toThrow(/keycloak/)
    expect(() => validateManifest('nope')).toThrow(/not an object/)
  })
})

describe('tallyNodes / tallyRels', () => {
  it('counts rows per label / type and skips blank lines', async () => {
    const nodes = join(dir, 'nodes.jsonl')
    await writeFile(nodes, [
      JSON.stringify({ id: '4:a:1', labels: ['Tenant'], props: { id: 't1' } }),
      '',
      JSON.stringify({ id: '4:a:2', labels: ['User', 'Person'], props: { id: 'u1' } }),
      JSON.stringify({ id: '4:a:3', labels: ['User'], props: {} }),
    ].join('\n') + '\n')
    expect(await tallyNodes(nodes)).toEqual({ count: 3, byKey: { Tenant: 1, User: 2, Person: 1 } })

    const rels = join(dir, 'rels.jsonl')
    const rel = (t: string) => JSON.stringify({
      startId: '4:a:2', startLabels: ['User'], startProps: { id: 'u1' }, relType: t, relProps: {},
      endId: '4:a:1', endLabels: ['Tenant'], endProps: { id: 't1' },
    })
    await writeFile(rels, [rel('MEMBER_OF'), rel('MEMBER_OF'), rel('OWNS')].join('\n'))
    expect(await tallyRels(rels)).toEqual({ count: 3, byKey: { MEMBER_OF: 2, OWNS: 1 } })
  })

  it('fails on invalid JSON with the line number, and on rows of the wrong shape', async () => {
    const bad = join(dir, 'bad.jsonl')
    await writeFile(bad, '{"id":"1","labels":["A"],"props":{}}\n{not json\n')
    await expect(tallyNodes(bad)).rejects.toThrow(/bad\.jsonl:2: invalid JSON/)

    const shape = join(dir, 'shape.jsonl')
    await writeFile(shape, JSON.stringify({ labels: 'A', props: {} }) + '\n')
    await expect(tallyNodes(shape)).rejects.toThrow(/row #1 is not a node row/)

    const relShape = join(dir, 'relshape.jsonl')
    await writeFile(relShape, JSON.stringify({ startId: 'a', endId: 'b', relType: 'X' }) + '\n')
    await expect(tallyRels(relShape)).rejects.toThrow(/row #1 is not a relationship row/)
  })
})

describe('compareCounts', () => {
  it('lists every differing key (missing on either side counts as 0)', () => {
    expect(compareCounts('label', { A: 1, B: 2 }, { A: 1, B: 2 })).toEqual([])
    expect(compareCounts('label', { A: 1, B: 2 }, { A: 1, C: 1 })).toEqual([
      'label "B": manifest 2, file 0',
      'label "C": manifest 0, file 1',
    ])
  })
})

// ── Review of 23 Sep 2026 ─────────────────────────────────────────────────────

describe('scope of an archive', () => {
  it('absent or null = the installation; a slug = one tenant; anything else is refused', () => {
    expect(manifestTenant(validateManifest(manifest()))).toBeNull()
    expect(manifestTenant(validateManifest(manifest({ scope: { tenant: null } })))).toBeNull()
    expect(manifestTenant(validateManifest(manifest({ scope: { tenant: 'acme' } })))).toBe('acme')
    for (const scope of [{ tenant: '' }, { tenant: 3 }, null, 'acme']) {
      expect(() => validateManifest(manifest({ scope }))).toThrow(/scope\.tenant/)
    }
  })
})

describe('ElementIdSet', () => {
  it('keeps the ids of one database in a bitmap, growing as needed', () => {
    const ids = new ElementIdSet()
    ids.add('4:db-1:0')
    ids.add('4:db-1:7')
    ids.add('4:db-1:5000000')   // far past the initial 64 KB
    expect(['4:db-1:0', '4:db-1:7', '4:db-1:5000000'].every((i) => ids.has(i))).toBe(true)
    expect(ids.has('4:db-1:1')).toBe(false)
    expect(ids.has('4:db-1:99999999')).toBe(false)
  })

  it('an id of another shape or another database falls back to a plain set: correctness never depends on the format', () => {
    const ids = new ElementIdSet()
    ids.add('4:db-1:3')
    ids.add('4:db-2:3')
    ids.add('no-colons')
    ids.add('4:db-1:x')
    expect(ids.has('4:db-2:3')).toBe(true)
    expect(ids.has('4:db-2:4')).toBe(false)
    expect(ids.has('no-colons')).toBe(true)
    expect(ids.has('4:db-1:x')).toBe(true)
    expect(ids.has('other')).toBe(false)
  })
})

describe('danglingRelations', () => {
  const node = (id: string) => JSON.stringify({ id, labels: ['User'], props: { id } })
  const rel = (a: string, b: string) => JSON.stringify({ startId: a, startLabels: ['User'], startProps: {}, relType: 'KNOWS', relProps: {}, endId: b, endLabels: ['Team'], endProps: {} })

  it('counts the relationships whose start or end is not among the nodes, with a sample', async () => {
    await writeFile(join(dir, 'd-nodes.jsonl'), [node('4:x:1'), node('4:x:2')].join('\n'))
    await writeFile(join(dir, 'd-rels.jsonl'), [rel('4:x:1', '4:x:2'), rel('4:x:1', '4:x:9'), rel('4:x:8', '4:x:2')].join('\n'))
    const out = await danglingRelations(join(dir, 'd-nodes.jsonl'), join(dir, 'd-rels.jsonl'))
    expect(out.count).toBe(2)
    expect(out.sample).toEqual(['User-[KNOWS]->Team (4:x:9)', 'User-[KNOWS]->Team (4:x:8)'])
  })

  it('none when every relationship has both ends', async () => {
    await writeFile(join(dir, 'e-nodes.jsonl'), [node('4:x:1'), node('4:x:2')].join('\n'))
    await writeFile(join(dir, 'e-rels.jsonl'), rel('4:x:2', '4:x:1'))
    await expect(danglingRelations(join(dir, 'e-nodes.jsonl'), join(dir, 'e-rels.jsonl'))).resolves.toEqual({ count: 0, sample: [] })
  })
})
