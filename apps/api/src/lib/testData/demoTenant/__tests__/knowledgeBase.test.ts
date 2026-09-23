/**
 * THE KNOWLEDGE BASE OF THREE YEARS (tour of 23 Sep 2026, D16, D52) — what
 * tickets.test.ts does not already pin.
 *
 *  - A known error is written up a few days AFTER its workaround: one found
 *    in the last hour has no article yet.
 *  - An article is filed under a category of the product's own «KB Category»
 *    vocabulary: a database's known error under «database», an access
 *    problem under «security», the others under their own.
 *  - The young articles are caught in the middle of their life, as the
 *    workflow leaves them: a draft never edited is still its first text
 *    (symptoms and workaround, no cause yet); a draft not sent for review has
 *    no approval; one in review waits on one pending request to the
 *    administrators; nothing unpublished has readers.
 *  - Without a Service Desk team, the support teams there are write the
 *    how-tos.
 *  - Written as the product has it: the article, its workflow instance and
 *    its history, its versions, its approvals, the incidents it was written
 *    from, its Audit Log — every node before the edges that need it (the
 *    writer fails on an edge with a missing end).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { Rng } from '../random.js'
import { DAY, MINUTE } from '../clock.js'
import { planKnowledgeBase, writeKnowledgeBase, type KnownErrorFact, type SimulatedArticle } from '../knowledgeBase.js'
import { World } from '../world.js'
import type { DemoWriter } from '../writer.js'
import { NOW, smallWorld } from './fixtures.js'

// trail.ts and the fixtures' world (@opengraphity/sla) reach Neo4j at import; seedEnumTypes through domainMatrix.ts.
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), runQueryOne: vi.fn(), getSession: vi.fn(), writeSession: vi.fn() }))
const { SYSTEM_ENUMS } = await import('../../../seedEnumTypes.js')

const w = smallWorld('kb-more')
const author = w.operators[0]!
const admins = w.people.users.filter((u) => u.role === 'admin')

function known(i: number, over: Partial<KnownErrorFact> = {}): KnownErrorFact {
  return {
    problemId: `p${String(i)}`, number: `PRB${String(i).padStart(8, '0')}`, title: `Recurring trouble ${String(i)}`,
    description: 'It keeps happening.', workaround: 'Restart it.', rootCause: 'A leak.', ciName: 'SRV_x', ciLabel: 'Server',
    category: 'software', authorId: author.id, knownAtMs: NOW - 400 * DAY, incidentIds: [`i${String(i)}`], ...over,
  }
}
const knownErrors = (articles: readonly SimulatedArticle[]) => articles.filter((a) => (a.props['title'] as string).startsWith('Workaround: '))

describe('D16: when a known error is written up', () => {
  it('a few days after its workaround: one found in the last hour has no article yet', () => {
    const fresh = Array.from({ length: 40 }, (_, i) => known(i, { knownAtMs: NOW - 30 * MINUTE }))
    const articles = planKnowledgeBase(new Rng('kb-fresh'), w, fresh, [])
    expect(knownErrors(articles)).toEqual([])
    // The how-tos are there all the same.
    expect(articles.length).toBeGreaterThan(20)
  })
})

describe('D16: the category an article is filed under', () => {
  const cases: Array<[category: string, ciLabel: string, expected: string]> = [
    ['software', 'Server', 'software'], ['hardware', 'Server', 'hardware'], ['network', 'Application', 'network'],
    ['security', 'Certificate', 'security'], ['access', 'Application', 'security'], ['other', 'Server', 'general'],
    ['hardware', 'DatabaseInstance', 'database'], ['software', 'Database', 'database'],
  ]
  const facts = cases.flatMap(([category, ciLabel], c) => Array.from({ length: 12 }, (_, i) => known(c * 100 + i, { category, ciLabel })))
  const articles = planKnowledgeBase(new Rng('kb-categories'), w, facts, [])

  it('is the problem\'s own, a database\'s is «database», an access problem\'s «security», the rest «general»', () => {
    const byTitle = new Map(facts.map((k) => [`Workaround: ${k.title}`, k]))
    const seen = new Set<string>()
    for (const a of knownErrors(articles)) {
      const k = byTitle.get(a.props['title'] as string)!
      const [, , expected] = cases.find(([category, ciLabel]) => category === k.category && ciLabel === k.ciLabel)!
      expect(a.props['category'], `${k.category} on ${k.ciLabel}`).toBe(expected)
      seen.add(`${k.category}|${k.ciLabel}`)
    }
    // Every case was written up at least once.
    expect(seen.size).toBe(cases.length)
  })

  it('is always a value of the product\'s «KB Category» vocabulary, how-tos and FAQs included', () => {
    const vocabulary = SYSTEM_ENUMS.find((e) => e.name === 'kb_category')!.values
    for (const a of articles) expect(vocabulary).toContain(a.props['category'])
  })

  it('a known error of a category the knowledge base does not file stops the plan, instead of landing in «general»', () => {
    const unknown = Array.from({ length: 20 }, (_, i) => known(i, { category: 'facilities' }))
    expect(() => planKnowledgeBase(new Rng('kb-unknown'), w, unknown, []))
      .toThrow(/^planKnowledgeBase: the category "facilities" of PRB\d{8} has no knowledge base category$/)
    // On a database the category is «database» whatever the problem's.
    expect(() => planKnowledgeBase(new Rng('kb-unknown'), w, unknown.map((k) => ({ ...k, ciLabel: 'Database' })), [])).not.toThrow()
  })
})

describe('D16: the young articles, caught in the middle of their life', () => {
  // Known three days ago: written up one or two days ago, or an hour ago.
  const recent = Array.from({ length: 80 }, (_, i) => known(i, { knownAtMs: NOW - 3 * DAY }))
  const articles = knownErrors(planKnowledgeBase(new Rng('kb-young'), w, recent, []))
  const state = (s: string) => articles.filter((a) => a.props['status'] === s)

  it('are all young, and some are still drafts, some in review, some published', () => {
    for (const a of articles) expect(NOW - Date.parse(a.props['created_at'] as string)).toBeLessThanOrEqual(2 * DAY)
    for (const s of ['draft', 'pending_review', 'published']) expect(state(s).length, s).toBeGreaterThan(0)
  })

  it('a draft never edited is still its first text: symptoms and workaround, no cause yet', () => {
    const untouched = articles.filter((a) => a.versions.length === 0)
    expect(untouched.length).toBeGreaterThan(0)
    for (const a of untouched) {
      expect(a.props['version']).toBe(1)
      expect(a.props['body']).toBe('## Symptoms\nIt keeps happening.\n\n## Workaround\nRestart it.')
      expect(a.props['last_edited_at']).toBe(a.props['created_at'])
    }
  })

  it('a draft not sent for review has no approval request', () => {
    for (const a of state('draft')) expect(a.approvals).toEqual([])
  })

  it('one in review waits on one pending request to the administrators, asked by its author', () => {
    for (const a of state('pending_review')) {
      expect(a.approvals).toHaveLength(1)
      expect(a.approvals[0]).toMatchObject({
        entity_type: 'kb_article', entity_id: a.id, title: `Publication: ${a.props['title'] as string}`, status: 'pending',
        requested_by: a.props['author_id'], approval_type: 'any', approved_by: '[]', resolved_at: null,
        approvers: JSON.stringify(admins.map((u) => u.id)),
      })
    }
  })

  it('nothing unpublished has readers', () => {
    for (const a of [...state('draft'), ...state('pending_review')]) {
      expect(a.props).toMatchObject({ published_at: null, views: 0, helpful_count: 0, not_helpful_count: 0 })
    }
  })
})

describe('D16: the how-tos of a tenant without a Service Desk', () => {
  it('are written by the support teams there are', () => {
    // The same world, with no team of the Service Desk area among the support teams.
    const noDesk = Object.assign(Object.create(World.prototype) as World, w, {
      supportTeams: w.supportTeams.filter((t) => t.area !== 'Service Desk'),
    })
    expect(noDesk.supportTeams.length).toBeGreaterThan(0)
    const howTos = planKnowledgeBase(new Rng('kb-no-desk'), noDesk, [], []).filter((a) => ['how-to', 'faq'].includes(a.props['category'] as string))
    expect(howTos.length).toBeGreaterThan(20)
    for (const a of howTos) {
      const by = a.props['author_id'] as string
      expect(noDesk.supportTeams.some((t) => t.managerId === by || t.memberIds.includes(by)), by).toBe(true)
    }
  })
})

describe('D16: writeKnowledgeBase', () => {
  const articles = planKnowledgeBase(new Rng('kb-write'), w, Array.from({ length: 30 }, (_, i) => known(i, { knownAtMs: NOW - (600 - 15 * i) * DAY })),
    [{ id: 'inc-vpn', storyKey: 'portal.vpn', createdAtMs: NOW - 1000 * DAY }])
  const calls: Array<{ what: string; rows: ReadonlyArray<Record<string, unknown>> }> = []
  const writer = {
    nodes: async (labels: readonly string[], rows: ReadonlyArray<Record<string, unknown>>) => { calls.push({ what: `(:${labels.join(':')})`, rows }) },
    relationships: async (from: string, type: string, to: string, rows: ReadonlyArray<Record<string, unknown>>) => { calls.push({ what: `(:${from})-[:${type}]->(:${to})`, rows }) },
    children: async (parent: string, type: string, labels: readonly string[], rows: ReadonlyArray<Record<string, unknown>>) => { calls.push({ what: `(:${parent})-[:${type}]->(:${labels.join(':')})`, rows }) },
  } as unknown as DemoWriter
  const rowsOf = (what: string) => calls.find((c) => c.what === what)!.rows
  beforeAll(async () => { await writeKnowledgeBase(writer, articles) })

  it('writes every node before the edges that need it', () => {
    expect(calls.map((c) => c.what)).toEqual([
      '(:KBArticle)', '(:WorkflowInstance)',
      '(:KBArticle)-[:HAS_WORKFLOW]->(:WorkflowInstance)', '(:WorkflowInstance)-[:CURRENT_STEP]->(:WorkflowStep)',
      '(:WorkflowInstance)-[:STEP_HISTORY]->(:WorkflowStepExecution)', '(:KBArticle)-[:HAS_VERSION]->(:KBArticleVersion)',
      '(:ApprovalRequest)', '(:KBArticle)-[:WRITTEN_FROM]->(:Incident)', '(:AuditEntry)',
    ])
  })

  it('each article with its workflow instance at its current step, and the instance completed only once archived', () => {
    expect(rowsOf('(:KBArticle)')).toEqual(articles.map((a) => a.props))
    expect(rowsOf('(:KBArticle)-[:HAS_WORKFLOW]->(:WorkflowInstance)')).toEqual(articles.map((a) => ({ from: a.id, to: a.trail.instanceId })))
    expect(rowsOf('(:WorkflowInstance)-[:CURRENT_STEP]->(:WorkflowStep)')).toEqual(articles.map((a) => ({ from: a.trail.instanceId, to: a.trail.current.id })))
    const instances = rowsOf('(:WorkflowInstance)')
    instances.forEach((row, i) => {
      expect(row).toMatchObject({ id: articles[i]!.trail.instanceId, entity_id: articles[i]!.id, entity_type: 'kb_article', current_step: articles[i]!.props['status'] })
      expect(row['status']).toBe(row['current_step'] === 'archived' ? 'completed' : 'active')
    })
  })

  it('the history under its instance, the versions under the article, the incidents it was written from, the audit', () => {
    const history = rowsOf('(:WorkflowInstance)-[:STEP_HISTORY]->(:WorkflowStepExecution)')
    expect(history).toHaveLength(articles.reduce((n, a) => n + a.trail.executions.length, 0))
    for (const row of history) expect(articles.some((a) => a.trail.instanceId === row['parent'])).toBe(true)
    const versions = rowsOf('(:KBArticle)-[:HAS_VERSION]->(:KBArticleVersion)')
    expect(versions).toHaveLength(articles.reduce((n, a) => n + a.versions.length, 0))
    for (const row of versions) expect((row['props'] as Record<string, unknown>)['article_id']).toBe(row['parent'])
    expect(rowsOf('(:ApprovalRequest)')).toEqual(articles.flatMap((a) => a.approvals))
    const from = rowsOf('(:KBArticle)-[:WRITTEN_FROM]->(:Incident)')
    expect(from).toEqual(articles.flatMap((a) => a.writtenFrom.map((i) => ({ from: a.id, to: i }))))
    expect(from).toContainEqual({ from: articles.find((a) => a.props['title'] === 'Connect to the VPN from home')!.id, to: 'inc-vpn' })
    expect(rowsOf('(:AuditEntry)')).toEqual(articles.flatMap((a) => a.trail.audits))
  })
})
