import type { ApiBase } from './apiBase.js'
import type { ClientLogger } from './logger.js'

/**
 * Logger that ships entries to `POST /api/logs/client` (stored per tenant as
 * `LogEntry` nodes, visible in the Logs page). A failed delivery is reported
 * on the console — never swallowed silently — but cannot throw: a logger
 * that breaks the caller would hide the original error.
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
      if (!res.ok) console.warn(`[clientLogger] invio log fallito: ${res.status} ${res.statusText}`, message)
    } catch (err) {
      console.warn('[clientLogger] invio log fallito', err, message)
    }
  }

  return {
    error: (message, data) => void send('error', message, data),
    warn:  (message, data) => void send('warn',  message, data),
    info:  (message, data) => void send('info',  message, data),
  }
}
