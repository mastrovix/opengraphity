/**
 * SSE endpoint for the graph-grounded conversational assistant.
 * Stateless: the client sends the full message history each turn.
 *
 * Wave 7 of «Nulla cablato»: the route needs the `assistant.use` permission
 * (before, any logged-in user — portal users included — could ask it for the
 * tenant's incidents), and the tools only read what the role can see.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { streamAssistantChat, type AssistantMessage } from '../services/assistantService.js'
import { consumeMinuteRate } from '../lib/webhookRateLimit.js'
import { logger } from '../lib/logger.js'

const router: ExpressRouter = Router()

/**
 * Richieste all'assistente per persona e per minuto (D-27). Una conversazione
 * umana ne fa due o tre; un ciclo ne fa centinaia.
 */
const ASSISTANT_REQUESTS_PER_MINUTE = 20

/** La chiave del minuto, per persona (stessa forma del limite dei webhook). */
export function assistantRateKey(tenantId: string, userId: string): string {
  return `og:assistant:rate:${tenantId}:${userId}`
}

/*
 * IL `.catch` NON È DECORAZIONE (revisione del 22 set 2026).
 *
 * `handleAssistantStream` ha due `await` che possono cadere per ragioni del
 * tutto normali — Redis irraggiungibile nel limitatore, il modello che
 * risponde male o non risponde — e nessuno dei due era coperto. Con un `void`
 * nudo quella rejection non ha padrone, e su Node 24 una rejection senza
 * padrone TERMINA IL PROCESSO: un singolo intoppo su questo endpoint buttava
 * giù l'API per tutti.
 *
 * Qui si risponde a chi ha chiesto (se la risposta non è già partita: con
 * l'SSE le intestazioni possono essere già andate, e allora si chiude e
 * basta) e si scrive l'errore per intero.
 */
router.post('/assistant/stream', authMiddleware, (req: Request, res: Response) => {
  void handleAssistantStream(req, res).catch((err: unknown) => {
    logger.error({ err, tenantId: req.user?.tenantId, userId: req.user?.userId },
      '[assistant] the stream failed: answering the caller instead of taking the process down')
    if (res.headersSent) { res.end(); return }
    res.status(500).json({ error: 'assistant stream failed' })
  })
})

async function handleAssistantStream(req: Request, res: Response): Promise<void> {
  const { tenantId, role, permissions } = req.user!
  if (!permissions.has('assistant.use')) {
    res.status(403).json({ error: `Role '${role}' is not authorized. Requires: assistant.use` })
    return
  }
  const { messages } = req.body as { messages?: AssistantMessage[] }

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages is required' })
    return
  }
  if (messages.length > 40) {
    res.status(400).json({ error: 'conversation too long — start a new one' })
    return
  }
  for (const m of messages) {
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) {
      res.status(400).json({ error: 'invalid message shape' })
      return
    }
    if (m.content.length > 8000) {
      res.status(400).json({ error: 'message too long (max 8000 chars)' })
      return
    }
  }

  /**
   * UN TETTO per persona (revisione totale · D-27): `assistant.use` è anche
   * del ruolo viewer e ogni richiesta rimanda l'intera conversazione al
   * modello, quindi la spesa non aveva nessun limite — né per utente né per
   * organizzazione. Finestra al minuto, la stessa forma del limite dei
   * webhook (Redis, condiviso fra le repliche): non ferma un uso normale e
   * ferma un ciclo. Redis irraggiungibile è un errore, non «limite spento».
   */
  const decision = await consumeMinuteRate(assistantRateKey(tenantId, req.user!.userId), ASSISTANT_REQUESTS_PER_MINUTE)
  if (!decision.allowed) {
    res.set('Retry-After', String(decision.retryAfterSeconds))
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: `Assistant limit reached (${ASSISTANT_REQUESTS_PER_MINUTE} requests/min): try again in a moment`, retry_after: decision.retryAfterSeconds },
    })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  await streamAssistantChat(tenantId, permissions, messages, {
    text:  (delta)   => send('text', { delta }),
    tool:  (name)    => send('tool', { name }),
    done:  (text)    => { send('done', { text }); res.end() },
    error: (message) => { send('error', { message }); res.end() },
  })
}

export const assistantRouter = router
