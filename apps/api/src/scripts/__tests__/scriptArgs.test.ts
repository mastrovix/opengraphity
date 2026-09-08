import { describe, it, expect } from 'vitest'
import {
  ScriptArgError,
  hasFlag,
  readOptionValue,
  resolveTenantArg,
  requireConfirmFlag,
  refuseInProduction,
} from '../lib/scriptArgs.js'

describe('readOptionValue', () => {
  it('reads --name=value', () => expect(readOptionValue('--tenant', ['--tenant=c-one'])).toBe('c-one'))
  it('reads --name value', () => expect(readOptionValue('--tenant', ['--tenant', 'c-one'])).toBe('c-one'))
  it('returns undefined when absent', () => expect(readOptionValue('--tenant', ['--other=x'])).toBeUndefined())
  it('does not consume a following option as value', () =>
    expect(readOptionValue('--tenant', ['--tenant', '--yes-delete'])).toBeUndefined())
  it('returns undefined when the option is last with no value', () =>
    expect(readOptionValue('--tenant', ['--yes-delete', '--tenant'])).toBeUndefined())
  it('picks the first occurrence', () =>
    expect(readOptionValue('--tenant', ['--tenant=a', '--tenant=b'])).toBe('a'))
})

describe('resolveTenantArg', () => {
  it('accepts --tenant=<slug>', () => expect(resolveTenantArg(['--tenant=c-one'])).toBe('c-one'))
  it('accepts --tenant <slug>', () => expect(resolveTenantArg(['--yes-delete', '--tenant', 'acme_2'])).toBe('acme_2'))
  it('fails loudly when missing (no default tenant)', () => {
    expect(() => resolveTenantArg([])).toThrow(ScriptArgError)
    expect(() => resolveTenantArg([])).toThrow(/--tenant=<slug>/)
  })
  it('fails when the value is empty', () => {
    expect(() => resolveTenantArg(['--tenant='])).toThrow(ScriptArgError)
    expect(() => resolveTenantArg(['--tenant', '  '])).toThrow(ScriptArgError)
  })
  it('fails when the value is another option', () =>
    expect(() => resolveTenantArg(['--tenant', '--yes-delete'])).toThrow(ScriptArgError))
  it('rejects slugs with unsafe characters', () => {
    expect(() => resolveTenantArg(['--tenant=c one'])).toThrow(/non valido/)
    expect(() => resolveTenantArg(['--tenant=-lead'])).toThrow(/non valido/)
    expect(() => resolveTenantArg(["--tenant=a'b"])).toThrow(/non valido/)
  })
})

describe('hasFlag / requireConfirmFlag', () => {
  it('hasFlag matches the exact token only', () => {
    expect(hasFlag('--yes-delete', ['--tenant=x', '--yes-delete'])).toBe(true)
    expect(hasFlag('--yes-delete', ['--yes-delete=false'])).toBe(false)
    expect(hasFlag('--yes-delete', ['--yes'])).toBe(false)
  })
  it('requireConfirmFlag passes when present', () =>
    expect(() => requireConfirmFlag('--yes-delete', ['--yes-delete'])).not.toThrow())
  it('requireConfirmFlag fails when absent, naming the flag', () => {
    expect(() => requireConfirmFlag('--yes-delete', ['--tenant=c-one'])).toThrow(ScriptArgError)
    expect(() => requireConfirmFlag('--yes-delete', [])).toThrow(/--yes-delete/)
  })
  it('requireConfirmFlag rejects a malformed flag name', () =>
    expect(() => requireConfirmFlag('yes-delete', ['yes-delete'])).toThrow(ScriptArgError))
})

describe('refuseInProduction', () => {
  it('throws when NODE_ENV is production', () => {
    expect(() => refuseInProduction('seed-x', { NODE_ENV: 'production' })).toThrow(ScriptArgError)
    expect(() => refuseInProduction('seed-x', { NODE_ENV: 'production' })).toThrow(/seed-x/)
  })
  it('passes for other environments or when unset', () => {
    expect(() => refuseInProduction('seed-x', { NODE_ENV: 'development' })).not.toThrow()
    expect(() => refuseInProduction('seed-x', { NODE_ENV: 'test' })).not.toThrow()
    expect(() => refuseInProduction('seed-x', {})).not.toThrow()
  })
  it('is exact-match: "Production" or "prod" do not trigger the guard', () => {
    expect(() => refuseInProduction('seed-x', { NODE_ENV: 'prod' })).not.toThrow()
  })
})
