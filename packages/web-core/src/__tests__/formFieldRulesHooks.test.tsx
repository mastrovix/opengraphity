/**
 * THE HOOKS THAT ASK THE SERVER FOR THE FIELD RULES.
 *
 * Both queries are `cache-first`: the rules change when an administrator
 * edits them, not while somebody is filling a form in, and asking on every
 * keystroke would put a round trip between a character and its echo.
 *
 * A failed query surfaces as an error the caller can show. Swallowing it
 * would render the form with NO rules at all — every field visible, none
 * required — which looks like a working form and is not.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { ApolloClient, ApolloLink, InMemoryCache } from '@apollo/client/core'
import { ApolloProvider } from '@apollo/client/react'
import { Observable } from '@apollo/client/utilities'
import { useFieldVisibility, useFieldRequirements, useFormFieldRules } from '../useFormFieldRules.js'
import { GET_FIELD_VISIBILITY_RULES, GET_FIELD_REQUIREMENT_RULES } from '../fieldRules.graphql.js'

afterEach(cleanup)

type Answer = { data?: Record<string, unknown>; error?: Error }

/** A client whose link answers each query by name, and records the variables. */
function clientAnswering(answers: Record<string, Answer>, seen: Array<Record<string, unknown>> = []) {
  const link = new ApolloLink((operation) => new Observable<Record<string, unknown>>((observer) => {
    seen.push({ name: operation.operationName, ...operation.variables })
    const a = answers[operation.operationName ?? ''] ?? { data: {} }
    if (a.error) { observer.error(a.error); return }
    observer.next({ data: a.data })
    observer.complete()
  })) as ApolloLink
  return new ApolloClient({ link, cache: new InMemoryCache() })
}

const nameOf = (doc: typeof GET_FIELD_VISIBILITY_RULES): string =>
  (doc.definitions[0] as { name?: { value: string } }).name!.value

const VISIBILITY = nameOf(GET_FIELD_VISIBILITY_RULES)
const REQUIREMENTS = nameOf(GET_FIELD_REQUIREMENT_RULES)

/** Renders a hook and prints what it returned, so the assertions read off the DOM. */
function show(useHook: () => unknown, client: ApolloClient) {
  function Probe() {
    return <pre data-testid="out">{JSON.stringify(useHook(), (_k, v: unknown) => (v instanceof Error ? v.message : v))}</pre>
  }
  render(<ApolloProvider client={client}><Probe /></ApolloProvider>)
  return async () => {
    await waitFor(() => { expect(screen.getByTestId('out').textContent).not.toBe('') })
    return JSON.parse(screen.getByTestId('out').textContent!) as Record<string, unknown>
  }
}

const visRule = (trigger: string, value: string, target: string, action: 'show' | 'hide') =>
  ({ __typename: 'FieldVisibilityRule', id: `${trigger}-${target}`, entityType: 'incident', triggerField: trigger, triggerValue: value, targetField: target, action })
const reqRule = (fieldName: string, required: boolean) =>
  ({ __typename: 'FieldRequirementRule', id: fieldName, entityType: 'incident', fieldName, workflowStep: null, required })

describe('useFieldVisibility', () => {
  it('asks for the entity type and evaluates the rules against the current answers', async () => {
    const seen: Array<Record<string, unknown>> = []
    const client = clientAnswering({ [VISIBILITY]: { data: { fieldVisibilityRules: [visRule('category', 'hardware', 'serial', 'show')] } } }, seen)
    const read = show(() => useFieldVisibility('incident', { category: 'hardware' }), client)
    expect((await read())['visibility']).toEqual({ serial: true })
    expect(seen[0]).toMatchObject({ entityType: 'incident' })
  })

  it('with no rules yet it reports nothing hidden, not a crash', async () => {
    const client = clientAnswering({ [VISIBILITY]: { data: {} } })
    const read = show(() => useFieldVisibility('incident', {}), client)
    expect(await read()).toEqual({ visibility: {}, error: null })
  })

  it('a failed query comes back as an error the caller can show', async () => {
    // Swallowing it would render a form with every field visible and none
    // required — which looks like a working form and is not.
    const client = clientAnswering({ [VISIBILITY]: { error: new Error('Failed to fetch') } })
    const read = show(() => useFieldVisibility('incident', {}), client)
    expect((await read())['error']).toContain('Failed to fetch')
  })
})

describe('useFieldRequirements', () => {
  it('asks for the entity type AND the workflow step: a field required at "resolved" is not at "new"', async () => {
    const seen: Array<Record<string, unknown>> = []
    const client = clientAnswering({ [REQUIREMENTS]: { data: { fieldRequirementRules: [reqRule('root_cause', true)] } } }, seen)
    const read = show(() => useFieldRequirements('incident', 'resolved'), client)
    expect((await read())['requirements']).toEqual({ root_cause: true })
    expect(seen[0]).toMatchObject({ entityType: 'incident', workflowStep: 'resolved' })
  })

  it('no step means null, not an absent variable: the server filters on it', async () => {
    const seen: Array<Record<string, unknown>> = []
    const client = clientAnswering({ [REQUIREMENTS]: { data: { fieldRequirementRules: [] } } }, seen)
    const read = show(() => useFieldRequirements('incident', undefined), client)
    await read()
    expect(seen[0]!['workflowStep']).toBeNull()
  })

  it('a failed query surfaces too', async () => {
    const client = clientAnswering({ [REQUIREMENTS]: { error: new Error('boom') } })
    const read = show(() => useFieldRequirements('incident', null), client)
    expect((await read())['error']).toContain('boom')
  })
})

describe('useFormFieldRules', () => {
  it('merges both, and a hidden field is never required', async () => {
    const client = clientAnswering({
      [VISIBILITY]:   { data: { fieldVisibilityRules: [visRule('category', 'hardware', 'serial', 'show')] } },
      [REQUIREMENTS]: { data: { fieldRequirementRules: [reqRule('serial', true), reqRule('title', true)] } },
    })
    const read = show(() => useFormFieldRules('incident', 'new', { category: 'software' }), client)
    expect((await read())['rules']).toEqual({
      serial: { visible: false, required: false },   // hidden → not required
      title:  { visible: true,  required: true },
    })
  })

  it('when the trigger matches, the same field becomes visible AND required', async () => {
    const client = clientAnswering({
      [VISIBILITY]:   { data: { fieldVisibilityRules: [visRule('category', 'hardware', 'serial', 'show')] } },
      [REQUIREMENTS]: { data: { fieldRequirementRules: [reqRule('serial', true)] } },
    })
    const read = show(() => useFormFieldRules('incident', 'new', { category: 'hardware' }), client)
    expect((await read())['rules']).toEqual({ serial: { visible: true, required: true } })
  })

  it('either query failing surfaces its error', async () => {
    const onlyVisibilityBroken = clientAnswering({
      [VISIBILITY]:   { error: new Error('visibility down') },
      [REQUIREMENTS]: { data: { fieldRequirementRules: [] } },
    })
    const read = show(() => useFormFieldRules('incident', null, {}), onlyVisibilityBroken)
    expect((await read())['error']).toContain('visibility down')
    cleanup()

    const onlyRequirementsBroken = clientAnswering({
      [VISIBILITY]:   { data: { fieldVisibilityRules: [] } },
      [REQUIREMENTS]: { error: new Error('requirements down') },
    })
    const read2 = show(() => useFormFieldRules('incident', null, {}), onlyRequirementsBroken)
    expect((await read2())['error']).toContain('requirements down')
  })
})
