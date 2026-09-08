/**
 * Persistence of AI report conversations (ReportConversation / ReportMessage),
 * shared by the GraphQL mutation `askReport` and the SSE route
 * `POST /api/report/stream` — previously two ~100-line copies (C-10).
 *
 * History semantics: the LAST `HISTORY_LIMIT` messages before the one just
 * saved, oldest first. The old copies used `ORDER BY created_at ASC LIMIT 10`
 * (the FIRST ten) and `slice(0, -1)` (dropping the tenth-oldest, not the new
 * message), so long conversations replayed their opening turns to the model.
 */
import { v4 as uuidv4 } from 'uuid'
import type { Session } from 'neo4j-driver'

export const HISTORY_LIMIT = 10

export interface ConversationMessage { role: string; content: string }

export interface SavedMessage { id: string; role: string; content: string; createdAt: string }

export interface RunConversationOptions {
  session:         Session
  tenantId:        string
  question:        string
  conversationId?: string | null
  /** Produces the assistant answer given the prior history and the new question. */
  ask:             (history: ConversationMessage[], question: string) => Promise<string>
  /** Called right after a NEW conversation node is created (SSE sends it to the client). */
  onConversationCreated?: (conversationId: string) => void
}

export interface RunConversationResult {
  conversationId: string
  message:        SavedMessage
}

export async function ensureConversation(
  session: Session, tenantId: string, conversationId: string | null | undefined, question: string,
): Promise<{ conversationId: string; created: boolean }> {
  if (conversationId) return { conversationId, created: false }
  const id = uuidv4()
  const now = new Date().toISOString()
  await session.executeWrite(tx => tx.run(
    `CREATE (:ReportConversation {
       id: $id, tenant_id: $tenantId,
       title: $title,
       created_at: $now, updated_at: $now
     })`,
    { id, tenantId, title: question.slice(0, 60), now },
  ))
  return { conversationId: id, created: true }
}

export async function saveMessage(
  session: Session, tenantId: string, conversationId: string, role: 'user' | 'assistant', content: string,
): Promise<SavedMessage> {
  const id  = uuidv4()
  const now = new Date().toISOString()
  const res = await session.executeWrite(tx => tx.run(
    `MATCH (c:ReportConversation {id: $convId, tenant_id: $tenantId})
     CREATE (m:ReportMessage {
       id: $id, tenant_id: $tenantId,
       conversation_id: $convId,
       role: $role, content: $content,
       created_at: $now
     })
     CREATE (c)-[:HAS_MESSAGE]->(m)
     SET c.updated_at = $now
     RETURN m.id AS id`,
    { convId: conversationId, tenantId, id, role, content, now },
  ))
  if (!res.records.length) {
    throw new Error(`ReportConversation ${conversationId} not found in tenant — message not saved`)
  }
  return { id, role, content, createdAt: now }
}

/**
 * Last `limit` messages of the conversation BEFORE `excludeMessageId`
 * (the user message just saved, passed separately as the question),
 * returned oldest → newest as the model expects.
 */
export async function loadRecentHistory(
  session: Session, tenantId: string, conversationId: string, excludeMessageId: string, limit = HISTORY_LIMIT,
): Promise<ConversationMessage[]> {
  const res = await session.executeRead(tx => tx.run(
    `MATCH (c:ReportConversation {id: $convId, tenant_id: $tenantId})-[:HAS_MESSAGE]->(m:ReportMessage)
     WHERE m.id <> $excludeId
     RETURN m.role AS role, m.content AS content
     ORDER BY m.created_at DESC
     LIMIT toInteger($limit)`,
    { convId: conversationId, tenantId, excludeId: excludeMessageId, limit },
  ))
  return res.records
    .map(r => ({ role: r.get('role') as string, content: r.get('content') as string }))
    .reverse()
}

/** Full turn: ensure conversation → save question → history → ask → save answer. */
export async function runReportConversation(opts: RunConversationOptions): Promise<RunConversationResult> {
  const { session, tenantId, question } = opts

  const { conversationId, created } = await ensureConversation(session, tenantId, opts.conversationId, question)
  if (created) opts.onConversationCreated?.(conversationId)

  const userMsg = await saveMessage(session, tenantId, conversationId, 'user', question)
  const history = await loadRecentHistory(session, tenantId, conversationId, userMsg.id)

  const answer  = await opts.ask(history, question)
  const message = await saveMessage(session, tenantId, conversationId, 'assistant', answer)

  return { conversationId, message }
}
