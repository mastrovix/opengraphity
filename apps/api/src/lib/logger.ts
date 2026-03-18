import pino from 'pino'
import { getSession } from '@opengraphity/neo4j'

const LEVEL_MAP: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

async function saveLogToNeo4j(log: Record<string, unknown>): Promise<void> {
  try {
    const session = getSession(undefined, 'WRITE')
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `CREATE (l:LogEntry {
            id:         randomUUID(),
            tenant_id:  'system',
            timestamp:  $timestamp,
            level:      $level,
            module:     $module,
            message:    $message,
            data:       $data,
            created_at: $timestamp
          })`,
          {
            timestamp: new Date(log['time'] as number).toISOString(),
            level:     LEVEL_MAP[log['level'] as number] ?? 'info',
            module:    (log['module'] as string | undefined) ?? 'api',
            message:   log['msg'] as string,
            data:      JSON.stringify(
              Object.fromEntries(
                Object.entries(log).filter(([k]) =>
                  !['level', 'time', 'msg', 'module', 'pid', 'hostname', 'service', 'env'].includes(k),
                ),
              ),
            ),
          },
        ),
      )
    } finally {
      await session.close()
    }
  } catch {
    // Silently ignore log persistence errors
  }
}

const streams: pino.StreamEntry[] = [
  {
    level: 'trace' as pino.Level,
    stream: process.env['NODE_ENV'] !== 'production'
      ? (await import('pino-pretty')).default({ colorize: true })
      : process.stdout,
  },
  {
    level: 'info' as pino.Level,
    stream: {
      write(msg: string) {
        void saveLogToNeo4j(JSON.parse(msg) as Record<string, unknown>)
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
