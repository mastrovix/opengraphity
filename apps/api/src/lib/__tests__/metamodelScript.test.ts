/**
 * Metamodel validation scripts and computed-field formulas, run in the
 * scripting sandbox.
 *
 * Why these behaviours matter:
 *  - A script written by the CUSTOMER must not run when the tenant's plan does
 *    not include scripting — and the refusal must be loud. Scripts of the
 *    shared metamodel (scope base/itil) are product behaviour and run anyway:
 *    gating them would switch off URL / IP validation for every small plan.
 *  - A formula is always customer code, so it is always gated.
 *  - The script sees `input` and `value` as free variables, exactly as in the
 *    browser: a different wrapper would make a script valid in the form and
 *    broken on save.
 *  - A rejection without a message still has to say which field failed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const assertScriptingEnabled = vi.fn()
vi.mock('../scriptingPlan.js', () => ({
  assertScriptingEnabled: (...a: unknown[]) => assertScriptingEnabled(...a),
  // Same rule as the real module: only the shared scopes are product-owned.
  isTenantOwnedDefinition: (scope: string | undefined) => !['base', 'itil'].includes(scope ?? ''),
}))
const runScript = vi.fn()
vi.mock('@opengraphity/scripting', () => ({ runScript: (...a: unknown[]) => runScript(...a) }))

const { runValidationScript, runFormulaScript } = await import('../metamodelScript.js')

beforeEach(() => {
  vi.clearAllMocks()
  assertScriptingEnabled.mockResolvedValue(undefined)
})

describe('runValidationScript', () => {
  it('accepts (null) when the script succeeds, exposing input and value to the code', async () => {
    runScript.mockResolvedValue({ success: true })
    const out = await runValidationScript('if (!value) throw new Error("x")', { input: { name: 'a' }, value: 3 }, 'port', 't1', 'tenant')
    expect(out).toBeNull()
    const [script, context] = runScript.mock.calls[0] as [{ code: string; tenant_id: string }, Record<string, unknown>]
    expect(script.code.startsWith('const input = ctx.input;\nconst value = ctx.value;\n')).toBe(true)
    expect(script.tenant_id).toBe('t1')
    expect(context).toEqual({ input: { name: 'a' }, value: 3, tenantId: 't1' })
  })

  it('a missing value reaches the script as null, not undefined', async () => {
    runScript.mockResolvedValue({ success: true })
    await runValidationScript('', { input: {} }, 'port', 't1', 'tenant')
    expect((runScript.mock.calls[0]![1] as { value: unknown }).value).toBeNull()
  })

  it('returns the rejection message, or a message naming the field when the script gave none', async () => {
    runScript.mockResolvedValueOnce({ success: false, error: 'Port out of range' })
    expect(await runValidationScript('', { input: {} }, 'port', 't1', 'tenant')).toBe('Port out of range')
    runScript.mockResolvedValueOnce({ success: false })
    expect(await runValidationScript('', { input: {} }, 'port', 't1', 'tenant')).toBe('port failed')
  })

  it('a customer-owned script is gated by the plan; a refusal stops it before it runs', async () => {
    assertScriptingEnabled.mockRejectedValue(new Error('scripting not in plan'))
    await expect(runValidationScript('', { input: {} }, 'port', 't1', 'tenant')).rejects.toThrow(/not in plan/)
    expect(assertScriptingEnabled).toHaveBeenCalledWith('t1', 'field script of "port"', 'errors.scripting.what.field', { field: 'port' })
    expect(runScript).not.toHaveBeenCalled()
  })

  it('a shared-metamodel script (scope base/itil) runs without asking the plan', async () => {
    runScript.mockResolvedValue({ success: true })
    await runValidationScript('', { input: {} }, 'url', 't1', 'base')
    expect(assertScriptingEnabled).not.toHaveBeenCalled()
    expect(runScript).toHaveBeenCalledTimes(1)
  })
})

describe('runFormulaScript', () => {
  it('returns the computed value', async () => {
    runScript.mockResolvedValue({ success: true, output: 42 })
    const out = await runFormulaScript('return input.a * 2', { a: 21 }, 'total', 't1')
    expect(out).toEqual({ ok: true, value: 42 })
    const [script, context] = runScript.mock.calls[0] as [{ code: string }, Record<string, unknown>]
    expect(script.code).toBe('const input = ctx.input;\nreturn input.a * 2')
    expect(context).toEqual({ input: { a: 21 }, tenantId: 't1' })
  })

  it('reports the failure with its message, or one naming the field', async () => {
    runScript.mockResolvedValueOnce({ success: false, error: 'boom' })
    expect(await runFormulaScript('', {}, 'total', 't1')).toEqual({ ok: false, error: 'boom' })
    runScript.mockResolvedValueOnce({ success: false })
    expect(await runFormulaScript('', {}, 'total', 't1')).toEqual({ ok: false, error: 'total failed' })
  })

  it('is always gated by the plan: a formula is customer code', async () => {
    assertScriptingEnabled.mockRejectedValue(new Error('scripting not in plan'))
    await expect(runFormulaScript('', {}, 'total', 't1')).rejects.toThrow(/not in plan/)
    expect(assertScriptingEnabled).toHaveBeenCalledWith('t1', 'formula of "total"', 'errors.scripting.what.formula', { field: 'total' })
    expect(runScript).not.toHaveBeenCalled()
  })
})
