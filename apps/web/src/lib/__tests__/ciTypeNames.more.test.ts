/**
 * The rejection message says WHERE a taken name comes from (A-12): a product
 * ITIL type, or a type whose origin the web cannot tell. If the origin mapping
 * regressed, an admin would read «a CI type of yours» about a name they never
 * created, and go looking for something that does not exist.
 *
 * And only a name rule violation is a message for the form: any other failure
 * of the shared validator is a bug and must surface as an exception, not be
 * shown to the admin as if their name were wrong.
 */
import { describe, it, expect, vi } from 'vitest'
import i18n from '@/i18n/i18n'
import { checkCITypeName, checkCIFieldName } from '../ciTypeNames'

vi.mock('@opengraphity/schema-generator/names', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opengraphity/schema-generator/names')>()
  // A name that makes the validator crash for a reason unrelated to naming rules.
  const crashOn = (name: string) => { if (name === 'crash_here' || name === 'crashHere') throw new TypeError('validator bug') }
  return {
    ...real,
    assertCITypeName: (name: string, reserved: Parameters<typeof real.assertCITypeName>[1]) => { crashOn(name); return real.assertCITypeName(name, reserved) },
    assertCIFieldName: (name: string, opts: Parameters<typeof real.assertCIFieldName>[1]) => { crashOn(name); return real.assertCIFieldName(name, opts) },
  }
})

describe('checkCITypeName — the origin of a taken name', () => {
  it('an ITIL type is named as an ITIL type shipped with the product', () => {
    expect(checkCITypeName('problem_record', [{ name: 'problem_record', scope: 'itil' }])).toContain('an ITIL type that ships with the product')
  })

  it('a type with an unknown scope is only said to exist, without guessing whose it is', () => {
    const m = checkCITypeName('gateway', [{ name: 'gateway', scope: 'something_new' }])!
    expect(m).toContain('a CI type that already exists')
    expect(m).not.toContain('of yours')
  })

  it('a type with no scope at all is treated the same way', () => {
    expect(checkCITypeName('gateway', [{ name: 'gateway', scope: null }])).toContain('a CI type that already exists')
  })
})

describe('a rejection whose key is missing from the locales', () => {
  it('shows the English message of the shared module rather than a raw key', () => {
    const exists = vi.spyOn(i18n, 'exists').mockReturnValue(false)
    const m = checkCIFieldName('tenantId')!
    expect(m).not.toMatch(/^[a-zA-Z]+(\.[a-zA-Z]+)+$/)   // not an i18n key
    expect(m).toContain('tenant_id')
    exists.mockRestore()
  })
})

describe('a failure that is not a naming rule is not swallowed', () => {
  it('checkCITypeName rethrows it', () => {
    expect(() => checkCITypeName('crash_here', [])).toThrow('validator bug')
  })

  it('checkCIFieldName rethrows it', () => {
    expect(() => checkCIFieldName('crashHere')).toThrow('validator bug')
  })
})
