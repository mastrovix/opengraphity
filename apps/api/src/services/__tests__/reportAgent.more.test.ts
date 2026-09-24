/**
 * Report AI agent — schema context, the guarded tool and the loop's limits.
 *
 * The agent writes Cypher from a natural-language question. What protects the
 * tenant and the database is here:
 * - the schema context the model sees is built from the tenant's own nodes,
 *   with exact per-label counts (they end up in the answer);
 * - a query the guard refuses is never executed, and after too many refusals
 *   the request fails instead of letting the model probe forever;
 * - any other error from the guard is a bug and must propagate, not be fed to
 *   the model as "rewrite your query";
 * - Neo4j errors go back to the model (so it can correct), results are capped
 *   so a huge result cannot blow the context, and the session is always closed;
 * - the wall-clock budget stops a runaway loop; an unknown tool is an error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
  toNumber: (v: unknown) => (typeof v === 'object' && v !== null && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : Number(v)),
}))
const warn = vi.hoisted(() => vi.fn())
vi.mock('../../lib/logger.js', () => {
  const l = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), child: () => l }
  return { logger: l }
})
vi.mock('../../lib/cypherGuard.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/cypherGuard.js')>()
  return {
    ...real,
    // A guard that crashes (a bug, not a refusal) on one sentinel query.
    assertSafeReadOnlyCypher: (q: string) => {
      if (q === 'GUARD_CRASH') throw new TypeError('guard bug')
      return real.assertSafeReadOnlyCypher(q)
    },
  }
})

const { runReportAgent, runGuardedCypherTool, ToolLoopBudget, REPORT_AI_LIMITS, CYPHER_TOOL } = await import('../reportAgent.js')

// Every read permission: these tests are about the loop, not about what a role may read (labelReadAccess.test.ts).
const ALL = new Set(['cmdb.read', 'incident.read', 'problem.read', 'change.read', 'request.read', 'kb.read'])
const { getSession } = await import('@opengraphity/neo4j')

const SAFE_Q = 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.title AS title'
const rec = (r: Record<string, unknown>) => ({ keys: Object.keys(r), get: (k: string) => r[k] })

function sessionAnswering(answer: (cypher: string) => unknown[] | Error) {
  const run = vi.fn(async (cypher: string) => {
    const a = answer(cypher)
    if (a instanceof Error) throw a
    return { records: a }
  })
  return {
    run,
    executeRead: vi.fn((fn: (tx: unknown) => unknown) => fn({ run })),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function message(content: unknown[], stop: Anthropic.Message['stop_reason']): Anthropic.Message {
  return {
    id: 'msg', type: 'message', role: 'assistant', model: 'm', content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message
}
const text = (t: string, stop: Anthropic.Message['stop_reason'] = 'end_turn') => message([{ type: 'text', text: t }], stop)
const clientReturning = (...ms: Anthropic.Message[]) => {
  const create = vi.fn()
  for (const m of ms) create.mockResolvedValueOnce(m)
  return { client: { messages: { create } } as unknown as Anthropic, create }
}

let tenantSeq = 0
const freshTenant = () => `tenant-${++tenantSeq}` // the schema cache is per tenant

beforeEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  process.env['ANTHROPIC_API_KEY'] = 'test-key'
  vi.mocked(getSession).mockImplementation(() => sessionAnswering(() => []) as never)
})

// D62 (tour of 23 Sep 2026): asked in English on an English interface, the analysis answered in Italian.
describe('answer language', () => {
  it('the system prompt is in English and names the language of the interface', async () => {
    const { buildSystemPrompt } = await import('../reportAgent.js')
    const p = buildSystemPrompt('## Neo4j graph schema', 'Italian')
    expect(p).toContain('Write every sentence in Italian')
    expect(p).toMatch(/^You are an ITSM analysis assistant/)
    expect(p).not.toMatch(/Rispondi|REGOLE/)
  })
})

describe('schema context', () => {
  it('lists the tenant\'s labels with exact counts and its relationships in the system prompt', async () => {
    const tenantId = freshTenant()
    const session = sessionAnswering((cypher) => {
      if (cypher.includes('count(n) AS count')) return [rec({ label: 'Incident', count: { toNumber: () => 42 } }), rec({ label: 'Team', count: 3 })]
      if (cypher.includes('MATCH (n:`Incident`)')) return [rec({ props: ['title', 'status'], rels: [{ rel: 'ASSIGNED_TO', to: 'Team' }] })]
      if (cypher.includes('MATCH (n:`Team`)')) return [rec({ props: ['name'], rels: [] })]
      return []
    })
    vi.mocked(getSession).mockReturnValue(session as never)
    const { client, create } = clientReturning(text('ok'))
    await runReportAgent({ permissions: ALL, tenantId, language: 'English', messages: [{ role: 'user', content: 'q' }], client })

    const system = (create.mock.calls[0]![0] as { system: Array<{ text: string }> }).system[0]!.text
    expect(system).toContain('- **Incident** (42 nodes): title, status')
    expect(system).toContain('- **Team** (3 nodes): name')
    expect(system).toContain('- (Incident)-[:ASSIGNED_TO]->(Team)')
    // Every schema read is scoped to the tenant.
    for (const call of session.run.mock.calls as unknown as Array<[string, Record<string, unknown>]>) {
      expect(call[1]).toMatchObject({ tenantId })
    }
    expect(session.close).toHaveBeenCalled()
  })

  /*
   * Review of 23 Sep 2026: the labels come from the exact counts, and each is
   * sampled on its own. A 20,000-node sample of the whole tenant, dominated by
   * the audit entries, left the tickets written later out of the schema.
   */
  it('every counted label is in the schema, even one the first nodes of the tenant do not show', async () => {
    const tenantId = freshTenant()
    const session = sessionAnswering((cypher) => {
      if (cypher.includes('count(n) AS count')) return [rec({ label: 'AuditEntry', count: 1_500_000 }), rec({ label: 'Problem', count: 12 })]
      if (cypher.includes('MATCH (n:`Problem`)')) return [rec({ props: ['title'], rels: [] })]
      return [rec({ props: [], rels: [] })]
    })
    vi.mocked(getSession).mockReturnValue(session as never)
    const { client, create } = clientReturning(text('ok'))
    await runReportAgent({ permissions: ALL, tenantId, language: 'English', messages: [{ role: 'user', content: 'q' }], client })
    const system = (create.mock.calls[0]![0] as { system: Array<{ text: string }> }).system[0]!.text
    expect(system).toContain('- **Problem** (12 nodes): title')
    // The label is written in the text, quoted — `MATCH (n:$(label))` scans every node.
    const reads = (session.run.mock.calls as unknown as Array<[string]>).map((c) => c[0])
    expect(reads.some((q) => q.includes('MATCH (n:`AuditEntry`)'))).toBe(true)
    expect(reads.some((q) => q.includes('$(label)'))).toBe(false)
  })

  it('a label is quoted as an identifier', async () => {
    const tenantId = freshTenant()
    const session = sessionAnswering((cypher) => (cypher.includes('count(n) AS count') ? [rec({ label: 'We`ird', count: 1 })] : []))
    vi.mocked(getSession).mockReturnValue(session as never)
    const { getCachedSchema, clearSchemaCache } = await import('../reportAgent.js')
    clearSchemaCache()
    expect(await getCachedSchema(tenantId)).toContain('- **We`ird** (1 nodes): ')
    expect((session.run.mock.calls as unknown as Array<[string]>).some((c) => c[0].includes('MATCH (n:`We``ird`)'))).toBe(true)
  })

  /*
   * D67 (tour of 23 Sep 2026): the exact counts read every node of the tenant
   * (2.7 s on the demo tenant) at the first question of every five minutes.
   * Now only the very first question waits; an expired schema is used while
   * the next one is built in the background.
   */
  it('only the first question waits for the scan; an expired schema is served while a new one is built', async () => {
    const { getCachedSchema, clearSchemaCache, SCHEMA_TTL_MS } = await import('../reportAgent.js')
    clearSchemaCache()
    const tenantId = freshTenant()
    let version = 1
    const session = sessionAnswering((cypher) => (cypher.includes('count(n) AS count') ? [rec({ label: `V${version}`, count: 1 })] : []))
    vi.mocked(getSession).mockReturnValue(session as never)
    const t0 = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0)

    expect(await getCachedSchema(tenantId)).toContain('**V1**')
    const reads = session.run.mock.calls.length

    // fresh: no read at all
    expect(await getCachedSchema(tenantId)).toContain('**V1**')
    expect(session.run.mock.calls.length).toBe(reads)

    // expired: the old one is answered at once, the new one is built behind it
    version = 2
    now.mockReturnValue(t0 + SCHEMA_TTL_MS + 1)
    expect(await getCachedSchema(tenantId)).toContain('**V1**')
    await vi.waitFor(async () => { expect(await getCachedSchema(tenantId)).toContain('**V2**') })
  })

  it('a failed rebuild is logged, and the previous schema stays in use', async () => {
    const { getCachedSchema, clearSchemaCache, SCHEMA_TTL_MS } = await import('../reportAgent.js')
    const { logger } = await import('../../lib/logger.js')
    clearSchemaCache()
    const tenantId = freshTenant()
    vi.mocked(getSession).mockReturnValue(sessionAnswering((cypher) => (cypher.includes('count(n) AS count') ? [rec({ label: 'Old', count: 1 })] : [])) as never)
    const t0 = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
    await getCachedSchema(tenantId)

    vi.mocked(getSession).mockReturnValue(sessionAnswering(() => new Error('neo4j busy')) as never)
    now.mockReturnValue(t0 + SCHEMA_TTL_MS + 1)
    expect(await getCachedSchema(tenantId)).toContain('**Old**')
    await vi.waitFor(() => { expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ tenantId }), expect.stringContaining('schema rebuild failed')) })
  })

  it('the first question of a tenant waits, and concurrent first questions share one scan', async () => {
    const { getCachedSchema, clearSchemaCache } = await import('../reportAgent.js')
    clearSchemaCache()
    const session = sessionAnswering((cypher) => (cypher.includes('count(n) AS count') ? [rec({ label: 'Incident', count: 1 }), rec({ label: 'Team', count: 1 })] : []))
    vi.mocked(getSession).mockReturnValue(session as never)
    const tenantId = freshTenant()
    const [a, b] = await Promise.all([getCachedSchema(tenantId), getCachedSchema(tenantId)])
    expect(a).toBe(b)
    // the counts, then one reading per label — once
    expect(session.run).toHaveBeenCalledTimes(3)
  })
})

