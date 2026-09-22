/**
 * rest/parametroDiRotta.ts — a route parameter is a string, or it is an error.
 *
 * Express 5 types `req.params` as `string | string[]` because a repeated route
 * parameter (`/:id+`) yields an array. A silent `String(['a','b'])` would turn
 * into "a,b" and a query that finds nothing, with no error anywhere. These
 * tests pin the loud failure for arrays and missing values, and that optional
 * parameters stay optional without weakening the checks.
 */
import { describe, it, expect } from 'vitest'
import type { Request } from 'express'

const { parametro, parametroOpzionale } = await import('../parametroDiRotta.js')
const { ValidationError } = await import('../../lib/errors.js')

const req = (params: Record<string, unknown>) => ({ params }) as unknown as Request

function caught(fn: () => unknown): ValidationError {
  try { fn() } catch (e) { return e as ValidationError }
  throw new Error('expected a throw')
}

describe('parametro', () => {
  it('returns a string parameter as is', () => {
    expect(parametro(req({ id: 'abc' }), 'id')).toBe('abc')
  })

  it('rejects an array with a message that says it is a repeated parameter', () => {
    const err = caught(() => parametro(req({ id: ['a', 'b', 'c'] }), 'id'))
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.message).toContain('arrived as a list (3 values)')
    expect(err.extensions['i18n']).toEqual({ key: 'errors.rest.repeatedRouteParam', params: { name: 'id' } })
  })

  it('rejects a missing parameter', () => {
    const err = caught(() => parametro(req({}), 'slug'))
    expect(err.message).toBe('route parameter "slug" is missing')
    expect(err.extensions['i18n']).toEqual({ key: 'errors.rest.missingRouteParam', params: { name: 'slug' } })
  })

  it('rejects an empty string as missing: an empty id would match nothing', () => {
    expect(caught(() => parametro(req({ id: '' }), 'id')).extensions['i18n']).toMatchObject({ key: 'errors.rest.missingRouteParam' })
  })
})

describe('parametroOpzionale', () => {
  it('returns undefined when the parameter is absent', () => {
    expect(parametroOpzionale(req({}), 'tenantId')).toBeUndefined()
  })

  it('returns the value when present', () => {
    expect(parametroOpzionale(req({ tenantId: 't1' }), 'tenantId')).toBe('t1')
  })

  it('still refuses an array or an empty string: optional is not lenient', () => {
    expect(() => parametroOpzionale(req({ tenantId: ['a', 'b'] }), 'tenantId')).toThrow(/arrived as a list/)
    expect(() => parametroOpzionale(req({ tenantId: '' }), 'tenantId')).toThrow(/is missing/)
  })
})
