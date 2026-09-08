/**
 * C-03: `set_field` automation action must not write identity/tenancy/
 * workflow properties, nor arbitrary property names.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), getSession: vi.fn() }))
vi.mock('@opengraphity/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opengraphity/events')>()
  return { ...actual, publish: vi.fn() }
})

import { assertSettableField, SET_FIELD_FORBIDDEN } from '../actionExecutor.js'
import { ValidationError } from '../errors.js'

describe('assertSettableField', () => {
  it.each(['priority', 'category', 'impact', 'urgency', 'description', 'custom_field_1', 'a1'])('accepts %s', (f) => {
    expect(assertSettableField(f)).toBe(f)
  })

  it.each(['tenant_id', 'id', 'number', 'code', 'created_at', 'created_by', 'status', 'updated_at', 'workflow_step'])(
    'rejects protected field %s', (f) => {
      expect(SET_FIELD_FORBIDDEN.has(f)).toBe(true)
      expect(() => assertSettableField(f)).toThrow(ValidationError)
      expect(() => assertSettableField(f)).toThrow(/protected/)
    },
  )

  it('points status changes to the workflow', () => {
    expect(() => assertSettableField('status')).toThrow(/transition_workflow/)
  })

  it.each(['', 'Priority', 'tenant-id', '1abc', 'a.b', 'a b', 'a`b', '$x', '__proto__', 'e.id'])(
    'rejects malformed name %j', (f) => {
      expect(() => assertSettableField(f)).toThrow(ValidationError)
    },
  )

  it('rejects non-string field params', () => {
    expect(() => assertSettableField(undefined)).toThrow(/field is required/)
    expect(() => assertSettableField(42)).toThrow(/field is required/)
    expect(() => assertSettableField(['priority'])).toThrow(/field is required/)
  })
})
