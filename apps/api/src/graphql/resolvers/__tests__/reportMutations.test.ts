/**
 * reportMutations.ts — creating and editing custom report templates.
 *
 * Why these behaviours matter (duplicateReportTemplate.test.ts covers the
 * happy-path clone):
 *  - every write is gated by assertReportTemplateAccess BEFORE any Cypher
 *    runs: a private report must not be edited, deleted or re-shared by a
 *    colleague who can merely guess its id;
 *  - every statement is scoped by tenant_id, so a template id from another
 *    tenant matches nothing;
 *  - sharing: `sharedWithTeamIds: []` means "unshare with everyone" while
 *    omitting it means "leave the sharing alone" — confusing the two either
 *    leaks a report or silently hides it from a team;
 *  - editing a section keeps its position (order) and its id, so bookmarks
 *    and the section order the user arranged survive an edit;
 *  - sessions are closed on every path, including failures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'
import type { SectionInput } from '../customReports.js'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../customReports.js', () => ({
  loadFullTemplate: vi.fn(async (id: string) => ({ id, loaded: true })),
  createSectionWithNodesEdges: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/reportTemplates.js', () => ({ loadTemplateSections: vi.fn().mockResolvedValue([]) }))
vi.mock('../../../lib/reportWhitelist.js', () => ({ getReportWhitelist: vi.fn().mockResolvedValue({}) }))
vi.mock('../reportAccess.js', () => ({ assertReportTemplateAccess: vi.fn().mockResolvedValue({}) }))

const { Mutation } = await import('../reportMutations.js')
const { getSession } = await import('@opengraphity/neo4j')
const { audit } = await import('../../../lib/audit.js')
const { loadFullTemplate, createSectionWithNodesEdges } = await import('../customReports.js')
const { loadTemplateSections } = await import('../../../lib/reportTemplates.js')
const { assertReportTemplateAccess } = await import('../reportAccess.js')
const { ForbiddenError } = await import('../../../lib/errors.js')

const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') }

interface Call { q: string; p: Record<string, unknown>; mode: 'read' | 'write' }
type Responder = (q: string, p: Record<string, unknown>) => Array<Record<string, unknown>>

/**
 * A session whose tx.run answers through `respond` and records every
 * statement. getSession may be called more than once (the sharing sub-session):
 * all sessions share the same call log.
 */
function fakeSessions(respond: Responder = () => []) {
  const calls: Call[] = []
  const sessions: Array<{ close: ReturnType<typeof vi.fn> }> = []
  vi.mocked(getSession).mockImplementation(() => {
    const make = (mode: Call['mode']) => vi.fn(async (fn: (tx: { run: (q: string, p: Record<string, unknown>) => unknown }) => unknown) =>
      fn({
        run: async (q: string, p: Record<string, unknown>) => {
          calls.push({ q, p, mode })
          return { records: respond(q, p).map((row) => ({ get: (k: string) => row[k] })) }
        },
      }))
    const s = { executeRead: make('read'), executeWrite: make('write'), close: vi.fn().mockResolvedValue(undefined) }
    sessions.push(s)
    return s as never
  })
  return { calls, sessions }
}

const SECTION: SectionInput = { title: 'By team', chartType: 'bar', nodes: [], edges: [] } as unknown as SectionInput

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(assertReportTemplateAccess).mockResolvedValue({} as never)
})

