/**
 * THE LABEL OF A FIELD VALUE: where the vocabulary is found.
 *
 * `useFieldValueLabel.test.tsx` covers a ticket field of the metamodel and a
 * ticket state. Here: a field of the catalog forms library, which the
 * metamodel does not have, finds its vocabulary in the widget catalog (before
 * that, a widget grouped by «Site» said «hq» while the list said
 * «Headquarters»); a CI field reads from the CI types, where «status» is a
 * vocabulary and not a workflow step; without an entity or a field nothing is
 * asked; and a value nobody labelled stays as it is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { apolloFinto } from '@/test/apolloFinto'
import { useFieldValueLabel } from './useFieldValueLabel'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('@/contexts/DomainVocabularyContext', () => ({
  useDomainVocabularies: () => ({
    labelOf: (vocabulary: string, value: string) =>
      ({ 'site:hq': 'Headquarters', 'environment:production': 'Production', 'ci_status:active': 'In service' } as Record<string, string>)[`${vocabulary}:${value}`] ?? null,
  }),
}))
// A step without a label gives an empty one, as the real hook does for a state it does not know.
vi.mock('@/hooks/useWorkflowSteps', () => ({ useWorkflowSteps: () => ({ labelFor: (s: string) => (s === 'closed' ? 'Closed' : '') }) }))

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ name: 'incident', fields: [{ name: 'priority', enumTypeName: 'priority' }] }] }
  apolloFinto.risposte['GetCITypes'] = { ciTypes: [{ name: 'server', fields: [
    { name: 'environment', enumTypeName: 'environment' }, { name: 'status', enumTypeName: 'ci_status' },
  ] }] }
  apolloFinto.risposte['GetWidgetCatalog'] = { widgetCatalog: [{ entityType: 'incident', fields: [{ name: 'site', enumTypeName: 'site' }] }] }
})

const label = (entity: string | null, field: string | null) => renderHook(() => useFieldValueLabel(entity, field)).result.current

describe('useFieldValueLabel', () => {
  it('a field of the catalog forms library finds its vocabulary in the widget catalog', () => {
    expect(label('incident', 'site')('hq')).toBe('Headquarters')
  })

  it('a CI field reads from the CI types; a CI\'s status is its vocabulary, not a workflow step', () => {
    expect(label('server', 'environment')('production')).toBe('Production')
    expect(label('server', 'status')('active')).toBe('In service')
    expect(apolloFinto.chiamate['GetITILTypes']).toBeUndefined()
  })

  it('a ticket state with no step label stays as it is', () => {
    expect(label('incident', 'status')('closed')).toBe('Closed')
    expect(label('incident', 'status')('parked')).toBe('parked')
  })

  it('without an entity or a field nothing is asked, and values stay as they are', () => {
    expect(label(null, 'site')('hq')).toBe('hq')
    expect(label('incident', null)('hq')).toBe('hq')
    expect(Object.keys(apolloFinto.chiamate)).toEqual([])
  })

  it('a field no vocabulary knows shows its value', () => {
    expect(label('incident', 'title')('Mail down')).toBe('Mail down')
  })
})
