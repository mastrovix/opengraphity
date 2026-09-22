/**
 * Problem PDF — loading the dossier.
 *
 * Why it matters: the Problem Audit Report is handed to auditors. Every query
 * must be scoped to the caller's tenant (an id from another tenant must not
 * pull its incidents or changes into this report), a missing value must print
 * as empty rather than "undefined", the priority colour must come from the
 * customer's Dictionary, and a change shows its live workflow step.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const queries: Array<{ q: string; p: Record<string, unknown> }> = []
let creator: Record<string, unknown> | null = null
let incidents: Array<Record<string, unknown>> = []
let changes: Array<Record<string, unknown>> = []

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
  runQueryOne: vi.fn(async (_s: unknown, q: string, p: Record<string, unknown>) => {
    queries.push({ q, p })
    return { cProps: creator }
  }),
  runQuery: vi.fn(async (_s: unknown, q: string, p: Record<string, unknown>) => {
    queries.push({ q, p })
    if (q.includes(':CAUSED_BY]->(i:Incident)')) return incidents
    if (q.includes(':RESOLVED_BY]->(c:Change)')) return changes
    return []
  }),
}))

const loadVocabularyEntries = vi.fn()
vi.mock('../vocabularyEntries.js', () => ({ loadVocabularyEntries: (...a: unknown[]) => loadVocabularyEntries(...a) }))

let props: Record<string, unknown> = {}
const loadTicketDossier = vi.fn()
vi.mock('../pdf/ticketDossier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pdf/ticketDossier.js')>()),
  loadTicketDossier: (...a: unknown[]) => loadTicketDossier(...a),
}))

const { loadProblemDossier } = await import('../problemPdf.js')

const common = () => ({
  props,
  assignee: { name: 'Mario', email: 'mario@x' },
  team: { name: 'Platform' },
  affectedCIs: [{ name: 'db-1', type: 'database', environment: null, status: null }],
  workflowHistory: [],
  comments: [
    { author: 'Mario', type: null, createdAt: null, text: 'no type' },
    { author: 'Luca', type: 'workaround', createdAt: null, text: 'typed' },
  ],
  attachments: [],
  customFields: [{ label: 'Region', value: 'EU' }],
})

beforeEach(() => {
  queries.length = 0
  creator = { id: 'u1', name: 'Luca', email: 'luca@x' }
  incidents = []
  changes = []
  props = { id: 'prb-1' }
  loadTicketDossier.mockReset()
  loadTicketDossier.mockImplementation(async () => common())
  loadVocabularyEntries.mockReset()
  loadVocabularyEntries.mockResolvedValue({ values: ['high'], labels: {}, colors: { high: 'danger' } })
})

describe('loadProblemDossier', () => {
  it('loads the shared parts as a Problem (AFFECTS CIs, Comment nodes) in the caller tenant', async () => {
    await loadProblemDossier({} as never, 'prb-1', 't1')
    expect(loadTicketDossier).toHaveBeenCalledWith({}, {
      label: 'Problem', entityType: 'problem', ciRelation: 'AFFECTS', comments: { label: 'Comment', authorProp: 'author_id' },
    }, 'prb-1', 't1')
  })

  it('every own query is tenant-scoped', async () => {
    await loadProblemDossier({} as never, 'prb-1', 't1')
    expect(queries).toHaveLength(3)
    for (const { q, p } of queries) {
      expect(q).toContain('(p:Problem {id: $id, tenant_id: $tenantId})')
      expect(p).toEqual({ id: 'prb-1', tenantId: 't1' })
    }
  })

  it('maps a fully populated problem, with the Dictionary colour of its priority', async () => {
    props = {
      id: 'prb-1', number: 'PRB00000001', title: 'Pool exhaustion', description: 'desc', priority: 'high', status: 'known_error',
      root_cause: 'rc', workaround: 'wa', affected_users: '120', created_at: 'c', updated_at: 'u', resolved_at: 'r', closed_at: 'x',
    }
    incidents = [{ number: 'INC1', title: 'Slow', status: 'resolved' }]
    changes = [{ code: 'CHG1', title: 'Bigger pool', status: 'deployment' }]
    const d = await loadProblemDossier({} as never, 'prb-1', 't1')
    expect(loadVocabularyEntries).toHaveBeenCalledWith('t1', 'priority')
    expect(d.problem).toEqual({
      id: 'prb-1', number: 'PRB00000001', title: 'Pool exhaustion', description: 'desc', priority: 'high', priorityColor: 'danger',
      status: 'known_error', rootCause: 'rc', workaround: 'wa', affectedUsers: 120, // stored as text, printed as a number
      createdAt: 'c', updatedAt: 'u', resolvedAt: 'r', closedAt: 'x',
    })
    expect(d.createdBy).toEqual({ name: 'Luca', email: 'luca@x' })
    expect(d.assignee).toEqual({ name: 'Mario', email: 'mario@x' })
    expect(d.team).toEqual({ name: 'Platform' })
    expect(d.relatedIncidents).toEqual([{ number: 'INC1', title: 'Slow', status: 'resolved' }])
    expect(d.relatedChanges).toEqual([{ code: 'CHG1', title: 'Bigger pool', status: 'deployment' }])
    expect(d.customFields).toEqual([{ label: 'Region', value: 'EU' }])
    expect(d.affectedCIs).toHaveLength(1)
  })

  it('missing values become empty strings or null, never "undefined" on the page', async () => {
    creator = null
    incidents = [{ number: null, title: null, status: null }]
    changes = [{ code: null, title: null, status: null }]
    const d = await loadProblemDossier({} as never, 'prb-1', 't1')
    expect(d.problem).toEqual({
      id: 'prb-1', number: '', title: '', description: null, priority: '', priorityColor: null, status: '',
      rootCause: null, workaround: null, affectedUsers: null, createdAt: null, updatedAt: null, resolvedAt: null, closedAt: null,
    })
    // no priority → the Dictionary is not even consulted
    expect(loadVocabularyEntries).not.toHaveBeenCalled()
    expect(d.createdBy).toBeNull()
    expect(d.relatedIncidents).toEqual([{ number: '', title: '', status: '' }])
    expect(d.relatedChanges).toEqual([{ code: '', title: '', status: '' }])
  })

  it('a priority the Dictionary has no colour for prints without colour', async () => {
    props = { id: 'prb-1', priority: 'custom_p' }
    expect((await loadProblemDossier({} as never, 'prb-1', 't1')).problem.priorityColor).toBeNull()
  })

  it('an affected_users of 0 is kept as 0, not dropped as missing', async () => {
    props = { id: 'prb-1', affected_users: 0 }
    expect((await loadProblemDossier({} as never, 'prb-1', 't1')).problem.affectedUsers).toBe(0)
  })

  it('a comment without a kind is a manual comment', async () => {
    const d = await loadProblemDossier({} as never, 'prb-1', 't1')
    expect(d.comments.map((c) => c.type)).toEqual(['manual', 'workaround'])
  })

  it('a related change shows its live workflow step, and soft-deleted changes are excluded', async () => {
    await loadProblemDossier({} as never, 'prb-1', 't1')
    const q = queries.find((x) => x.q.includes('RESOLVED_BY'))!.q
    expect(q).toContain('coalesce(wi.current_step, c.status) AS status')
    expect(q).toContain('coalesce(c.deleted, false) = false')
  })

  it('a missing problem fails in the shared loader and nothing else is queried', async () => {
    loadTicketDossier.mockRejectedValueOnce(new Error('Problem not found'))
    await expect(loadProblemDossier({} as never, 'nope', 't1')).rejects.toThrow('Problem not found')
    expect(queries).toHaveLength(0)
  })
})
