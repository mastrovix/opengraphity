/**
 * THE REPORT-AI ENTRY POINTS (SSE stream and GraphQL call).
 *
 * These wrappers are the only thing between a user's chat history and the
 * report agent. What must not regress:
 *  - the tenant's "reportAnalysis" switch is checked BEFORE the agent runs:
 *    a tenant that turned AI off must not have its data sent to the model;
 *  - the history is replayed in order with the new question last, and a
 *    foreign role (e.g. "system" smuggled in from a client) fails loudly
 *    instead of being passed to the model as an instruction;
 *  - the stream callbacks split text chunks from tool-use descriptions, so
 *    the UI shows "querying incidents..." rather than mixing it into the answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../reportAgent.js', () => ({
  runReportAgent: vi.fn(),
  REPORT_AI_LIMITS: {},
  ToolLoopBudget: class {},
  runGuardedCypherTool: vi.fn(),
  DEFAULT_REPORT_AI_MODEL: 'm',
  resolveReportAIModel: vi.fn(),
}))
vi.mock('../../lib/aiSettings.js', () => ({
  assertAIFeature: vi.fn(),
}))

const { toAgentMessages, streamReportAI, callReportAI } = await import('../reportAI.js')
const { runReportAgent } = await import('../reportAgent.js')
const { assertAIFeature } = await import('../../lib/aiSettings.js')

beforeEach(() => {
  vi.mocked(runReportAgent).mockReset()
  vi.mocked(assertAIFeature).mockReset().mockResolvedValue(undefined)
})

describe('toAgentMessages', () => {
  it('replays the history in order and appends the question as the last user turn', () => {
    const out = toAgentMessages(
      [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }],
      'q2',
    )
    expect(out).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
  })

  it('a foreign role fails loud, naming the offending message', () => {
    // A "system" turn from the client would become an instruction to the model.
    expect(() => toAgentMessages([{ role: 'user', content: 'x' }, { role: 'system', content: 'y' }], 'q'))
      .toThrow(/history message #1 has unsupported role "system"/)
  })
})

describe('callReportAI', () => {
  it('checks the tenant switch, then runs the agent with the tenant and the messages', async () => {
    vi.mocked(runReportAgent).mockResolvedValue('answer')
    await expect(callReportAI('t1', [], 'how many incidents?')).resolves.toBe('answer')
    expect(assertAIFeature).toHaveBeenCalledWith('t1', 'reportAnalysis')
    expect(runReportAgent).toHaveBeenCalledWith({ tenantId: 't1', messages: [{ role: 'user', content: 'how many incidents?' }] })
  })

  it('with the feature disabled the agent never runs', async () => {
    vi.mocked(assertAIFeature).mockRejectedValue(new Error('AI disabled'))
    await expect(callReportAI('t1', [], 'q')).rejects.toThrow('AI disabled')
    expect(runReportAgent).not.toHaveBeenCalled()
  })
})

describe('streamReportAI', () => {
  it('routes text events to onChunk and tool events to onToolUse', async () => {
    vi.mocked(runReportAgent).mockImplementation(async (opts) => {
      opts.stream?.({ type: 'text', text: 'Hel' })
      opts.stream?.({ type: 'tool', description: 'Counting incidents' })
      opts.stream?.({ type: 'text', text: 'lo' })
      return 'Hello'
    })
    const chunks: string[] = []
    const tools: string[] = []
    const out = await streamReportAI('t2', [{ role: 'assistant', content: 'hi' }], 'q', c => chunks.push(c), d => tools.push(d))
    expect(out).toBe('Hello')
    expect(chunks).toEqual(['Hel', 'lo'])
    expect(tools).toEqual(['Counting incidents'])
    expect(vi.mocked(runReportAgent).mock.calls[0]![0].tenantId).toBe('t2')
  })

  it('with the feature disabled nothing is streamed', async () => {
    vi.mocked(assertAIFeature).mockRejectedValue(new Error('AI disabled'))
    const onChunk = vi.fn()
    await expect(streamReportAI('t1', [], 'q', onChunk, vi.fn())).rejects.toThrow('AI disabled')
    expect(runReportAgent).not.toHaveBeenCalled()
    expect(onChunk).not.toHaveBeenCalled()
  })
})
