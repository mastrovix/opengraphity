/**
 * GET /api/reports/:filename over a real Express app with a real (scratch)
 * REPORT_DIR: traversal/odd filenames → 400, another tenant's file → 404,
 * own file → 200 with the right Content-Type/Disposition and bytes.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const REPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'og-reports-router-test-'))
process.env['REPORT_DIR'] = REPORT_DIR

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const tenantId = typeof req.headers['x-test-tenant'] === 'string' ? req.headers['x-test-tenant'] : 'tenant-a'
    req.user = { tenantId, userId: 'user-1', email: 'u@example.com', role: 'operator' }
    next()
  },
}))

const { reportsRouter } = await import('../reports.js')
const { logger } = await import('../../lib/logger.js')

const PDF_NAME  = '3f2b6a1e-1111-4222-8333-444455556666.pdf'
const XLSX_NAME = '9a8b7c6d-2222-4333-8444-555566667777.xlsx'
const PDF_BYTES = Buffer.from('%PDF-1.4 fake report for tenant-a')

let server: Server
let base: string

beforeAll(async () => {
  fs.mkdirSync(path.join(REPORT_DIR, 'tenant-a'), { recursive: true })
  fs.writeFileSync(path.join(REPORT_DIR, 'tenant-a', PDF_NAME), PDF_BYTES)
  fs.writeFileSync(path.join(REPORT_DIR, 'tenant-a', XLSX_NAME), 'xlsx-bytes')
  // A file directly under REPORT_DIR (flat legacy layout) must not be reachable via `..`.
  fs.writeFileSync(path.join(REPORT_DIR, 'secret.pdf'), 'top-level')

  const app = express()
  app.use('/api', reportsRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/reports`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(REPORT_DIR, { recursive: true, force: true })
})

const get = (name: string, tenant?: string) =>
  fetch(`${base}/${name}`, { headers: tenant ? { 'x-test-tenant': tenant } : {} })

describe('GET /api/reports/:filename', () => {
  it.each([
    '..%2Fsecret.pdf',
    '..%2F..%2Fsecret.pdf',
    'abc..pdf',
    `${PDF_NAME}%2F..%2F..%2Fsecret.pdf`,
    'report.exe',
    'noext',
    'ABC$.pdf',
  ])('rejects %s with 400 (never touches the disk)', async (name) => {
    const res = await get(name)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid filename' })
  })

  it('same filename requested by another tenant → 404', async () => {
    const res = await get(PDF_NAME, 'tenant-b')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'File not found' })
  })

  it('tenant id that is not a path segment → tenantReportDir throws → 500 by the Express default handler, no file served', async () => {
    // The tenant id comes from the auth context (never from the client), so a
    // bad segment is a server-side invariant violation: the sync throw is not
    // caught by the route and Express answers 500. Pinned: nothing is served.
    const res = await get(PDF_NAME, '../tenant-a')
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).not.toBe('application/pdf')
  })

  it('unknown uuid in the caller tenant → 404', async () => {
    const res = await get('00000000-0000-4000-8000-000000000000.pdf')
    expect(res.status).toBe(404)
  })

  it('own PDF → 200, application/pdf, attachment disposition, exact bytes', async () => {
    const res = await get(PDF_NAME, 'tenant-a')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="report.pdf"')
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF_BYTES)).toBe(true)
    expect(logger.info).toHaveBeenCalledWith({ filename: PDF_NAME, tenantId: 'tenant-a' }, '[report-download] serving file')
  })

  it('own XLSX → 200 with the spreadsheet MIME type', async () => {
    const res = await get(XLSX_NAME, 'tenant-a')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="report.xlsx"')
    expect(await res.text()).toBe('xlsx-bytes')
  })
})
