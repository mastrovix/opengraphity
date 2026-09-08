import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { asyncHandler, restErrorHandler } from './errorHandler.js'
import { getSession } from '@opengraphity/neo4j'
import { authMiddleware } from '../middleware/auth.js'
import { streamReportAI } from '../services/reportAI.js'
import { runReportConversation } from '../services/reportConversation.js'
import { logger } from '../lib/logger.js'

const router: ExpressRouter = Router()

router.post('/report/stream', authMiddleware, asyncHandler(handleReportStream))
// Errori lanciati prima degli header SSE → risposta JSON via restErrorHandler
router.use(restErrorHandler)

async function handleReportStream(req: Request, res: Response): Promise<void> {
  const { tenantId, role } = req.user!
  const { question, conversationId: inputConvId } = req.body as {
    question?: string
    conversationId?: string | null
  }

  // Same policy as GraphQL askReport: the AI tool runs model-generated
  // (guarded, read-only) Cypher — admin/operator only.
  if (role !== 'admin' && role !== 'operator') {
    res.status(403).json({ error: `Role '${role}' is not authorized. Required: admin, operator` })
    return
  }

  if (typeof question !== 'string' || !question.trim()) {
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

  const session = getSession(undefined, 'WRITE')

  try {
    // Conversation persistence + "last 10" history: services/reportConversation
    // (shared with the GraphQL askReport mutation).
    const { conversationId, message } = await runReportConversation({
      session,
      tenantId,
      question,
      conversationId: inputConvId,
      onConversationCreated: (id) => send('conversation', { conversationId: id }),
      ask: (history, q) => streamReportAI(
        tenantId,
        history,
        q,
        (chunk) => send('chunk', { text: chunk }),
        (description) => send('tool', { description }),
      ),
    })

    send('done', { message, conversationId })
  } catch (err: unknown) {
    logger.error({ err }, 'report-stream error')
    send('error', { message: err instanceof Error ? err.message : 'Internal error' })
  } finally {
    await session.close()
    res.end()
  }
}

export { router as reportStreamRouter }
