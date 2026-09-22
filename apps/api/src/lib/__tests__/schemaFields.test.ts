/**
 * FILTERABLE FIELDS FROM THE SCHEMA.
 *
 * `getScalarFields` is what lets a list page filter on a field without anyone
 * maintaining an allowlist: whatever is a scalar or an enum on the GraphQL
 * type is filterable. If it let a LIST or an object field through, the filter
 * builder would offer a field that cannot be compared with `=` and the query
 * would fail for the user; if it dropped a NonNull scalar (most of them are),
 * the field would silently vanish from the filters.
 */
import { describe, it, expect } from 'vitest'
import { buildSchema } from 'graphql'
import { getScalarFields } from '../schemaFields.js'

const schema = buildSchema(`
  enum Priority { low high }
  scalar DateTime
  type Team { id: ID! }
  type Ticket {
    id: ID!
    title: String
    priority: Priority!
    createdAt: DateTime
    team: Team
    tags: [String!]!
    optionalTags: [String]
    watchers: [Team!]
  }
  input TicketFilter { title: String }
  type Query { ticket: Ticket }
`)

describe('getScalarFields', () => {
  it('keeps scalars, custom scalars and enums, nullable or not', () => {
    expect([...getScalarFields(schema, 'Ticket')].sort()).toEqual(['createdAt', 'id', 'priority', 'title'])
  })

  it('never offers lists or object fields, which cannot be compared as a value', () => {
    const fields = getScalarFields(schema, 'Ticket')
    for (const f of ['tags', 'optionalTags', 'watchers', 'team']) expect(fields.has(f)).toBe(false)
  })

  it('returns an empty set for an unknown type or a type that is not an object', () => {
    // An empty set means "nothing filterable", never a crash on a typo in the entity name.
    expect(getScalarFields(schema, 'Nope').size).toBe(0)
    expect(getScalarFields(schema, 'TicketFilter').size).toBe(0)
    expect(getScalarFields(schema, 'Priority').size).toBe(0)
  })
})
