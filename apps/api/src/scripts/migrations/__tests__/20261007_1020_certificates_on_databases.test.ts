/**
 * Migration 20261007_1020: certificates installed on database instances and
 * used by databases, declared in the shipped metamodel.
 *
 * Why it matters: the app refuses a CI relation no type declares, and the CI
 * page hides an undeclared edge. A declaration on the wrong type, in the wrong
 * direction or towards the wrong label would keep both problems while looking
 * done; overwriting an existing declaration would undo an administrator's
 * relabelling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { certificatesOnDatabases, CERTIFICATE_DATABASE_RELATIONS } = await import('../20261007_1020_certificates_on_databases.js')
const { MIGRATIONS } = await import('../index.js')

let lines: string[] = []
beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
})

function session(rows: (params: Record<string, unknown>) => Array<{ wasCreated: boolean }>) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> }> = []
  const run = vi.fn(async (cypher: string, params: Record<string, unknown>) => {
    calls.push({ cypher, params })
    return { records: rows(params).map((r) => ({ get: (k: string) => (r as Record<string, unknown>)[k] })) }
  })
  return { session: { run }, calls }
}

describe('20261007_1020_certificates_on_databases', () => {
  it('is registered right after 20261007_1010', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20261007_1020_certificates_on_databases'))
      .toBe(ids.indexOf('20261007_1010_delete_ownerless_report_conversations') + 1)
  })

  it('declares both ends of the two edges, with the labels the CI graph uses', () => {
    // (Certificate)-[:INSTALLED_ON]->(DatabaseInstance) and (Database)-[:USES_CERTIFICATE]->(Certificate).
    expect(CERTIFICATE_DATABASE_RELATIONS.map((r) => [r.typeName, r.relationshipType, r.direction, r.targetType])).toEqual([
      ['database', 'USES_CERTIFICATE', 'outgoing', 'Certificate'],
      ['database_instance', 'INSTALLED_ON', 'incoming', 'Certificate'],
      ['certificate', 'INSTALLED_ON', 'outgoing', 'DatabaseInstance'],
      ['certificate', 'USES_CERTIFICATE', 'incoming', 'Database'],
    ])
  })

  it('writes on the shipped types only, creates when missing and never overwrites', async () => {
    const { session: s, calls } = session(() => [{ wasCreated: true }])
    await certificatesOnDatabases.up(s as never)
    expect(calls).toHaveLength(4)
    for (const c of calls) {
      expect(c.cypher).toContain("MATCH (t:CITypeDefinition {name: $typeName, tenant_id: 'system'})")
      expect(c.cypher).toContain("MERGE (r:CIRelationDefinition {name: $name, tenant_id: 'system'})-[:BELONGS_TO]->(t)")
      expect(c.cypher).toContain('ON CREATE SET')
      expect(c.cypher).not.toContain('ON MATCH')
      expect(c.cypher).toContain('MERGE (t)-[:HAS_RELATION]->(r)')
    }
    expect(calls.map((c) => c.params['typeName'])).toEqual(['database', 'database_instance', 'certificate', 'certificate'])
    expect(lines[0]).toContain('declared: database.certificates, database_instance.certificates, certificate.installedOnInstance, certificate.usedByDatabases')
  })

  it('a second run reports that nothing was left to declare', async () => {
    await certificatesOnDatabases.up(session(() => [{ wasCreated: false }]).session as never)
    expect(lines).toEqual(['[20261007_1020_certificates_on_databases] already declared'])
  })

  it('a missing shipped type stops the migration instead of claiming success', async () => {
    const { session: s } = session((p) => (p['typeName'] === 'database_instance' ? [] : [{ wasCreated: true }]))
    await expect(certificatesOnDatabases.up(s as never)).rejects.toThrow(/CI type "database_instance" not found/)
  })
})