describe('the tool the model reads (D62)', () => {
  it('is described in English, like the system prompt', () => {
    expect(CYPHER_TOOL.description).toMatch(/^Runs a READ-ONLY Cypher query/)
    expect(JSON.stringify(CYPHER_TOOL)).not.toMatch(/Esegue|Descrizione|rifiutat/)
  })
})

describe('runReportAgent — input and loop edges', () => {
  // Review of 23 Sep 2026: an abandoned stream kept calling the model to the end of its budget.
  it('the signal reaches the model call, and an aborted one stops before the next turn', async () => {
    const tool = message([{ type: 'tool_use', id: 'tu', name: CYPHER_TOOL.name, input: { query: SAFE_Q } }], 'tool_use')
    const ctrl = new AbortController()
    const create = vi.fn(async () => { ctrl.abort(); return tool })
    const client = { messages: { create } } as unknown as Anthropic
    await expect(runReportAgent({ permissions: ALL, tenantId: freshTenant(), messages: [{ role: 'user', content: 'q' }], client, signal: ctrl.signal }))
      .rejects.toThrow('the person who asked went away')
    expect(create).toHaveBeenCalledTimes(1)
    expect((create.mock.calls[0] as unknown[])[1]).toEqual({ signal: ctrl.signal })
  })

  it('refuses an empty conversation before calling the model', async () => {
    const { client, create } = clientReturning(text('x'))
    await expect(runReportAgent({ permissions: ALL, tenantId: freshTenant(), messages: [], client })).rejects.toThrow('no messages to send')
    expect(create).not.toHaveBeenCalled()
  })

  it('an answer cut by max_tokens is returned (partial) and logged', async () => {
    const tenantId = freshTenant()
    const { client } = clientReturning(text('partial', 'max_tokens'))
    await expect(runReportAgent({ permissions: ALL, tenantId, language: 'English', messages: [{ role: 'user', content: 'q' }], client })).resolves.toBe('partial')
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tenantId }), expect.stringContaining('truncated by max_tokens'))
  })

  it('a call to a tool the agent does not offer fails the request', async () => {
    const { client } = clientReturning(message([{ type: 'tool_use', id: 'tu', name: 'delete_everything', input: {} }], 'tool_use'))
    await expect(runReportAgent({ permissions: ALL, tenantId: freshTenant(), messages: [{ role: 'user', content: 'q' }], client }))
      .rejects.toThrow('unknown tool "delete_everything"')
  })

  it('a tool call without a description still runs, announcing an empty description to the stream', async () => {
    const events: unknown[] = []
    const tool = message([{ type: 'tool_use', id: 'tu', name: CYPHER_TOOL.name, input: { query: SAFE_Q } }], 'tool_use')
    const done = text('done')
    let n = 0
    const client = {
      messages: {
        stream: () => {
          const m = n++ === 0 ? tool : done
          return { on: () => {}, finalMessage: async () => m }
        },
      },
    } as unknown as Anthropic
    await runReportAgent({ permissions: ALL, tenantId: freshTenant(), messages: [{ role: 'user', content: 'q' }], client, stream: (e) => events.push(e) })
    expect(events).toContainEqual({ type: 'tool', description: '' })
  })
})

