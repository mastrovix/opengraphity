import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { asyncHandler, restErrorHandler } from './errorHandler.js'
import { getSession } from '@opengraphity/neo4j'
import { authMiddleware } from '../middleware/auth.js'
import { streamReportAI } from '../services/reportAI.js'
import { runReportConversation, REPORT_QUESTION_MAX_CHARS } from '../services/reportConversation.js'
import { consumeMinuteRate } from '../lib/webhookRateLimit.js'
import { logger } from '../lib/logger.js'
import { aiDisabledError, aiFeatureEnabled } from '../lib/aiSettings.js'

const router: ExpressRouter = Router()

/**
 * Analyses per person and per minute (review of 23 Sep 2026). The GraphQL
 * askReport had its cap, this route — the one the Reports page uses — had
 * none, and the model is paid from one key for the whole platform. The same
 * number as askReport's.
 */
export const REPORT_STREAM_PER_MINUTE = 10

export function reportStreamRateKey(tenantId: string, userId: string): string {
  return `og:report-ai:rate:${tenantId}:${userId}`
}

router.post('/report/stream', authMiddleware, asyncHandler(handleReportStream))
// Errori lanciati prima degli header SSE → risposta JSON via restErrorHandler
router.use(restErrorHandler)

async function handleReportStream(req: Request, res: Response): Promise<void> {
  const { tenantId, userId, role, permissions } = req.user!
  const { question, conversationId: inputConvId } = req.body as {
    question?: string
    conversationId?: string | null
  }

  // Same policy as GraphQL askReport: the AI tool runs model-generated
  // (guarded, read-only) Cypher — the report.ai permission.
  if (!permissions.has('report.ai')) {
    res.status(403).json({ error: `Role '${role}' is not authorized. Requires: report.ai` })
    return
  }

  if (typeof question !== 'string' || !question.trim()) {
    res.status(400).json({ error: 'question is required' })
    return
  }
  if (question.length > REPORT_QUESTION_MAX_CHARS) {
    res.status(400).json({ error: { code: 'QUESTION_TOO_LONG', max: REPORT_QUESTION_MAX_CHARS, message: `The question is too long: at most ${REPORT_QUESTION_MAX_CHARS} characters` } })
    return
  }
  // Funzione spenta dall'organizzazione (ondata 6): si dice prima di aprire lo stream.
  if (!(await aiFeatureEnabled(tenantId, 'reportAnalysis'))) {
    res.status(403).json({ error: { code: 'AI_DISABLED', feature: 'reportAnalysis', message: aiDisabledError('reportAnalysis').message } })
    return
  }

  const decision = await consumeMinuteRate(reportStreamRateKey(tenantId, userId), REPORT_STREAM_PER_MINUTE)
  if (!decision.allowed) {
    res.set('Retry-After', String(decision.retryAfterSeconds))
    res.status(429).json({
      error: { code: 'RATE_LIMITED', limit: REPORT_STREAM_PER_MINUTE, message: `Analysis limit reached (${REPORT_STREAM_PER_MINUTE} per minute): try again in a moment`, retry_after: decision.retryAfterSeconds },
    })
    return
  }

  // The person went away before the answer ended: the analysis stops, instead
  // of paying for the rest of its turns. `res` closes on a disconnection; a
  // `close` after `end()` is ours and changes nothing.
  const gone = new AbortController()
  res.on('close', () => { if (!res.writableEnded) gone.abort() })

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
      userId,
      question,
      conversationId: inputConvId,
      onConversationCreated: (id) => send('conversation', { conversationId: id }),
      ask: (history, q) => streamReportAI(
        tenantId,
        userId,
        permissions,
        history,
        q,
        (chunk) => send('chunk', { text: chunk }),
        (description) => send('tool', { description }),
        gone.signal,
      ),
    })

    send('done', { message, conversationId })
  } catch (err: unknown) {
    if (gone.signal.aborted) {
      logger.info({ tenantId, userId }, 'report-stream: the person went away, analysis stopped')
      return
    }
    logger.error({ err }, 'report-stream error')
    send('error', { message: err instanceof Error ? err.message : 'Internal error' })
  } finally {
    await session.close()
    res.end()
  }
}

export { router as reportStreamRouter }
