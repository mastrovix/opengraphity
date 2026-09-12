import pino from 'pino'
import { randomUUID } from 'node:crypto'
import { pushLog } from './logBuffer.js'
import { config } from './config.js'
import { serviceNameFor } from './serviceName.js'

const LEVEL_MAP: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

const SKIP_KEYS = new Set(['level', 'time', 'msg', 'module', 'pid', 'hostname', 'service', 'env'])

function bufferLog(raw: Record<string, unknown>): void {
  const extra = Object.fromEntries(
    Object.entries(raw).filter(([k]) => !SKIP_KEYS.has(k)),
  )
  pushLog({
    id:        randomUUID(),
    timestamp: new Date(raw['time'] as number).toISOString(),
    level:     LEVEL_MAP[raw['level'] as number] ?? 'info',
    module:    (raw['module'] as string | undefined) ?? 'api',
    message:   (raw['msg'] as string) ?? '',
    data:      Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
  })
}

const streams: pino.StreamEntry[] = [
  {
    level: 'trace' as pino.Level,
    stream: !config.isProduction
      ? (await import('pino-pretty')).default({ colorize: true })
      : process.stdout,
  },
  {
    level: 'trace' as pino.Level,
    stream: {
      write(msg: string) {
        try { bufferLog(JSON.parse(msg) as Record<string, unknown>) } catch { /* skip malformed */ }
      },
    },
  },
]

export const logger = pino(
  {
    level: config.logLevel,
    base: {
      // Il nome del processo, non quello dell'immagine (ondata 5): API, worker
      // degli embedding e worker degli allarmi condividono immagine e logger, e
      // scrivendo sempre `opengrafo-api` i loro log erano indistinguibili in
      // Loki. Vedi `lib/serviceName.ts`.
      service: serviceNameFor(process.argv[1], config.workerProfile),
      env:     config.nodeEnv,
    },
    // pino redact: `*` matches exactly ONE path segment (no `**`), so each
    // nesting depth that can carry a secret is listed explicitly. Deeper
    // objects are NOT covered — never log raw job.data / request bodies.
    redact: {
      paths: [
        'req.headers.authorization', 'req.headers.cookie',
        'headers.authorization', 'headers.Authorization',
        '*.headers.authorization', '*.headers.Authorization',
        'password', '*.password', '*.*.password',
        'secret', '*.secret', '*.*.secret',
        'token', '*.token', '*.*.token',
        'key_hash', '*.key_hash',
        'apiKey', '*.apiKey', 'api_key', '*.api_key',
        'webhook_url', '*.webhook_url', 'webhookUrl', '*.webhookUrl',
      ],
      censor: '[REDACTED]',
    },
  },
  pino.multistream(streams),
)

export const httpLogger         = logger.child({ module: 'http' })
export const graphqlLogger      = logger.child({ module: 'graphql' })
export const authLogger         = logger.child({ module: 'auth' })
export const workflowLogger     = logger.child({ module: 'workflow' })
export const notificationLogger = logger.child({ module: 'notification' })
