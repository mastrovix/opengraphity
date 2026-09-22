/**
 * streamAssistantChat — the organization's AI switches and the text layout.
 *
 * - When the organization turns the assistant off, the model must not be
 *   called at all (it costs money and the admin said no): the user gets the
 *   explicit "turned off" message instead.
 * - When embeddings are turned off, the two semantic-search tools must answer
 *   the model with an explicit "search is off, use X instead" instead of
 *   calling the embedder (which would fail, or silently search a stale index).
 * - A text block that starts after text already written (typically the answer
 *   after a tool call) begins on a new paragraph: without it the user read
 *   "…clienti.**CI:" glued together (browser review of 14 Sep 2026, #52).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../lib/__tests__/testPermissions.js'

vi.mock('../../lib/aiSettings.js', () => import('../../lib/__tests__/aiSettingsFake.js'))
vi.mock('../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant: vi.fn(async () => ['Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Server)`),
}))

type ToolLike = { name: string; run: (input: unknown) => Promise<string> }
type RunnerParams = { tools: ToolLike[] }

const h = vi.hoisted(() => ({
  cfg: { anthropicApiKey: 'sk-test' as string | undefined },
  toolRunner: vi.fn<(p: RunnerParams) => AsyncIterable<unknown>>(),
  embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1])),
}))

vi.mock('../../lib/config.js', () => ({ config: h.cfg }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { beta = { messages: { toolRunner: h.toolRunner } } },
}))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn(async () => undefined) })),
  runQuery: vi.fn().mockResolvedValue([]),
}))
vi.mock('../embeddings.js', () => ({
  getEmbedder: () => ({ embed: h.embed }),
  vectorIndexName: (label: string) => `${label}_idx`,
}))
vi.mock('../../lib/statusStepNames.js', () => ({
  concludedStatusNames: vi.fn(async () => ['closed']),
  statusNamesForClasses: vi.fn(async () => ['closed']),
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const { streamAssistantChat } = await import('../assistantService.js')
const { aiOff, aiResetFake } = await import('../../lib/__tests__/aiSettingsFake.js')
const { runQuery } = await import('@opengraphity/neo4j')

const emitter = () => ({ text: vi.fn(), tool: vi.fn(), done: vi.fn(), error: vi.fn() })

function messageStream(events: unknown[], final: { stop_reason: string } = { stop_reason: 'end_turn' }) {
  return {
    async *[Symbol.asyncIterator]() { for (const e of events) yield e },
    finalMessage: async () => ({ ...final, usage: { input_tokens: 1, output_tokens: 1 } }),
  }
}
const textDelta = (text: string) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } })
const textStart = () => ({ type: 'content_block_start', content_block: { type: 'text', text: '' } })
const toolStart = (name: string) => ({ type: 'content_block_start', content_block: { type: 'tool_use', name } })

function runnerOf(...streams: ReturnType<typeof messageStream>[]) {
  h.toolRunner.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() { for (const s of streams) yield s },
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  aiResetFake()
  h.cfg.anthropicApiKey = 'sk-test'
})

describe('organization switches', () => {
  it('assistant turned off → explicit error, the model is never called', async () => {
    aiOff('assistant')
    const emit = emitter()
    await streamAssistantChat('t1', perms('operator'), [{ role: 'user', content: 'hi' }], emit)
    expect(emit.error).toHaveBeenCalledWith(expect.stringMatching(/"assistant" is turned off/))
    expect(h.toolRunner).not.toHaveBeenCalled()
    expect(emit.done).not.toHaveBeenCalled()
  })

  it.each(['cerca_incident', 'cerca_kb'])('embeddings turned off → %s tells the model search is off, without embedding or querying', async (toolName) => {
    aiOff('embeddings')
    runnerOf(messageStream([]))
    await streamAssistantChat('t1', perms('operator'), [{ role: 'user', content: 'hi' }], emitter())
    const tool = h.toolRunner.mock.calls[0]![0].tools.find((t) => t.name === toolName)!
    const answer = JSON.parse(await tool.run({ query: 'disk full' })) as { error: string }
    expect(answer.error).toMatch(/Semantic search is turned off/)
    expect(h.embed).not.toHaveBeenCalled()
    expect(runQuery).not.toHaveBeenCalled()
  })
})

describe('paragraphs between text blocks', () => {
  it('a text block after written text starts a new paragraph; the first block does not', async () => {
    runnerOf(
      messageStream([textStart(), textDelta('Let me look.'), toolStart('cerca_ci')], { stop_reason: 'tool_use' }),
      messageStream([textStart(), textDelta('**CI:** db-01')]),
    )
    const emit = emitter()
    await streamAssistantChat('t1', perms('operator'), [{ role: 'user', content: 'hi' }], emit)
    expect(emit.done).toHaveBeenCalledWith('Let me look.\n\n**CI:** db-01')
    expect(emit.text.mock.calls.map((c) => c[0])).toEqual(['Let me look.', '\n\n', '**CI:** db-01'])
    expect(emit.tool).toHaveBeenCalledWith('cerca_ci')
  })

  it('no extra blank line when the text already ends with a newline', async () => {
    runnerOf(messageStream([textStart(), textDelta('Line\n'), textStart(), textDelta('Next')]))
    const emit = emitter()
    await streamAssistantChat('t1', perms('operator'), [{ role: 'user', content: 'hi' }], emit)
    expect(emit.done).toHaveBeenCalledWith('Line\nNext')
  })
})