describe('ToolLoopBudget', () => {
  it('stops the loop once the wall-clock budget is spent', () => {
    const t0 = 1_000_000
    vi.spyOn(Date, 'now').mockReturnValue(t0)
    const budget = new ToolLoopBudget()
    vi.spyOn(Date, 'now').mockReturnValue(t0 + REPORT_AI_LIMITS.maxDurationMs + 1000)
    expect(() => budget.beforeModelCall()).toThrow(/time budget exhausted \(121s > 120s\)/)
  })

  it('ignores a usage figure that is not a finite number', () => {
    const budget = new ToolLoopBudget()
    budget.recordUsage(undefined)
    budget.recordUsage(Number.NaN)
    budget.recordUsage(5)
    expect(budget.outputTokens).toBe(5)
  })
})

describe('runGuardedCypherTool', () => {
  it(`fails the request after ${REPORT_AI_LIMITS.maxRejections} tolerated refusals, never running the query`, async () => {
    const budget = new ToolLoopBudget()
    const bad = 'MATCH (u:User) RETURN u'
    for (let i = 0; i < REPORT_AI_LIMITS.maxRejections; i++) {
      await expect(runGuardedCypherTool(bad, 't1', budget, 'L')).resolves.toContain('Rewrite the query')
    }
    await expect(runGuardedCypherTool(bad, 't1', budget, 'L')).rejects.toThrow(/refused 3 times by the safety guard/)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('a guard failure that is not a refusal propagates (it is a bug, not feedback for the model)', async () => {
    const budget = new ToolLoopBudget()
    await expect(runGuardedCypherTool('GUARD_CRASH', 't1', budget, 'L')).rejects.toThrow('guard bug')
    expect(budget.rejections).toBe(0)
  })

  it('runs the query with the tenant as the only parameter, converting Neo4j integers', async () => {
    const session = sessionAnswering(() => [rec({ title: 'Down', n: { toNumber: () => 7 }, none: null })])
    vi.mocked(getSession).mockReturnValue(session as never)
    const out = await runGuardedCypherTool(SAFE_Q, 't1', new ToolLoopBudget(), 'L')
    expect(JSON.parse(out)).toEqual([{ title: 'Down', n: 7, none: null }])
    expect(session.run).toHaveBeenCalledWith(SAFE_Q, { tenantId: 't1' })
    expect(session.close).toHaveBeenCalled()
  })

  it('caps a huge result so it cannot flood the model context', async () => {
    const rows = Array.from({ length: 400 }, (_, i) => rec({ title: `incident number ${i} with a long title` }))
    vi.mocked(getSession).mockReturnValue(sessionAnswering(() => rows) as never)
    const out = await runGuardedCypherTool(SAFE_Q, 't1', new ToolLoopBudget(), 'L')
    expect(out).toContain('\n... (truncated)')
    // Review of 23 Sep 2026: the rows past the limit are not even loaded, and the model is told.
    expect(out.endsWith('\n... (only the first 200 rows: aggregate, or add a LIMIT)')).toBe(true)
    expect(out.length).toBe(8000 + '\n... (truncated)'.length + '\n... (only the first 200 rows: aggregate, or add a LIMIT)'.length)
  })

  it('the query runs with a time limit, and a timeout goes back to the model as advice, not as a crash', async () => {
    const session = sessionAnswering(() => Object.assign(new Error('The transaction has been terminated'), { code: 'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration' }))
    vi.mocked(getSession).mockReturnValue(session as never)
    await expect(runGuardedCypherTool(SAFE_Q, 't1', new ToolLoopBudget(), 'L')).resolves.toMatch(/^Query error: it ran for more than 20 seconds and was stopped/)
    expect(session.executeRead.mock.calls[0]![1]).toEqual({ timeout: 20_000 })
  })

  it('a Neo4j error goes back to the model as the tool result, and the session is closed', async () => {
    const session = sessionAnswering(() => new Error('Unknown function foo'))
    vi.mocked(getSession).mockReturnValue(session as never)
    await expect(runGuardedCypherTool(SAFE_Q, 't1', new ToolLoopBudget(), 'L')).resolves.toBe('Query error: Unknown function foo')
    expect(session.close).toHaveBeenCalled()
  })

  it('a non-Error rejection is stringified', async () => {
    const session = { executeRead: vi.fn().mockRejectedValue('boom'), close: vi.fn().mockResolvedValue(undefined) }
    vi.mocked(getSession).mockReturnValue(session as never)
    await expect(runGuardedCypherTool(SAFE_Q, 't1', new ToolLoopBudget(), 'L')).resolves.toBe('Query error: boom')
  })
})
