/**
 * C-20a — one agent loop for streaming and non-streaming callers: same
 * system prompt, same tool, same model; guard + budget enforced in both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { runReportAgent, REPORT_AI_LIMITS, DEFAULT_REPORT_AI_MODEL, resolveReportAIModel, CYPHER_TOOL } = await import('../reportAgent.js')
const { streamReportAI, callReportAI, toAgentMessages } = await import('../reportAI.js')
const { getSession } = await import('@opengraphity/neo4j')

// ── Fakes ─────────────────────────────────────────────────────────────────

const SCHEMA_QUERY_MARKERS = ["WITH head([l IN labels(n) WHERE l <> 'ConfigurationItem']) AS label, keys(n)", 'MATCH (a)-[r]->(b)', 'count(n) AS count']

/** Schema-context queries get no rows; everything else gets `rows`. */
function makeSession(rows: Array<Record<string, unknown>> = []) {
  const run = vi.fn().mockImplementation(async (cypher: string) => ({
    records: SCHEMA_QUERY_MARKERS.some(m => cypher.includes(m))
      ? []
      : rows.map(r => ({ keys: Object.keys(r), get: (k: string) => r[k] })),
  }))
  return {
    run,
    executeRead: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn({ run })),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function textMessage(text: string, stop: Anthropic.Message['stop_reason'] = 'end_turn', outputTokens = 10): Anthropic.Message {
  return {
    id: 'msg', type: 'message', role: 'assistant', model: 'm',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: outputTokens, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null },
  } as unknown as Anthropic.Message
}

function toolMessage(id: string, query: string, description = 'cerco', preText = ''): Anthropic.Message {
  const m = textMessage(preText, 'tool_use')
  m.content = [
    ...(preText ? m.content : []),
    { type: 'tool_use', id, name: CYPHER_TOOL.name, input: { query, description } },
  ] as Anthropic.Message['content']
  return m
}

/** Fake SDK client: `create` returns messages in order; `stream` replays text blocks as deltas. */
function fakeClient(responses: Anthropic.Message[]) {
  let i = 0
  const next = () => {
    const m = responses[Math.min(i, responses.length - 1)]!
    i++
    return m
  }
  const create = vi.fn().mockImplementation(async () => next())
  const stream = vi.fn().mockImplementation(() => {
    const m = next()
    let onText: ((t: string) => void) | null = null
    return {
      on: (event: string, cb: (t: string) => void) => { if (event === 'text') onText = cb },
      finalMessage: async () => {
        for (const b of m.content) if (b.type === 'text' && onText) onText(b.text)
        return m
      },
    }
  })
  return { client: { messages: { create, stream } } as unknown as Anthropic, create, stream }
}

const SAFE_Q = 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN count(i) AS n'

beforeEach(() => {
  vi.clearAllMocks()
  process.env['ANTHROPIC_API_KEY'] = 'test-key'
  delete process.env['REPORT_AI_MODEL']
  vi.mocked(getSession).mockImplementation(() => makeSession([{ n: 3 }]) as never)
})
afterEach(() => { delete process.env['REPORT_AI_MODEL'] })

// ── Tests ─────────────────────────────────────────────────────────────────

describe('runReportAgent — stream vs non-stream', () => {
  it('sends the same model, system prompt and tool set in both modes', async () => {
    const a = fakeClient([textMessage('ciao')])
    const b = fakeClient([textMessage('ciao')])
    const messages = [{ role: 'user' as const, content: 'quanti incident?' }]

    await runReportAgent({ tenantId: 't1', messages, client: a.client })
    await runReportAgent({ tenantId: 't1', messages, client: b.client, stream: () => {} })

    expect(a.create).toHaveBeenCalledTimes(1)
    expect(a.stream).not.toHaveBeenCalled()
    expect(b.stream).toHaveBeenCalledTimes(1)
    expect(b.create).not.toHaveBeenCalled()

    const p1 = a.create.mock.calls[0]![0] as Record<string, unknown>
    const p2 = b.stream.mock.calls[0]![0] as Record<string, unknown>
    for (const key of ['model', 'system', 'tools', 'max_tokens', 'tool_choice', 'thinking']) {
      expect(p2[key]).toEqual(p1[key])
    }
    expect(p1['model']).toBe(DEFAULT_REPORT_AI_MODEL)
    expect(p1['tools']).toEqual([CYPHER_TOOL])
    const system = p1['system'] as Array<{ text: string }>
    expect(system[0]!.text).toContain('run_cypher_query')
    expect(system[0]!.text).toContain('tenant_id: $tenantId')
  })

  it('REPORT_AI_MODEL overrides the default model', async () => {
    process.env['REPORT_AI_MODEL'] = 'claude-test-model'
    expect(resolveReportAIModel()).toBe('claude-test-model')
    const f = fakeClient([textMessage('ok')])
    await runReportAgent({ tenantId: 't1', messages: [{ role: 'user', content: 'q' }], client: f.client })
    expect((f.create.mock.calls[0]![0] as { model: string }).model).toBe('claude-test-model')
  })

  it('fails loud without ANTHROPIC_API_KEY', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    const f = fakeClient([textMessage('ok')])
    await expect(runReportAgent({ tenantId: 't1', messages: [{ role: 'user', content: 'q' }], client: f.client }))
      .rejects.toThrow(/ANTHROPIC_API_KEY/)
    expect(f.create).not.toHaveBeenCalled()
  })
})

