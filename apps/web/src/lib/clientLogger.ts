import { keycloak } from './keycloak'

const API_URL = import.meta.env['VITE_API_URL']?.replace('/graphql', '') ?? 'http://localhost:4000'

async function sendLog(
  level: 'error' | 'warn' | 'info',
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    const token = keycloak.token ?? ''
    await fetch(`${API_URL}/api/logs/client`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        level,
        message,
        data,
        url:       window.location.pathname,
        timestamp: new Date().toISOString(),
      }),
    })
  } catch {
    // Silently ignore logger errors
  }
}

export const clientLogger = {
  error: (message: string, data?: Record<string, unknown>) => void sendLog('error', message, data),
  warn:  (message: string, data?: Record<string, unknown>) => void sendLog('warn',  message, data),
  info:  (message: string, data?: Record<string, unknown>) => void sendLog('info',  message, data),
}