describe('duplicateReportTemplate — failure paths', () => {
  it('a source that vanished inside the tx → NotFound, nothing audited, session closed', async () => {
    vi.mocked(loadTemplateSections).mockResolvedValueOnce([])
    const { sessions } = fakeSessions(() => [])   // CREATE matched nothing
    await expect(Mutation.duplicateReportTemplate(null, { id: 'tpl-x' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(audit).not.toHaveBeenCalled()
    expect(loadFullTemplate).not.toHaveBeenCalled()
    expect(sessions[0]!.close).toHaveBeenCalledOnce()
  })

  it('no read access → refused before anything is read or written', async () => {
    const { calls, sessions } = fakeSessions()
    vi.mocked(assertReportTemplateAccess).mockRejectedValueOnce(new ForbiddenError('no'))
    await expect(Mutation.duplicateReportTemplate(null, { id: 'tpl-private' }, ctx)).rejects.toBeInstanceOf(ForbiddenError)
    expect(loadTemplateSections).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(sessions[0]!.close).toHaveBeenCalledOnce()
  })

  it('audits the source id and section count on success', async () => {
    vi.mocked(loadTemplateSections).mockResolvedValueOnce([{ order: 0 }, { order: 1 }] as never)
    fakeSessions((q) => (q.includes('CREATE (r:ReportTemplate') ? [{ id: 'new' }] : []))
    await Mutation.duplicateReportTemplate(null, { id: 'tpl-src' }, ctx)
    expect(createSectionWithNodesEdges).toHaveBeenCalledTimes(2)
    expect(audit).toHaveBeenCalledWith(ctx, 'report.duplicated', 'ReportTemplate', expect.any(String), { sourceTemplateId: 'tpl-src', sections: 2 })
  })
})

describe('createReportTemplate', () => {
  it('creates in the caller tenant with the caller as owner and null-defaults for optional fields', async () => {
    const { calls } = fakeSessions()
    const out = await Mutation.createReportTemplate(null, { input: { name: 'Weekly', visibility: 'private' } }, ctx)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.q).toContain('CREATE (r:ReportTemplate')
    expect(calls[0]!.q).toContain('MATCH (u:User {id: $userId, tenant_id: $tenantId})')
    expect(calls[0]!.p).toMatchObject({
      tenantId: 't1', userId: 'u1', name: 'Weekly', visibility: 'private',
      description: null, icon: null, scheduleEnabled: false, scheduleCron: null, scheduleChannelId: null,
    })
    const id = calls[0]!.p['id'] as string
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(audit).toHaveBeenCalledWith(ctx, 'report.created', 'ReportTemplate', id)
    expect(out).toEqual({ id, loaded: true })
    expect(loadFullTemplate).toHaveBeenCalledWith(id, 't1')
  })

  it('shares with the given teams, matching teams only inside the tenant', async () => {
    const { calls, sessions } = fakeSessions()
    await Mutation.createReportTemplate(null, { input: {
      name: 'Shared', visibility: 'team', sharedWithTeamIds: ['team-a', 'team-b'],
      description: 'd', icon: 'chart', scheduleEnabled: true, scheduleCron: '0 8 * * 1', scheduleChannelId: 'ch-1',
    } }, ctx)

    expect(calls[0]!.p).toMatchObject({ description: 'd', icon: 'chart', scheduleEnabled: true, scheduleCron: '0 8 * * 1', scheduleChannelId: 'ch-1' })
    const share = calls[1]!
    expect(share.q).toContain('MATCH (t:Team {id: teamId, tenant_id: $tenantId})')
    expect(share.q).toContain('MERGE (r)-[:SHARED_WITH]->(t)')
    expect(share.p).toEqual({ id: calls[0]!.p['id'], tenantId: 't1', teamIds: ['team-a', 'team-b'] })
    // Both the main and the sharing session are closed.
    expect(sessions).toHaveLength(2)
    for (const s of sessions) expect(s.close).toHaveBeenCalledOnce()
  })

  it('an empty team list opens no sharing session', async () => {
    const { calls, sessions } = fakeSessions()
    await Mutation.createReportTemplate(null, { input: { name: 'N', visibility: 'private', sharedWithTeamIds: [] } }, ctx)
    expect(calls).toHaveLength(1)
    expect(sessions).toHaveLength(1)
  })
})

describe('updateReportTemplate', () => {
  it('checks WRITE access first, then patches only the given fields (COALESCE keeps the rest)', async () => {
    const { calls } = fakeSessions()
    const out = await Mutation.updateReportTemplate(null, { id: 'tpl-1', input: { name: 'Renamed' } }, ctx)

    expect(assertReportTemplateAccess).toHaveBeenCalledWith(expect.anything(), 'tpl-1', ctx, 'write')
    expect(calls).toHaveLength(1)   // no sharing change requested → sharing untouched
    expect(calls[0]!.q).toContain('MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})')
    expect(calls[0]!.q).toContain('r.name                = COALESCE($name, r.name)')
    expect(calls[0]!.p).toMatchObject({
      id: 'tpl-1', tenantId: 't1', name: 'Renamed', description: null, icon: null, visibility: null,
      scheduleEnabled: null, scheduleCron: null, scheduleChannelId: null,
    })
    expect(audit).toHaveBeenCalledWith(ctx, 'report.updated', 'ReportTemplate', 'tpl-1')
    expect(out).toEqual({ id: 'tpl-1', loaded: true })
  })

  it('passes through every provided field, including scheduleEnabled=false', async () => {
    const { calls } = fakeSessions()
    await Mutation.updateReportTemplate(null, { id: 'tpl-1', input: {
      description: 'd', icon: 'i', visibility: 'public', scheduleEnabled: false, scheduleCron: '* * * * *', scheduleChannelId: 'c',
    } }, ctx)
    // false must reach Cypher as false, not be turned into "keep the old value".
    expect(calls[0]!.p).toMatchObject({ description: 'd', icon: 'i', visibility: 'public', scheduleEnabled: false, scheduleCron: '* * * * *', scheduleChannelId: 'c' })
  })

  it('sharedWithTeamIds replaces the sharing: old links removed, new ones merged, all tenant-scoped', async () => {
    const { calls, sessions } = fakeSessions()
    await Mutation.updateReportTemplate(null, { id: 'tpl-1', input: { sharedWithTeamIds: ['team-z'] } }, ctx)
    expect(calls).toHaveLength(3)
    expect(calls[1]!.q).toContain('-[rel:SHARED_WITH]->()')
    expect(calls[1]!.q).toContain('DELETE rel')
    expect(calls[1]!.p).toEqual({ id: 'tpl-1', tenantId: 't1' })
    expect(calls[2]!.q).toContain('MATCH (t:Team {id: teamId, tenant_id: $tenantId})')
    expect(calls[2]!.p).toEqual({ id: 'tpl-1', tenantId: 't1', teamIds: ['team-z'] })
    for (const s of sessions) expect(s.close).toHaveBeenCalledOnce()
  })

  it('an empty team list unshares with everyone and links nobody', async () => {
    const { calls } = fakeSessions()
    await Mutation.updateReportTemplate(null, { id: 'tpl-1', input: { sharedWithTeamIds: [] } }, ctx)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.q).toContain('DELETE rel')
  })

  it('without write access nothing is written or audited', async () => {
    const { calls, sessions } = fakeSessions()
    vi.mocked(assertReportTemplateAccess).mockRejectedValueOnce(new ForbiddenError('not yours'))
    await expect(Mutation.updateReportTemplate(null, { id: 'tpl-1', input: { name: 'x', sharedWithTeamIds: [] } }, ctx)).rejects.toBeInstanceOf(ForbiddenError)
    expect(calls).toEqual([])
    expect(audit).not.toHaveBeenCalled()
    expect(sessions[0]!.close).toHaveBeenCalledOnce()
  })
})

describe('deleteReportTemplate', () => {
  it('deletes the template with its sections and nodes, tenant-scoped, and audits', async () => {
    const { calls, sessions } = fakeSessions()
    await expect(Mutation.deleteReportTemplate(null, { id: 'tpl-1' }, ctx)).resolves.toBe(true)
    expect(assertReportTemplateAccess).toHaveBeenCalledWith(expect.anything(), 'tpl-1', ctx, 'write')
    expect(calls[0]!.q).toContain('MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})')
    expect(calls[0]!.q).toContain('DETACH DELETE r, s, n')
    expect(calls[0]!.p).toEqual({ id: 'tpl-1', tenantId: 't1' })
    expect(audit).toHaveBeenCalledWith(ctx, 'report.deleted', 'ReportTemplate', 'tpl-1')
    expect(sessions[0]!.close).toHaveBeenCalledOnce()
  })

  it('refused access → nothing deleted', async () => {
    const { calls } = fakeSessions()
    vi.mocked(assertReportTemplateAccess).mockRejectedValueOnce(new ForbiddenError('no'))
    await expect(Mutation.deleteReportTemplate(null, { id: 'tpl-1' }, ctx)).rejects.toBeInstanceOf(ForbiddenError)
    expect(calls).toEqual([])
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('addReportSection', () => {
  it('appends after the last section (next order from the tenant-scoped template)', async () => {
    const { calls } = fakeSessions((q) => (q.includes('nextOrder') ? [{ nextOrder: 3 }] : []))
    const out = await Mutation.addReportSection(null, { templateId: 'tpl-1', input: SECTION }, ctx)

    expect(assertReportTemplateAccess).toHaveBeenCalledWith(expect.anything(), 'tpl-1', ctx, 'write')
    expect(calls[0]!.q).toContain('MATCH (r:ReportTemplate {id: $templateId, tenant_id: $tenantId})')
    expect(calls[0]!.p).toEqual({ templateId: 'tpl-1', tenantId: 't1' })
    const [, templateId, sectionId, order, input, tenantId] = vi.mocked(createSectionWithNodesEdges).mock.calls[0]!
    expect([templateId, order, input, tenantId]).toEqual(['tpl-1', 3, SECTION, 't1'])
    expect(sectionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(out).toEqual({ id: 'tpl-1', loaded: true })
  })

  it('first section of an empty template gets order 0, also when the driver returns no row', async () => {
    // Neo4j Integer-like values and floats are normalised to a whole number.
    fakeSessions((q) => (q.includes('nextOrder') ? [{ nextOrder: { toString: () => '0' } }] : []))
    await Mutation.addReportSection(null, { templateId: 'tpl-1', input: SECTION }, ctx)
    expect(vi.mocked(createSectionWithNodesEdges).mock.calls[0]![3]).toBe(0)

    vi.mocked(createSectionWithNodesEdges).mockClear()
    fakeSessions(() => [])
    await Mutation.addReportSection(null, { templateId: 'tpl-1', input: SECTION }, ctx)
    expect(vi.mocked(createSectionWithNodesEdges).mock.calls[0]![3]).toBe(0)
  })

  it('refused access → no section created', async () => {
    fakeSessions()
    vi.mocked(assertReportTemplateAccess).mockRejectedValueOnce(new ForbiddenError('no'))
    await expect(Mutation.addReportSection(null, { templateId: 'tpl-1', input: SECTION }, ctx)).rejects.toBeInstanceOf(ForbiddenError)
    expect(createSectionWithNodesEdges).not.toHaveBeenCalled()
  })
})

describe('updateReportSection', () => {
  it('finds the owning template in the tenant, checks write access on IT, and recreates the section in place', async () => {
    const { calls, sessions } = fakeSessions((q) => (q.includes('RETURN r.id AS templateId') ? [{ templateId: 'tpl-9', order: 4 }] : []))
    const out = await Mutation.updateReportSection(null, { sectionId: 'sec-1', input: SECTION }, ctx)

    expect(calls[0]!.q).toContain('MATCH (r:ReportTemplate {tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection {id: $sectionId})')
    expect(calls[0]!.p).toEqual({ sectionId: 'sec-1', tenantId: 't1' })
    // Access is checked on the template that owns the section, not on anything the client sent.
    expect(assertReportTemplateAccess).toHaveBeenCalledWith(expect.anything(), 'tpl-9', ctx, 'write')

    const writes = calls.filter((c) => c.mode === 'write')
    expect(writes).toHaveLength(2)
    expect(writes[0]!.q).toContain('DETACH DELETE n')
    expect(writes[1]!.q).toContain('DETACH DELETE s')
    for (const w of writes) {
      expect(w.q).toContain('(:ReportTemplate {tenant_id: $tenantId})')
      expect(w.p).toEqual({ sectionId: 'sec-1', tenantId: 't1' })
    }
    // Same id and same position after the edit.
    expect(vi.mocked(createSectionWithNodesEdges).mock.calls[0]!.slice(1)).toEqual(['tpl-9', 'sec-1', 4, SECTION, 't1'])
    expect(out).toEqual({ id: 'tpl-9', loaded: true })
    expect(sessions[0]!.close).toHaveBeenCalledOnce()
  })

  it('a missing stored order becomes 0', async () => {
    fakeSessions((q) => (q.includes('RETURN r.id AS templateId') ? [{ templateId: 'tpl-9', order: null }] : []))
    await Mutation.updateReportSection(null, { sectionId: 'sec-1', input: SECTION }, ctx)
    expect(vi.mocked(createSectionWithNodesEdges).mock.calls[0]![3]).toBe(0)
  })

  it('a section of another tenant → NotFound, nothing deleted', async () => {
    const { calls, sessions } = fakeSessions(() => [])
    await expect(Mutation.updateReportSection(null, { sectionId: 'sec-x', input: SECTION }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(calls.filter((c) => c.mode === 'write')).toEqual([])
    expect(assertReportTemplateAccess).not.toHaveBeenCalled()
    expect(sessions[0]!.close).toHaveBeenCalledOnce()
  })

  it('refused access on the owning template → nothing deleted', async () => {
    const { calls } = fakeSessions((q) => (q.includes('RETURN r.id AS templateId') ? [{ templateId: 'tpl-9', order: 1 }] : []))
    vi.mocked(assertReportTemplateAccess).mockRejectedValueOnce(new ForbiddenError('no'))
    await expect(Mutation.updateReportSection(null, { sectionId: 'sec-1', input: SECTION }, ctx)).rejects.toBeInstanceOf(ForbiddenError)
    expect(calls.filter((c) => c.mode === 'write')).toEqual([])
    expect(createSectionWithNodesEdges).not.toHaveBeenCalled()
  })
})

describe('removeReportSection', () => {
  it('removes only a section of THAT template in THAT tenant', async () => {
    const { calls } = fakeSessions()
    const out = await Mutation.removeReportSection(null, { templateId: 'tpl-1', sectionId: 'sec-1' }, ctx)
    expect(assertReportTemplateAccess).toHaveBeenCalledWith(expect.anything(), 'tpl-1', ctx, 'write')
    expect(calls[0]!.q).toContain('(:ReportTemplate {id: $templateId, tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection {id: $sectionId})')
    expect(calls[0]!.q).toContain('DETACH DELETE s, n')
    expect(calls[0]!.p).toEqual({ sectionId: 'sec-1', templateId: 'tpl-1', tenantId: 't1' })
    expect(out).toEqual({ id: 'tpl-1', loaded: true })
  })

  it('refused access → nothing removed, session closed', async () => {
    const { calls, sessions } = fakeSessions()
    vi.mocked(assertReportTemplateAccess).mockRejectedValueOnce(new ForbiddenError('no'))
    await expect(Mutation.removeReportSection(null, { templateId: 'tpl-1', sectionId: 'sec-1' }, ctx)).rejects.toBeInstanceOf(ForbiddenError)
    expect(calls).toEqual([])
    expect(sessions[0]!.close).toHaveBeenCalledOnce()
  })
})

describe('reorderReportSections', () => {
  it('writes the list position as the new order of each section', async () => {
    const { calls } = fakeSessions()
    await Mutation.reorderReportSections(null, { templateId: 'tpl-1', sectionIds: ['s-c', 's-a', 's-b'] }, ctx)
    expect(assertReportTemplateAccess).toHaveBeenCalledWith(expect.anything(), 'tpl-1', ctx, 'write')
    expect(calls.map((c) => [c.p['sectionId'], c.p['order']])).toEqual([['s-c', 0], ['s-a', 1], ['s-b', 2]])
    for (const c of calls) {
      expect(c.q).toContain('(:ReportTemplate {id: $templateId, tenant_id: $tenantId})')
      expect(c.p).toMatchObject({ templateId: 'tpl-1', tenantId: 't1' })
    }
  })

  it('refused access → no order changed', async () => {
    const { calls } = fakeSessions()
    vi.mocked(assertReportTemplateAccess).mockRejectedValueOnce(new ForbiddenError('no'))
    await expect(Mutation.reorderReportSections(null, { templateId: 'tpl-1', sectionIds: ['a'] }, ctx)).rejects.toBeInstanceOf(ForbiddenError)
    expect(calls).toEqual([])
  })
})