describe('runReportAgent — tool loop', () => {
  it('runs the guarded query, feeds the result back and returns the concatenated text', async () => {
    const f = fakeClient([
      toolMessage('tu-1', SAFE_Q, 'conto gli incident', 'Vediamo. '),
      textMessage('Ci sono 3 incident.'),
    ])
    const events: unknown[] = []
    const out = await runReportAgent({
      tenantId: 't1',
      messages: [{ role: 'user', content: 'quanti incident?' }],
      client: f.client,
      stream: (e) => events.push(e),
    })

    expect(out).toBe('Vediamo. Ci sono 3 incident.')
    expect(events).toEqual([
      { type: 'text', text: 'Vediamo. ' },
      { type: 'tool', description: 'conto gli incident' },
      { type: 'text', text: 'Ci sono 3 incident.' },
    ])

    // second turn carries assistant tool_use + user tool_result with the rows
    const second = f.stream.mock.calls[1]![0] as { messages: Anthropic.MessageParam[] }
    expect(second.messages).toHaveLength(3)
    expect(second.messages[1]!.role).toBe('assistant')
    const toolResult = (second.messages[2]!.content as Anthropic.ToolResultBlockParam[])[0]!
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'tu-1' })
    expect(JSON.parse(toolResult.content as string)).toEqual([{ n: 3 }])
  })

  it('unsafe Cypher is not executed: the rejection goes back to the model as tool_result', async () => {
    const session = makeSession()
    vi.mocked(getSession).mockReturnValue(session as never)
    const f = fakeClient([
      toolMessage('tu-1', 'MATCH (u:User) RETURN u.email'),
      textMessage('Non posso.'),
    ])
    await runReportAgent({ tenantId: 't1', messages: [{ role: 'user', content: 'q' }], client: f.client })

    expect(session.run).not.toHaveBeenCalledWith(expect.stringContaining('u.email'), expect.anything())
    const second = f.create.mock.calls[1]![0] as { messages: Anthropic.MessageParam[] }
    const toolResult = (second.messages[2]!.content as Anthropic.ToolResultBlockParam[])[0]!
    expect(toolResult.content).toContain('Query rifiutata')
  })

  it(`stops after ${REPORT_AI_LIMITS.maxIterations} tool calls (budget)`, async () => {
    const f = fakeClient([toolMessage('tu', SAFE_Q)]) // always asks for another query
    await expect(runReportAgent({ tenantId: 't1', messages: [{ role: 'user', content: 'q' }], client: f.client }))
      .rejects.toThrow(new RegExp(`limite di ${REPORT_AI_LIMITS.maxIterations} query`))
    expect(f.create).toHaveBeenCalledTimes(REPORT_AI_LIMITS.maxIterations + 1)
  })

  it('stops when the cumulative output-token budget is exceeded', async () => {
    const big = toolMessage('tu', SAFE_Q)
    big.usage.output_tokens = REPORT_AI_LIMITS.maxOutputTokens + 1
    const f = fakeClient([big])
    await expect(runReportAgent({ tenantId: 't1', messages: [{ role: 'user', content: 'q' }], client: f.client }))
      .rejects.toThrow(/budget token/)
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it('a tool call without a query fails the request instead of running nothing', async () => {
    const m = toolMessage('tu-1', '')
    const f = fakeClient([m, textMessage('x')])
    await expect(runReportAgent({ tenantId: 't1', messages: [{ role: 'user', content: 'q' }], client: f.client }))
      .rejects.toThrow(/without a query/)
  })

  it('a refusal is an error, not an empty answer', async () => {
    const f = fakeClient([textMessage('', 'refusal')])
    await expect(runReportAgent({ tenantId: 't1', messages: [{ role: 'user', content: 'q' }], client: f.client }))
      .rejects.toThrow(/rifiutato/)
  })
})

describe('reportAI wrappers', () => {
  it('toAgentMessages appends the question and rejects foreign roles', () => {
    expect(toAgentMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], 'c')).toEqual([
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
    ])
    expect(() => toAgentMessages([{ role: 'system', content: 'x' }], 'c')).toThrow(/unsupported role/)
  })

  it('streamReportAI and callReportAI keep their signatures (smoke via SDK default client)', async () => {
    // Without a client seam the wrappers build `new Anthropic()`; with the fake
    // key that fails at request time — assert we get that far and no further.
    await expect(callReportAI('t1', [], 'q')).rejects.toBeTruthy()
    await expect(streamReportAI('t1', [], 'q', () => {}, () => {})).rejects.toBeTruthy()
  })
})
