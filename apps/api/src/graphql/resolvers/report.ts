import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { callReportAI } from '../../services/reportAI.js'
import { runReportConversation } from '../../services/reportConversation.js'
import { requireRole } from '../../lib/requireRole.js'

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
  // The AI tool executes model-generated Cypher (guarded, read-only): not for viewers/end users.
  requireRole(ctx, 'admin', 'operator')

  const session = getSession(undefined, 'WRITE')
  try {
    // Conversation persistence + "last 10" history live in services/reportConversation
    // (shared with the SSE route).
    const { conversationId, message } = await runReportConversation({
      session,
      tenantId:       ctx.tenantId,
      question:       args.question,
      conversationId: args.conversationId,
      ask: (history, question) => callReportAI(ctx.tenantId, history, question),
    })
    return { message, conversationId }
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
