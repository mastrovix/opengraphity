/**
 * The report whitelist: the ONLY labels and relationship types the custom
 * report builder may interpolate into Cypher. It is checked when a report is
 * built and again when a section is saved, so a crafted saved section can
 * never be executed by the scheduler.
 *
 * Contracts pinned here, and what a regression would mean:
 *  - a metamodel name that is not a safe Cypher identifier never enters the
 *    whitelist (otherwise it is a Cypher injection vector);
 *  - it is PER TENANT: one customer's CI types are not reportable by another;
 *  - the per-tenant cache is invalidated when the metamodel changes, so a new
 *    type is reportable immediately and a deleted one stops being so;
 *  - temporal fields are known per label, so "group by month" on a text field
 *    is refused at save time rather than failing at execution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// cypherIdentifiers pulls in the schema generator, which imports the Neo4j
// package: stub it so the test never opens a driver to a real database.
vi.mock('@opengraphity/neo4j', () => ({}))
const getNavigableEntities = vi.fn()
vi.mock('../navigableGraph.js', () => ({ getNavigableEntities: (...a: unknown[]) => getNavigableEntities(...a) }))
const registered: Array<{ name: string; one: (t: string) => void; all: () => void }> = []
vi.mock('../schemaInvalidator.js', () => ({
  registerMetamodelCacheClearer: (name: string, one: (t: string) => void, all: () => void) => { registered.push({ name, one, all }) },
}))

const {
  getReportWhitelist, clearReportWhitelistCache, invalidateReportWhitelist,
  STATIC_REPORT_LABELS, STATIC_REPORT_RELATIONSHIP_TYPES,
} = await import('../reportWhitelist.js')

interface Entity {
  neo4jLabel: string
  relations: Array<{ relationshipType: string; targetNeo4jLabel?: string | null }>
  fields: Array<{ name: string; fieldType?: string | null }>
}
const entity = (over: Partial<Entity> & { neo4jLabel: string }): Entity => ({ relations: [], fields: [], ...over })

beforeEach(() => {
  clearReportWhitelistCache()
  getNavigableEntities.mockReset()
  getNavigableEntities.mockResolvedValue([])
})
afterEach(() => { vi.useRealTimers() })

describe('getReportWhitelist', () => {
  it('always contains the shipped ITSM labels and relationship types', async () => {
    const wl = await getReportWhitelist('tenant-a')
    for (const l of STATIC_REPORT_LABELS) expect(wl.labels.has(l)).toBe(true)
    for (const r of STATIC_REPORT_RELATIONSHIP_TYPES) expect(wl.relationshipTypes.has(r)).toBe(true)
    expect(getNavigableEntities).toHaveBeenCalledWith('tenant-a')
  })

  it('adds the tenant metamodel labels, relation types and relation targets', async () => {
    getNavigableEntities.mockResolvedValue([
      entity({ neo4jLabel: 'Firewall', relations: [{ relationshipType: 'PROTECTS', targetNeo4jLabel: 'Subnet' }] }),
    ])
    const wl = await getReportWhitelist('tenant-a')
    expect(wl.labels.has('Firewall')).toBe(true)
    expect(wl.labels.has('Subnet')).toBe(true)
    expect(wl.relationshipTypes.has('PROTECTS')).toBe(true)
  })

  it('never admits a name that is not a safe Cypher identifier', async () => {
    getNavigableEntities.mockResolvedValue([
      entity({
        neo4jLabel: 'X) DETACH DELETE n //',
        relations: [
          { relationshipType: 'OWNS]->(m) DELETE m //', targetNeo4jLabel: 'bad label' },
          // lowercase relation types are not in the house convention either
          { relationshipType: 'depends_on', targetNeo4jLabel: null },
        ],
      }),
    ])
    const wl = await getReportWhitelist('tenant-a')
    expect(wl.labels.has('X) DETACH DELETE n //')).toBe(false)
    expect(wl.labels.has('bad label')).toBe(false)
    expect(wl.relationshipTypes.has('OWNS]->(m) DELETE m //')).toBe(false)
    expect(wl.relationshipTypes.has('depends_on')).toBe(false)
    expect(wl.labels.size).toBe(STATIC_REPORT_LABELS.length)
    expect(wl.relationshipTypes.size).toBe(STATIC_REPORT_RELATIONSHIP_TYPES.length)
  })

  it('records the temporal fields per label, and none for a label without dates', async () => {
    getNavigableEntities.mockResolvedValue([
      entity({ neo4jLabel: 'Firewall', fields: [
        { name: 'status', fieldType: 'string' },
        { name: 'installed_on', fieldType: 'date' },
        { name: 'checked_at', fieldType: 'string' },
      ] }),
      entity({ neo4jLabel: 'Subnet', fields: [{ name: 'cidr', fieldType: 'string' }] }),
    ])
    const wl = await getReportWhitelist('tenant-a')
    expect([...wl.temporalFields.get('Firewall')!].sort()).toEqual(['checked_at', 'installed_on'])
    // "group by month" on Subnet has nothing to group by.
    expect(wl.temporalFields.has('Subnet')).toBe(false)
  })

  it('is per tenant: another tenant does not see this tenant types', async () => {
    getNavigableEntities.mockImplementation(async (t: string) => (t === 'tenant-a' ? [entity({ neo4jLabel: 'Firewall' })] : []))
    expect((await getReportWhitelist('tenant-a')).labels.has('Firewall')).toBe(true)
    expect((await getReportWhitelist('tenant-b')).labels.has('Firewall')).toBe(false)
  })
})

describe('the per-tenant cache', () => {
  it('serves the second call from cache within 60 s, and reloads after', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-22T10:00:00Z'))
    const first = await getReportWhitelist('tenant-a')
    expect(await getReportWhitelist('tenant-a')).toBe(first)
    expect(getNavigableEntities).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-09-22T10:01:01Z'))
    expect(await getReportWhitelist('tenant-a')).not.toBe(first)
    expect(getNavigableEntities).toHaveBeenCalledTimes(2)
  })

  it('invalidating one tenant reloads only that tenant', async () => {
    await getReportWhitelist('tenant-a')
    await getReportWhitelist('tenant-b')
    getNavigableEntities.mockResolvedValue([entity({ neo4jLabel: 'Firewall' })])
    invalidateReportWhitelist('tenant-a')
    // A type added to tenant-a is reportable at once, not after the TTL.
    expect((await getReportWhitelist('tenant-a')).labels.has('Firewall')).toBe(true)
    // tenant-b still answers from its cached value.
    expect((await getReportWhitelist('tenant-b')).labels.has('Firewall')).toBe(false)
    expect(getNavigableEntities).toHaveBeenCalledTimes(3)
  })

  it('is wired to the metamodel channel, which invalidates one tenant or all of them', async () => {
    const hook = registered.find((r) => r.name === 'report-whitelist')
    expect(hook).toBeDefined()
    await getReportWhitelist('tenant-a')
    await getReportWhitelist('tenant-b')
    hook!.one('tenant-a')
    await getReportWhitelist('tenant-a')
    expect(getNavigableEntities).toHaveBeenCalledTimes(3)
    hook!.all()
    await getReportWhitelist('tenant-a')
    await getReportWhitelist('tenant-b')
    expect(getNavigableEntities).toHaveBeenCalledTimes(5)
  })
})
