/**
 * Persistence of AI report conversations (ReportConversation / ReportMessage),
 * shared by the GraphQL mutation `askReport` and the SSE route
 * `POST /api/report/stream` — previously two ~100-line copies (C-10).
 *
 * A CONVERSATION BELONGS TO ONE PERSON (23 Sep 2026). It used to be scoped to
 * the tenant only, so anyone in the tenant could list, read, continue and
 * delete everybody else's AI report conversations — and a question asked of
 * the AI can carry things the asker would not show a colleague. Every read
 * and write below now matches on `user_id` as well as `tenant_id`, and
 * continuing somebody else's conversation is "not found", exactly like one
 * that does not exist: saying "it exists but is not yours" would confirm the
 * id. Conversations saved before this carry no `user_id`, so nobody sees them
 * any more: there is no record of who started them, and guessing an owner
 * would hand them to the wrong person. They are hidden, not deleted.
 *
 * History semantics: the LAST `HISTORY_LIMIT` messages before the one just
 * saved, oldest first. The old copies used `ORDER BY created_at ASC LIMIT 10`
 * (the FIRST ten) and `slice(0, -1)` (dropping the tenth-oldest, not the new
 * message), so long conversations replayed their opening turns to the model.
 */
import { v4 as uuidv4 } from 'uuid'
import type { Session } from 'neo4j-driver'
import { NotFoundError } from '../lib/errors.js'

export const HISTORY_LIMIT = 10

export interface ConversationMessage { role: string; content: string }

export interface SavedMessage { id: string; role: string; content: string; createdAt: string }

export interface RunConversationOptions {
  session:         Session
  tenantId:        string
  /** The person asking: the conversation is theirs and only theirs. */
  userId:          string
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
  session: Session, tenantId: string, userId: string, conversationId: string | null | undefined, question: string,
): Promise<{ conversationId: string; created: boolean }> {
  if (conversationId) {
    // Continuing a conversation: it must be THIS person's, or it is not found.
    const res = await session.executeRead(tx => tx.run(
      `MATCH (c:ReportConversation {id: $id, tenant_id: $tenantId, user_id: $userId}) RETURN c.id AS id`,
      { id: conversationId, tenantId, userId },
    ))
    if (!res.records.length) throw new NotFoundError('ReportConversation', conversationId)
    return { conversationId, created: false }
  }
  const id = uuidv4()
  const now = new Date().toISOString()
  await session.executeWrite(tx => tx.run(
    `CREATE (:ReportConversation {
       id: $id, tenant_id: $tenantId, user_id: $userId,
       title: $title,
       created_at: $now, updated_at: $now
     })`,
    { id, tenantId, userId, title: question.slice(0, 60), now },
  ))
  return { conversationId: id, created: true }
}

export async function saveMessage(
  session: Session, tenantId: string, userId: string, conversationId: string, role: 'user' | 'assistant', content: string,
): Promise<SavedMessage> {
  const id  = uuidv4()
  const now = new Date().toISOString()
  const res = await session.executeWrite(tx => tx.run(
    `MATCH (c:ReportConversation {id: $convId, tenant_id: $tenantId, user_id: $userId})
     CREATE (m:ReportMessage {
       id: $id, tenant_id: $tenantId,
       conversation_id: $convId,
       role: $role, content: $content,
       created_at: $now
     })
     CREATE (c)-[:HAS_MESSAGE]->(m)
     SET c.updated_at = $now
     RETURN m.id AS id`,
    { convId: conversationId, tenantId, userId, id, role, content, now },
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
  session: Session, tenantId: string, userId: string, conversationId: string, excludeMessageId: string, limit = HISTORY_LIMIT,
): Promise<ConversationMessage[]> {
  const res = await session.executeRead(tx => tx.run(
    `MATCH (c:ReportConversation {id: $convId, tenant_id: $tenantId, user_id: $userId})-[:HAS_MESSAGE]->(m:ReportMessage)
     WHERE m.id <> $excludeId
     RETURN m.role AS role, m.content AS content
     ORDER BY m.created_at DESC
     LIMIT toInteger($limit)`,
    { convId: conversationId, tenantId, userId, excludeId: excludeMessageId, limit },
  ))
  return res.records
    .map(r => ({ role: r.get('role') as string, content: r.get('content') as string }))
    .reverse()
}

/** Full turn: ensure conversation → save question → history → ask → save answer. */
export async function runReportConversation(opts: RunConversationOptions): Promise<RunConversationResult> {
  const { session, tenantId, userId, question } = opts

  const { conversationId, created } = await ensureConversation(session, tenantId, userId, opts.conversationId, question)
  if (created) opts.onConversationCreated?.(conversationId)

  const userMsg = await saveMessage(session, tenantId, userId, conversationId, 'user', question)
  const history = await loadRecentHistory(session, tenantId, userId, conversationId, userMsg.id)

  const answer  = await opts.ask(history, question)
  const message = await saveMessage(session, tenantId, userId, conversationId, 'assistant', answer)

  return { conversationId, message }
}
