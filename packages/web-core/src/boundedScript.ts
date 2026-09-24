/**
 * A QUICKJS CONTEXT THAT CANNOT HANG THE TAB (review of 23 Sep 2026).
 *
 * The formulas of the catalog forms and the scripts of the CI types run in the
 * browser, in QuickJS, on the main thread, again at every answer typed. The
 * formula runner said «a `while(true)` does not block the browser because the
 * context has an instruction limit»: there was none. A formula looping on an
 * input, or a default script like `while (!input.port) {}`, froze the tab for
 * good — the server stops the same code after five seconds, the browser never
 * got that far.
 *
 * Every evaluation now gets its own deadline and the runtime a memory cap. An
 * interrupted script comes back as an error, which the field shows like any
 * other script error.
 */

/** How long one evaluation may run: a formula is arithmetic, a CI script a few checks. */
export const BROWSER_SCRIPT_DEADLINE_MS = 500
/** The memory of one runtime. */
export const BROWSER_SCRIPT_MEMORY_BYTES = 16 * 1024 * 1024

export interface ScriptHandle { dispose: () => void }

export interface BoundedScriptVM {
  /** Evaluates `code` with a fresh deadline; an interrupt or a memory exhaustion comes back as `error`. */
  evalCode: (code: string) => { error?: ScriptHandle; value?: ScriptHandle }
  dump: (h: ScriptHandle) => unknown
  dispose: () => void
}

interface QuickJSRuntimeLike {
  setMemoryLimit: (bytes: number) => void
  setInterruptHandler: (handler: () => boolean) => void
  newContext: () => { evalCode: BoundedScriptVM['evalCode']; dump: BoundedScriptVM['dump']; dispose: () => void }
  dispose: () => void
}
interface QuickJSLibrary {
  getQuickJS: () => Promise<{ newRuntime: () => QuickJSRuntimeLike }>
  shouldInterruptAfterDeadline: (deadline: number) => () => boolean
}

/** Loaded the first time it is needed: a page without scripts does not pay for the WASM. */
let library: Promise<QuickJSLibrary> | null = null

export async function newBoundedScriptVM(): Promise<BoundedScriptVM> {
  // A failed load is not kept: the next evaluation tries again (a network that dropped the file).
  if (!library) library = (import('quickjs-emscripten') as unknown as Promise<QuickJSLibrary>).catch((e: unknown) => { library = null; throw e })
  const lib = await library
  const runtime = (await lib.getQuickJS()).newRuntime()
  runtime.setMemoryLimit(BROWSER_SCRIPT_MEMORY_BYTES)
  const vm = runtime.newContext()
  return {
    evalCode: (code) => {
      runtime.setInterruptHandler(lib.shouldInterruptAfterDeadline(Date.now() + BROWSER_SCRIPT_DEADLINE_MS))
      return vm.evalCode(code)
    },
    dump: (h) => vm.dump(h),
    dispose: () => { vm.dispose(); runtime.dispose() },
  }
}

/**
 * What a script error says, read by a person: the message of a thrown error,
 * the two limits in words, and anything else as text.
 */
export function scriptErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err !== null && typeof err === 'object') {
    const { name, message } = err as { name?: unknown; message?: unknown }
    if (name === 'InternalError' && message === 'interrupted') {
      return `The script ran for more than ${BROWSER_SCRIPT_DEADLINE_MS} ms and was stopped`
    }
    if (name === 'InternalError' && message === 'out of memory') {
      return `The script used more than ${BROWSER_SCRIPT_MEMORY_BYTES / (1024 * 1024)} MB and was stopped`
    }
    if (typeof message === 'string' && message !== '') return typeof name === 'string' && name !== '' ? `${name}: ${message}` : message
  }
  return JSON.stringify(err)
}
