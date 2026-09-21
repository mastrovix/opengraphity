/**
 * `GET /metrics` per i processi senza Express (worker.ts).
 *
 * Con il profilo `events` (revisione 2 · D1.1) la pipeline degli allarmi e il
 * motore dei servizi girano nel processo worker: i contatori che incrementano
 * (`events_received_total`, `events_correlated_total`, `event_ingest_lag_seconds`,
 * i gauge delle passate…) vivono in QUEL processo e Prometheus deve
 * raschiarli lì — altrimenti spostare il lavoro spegnerebbe le metriche e gli
 * allarmi di infra/prometheus/alerts.yml in silenzio. Stessa esposizione e
 * stessa politica di accesso dell'API (`metricsAccessAllowed`: token oppure
 * reti private). Solo `/metrics`: la liveness del worker resta il probe
 * Redis del Dockerfile.
 */
import http from 'node:http'
import { config } from './config.js'
import { METRICS_CONTENT_TYPE, metricsAccessAllowed, renderMetrics } from '../middleware/metrics.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'metrics-server' })

export function metricsRequestListener(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== 'GET' || req.url !== '/metrics') {
    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain')
    res.end('not found')
    return
  }
  if (!metricsAccessAllowed(req)) {
    res.statusCode = config.metricsToken ? 401 : 403
    res.setHeader('Content-Type', 'text/plain')
    res.end('metrics: forbidden')
    return
  }
  res.statusCode = 200
  res.setHeader('Content-Type', METRICS_CONTENT_TYPE)
  res.end(renderMetrics())
}

/** Ascolta su `port`; una porta occupata è un errore d'avvio (il processo non parte a metà). */
export function startMetricsServer(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(metricsRequestListener)
    server.once('error', reject)
    server.listen(port, () => {
      server.off('error', reject)
      log.info({ port }, 'Metrics endpoint listening (GET /metrics)')
      resolve(server)
    })
  })
}
