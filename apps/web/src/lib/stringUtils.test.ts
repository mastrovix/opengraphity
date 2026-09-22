/**
 * The CI list and detail pages build the NAME of a GraphQL operation from the
 * CI type name (`application_server` → `ApplicationServers` →
 * `applicationServers` / `createApplicationServer`). The API side builds the
 * same names with `packages/schema-generator/src/stringUtils.ts`: if the two
 * copies drift, the page asks for a query the schema does not have and the
 * list of that CI type stays empty (or creation fails) for every user.
 * These cases pin the web copy to the generator's rules.
 */
import { describe, it, expect } from 'vitest'
import { toPascalCase, pluralize } from './stringUtils'

describe('toPascalCase', () => {
  it('capitalises every underscore-separated word and joins them', () => {
    expect(toPascalCase('application_server')).toBe('ApplicationServer')
    expect(toPascalCase('server')).toBe('Server')
  })

  it('splits ONLY on underscores: the rest of each word is kept as typed', () => {
    // The generator does not lowercase: `ssl_Certificate` stays `SslCertificate`,
    // and an inner capital survives — changing that would rename existing types.
    expect(toPascalCase('ssl_Certificate')).toBe('SslCertificate')
    expect(toPascalCase('myType')).toBe('MyType')
  })

  it('an empty name stays empty instead of throwing (CIListPage calls it with `?? ""`)', () => {
    expect(toPascalCase('')).toBe('')
  })
})

describe('pluralize', () => {
  it('adds "s" to a regular name', () => {
    expect(pluralize('Server')).toBe('Servers')
  })

  it('a name ending in "s" takes "es"', () => {
    expect(pluralize('Database')).toBe('Databases')
    expect(pluralize('Bus')).toBe('Buses')
  })

  it('a name ending in "y" takes "ies"', () => {
    expect(pluralize('Proxy')).toBe('Proxies')
  })

  it('composes with toPascalCase the way the CI list builds its query name', () => {
    expect(pluralize(toPascalCase('load_balancer_policy'))).toBe('LoadBalancerPolicies')
  })
})
