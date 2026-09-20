import type { ApiBase } from './apiBase.js'
import type { ClientLogger } from './logger.js'

/**
 * Logger that ships entries to `POST /api/logs/client`, stored per tenant as
 * `LogEntry` nodes and shown in the Logs page alongside the server lines of
 * the same tenant. A failed delivery is reported on the console — never
 * swallowed silently — but cannot throw: a logger that breaks the caller
 * would hide the original error.
 *
 * Fino al 20 set 2026 questo commento diceva «visible in the Logs page» e NON
 * era vero: i nodi venivano scritti e non li leggeva nessuno (zero `MATCH` in
 * tutto l'albero), mentre la pagina mostrava solo l'anello in memoria del
 * server. Adesso lo è — e la lezione è che una frase in un commento non
 * diventa vera perché qualcuno l'ha scritta in buona fede.
 */
export function createClientLogger(api: ApiBase): ClientLogger {
  async function send(level: 'error' | 'warn' | 'info', message: string, data?: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch(api.apiUrl('/api/logs/client'), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...api.authHeader() },
        body: JSON.stringify({
          level,
          message,
          data,
          url:       window.location.pathname,
          timestamp: new Date().toISOString(),
        }),
      })
      if (!res.ok) console.warn(`[clientLogger] sending logs failed: ${res.status} ${res.statusText}`, message)
    } catch (err) {
      console.warn('[clientLogger] sending logs failed', err, message)
    }
  }

  return {
    error: (message, data) => void send('error', message, data),
    warn:  (message, data) => void send('warn',  message, data),
    info:  (message, data) => void send('info',  message, data),
  }
}
