import { describe, it, expect } from 'vitest'
import { APOLLO_DEFAULT_OPTIONS } from './apolloDefaults'

describe('Apollo: le pagine si rivalidano all\'apertura', () => {
  it('le query guardate partono da cache-and-network, poi cache-first', () => {
    expect(APOLLO_DEFAULT_OPTIONS.watchQuery).toMatchObject({ fetchPolicy: 'cache-and-network', nextFetchPolicy: 'cache-first' })
  })
})
