/**
 * The name of a request's GraphQL operation, for the slow-query panel and the
 * logs (wave 7 · A2). It comes from the client: only a GraphQL name of a
 * sensible length is kept as it is.
 */
import { describe, it, expect } from 'vitest'
import { graphqlOperationName } from '../graphqlOperationName.js'

describe('graphqlOperationName', () => {
  it('a named operation keeps its name', () => {
    expect(graphqlOperationName({ operationName: 'GetIncidents', query: 'query GetIncidents { x }' })).toBe('GetIncidents')
    expect(graphqlOperationName({ operationName: '_private2' })).toBe('_private2')
  })

  it('no name is «anonymous», a batch is «batch»', () => {
    expect(graphqlOperationName({ query: '{ x }' })).toBe('anonymous')
    expect(graphqlOperationName({ operationName: null })).toBe('anonymous')
    expect(graphqlOperationName({ operationName: '' })).toBe('anonymous')
    expect(graphqlOperationName(undefined)).toBe('anonymous')
    expect(graphqlOperationName([{ operationName: 'A' }, { operationName: 'B' }])).toBe('batch')
  })

  it('anything that is not a GraphQL name does not reach the logs as it was sent', () => {
    for (const bad of ['Get Incidents', 'x'.repeat(101), '1abc', 'a\nb', 42, { toString: () => 'X' }]) {
      expect(graphqlOperationName({ operationName: bad })).toBe('invalid name')
    }
    expect(graphqlOperationName({ operationName: 'x'.repeat(100) })).toBe('x'.repeat(100))
  })
})
