/**
 * AN HTTP HANDLER THAT FAILS ANSWERS THE CALLER; IT DOES NOT END THE PROCESS
 * (review of 23 Sep 2026).
 *
 * On Node 24 a promise rejection nobody handles, and an 'error' event nobody
 * listens to, terminate the process. The Slack routes ran `void handle(req,
 * res)` with no catch, the attachment download ran an async body with no
 * catch, and three routes piped a file stream with no 'error' listener: a
 * Neo4j blip or a file removed at the wrong moment took the API down for
 * every tenant. The guard `src/__tests__/routeSafety.test.ts` keeps both
 * shapes out of the REST routes.
 */
import fs from 'node:fs'
import type { Response } from 'express'
import { logger } from '../lib/logger.js'

/** Runs an async route body; a failure is logged whole and answered with 500 (or the response is closed if it had started). */
export function runRoute(res: Response, label: string, work: () => Promise<unknown>): void {
  void work().catch((err: unknown) => {
    logger.error({ err }, `${label}: the handler failed; answering the caller instead of taking the process down`)
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' })
    else res.destroy()
  })
}

/** Streams a file into the response; a read error is answered, not thrown as an unhandled 'error' event. */
export function sendFile(res: Response, filePath: string, label: string): void {
  const stream = fs.createReadStream(filePath)
  stream.on('error', (err) => {
    logger.warn({ err, filePath }, `${label}: the file could not be read`)
    if (!res.headersSent) { res.removeHeader('Content-Disposition'); res.status(404).json({ error: 'File not found' }) }
    else res.destroy()
  })
  stream.pipe(res)
}
