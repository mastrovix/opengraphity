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
  /** V8 heap limit in MB. Default: 8. */
  memoryLimitMb?: number
  /** Wall-clock timeout in ms. Default: 5000. */
  timeoutMs?: number
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

export class Sandbox {
  private readonly memoryLimitMb: number
  private readonly timeoutMs: number

  constructor(options?: SandboxOptions) {
    this.memoryLimitMb = options?.memoryLimitMb ?? 8
    this.timeoutMs     = options?.timeoutMs     ?? 5_000
  }

  async run(script: string, context: ScriptContext): Promise<ScriptResult> {
    const startMs = Date.now()
    const logs: string[] = []

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

      return { success: true, output, logs, duration_ms: Date.now() - startMs }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, logs, error: message, duration_ms: Date.now() - startMs }
    } finally {
      isolate.dispose()
    }
  }
}

/** Default shared sandbox instance with conservative defaults. */
export const sandbox = new Sandbox()
