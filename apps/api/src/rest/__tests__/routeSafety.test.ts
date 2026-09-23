import { describe, it, expect, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'

vi.mock('../../lib/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
const { runRoute, sendFile } = await import('../routeSafety.js')

/** A response that records what the route did. */
function fakeRes(headersSent = false) {
  const res = new PassThrough() as PassThrough & Record<string, unknown>
  const state = { status: 0, json: undefined as unknown, destroyed: false, removed: [] as string[] }
  Object.assign(res, {
    headersSent,
    status: (c: number) => { state.status = c; return res },
    json: (b: unknown) => { state.json = b; return res },
    removeHeader: (h: string) => { state.removed.push(h) },
  })
  const destroy = res.destroy.bind(res)
  res.destroy = ((e?: Error) => { state.destroyed = true; return destroy(e) }) as typeof res.destroy
  return { res: res as never, state }
}

describe('runRoute', () => {
  it('a failed body is answered with 500, not left as an unhandled rejection', async () => {
    const { res, state } = fakeRes()
    runRoute(res, '[t]', async () => { throw new Error('neo4j down') })
    await vi.waitFor(() => expect(state.status).toBe(500))
    expect(state.json).toEqual({ error: 'Internal error' })
  })

  it('a body that failed after the answer started closes the response', async () => {
    const { res, state } = fakeRes(true)
    runRoute(res, '[t]', async () => { throw new Error('late') })
    await vi.waitFor(() => expect(state.destroyed).toBe(true))
    expect(state.status).toBe(0)
  })
})

describe('sendFile', () => {
  it('streams the file', async () => {
    const file = path.join(os.tmpdir(), `route-safety-${process.pid}.txt`)
    fs.writeFileSync(file, 'hello')
    const { res } = fakeRes()
    const chunks: Buffer[] = []
    ;(res as PassThrough).on('data', (c: Buffer) => chunks.push(c))
    sendFile(res, file, '[t]')
    await new Promise((r) => (res as PassThrough).on('end', r))
    expect(Buffer.concat(chunks).toString()).toBe('hello')
    fs.unlinkSync(file)
  })

  it('a file that cannot be read is answered 404, without the download header', async () => {
    const { res, state } = fakeRes()
    sendFile(res, '/nonexistent/route-safety', '[t]')
    await vi.waitFor(() => expect(state.status).toBe(404))
    expect(state.removed).toEqual(['Content-Disposition'])
  })

  it('a read error after the answer started closes the response', async () => {
    const { res, state } = fakeRes(true)
    sendFile(res, '/nonexistent/route-safety', '[t]')
    await vi.waitFor(() => expect(state.destroyed).toBe(true))
  })
})
