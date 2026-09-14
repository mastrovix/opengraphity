/**
 * Gli stream SSE non si comprimono (giro nel browser del 14 set 2026).
 *
 * Dal vivo: le notifiche in-app non arrivavano mai in tempo reale, solo al
 * ricaricamento. Il server scriveva sul flusso («Broadcast to tenant c-test
 * (1 connection/s)»), ma la risposta usciva con `content-encoding: br`: Brotli
 * trattiene i byte finché non riempie un blocco, e al browser non arrivava
 * nemmeno il primo `connected`. Il filtro escludeva `req.path === '/api/sse'`,
 * ma `compression` lo valuta quando partono le intestazioni, DENTRO il router
 * montato su `/api`, dove Express ha già tolto il prefisso: `req.path` vale
 * `/sse`. Stesso destino per lo streaming dell'analisi AI.
 *
 * Il test monta un router su `/api` come fa server.ts, e chiede Brotli.
 */
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express, { Router } from 'express'
import compression from 'compression'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compressionFilter } from '../compressionFilter.js'

let server: Server
let port = 0

beforeAll(async () => {
  const app = express()
  app.use(compression({ threshold: 0, filter: compressionFilter }))
  const router = Router()
  router.get('/sse', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.flushHeaders()
    res.write('data: {"type":"connected"}\n\n')
  })
  router.get('/report/stream', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
    res.write('data: first\n\n')
  })
  router.get('/json', (_req, res) => { res.json({ big: 'x'.repeat(5000) }) })
  app.use('/api', router)
  server = createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => { await new Promise((r) => server.close(r)) })

/** Le intestazioni e il PRIMO pezzo del corpo, entro 2 secondi. */
function firstChunk(path: string): Promise<{ encoding: string | undefined; chunk: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { 'Accept-Encoding': 'br, gzip' } }, (res) => {
      const timer = setTimeout(() => { req.destroy(); resolve({ encoding: res.headers['content-encoding'], chunk: '' }) }, 2000)
      res.once('data', (d: Buffer) => { clearTimeout(timer); req.destroy(); resolve({ encoding: res.headers['content-encoding'], chunk: d.toString('utf8') }) })
    })
    req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e) })
    req.end()
  })
}

describe('compressione e stream SSE', () => {
  it('il flusso delle notifiche (router su /api) non è compresso e il primo messaggio arriva subito', async () => {
    const { encoding, chunk } = await firstChunk('/api/sse')
    expect(encoding).toBeUndefined()
    expect(chunk).toContain('"connected"')
  })

  it('anche lo streaming dell\'analisi AI (content-type con charset)', async () => {
    const { encoding, chunk } = await firstChunk('/api/report/stream')
    expect(encoding).toBeUndefined()
    expect(chunk).toContain('first')
  })

  it('il resto continua a essere compresso', async () => {
    const { encoding } = await firstChunk('/api/json')
    expect(encoding).toBeDefined()
  })
})
