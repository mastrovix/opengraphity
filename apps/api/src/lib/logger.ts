import pino from 'pino'
import { randomUUID } from 'node:crypto'
import { pushLog } from './logBuffer.js'

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
    stream: process.env['NODE_ENV'] !== 'production'
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
    level: process.env['LOG_LEVEL'] ?? 'info',
    base: {
      service: 'opengrafo-api',
      env:     process.env['NODE_ENV'] ?? 'development',
    },
    redact: [
      'req.headers.authorization',
      'password',
      'secret',
      'token',
    ],
  },
  pino.multistream(streams),
)

export const httpLogger         = logger.child({ module: 'http' })
export const graphqlLogger      = logger.child({ module: 'graphql' })
export const authLogger         = logger.child({ module: 'auth' })
export const workflowLogger     = logger.child({ module: 'workflow' })
export const notificationLogger = logger.child({ module: 'notification' })
