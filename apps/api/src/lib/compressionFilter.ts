/**
 * Quali risposte comprimere.
 *
 * Gli stream SSE (`text/event-stream`) MAI: Brotli e gzip trattengono i byte
 * finché non riempiono un blocco, e un evento di poche decine di byte non
 * arriva al browser (giro nel browser del 14 set 2026: notifiche in-app mai in
 * tempo reale, analisi AI senza streaming). Si decide dal TIPO della risposta,
 * non dal percorso: `compression` valuta il filtro quando partono le
 * intestazioni, dentro il router montato su `/api`, dove `req.path` ha già
 * perso il prefisso — il filtro di prima (`req.path === '/api/sse'`) non
 * escludeva niente.
 */
import type { Request, Response } from 'express'
import compression from 'compression'

export function compressionFilter(req: Request, res: Response): boolean {
  const type = String(res.getHeader('Content-Type') ?? '')
  if (type.toLowerCase().startsWith('text/event-stream')) return false
  return compression.filter(req, res)
}
