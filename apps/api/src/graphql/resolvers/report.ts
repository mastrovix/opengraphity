import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { callReportAI } from '../../services/reportAI.js'

interface Props { [key: string]: unknown }

function mapConversation(p: Props) {
  return {
    id:        p['id']         as string,
    title:     p['title']      as string,
    createdAt: p['created_at'] as string,
    updatedAt: p['updated_at'] as string,
  }
}

function mapMessage(p: Props) {
  return {
    id:        p['id']         as string,
    role:      p['role']       as string,
    content:   p['content']    as string,
    createdAt: p['created_at'] as string,
  }
}

async function reportConversations(_: unknown, __: unknown, ctx: GraphQLContext) {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (c:ReportConversation {tenant_id: $tenantId})
         RETURN properties(c) AS props ORDER BY c.updated_at DESC`,
        { tenantId: ctx.tenantId },
      ),
    )
    return result.records.map((r) => mapConversation(r.get('props') as Props))
  } finally {
    await session.close()
  }
}

async function reportConversation(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (c:ReportConversation {id: $id, tenant_id: $tenantId})
         RETURN properties(c) AS props`,
        { id: args.id, tenantId: ctx.tenantId },
      ),
    )
    if (!result.records.length) return null
    return mapConversation(result.records[0].get('props') as Props)
  } finally {
    await session.close()
  }
}

async function askReport(
  _: unknown,
  args: { question: string; conversationId?: string | null },
  ctx: GraphQLContext,
) {
  const session = getSession(undefined, 'WRITE')
  const now = new Date().toISOString()

  try {
    let convId = args.conversationId ?? null

    // 1. Crea conversazione se nuova
    if (!convId) {
      convId = uuidv4()
      const title = args.question.slice(0, 60)
      await session.executeWrite((tx) =>
        tx.run(
          `CREATE (:ReportConversation {
            id: $id, tenant_id: $tenantId,
            title: $title,
            created_at: $now, updated_at: $now
          })`,
          { id: convId, tenantId: ctx.tenantId, title, now },
        ),
      )
    }

    // 2. Salva messaggio utente
    const userMsgId = uuidv4()
    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (c:ReportConversation {id: $convId, tenant_id: $tenantId})
         CREATE (m:ReportMessage {
           id: $id, tenant_id: $tenantId,
           conversation_id: $convId,
           role: 'user', content: $content,
           created_at: $now
         })
         CREATE (c)-[:HAS_MESSAGE]->(m)`,
        { convId, tenantId: ctx.tenantId, id: userMsgId, content: args.question, now },
      ),
    )

    // 3. Carica storia (ultimi 10 messaggi)
    const histResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (c:ReportConversation {id: $convId})-[:HAS_MESSAGE]->(m:ReportMessage)
         RETURN m.role AS role, m.content AS content
         ORDER BY m.created_at ASC LIMIT 10`,
        { convId },
      ),
    )
    const history = histResult.records.map((r) => ({
      role:    r.get('role')    as string,
      content: r.get('content') as string,
    }))
    // Escludi l'ultimo messaggio utente appena salvato dalla history (verrà passato come question)
    const historyWithoutLast = history.slice(0, -1)

    // 4. Chiama Claude API
    const aiResponse = await callReportAI(ctx.tenantId, historyWithoutLast, args.question)

    // 5. Salva risposta assistant
    const asstMsgId = uuidv4()
    const asstNow = new Date().toISOString()
    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (c:ReportConversation {id: $convId, tenant_id: $tenantId})
         CREATE (m:ReportMessage {
           id: $id, tenant_id: $tenantId,
           conversation_id: $convId,
           role: 'assistant', content: $content,
           created_at: $now
         })
         CREATE (c)-[:HAS_MESSAGE]->(m)`,
        { convId, tenantId: ctx.tenantId, id: asstMsgId, content: aiResponse, now: asstNow },
      ),
    )

    // 6. Aggiorna updated_at conversazione
    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (c:ReportConversation {id: $convId, tenant_id: $tenantId})
         SET c.updated_at = $now`,
        { convId, tenantId: ctx.tenantId, now: asstNow },
      ),
    )

    // 7. Ritorna risultato
    return {
      message: {
        id:        asstMsgId,
        role:      'assistant',
        content:   aiResponse,
        createdAt: asstNow,
      },
      conversationId: convId,
    }
  } finally {
    await session.close()
  }
}

async function deleteReportConversation(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (c:ReportConversation {id: $id, tenant_id: $tenantId})
         OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(m:ReportMessage)
         DETACH DELETE c, m`,
        { id: args.id, tenantId: ctx.tenantId },
      ),
    )
    return true
  } finally {
    await session.close()
  }
}

// Field resolver: ReportConversation.messages
async function reportConversationMessages(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (c:ReportConversation {id: $id, tenant_id: $tenantId})-[:HAS_MESSAGE]->(m:ReportMessage)
         RETURN properties(m) AS props ORDER BY m.created_at ASC`,
        { id: parent.id, tenantId: ctx.tenantId },
      ),
    )
    return result.records.map((r) => mapMessage(r.get('props') as Props))
  } finally {
    await session.close()
  }
}

export const reportResolvers = {
  Query: {
    reportConversations,
    reportConversation,
  },
  Mutation: {
    askReport,
    deleteReportConversation,
  },
  ReportConversation: {
    messages: reportConversationMessages,
  },
}
