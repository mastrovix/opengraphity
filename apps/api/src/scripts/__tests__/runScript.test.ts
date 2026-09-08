import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ closeDriver: vi.fn() }))

const { runScript } = await import('../lib/runScript.js')
const { closeDriver } = await import('@opengraphity/neo4j')
const { ScriptArgError } = await import('../lib/scriptArgs.js')

const flush = () => new Promise(r => setTimeout(r, 0))

describe('runScript', () => {
  const savedExitCode = process.exitCode
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.exitCode = undefined
    vi.mocked(closeDriver).mockReset().mockResolvedValue(undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    process.exitCode = savedExitCode
    errorSpy.mockRestore()
  })

  it('runs main, closes the driver and leaves exitCode untouched on success', async () => {
    const main = vi.fn().mockResolvedValue(undefined)
    runScript('ok', main)
    await flush()
    expect(main).toHaveBeenCalledOnce()
    expect(closeDriver).toHaveBeenCalledOnce()
    expect(process.exitCode).toBeUndefined()
  })

  it('prints only the message for ScriptArgError and sets exitCode 1', async () => {
    runScript('x', async () => { throw new ScriptArgError('tenant mancante') })
    await flush()
    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('\n✖ x: tenant mancante')
    expect(closeDriver).toHaveBeenCalledOnce()
  })

  it('prints the full error otherwise and still closes the driver', async () => {
    const boom = new Error('boom')
    runScript('x', async () => { throw boom })
    await flush()
    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('\n✖ x fallito:', boom)
    expect(closeDriver).toHaveBeenCalledOnce()
  })

  it('reports a failure while closing the driver', async () => {
    vi.mocked(closeDriver).mockRejectedValue(new Error('close failed'))
    runScript('x', async () => undefined)
    await flush()
    expect(process.exitCode).toBe(1)
    expect(errorSpy.mock.calls[0]![0]).toContain('errore in chiusura del driver')
  })
})
