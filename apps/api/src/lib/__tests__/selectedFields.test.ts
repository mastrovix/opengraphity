/**
 * lib/selectedFields.ts — the fields a query selects under the current one,
 * read through fragments (review of 23 Sep 2026: list resolvers prefetch only
 * what is asked).
 */
import { describe, it, expect } from 'vitest'
import { parse, type FragmentDefinitionNode, type OperationDefinitionNode, type FieldNode } from 'graphql'
import { selectedFields } from '../selectedFields.js'

function infoFor(query: string) {
  const doc = parse(query)
  const op = doc.definitions.find((d): d is OperationDefinitionNode => d.kind === 'OperationDefinition')!
  const fragments = Object.fromEntries(doc.definitions
    .filter((d): d is FragmentDefinitionNode => d.kind === 'FragmentDefinition')
    .map((f) => [f.name.value, f]))
  return { fieldNodes: [op.selectionSet.selections[0] as FieldNode], fragments }
}

describe('selectedFields', () => {
  it('the direct fields, those of named fragments and of inline fragments', () => {
    const info = infoFor(`
      query { teams { id name ...TeamRef ... on Team { manager { id } } } }
      fragment TeamRef on Team { type members { id } ...More }
      fragment More on Team { ownedCIs { id } }
    `)
    expect([...selectedFields(info)].sort()).toEqual(['id', 'manager', 'members', 'name', 'ownedCIs', 'type'])
  })

  it('the fields of a child are not the parent\'s', () => {
    expect(selectedFields(infoFor('query { users { id teams { members { id } } } }')).has('members')).toBe(false)
  })

  it('no info: nothing is known to be selected', () => {
    expect(selectedFields(undefined).size).toBe(0)
  })
})
