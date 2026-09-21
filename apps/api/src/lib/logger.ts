import pino from 'pino'
import { randomUUID } from 'node:crypto'
import { pushLog } from './logBuffer.js'
import { currentLogTenant } from './logTenantScope.js'
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

/*
 * IL SINK PERSISTENTE, COLLEGATO DA FUORI (20 set 2026, ondata 3).
 *
 * `logger.ts` è importato da quasi tutto il codice: se importasse il sink, e
 * il sink il driver di Neo4j, si aprirebbe un ciclo e ogni test che tocca un
 * logger si porterebbe dietro il database. Quindi è il sink a presentarsi —
 * `index.ts` lo collega all'avvio — e finché nessuno lo collega, qui non
 * succede niente: è il caso dei test e degli script.
 */
type SinkDeiLog = (raw: Record<string, unknown>, livello: string, tenantId: string | null) => void
let sinkDeiLog: SinkDeiLog | null = null

export function collegaSinkDeiLog(fn: SinkDeiLog | null): void { sinkDeiLog = fn }

function bufferLog(raw: Record<string, unknown>): void {
  const extra = Object.fromEntries(
    Object.entries(raw).filter(([k]) => !SKIP_KEYS.has(k)),
  )
  const livello = LEVEL_MAP[raw['level'] as number] ?? 'info'
  /*
   * Il sink riceve la riga GREZZA, non quella bufferizzata: `SKIP_KEYS` qui
   * sotto butta via `service` ed `env`, e il sink ha bisogno di `service` per
   * sapere quale processo ha sbagliato — era il difetto che `serviceName.ts`
   * ha chiuso nei log di Loki, e ripeterlo nel grafo sarebbe stato comico.
   */
  /*
   * DI CHI È LA RIGA: lo stesso calcolo che fa `pushLog` qui sotto, fatto una
   * volta sola. Serve al sink per sapere se questa riga va anche nella pagina
   * Log di un cliente (20 set 2026, sera): prima il tenant lo buttavamo via e
   * gli errori dei job di sfondo di un cliente sparivano al riavvio.
   */
  const tenantDellaRiga = currentLogTenant() ?? (typeof raw['tenantId'] === 'string' ? raw['tenantId'] : null)
  if (sinkDeiLog) { try { sinkDeiLog(raw, livello, tenantDellaRiga) } catch { /* mai far cadere una riga di log */ } }
  pushLog({
    id:        randomUUID(),
    timestamp: new Date(raw['time'] as number).toISOString(),
    level:     livello,
    module:    (raw['module'] as string | undefined) ?? 'api',
    message:   (raw['msg'] as string) ?? '',
    data:      Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
    /*
     * DI CHI È LA RIGA (20 set 2026): la richiesta in corso, se c'è;
     * altrimenti il `tenantId` che la riga stessa porta — i job di sfondo lo
     * scrivono già. Nessuno dei due = riga di piattaforma.
     */
    tenantId:  tenantDellaRiga,
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
