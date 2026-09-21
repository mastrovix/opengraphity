/**
 * QUELLO CHE IL PRODOTTO CONSERVA DI SÉ STESSO, LEGGIBILE (20 set 2026, ondata 3).
 *
 * Il progetto chiede «una proiezione in allowlist con scrubbing ispezionabile»
 * e «un permesso di piattaforma». Queste rotte sono l'ispezionabilità: chi
 * gestisce la piattaforma apre `/platform/server-logs` e vede ESATTAMENTE
 * quello che c'è nel grafo — non un riassunto, non una vista diversa. Il
 * template salvato È l'uscita dello scrubbing (`lib/serverLogScrub.ts`), e
 * qui si restituisce quello, senza trasformarlo.
 *
 * ## Perché REST e non GraphQL
 * Stesso motivo della console dei tenant (`rest/platform-tenants.ts`): ogni
 * resolver GraphQL è legato a un tenant, e un lint (`tenantScoping`) lo
 * pretende su tutta l'API. Questo archivio un tenant non ce l'ha per
 * costruzione — è la decisione 3 di `lib/serverLogSink.ts` — e metterlo nello
 * schema avrebbe voluto dire un contesto con un `tenantId` finto: da quel
 * momento il lint avrebbe protetto una bugia.
 *
 * ## Il confine
 * `platformAuthMiddleware` pretende un token emesso dal realm di piattaforma
 * E l'host della console, in entrambi i versi. Un amministratore di un
 * cliente, per quanto potente dentro il suo tenant, non arriva qui: non è un
 * permesso che gli manca, è un'identità che non ha.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { getSession, toNumber } from '@opengraphity/neo4j'
import { platformAuthMiddleware } from '../auth/platformAuth.js'
import { asyncHandler, restErrorHandler } from './errorHandler.js'
import { statoDelSink } from '../lib/serverLogSink.js'
import { aggregatiPerFirma, verdettoPerFirma, SOGLIE } from '../lib/serverLogEvents.js'
import { leggiGiorniDiRetention } from '../services/serverLogRetention.js'

const router: ExpressRouter = Router()

router.use('/platform', platformAuthMiddleware)

/** Quante righe al massimo. Un tetto dichiarato, non una pagina infinita. */
const MAX_RIGHE = 200

/**
 * L'archivio, riga per riga, dalla più recente.
 *
 * `day` e `fingerprint` filtrano; `level` no, perché nell'archivio ci sono
 * solo `error` e `fatal` (decisione 1 del sink) e un filtro che non filtra
 * niente è un filtro che mente.
 */
router.get('/platform/server-logs', asyncHandler(async (req: Request, res: Response) => {
  const limite = Math.min(Number(req.query['limit'] ?? 50) || 50, MAX_RIGHE)
  const firma  = typeof req.query['fingerprint'] === 'string' ? req.query['fingerprint'] : null
  const dal    = typeof req.query['since'] === 'string' ? req.query['since'] : null

  const session = getSession()
  try {
    const r = await session.run(`
      MATCH (l:ServerLogEntry)
      WHERE ($firma IS NULL OR l.fingerprint = $firma)
        AND ($dal   IS NULL OR l.day >= $dal)
      RETURN l.fingerprint AS fingerprint, l.day AS day, l.service AS service,
             l.module AS module, l.level AS level, l.template AS template,
             l.stack_head AS stackHead, l.count AS count,
             l.first_at AS firstAt, l.last_at AS lastAt
      ORDER BY l.day DESC, l.count DESC
      LIMIT toInteger($limite)
    `, { firma, dal, limite })
    res.json({
      /*
       * Si dichiara COSA si conserva, ogni volta, insieme ai dati. Non è
       * decorazione: è la differenza fra «fidati» e «guarda».
       */
      projection: ['fingerprint', 'day', 'service', 'module', 'level', 'template', 'stackHead', 'count', 'firstAt', 'lastAt'],
      notStored: ['the raw message', 'the free-form fields of the line (`data`)', 'the tenant'],
      retentionDays: leggiGiorniDiRetention(),
      entries: r.records.map((rec) => ({
        fingerprint: rec.get('fingerprint') as string,
        day:       rec.get('day') as string,
        service:   rec.get('service') as string,
        module:    rec.get('module') as string,
        level:     rec.get('level') as string,
        template:  rec.get('template') as string,
        stackHead: (rec.get('stackHead') as string | null) ?? null,
        count:     toNumber(rec.get('count')),
        firstAt:   rec.get('firstAt') as string,
        lastAt:    (rec.get('lastAt') as string | null) ?? null,
      })),
    })
  } finally {
    await session.close()
  }
}))

/**
 * Le firme aggregate con il verdetto del connettore: la stessa funzione che
 * decide di notte, chiamata a vista. Serve a rispondere «perché non è stato
 * aperto un incident per questo?» senza leggere il codice.
 */
router.get('/platform/server-logs/signatures', asyncHandler(async (_req: Request, res: Response) => {
  const adesso = Date.now()
  const firme = await aggregatiPerFirma(adesso)
  res.json({
    thresholds: SOGLIE,
    signatures: firme.map((f) => ({ ...f, verdict: verdettoPerFirma(f, adesso) })),
  })
}))

/** Lo stato del sink: se è rotto, si deve poter sapere. */
router.get('/platform/server-logs/sink', asyncHandler(async (_req: Request, res: Response) => {
  res.json(statoDelSink())
}))

router.use(restErrorHandler)

export { router as platformServerLogsRouter }
