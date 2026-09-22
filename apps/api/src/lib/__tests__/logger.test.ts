/**
 * The process logger: what lands in the in-memory buffer (the tenant Log
 * page) and what the persistent sink receives.
 *
 * Why these behaviours matter:
 *  - each buffered line must carry its owner tenant — the request scope first,
 *    otherwise the `tenantId` the line itself carries (background jobs) — or a
 *    customer's errors show up in nobody's Log page, or in someone else's;
 *  - the sink receives the RAW line (with `service`), because it needs to know
 *    which process failed; and a sink that throws must never drop the line;
 *  - secrets are redacted before anything is buffered.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const cfg = vi.hoisted(() => ({ isProduction: false, logLevel: 'trace', workerProfile: 'all', nodeEnv: 'test' }))
vi.mock('../config.js', () => ({ config: cfg }))
// The dev pretty-printer would write to the test output: replace it with a silent stream.
vi.mock('pino-pretty', () => ({ default: () => ({ write: () => {} }) }))

async function freshLogger() {
  vi.resetModules()
  const mod = await import('../logger.js')
  const buffer = await import('../logBuffer.js')
  const scope = await import('../logTenantScope.js')
  return { ...mod, ...buffer, ...scope }
}

afterEach(() => { cfg.isProduction = false; vi.restoreAllMocks() })

describe('logger → in-memory buffer', () => {
  it('buffers the line with level, module, message, extra data and no bookkeeping keys', async () => {
    const { graphqlLogger, tutteLeRighe } = await freshLogger()
    graphqlLogger.warn({ tenantId: 't1', ticket: 'INC1' }, 'slow resolver')
    const [line] = tutteLeRighe()
    expect(line).toMatchObject({ level: 'warn', module: 'graphql', message: 'slow resolver', tenantId: 't1' })
    expect(JSON.parse(line!.data!)).toEqual({ tenantId: 't1', ticket: 'INC1' })
    expect(line!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('a line with no extra fields has null data and defaults the module to api', async () => {
    const { logger, tutteLeRighe } = await freshLogger()
    logger.info('boot')
    expect(tutteLeRighe()[0]).toMatchObject({ module: 'api', message: 'boot', data: null, tenantId: null })
    // A line with only an object and no message still gets a string message.
    logger.info({ tenantId: 't1' })
    expect(tutteLeRighe()[0]).toMatchObject({ message: '', tenantId: 't1' })
  })

  it('the request scope wins over the tenantId written on the line', async () => {
    const { logger, tutteLeRighe, runInLogTenantScope } = await freshLogger()
    runInLogTenantScope('scoped', () => logger.error({ tenantId: 'other' }, 'boom'))
    expect(tutteLeRighe()[0]).toMatchObject({ tenantId: 'scoped', level: 'error' })
  })

  it('a non-string tenantId on the line is not an owner (platform line)', async () => {
    const { logger, tutteLeRighe } = await freshLogger()
    logger.info({ tenantId: 42 }, 'odd')
    expect(tutteLeRighe()[0]!.tenantId).toBeNull()
  })

  it('redacts secrets before they reach the buffer', async () => {
    const { logger, tutteLeRighe } = await freshLogger()
    logger.info({ password: 'hunter2', nested: { token: 'abc' }, headers: { authorization: 'Bearer x' } }, 'login')
    const data = tutteLeRighe()[0]!.data!
    expect(data).not.toContain('hunter2')
    expect(data).not.toContain('abc')
    expect(data).not.toContain('Bearer x')
    expect(data).toContain('[REDACTED]')
  })
})

describe('persistent sink', () => {
  it('receives the raw line (service included), the level name and the owner tenant; unplugging stops it', async () => {
    const { logger, collegaSinkDeiLog } = await freshLogger()
    const sink = vi.fn()
    collegaSinkDeiLog(sink)
    logger.child({ module: 'queue' }).error({ tenantId: 't9' }, 'job failed')
    expect(sink).toHaveBeenCalledTimes(1)
    const [raw, level, tenant] = sink.mock.calls[0]!
    expect(raw).toMatchObject({ msg: 'job failed', module: 'queue', env: 'test' })
    // Why: the buffered copy drops `service`; the sink needs it to name the process.
    expect(typeof (raw as Record<string, unknown>)['service']).toBe('string')
    expect(level).toBe('error')
    expect(tenant).toBe('t9')
    collegaSinkDeiLog(null)
    logger.error('after unplug')
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('a sink that throws never drops the line from the buffer', async () => {
    const { logger, collegaSinkDeiLog, tutteLeRighe } = await freshLogger()
    collegaSinkDeiLog(() => { throw new Error('graph down') })
    expect(() => logger.fatal('still recorded')).not.toThrow()
    expect(tutteLeRighe()[0]).toMatchObject({ level: 'fatal', message: 'still recorded' })
    collegaSinkDeiLog(null)
  })

  it('a custom level outside the standard map is recorded as info, not dropped', async () => {
    const { logger, tutteLeRighe } = await freshLogger()
    const audit = logger.child({}, { customLevels: { audit: 35 } }) as unknown as { audit: (m: string) => void }
    audit.audit('custom level')
    expect(tutteLeRighe()[0]).toMatchObject({ message: 'custom level', level: 'info' })
  })
})

describe('production stream', () => {
  it('writes JSON to stdout in production (no pretty printer) and still buffers', async () => {
    cfg.isProduction = true
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { logger, tutteLeRighe } = await freshLogger()
    logger.info({ tenantId: 't1' }, 'prod line')
    const printed = write.mock.calls.map((c) => String(c[0])).find((s) => s.includes('prod line'))
    expect(printed).toBeDefined()
    expect(JSON.parse(printed!)).toMatchObject({ msg: 'prod line', tenantId: 't1' })
    expect(tutteLeRighe()[0]!.message).toBe('prod line')
  })
})
