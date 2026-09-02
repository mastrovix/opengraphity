/**
 * SSE endpoint for the graph-grounded conversational assistant.
 * Stateless: the client sends the full message history each turn.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { streamAssistantChat, type AssistantMessage } from '../services/assistantService.js'

const router: ExpressRouter = Router()

router.post('/assistant/stream', authMiddleware, (req: Request, res: Response) => {
  void handleAssistantStream(req, res)
})

async function handleAssistantStream(req: Request, res: Response): Promise<void> {
  const { tenantId } = req.user!
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

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  await streamAssistantChat(tenantId, messages, {
    text:  (delta)   => send('text', { delta }),
    tool:  (name)    => send('tool', { name }),
    done:  (text)    => { send('done', { text }); res.end() },
    error: (message) => { send('error', { message }); res.end() },
  })
}

export const assistantRouter = router
