import pino from 'pino'

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: process.env['NODE_ENV'] !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  base: {
    service: 'opengrafo-api',
    env: process.env['NODE_ENV'] ?? 'development',
  },
  redact: [
    'req.headers.authorization',
    'password',
    'secret',
    'token',
  ],
})

export const httpLogger         = logger.child({ module: 'http' })
export const graphqlLogger      = logger.child({ module: 'graphql' })
export const authLogger         = logger.child({ module: 'auth' })
export const workflowLogger     = logger.child({ module: 'workflow' })
export const notificationLogger = logger.child({ module: 'notification' })
