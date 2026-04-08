import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import { authMiddleware } from '../middleware/auth.js'
import { streamReportAI } from '../services/reportAI.js'
import { logger } from '../lib/logger.js'

const router: ExpressRouter = Router()

router.post('/report/stream', authMiddleware, (req: Request, res: Response) => {
  void handleReportStream(req, res)
})

async function handleReportStream(req: Request, res: Response): Promise<void> {
  const { tenantId, userId } = req.user!
  const { question, conversationId: inputConvId } = req.body as {
    question?: string
    conversationId?: string | null
  }

  if (!question?.trim()) {
    res.status(400).json({ error: 'question is required' })
    return
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const now = new Date().toISOString()
  let convId = inputConvId ?? null
  const session = getSession(undefined, 'WRITE')

  try {
    // 1. Create conversation if new
    if (!convId) {
      convId = uuidv4()
      const title = question.slice(0, 60)
      await session.executeWrite((tx) =>
        tx.run(
          `CREATE (:ReportConversation {
            id: $id, tenant_id: $tenantId,
            title: $title,
            created_at: $now, updated_at: $now
          })`,
          { id: convId, tenantId, title, now },
        ),
      )
      send('conversation', { conversationId: convId })
    }

    // 2. Save user message
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
        { convId, tenantId, id: userMsgId, content: question, now },
      ),
    )

    // 3. Load history (last 10 messages)
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
    const historyWithoutLast = history.slice(0, -1)

    // 4. Stream AI response
    let fullText = ''
    const aiText = await streamReportAI(
      tenantId,
      historyWithoutLast,
      question,
      (chunk) => {
        fullText += chunk
        send('chunk', { text: chunk })
      },
      (description) => {
        send('tool', { description })
      },
    )
    fullText = aiText

    // 5. Save assistant message
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
        { convId, tenantId, id: asstMsgId, content: fullText, now: asstNow, userId },
      ),
    )

    // 6. Update conversation updated_at
    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (c:ReportConversation {id: $convId, tenant_id: $tenantId})
         SET c.updated_at = $now`,
        { convId, tenantId, now: asstNow },
      ),
    )

    // 7. Send done event
    send('done', {
      message: {
        id:        asstMsgId,
        role:      'assistant',
        content:   fullText,
        createdAt: asstNow,
      },
      conversationId: convId,
    })
  } catch (err: unknown) {
    logger.error({ err }, 'report-stream error')
    send('error', { message: err instanceof Error ? err.message : 'Internal error' })
  } finally {
    await session.close()
    res.end()
  }
}

export { router as reportStreamRouter }
