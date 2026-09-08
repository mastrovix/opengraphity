/**
 * Thin wrappers around the single report agent (see ./reportAgent.ts).
 * Kept for the existing callers (`rest/report-stream.ts`,
 * `graphql/resolvers/report.ts`) whose signatures are unchanged.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { runReportAgent } from './reportAgent.js'

export {
  REPORT_AI_LIMITS, ToolLoopBudget, runGuardedCypherTool,
  DEFAULT_REPORT_AI_MODEL, resolveReportAIModel,
} from './reportAgent.js'

export interface HistoryMessage { role: string; content: string }

/** Conversation history + new question → SDK messages. A foreign role is a data bug: fail loud. */
export function toAgentMessages(history: HistoryMessage[], question: string): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = history.map((m, i) => {
    if (m.role !== 'user' && m.role !== 'assistant') {
      throw new Error(`[reportAI] history message #${i} has unsupported role "${m.role}"`)
    }
    return { role: m.role, content: m.content }
  })
  messages.push({ role: 'user', content: question })
  return messages
}

export async function streamReportAI(
  tenantId: string,
  history: HistoryMessage[],
  question: string,
  onChunk: (text: string) => void,
  onToolUse: (description: string) => void,
): Promise<string> {
  return runReportAgent({
    tenantId,
    messages: toAgentMessages(history, question),
    stream: (event) => {
      if (event.type === 'text') onChunk(event.text)
      else onToolUse(event.description)
    },
  })
}

export async function callReportAI(
  tenantId: string,
  history: HistoryMessage[],
  question: string,
): Promise<string> {
  return runReportAgent({ tenantId, messages: toAgentMessages(history, question) })
}
