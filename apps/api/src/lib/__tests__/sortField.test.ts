/**
 * The sort order a client asks for is either applied or refused out loud.
 *
 * Why it matters: an unknown `sortField` used to be ignored silently — the
 * table showed the arrow on the requested column while the rows came back in
 * the default order, and nobody calling the API could tell. These tests pin
 * that the whitelist is the only source of the column (the value ends up
 * interpolated in Cypher), that the direction can only be ASC or DESC, and
 * that a refusal names the sortable fields so the caller can fix the request.
 */
import { describe, it, expect } from 'vitest'
import { GraphQLError } from 'graphql'
import { orderByOrThrow } from '../sortField.js'
import { ValidationError } from '../errors.js'

const WHITELIST = { createdAt: 'n.created_at', title: 'n.title' } as const
const DEFAULT = 'n.created_at DESC'

describe('orderByOrThrow', () => {
  it('returns the default order when the client asks for nothing', () => {
    expect(orderByOrThrow(WHITELIST, undefined, 'ASC', DEFAULT, 'incidents')).toBe(DEFAULT)
    expect(orderByOrThrow(WHITELIST, null, null, DEFAULT, 'incidents')).toBe(DEFAULT)
    // An empty string is what an uncontrolled <select> sends: same as "no sort".
    expect(orderByOrThrow(WHITELIST, '', 'DESC', DEFAULT, 'incidents')).toBe(DEFAULT)
  })

  it('maps the requested field to its whitelisted column, never to the raw input', () => {
    expect(orderByOrThrow(WHITELIST, 'title', 'desc', DEFAULT, 'incidents')).toBe('n.title DESC')
    expect(orderByOrThrow(WHITELIST, 'title', 'DESC', DEFAULT, 'incidents')).toBe('n.title DESC')
  })

  it('treats anything that is not DESC as ASC, so the direction cannot inject Cypher', () => {
    expect(orderByOrThrow(WHITELIST, 'title', null, DEFAULT, 'incidents')).toBe('n.title ASC')
    expect(orderByOrThrow(WHITELIST, 'title', 'asc', DEFAULT, 'incidents')).toBe('n.title ASC')
    expect(orderByOrThrow(WHITELIST, 'title', 'DESC; MATCH (x) DETACH DELETE x', DEFAULT, 'incidents')).toBe('n.title ASC')
  })

  it('refuses an unknown field as a BAD_USER_INPUT that names the allowed ones', () => {
    let err: unknown
    try { orderByOrThrow(WHITELIST, 'priority', 'ASC', DEFAULT, 'incidents') } catch (e) { err = e }
    expect(err).toBeInstanceOf(ValidationError)
    const ge = err as GraphQLError
    expect(ge.message).toBe('incidents: "priority" is not a sortable field. Sortable: createdAt, title.')
    expect(ge.extensions['code']).toBe('BAD_USER_INPUT')
    // The client composes the sentence in the viewer's language from these params.
    expect(ge.extensions['i18n']).toEqual({
      key: 'errors.sort.unknownField',
      params: { what: 'incidents', field: 'priority', allowed: 'createdAt, title' },
    })
  })

  it('does not accept inherited object keys as sortable fields', () => {
    // Every object has these members: before the fix they resolved to a
    // function / Object.prototype and were interpolated into ORDER BY.
    for (const field of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(() => orderByOrThrow(WHITELIST, field, 'ASC', DEFAULT, 'incidents'), field).toThrow(ValidationError)
    }
  })
})
