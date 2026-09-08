import ivm from 'isolated-vm'

/** Arbitrary data available to the script as the global `ctx` object. */
export type ScriptContext = Record<string, unknown>

export interface ScriptResult {
  success: boolean
  /** Return value of the script (JSON-serializable). */
  output?: unknown
  /** Lines captured from console.log / console.error / console.warn. */
  logs: string[]
  /** Error message if the script threw or timed out. */
  error?: string
  duration_ms: number
}

export interface SandboxOptions {
  /** V8 heap limit in MB. Default: 8. Max: MAX_MEMORY_LIMIT_MB. */
  memoryLimitMb?: number
  /** Wall-clock timeout in ms. Default: 5000. Max: MAX_TIMEOUT_MS. */
  timeoutMs?: number
}

// ── Hard limits (D-13) ────────────────────────────────────────────────────────
// The isolate's heap limit protects only the isolate; the log buffer lives in
// the HOST process, so it needs its own cap. Timeout/memory are tenant-editable
// on the ScriptDefinition: values above the caps are refused loudly, not
// silently clamped, so the admin sees why the script does not run.

export const MAX_TIMEOUT_MS      = 30_000
export const MAX_MEMORY_LIMIT_MB = 64
export const MAX_LOG_LINES       = 500
export const MAX_LOG_BYTES       = 64 * 1024

export class SandboxOptionsError extends Error {
  override readonly name = 'ValidationError'
  constructor(message: string) {
    super(message)
  }
}

function validateOptions(options: SandboxOptions | undefined): { memoryLimitMb: number; timeoutMs: number } {
  const memoryLimitMb = options?.memoryLimitMb ?? 8
  const timeoutMs     = options?.timeoutMs     ?? 5_000

  if (!Number.isInteger(memoryLimitMb) || memoryLimitMb <= 0 || memoryLimitMb > MAX_MEMORY_LIMIT_MB) {
    throw new SandboxOptionsError(
      `memoryLimitMb must be an integer in 1..${MAX_MEMORY_LIMIT_MB} (got ${String(options?.memoryLimitMb)})`,
    )
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new SandboxOptionsError(
      `timeoutMs must be in 1..${MAX_TIMEOUT_MS} (got ${String(options?.timeoutMs)})`,
    )
  }
  return { memoryLimitMb, timeoutMs }
}

// Bootstrap code injected once per isolate context.
// Sets up console mock that calls back into the host via _log reference.
const BOOTSTRAP = `
globalThis.console = {
  log:   (...a) => _log.applySync(undefined, ['LOG',   _fmt(a)], { arguments: { copy: true } }),
  error: (...a) => _log.applySync(undefined, ['ERROR', _fmt(a)], { arguments: { copy: true } }),
  warn:  (...a) => _log.applySync(undefined, ['WARN',  _fmt(a)], { arguments: { copy: true } }),
  info:  (...a) => _log.applySync(undefined, ['INFO',  _fmt(a)], { arguments: { copy: true } }),
};
function _fmt(args) {
  return args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
}
`

/**
 * Bounded log buffer: at most MAX_LOG_LINES lines / MAX_LOG_BYTES bytes. Once
 * a limit is hit a single truncation marker is appended and further lines are
 * dropped (counted), so a `console.log` in a hot loop cannot grow host memory.
 */
class LogBuffer {
  readonly lines: string[] = []
  private bytes = 0
  private dropped = 0
  private truncated = false

  push(line: string): void {
    if (this.truncated) {
      this.dropped += 1
      return
    }
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (this.lines.length >= MAX_LOG_LINES || this.bytes + lineBytes > MAX_LOG_BYTES) {
      this.truncated = true
      this.dropped = 1
      this.lines.push(`[TRUNCATED] log limit reached (${MAX_LOG_LINES} lines / ${MAX_LOG_BYTES} bytes)`)
      return
    }
    this.lines.push(line)
    this.bytes += lineBytes
  }

  /** Finalizes the marker with the count of dropped lines. */
  finish(): string[] {
    if (this.truncated && this.dropped > 0) {
      const last = this.lines.length - 1
      this.lines[last] = `${this.lines[last]} — ${this.dropped} line(s) dropped`
    }
    return this.lines
  }
}

export class Sandbox {
  private readonly memoryLimitMb: number
  private readonly timeoutMs: number

  /** @throws SandboxOptionsError when an option exceeds the hard limits. */
  constructor(options?: SandboxOptions) {
    const v = validateOptions(options)
    this.memoryLimitMb = v.memoryLimitMb
    this.timeoutMs     = v.timeoutMs
  }

  async run(script: string, context: ScriptContext): Promise<ScriptResult> {
    const startMs = Date.now()
    const logs = new LogBuffer()

    const isolate = new ivm.Isolate({ memoryLimit: this.memoryLimitMb })

    try {
      const vmContext = await isolate.createContext()
      const jail      = vmContext.global

      // ── 1. Inject console mock callback ──────────────────────────────────
      await jail.set(
        '_log',
        new ivm.Reference((level: string, message: string) => {
          logs.push(`[${level}] ${message}`)
        }),
      )

      // ── 2. Bootstrap console in the isolate ──────────────────────────────
      await vmContext.eval(BOOTSTRAP)

      // ── 3. Inject ScriptContext as JSON (copied into the isolate) ─────────
      await jail.set('ctx', new ivm.ExternalCopy(context).copyInto())

      // ── 4. Wrap and run the user script ───────────────────────────────────
      // JSON.stringify ensures the result is always a copyable string.
      // If the script returns undefined, JSON.stringify returns undefined
      // (not a string) — we guard with the nullish coalesce below.
      const wrapped = `JSON.stringify((function(){\n${script}\n})())`

      const jsonResult = await vmContext.eval(wrapped, {
        timeout: this.timeoutMs,
      })

      let output: unknown
      if (typeof jsonResult === 'string') {
        try {
          output = JSON.parse(jsonResult)
        } catch {
          output = jsonResult
        }
      }

      return { success: true, output, logs: logs.finish(), duration_ms: Date.now() - startMs }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, logs: logs.finish(), error: message, duration_ms: Date.now() - startMs }
    } finally {
      // An isolate killed by V8 (OOM) is already disposed: a second dispose()
      // throws and would otherwise replace the real error/result (D-34). The
      // failure is logged, never swallowed silently.
      try {
        if (!isolate.isDisposed) isolate.dispose()
      } catch (disposeErr) {
        console.warn('[scripting:sandbox] isolate.dispose() failed after run:', disposeErr)
      }
    }
  }
}

/** Default shared sandbox instance with conservative defaults. */
export const sandbox = new Sandbox()
