import { describe, it, expect, vi } from 'vitest'
import {
  Sandbox, SandboxOptionsError,
  MAX_TIMEOUT_MS, MAX_MEMORY_LIMIT_MB, MAX_LOG_LINES, MAX_LOG_BYTES,
} from '../sandbox.js'

describe('Sandbox options — hard caps are refused loudly, not clamped (D-13)', () => {
  it('accepts values within the limits', () => {
    expect(() => new Sandbox({ timeoutMs: MAX_TIMEOUT_MS, memoryLimitMb: MAX_MEMORY_LIMIT_MB })).not.toThrow()
    expect(() => new Sandbox()).not.toThrow()
  })
  it('rejects timeoutMs above the cap', () => {
    expect(() => new Sandbox({ timeoutMs: MAX_TIMEOUT_MS + 1 })).toThrow(SandboxOptionsError)
    expect(() => new Sandbox({ timeoutMs: 60_000 })).toThrow(/timeoutMs must be in 1\.\.30000/)
  })
  it('rejects memoryLimitMb above the cap or non-integer/non-positive', () => {
    expect(() => new Sandbox({ memoryLimitMb: MAX_MEMORY_LIMIT_MB + 1 })).toThrow(/memoryLimitMb must be an integer in 1\.\.64/)
    expect(() => new Sandbox({ memoryLimitMb: 0 })).toThrow(SandboxOptionsError)
    expect(() => new Sandbox({ memoryLimitMb: 1.5 })).toThrow(SandboxOptionsError)
    expect(() => new Sandbox({ timeoutMs: 0 })).toThrow(SandboxOptionsError)
  })
  it('the error is named ValidationError for the API error mapping', () => {
    try {
      new Sandbox({ timeoutMs: 999_999 })
      expect.unreachable()
    } catch (err) {
      expect((err as Error).name).toBe('ValidationError')
    }
  })
})

describe('Sandbox.run', () => {
  it('runs a script with ctx and captures logs', async () => {
    const r = await new Sandbox().run(`console.log('hello', ctx.n); return ctx.n * 2`, { n: 21 })
    expect(r.success).toBe(true)
    expect(r.output).toBe(42)
    expect(r.logs).toEqual(['[LOG] hello 21'])
  })

  it('truncates the log buffer by line count with a single marker (D-13)', async () => {
    const r = await new Sandbox().run(`for (let i = 0; i < ${MAX_LOG_LINES + 50}; i++) console.log('line', i); return 'ok'`, {})
    expect(r.success).toBe(true)
    expect(r.logs).toHaveLength(MAX_LOG_LINES + 1)
    expect(r.logs[MAX_LOG_LINES]).toMatch(/^\[TRUNCATED\] log limit reached \(500 lines \/ 65536 bytes\) — 50 line\(s\) dropped$/)
    expect(r.logs[MAX_LOG_LINES - 1]).toBe(`[LOG] line ${MAX_LOG_LINES - 1}`)
  })

  it('truncates the log buffer by bytes (D-13)', async () => {
    // 10 lines of 10 KB each: the 7th exceeds 64 KB.
    const r = await new Sandbox().run(`const s = 'x'.repeat(10 * 1024); for (let i = 0; i < 10; i++) console.log(s); return 1`, {})
    expect(r.success).toBe(true)
    const marker = r.logs[r.logs.length - 1]!
    expect(marker).toMatch(/^\[TRUNCATED\]/)
    const bytes = r.logs.slice(0, -1).reduce((n, l) => n + Buffer.byteLength(l), 0)
    expect(bytes).toBeLessThanOrEqual(MAX_LOG_BYTES)
    expect(r.logs.length).toBeLessThan(10)
  })

  it('reports a timeout as a failed result (not a throw) and keeps the logs so far', async () => {
    const r = await new Sandbox({ timeoutMs: 200 }).run(`console.log('start'); while (true) {}`, {})
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/timed out/i)
    expect(r.logs).toEqual(['[LOG] start'])
  })

  it('a script error surfaces as the result error (dispose never masks it — D-34)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await new Sandbox().run(`throw new Error('user bug')`, {})
    expect(r.success).toBe(false)
    expect(r.error).toBe('user bug')
    expect(warn).not.toHaveBeenCalled()
  })

  it('an out-of-memory run returns the OOM error, not a dispose error (D-34)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await new Sandbox({ memoryLimitMb: 8, timeoutMs: 5_000 }).run(
      `const a = []; while (true) a.push(new Array(1e5).fill('x'.repeat(100)));`, {},
    )
    expect(r.success).toBe(false)
    // isolated-vm's own OOM message ("Isolate was disposed during execution
    // due to memory limit") is the result: the isolate is already disposed, so
    // the finally block must NOT call dispose() again (it would throw
    // "already disposed" and mask this outcome) and must not warn either.
    expect(r.error).toMatch(/memory limit/i)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  }, 20_000)
})
