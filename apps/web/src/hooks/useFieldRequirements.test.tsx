/**
 * FIELD REQUIREMENT RULES: which fields a form must have filled in.
 *
 * The customer's rules say, per entity type and optionally per workflow step,
 * which fields are required. A rule without a step applies to every step, so
 * the step is always sent (as null when there is none); a rule that says
 * «not required» makes nothing required. A failure to load the rules is
 * reported, never mistaken for «nothing is required».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { apolloFinto } from '@/test/apolloFinto'
import { useFieldRequirements } from './useFieldRequirements'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetFieldRequirementRules'] = { fieldRequirementRules: [
    { id: 'r1', fieldName: 'category', required: true, workflowStep: null },
    { id: 'r2', fieldName: 'resolution', required: true, workflowStep: 'resolved' },
    { id: 'r3', fieldName: 'notes', required: false, workflowStep: null },
  ] }
})

describe('useFieldRequirements', () => {
  it('the required fields are the rules that say so; a «not required» rule adds nothing', () => {
    const { result } = renderHook(() => useFieldRequirements('incident', 'resolved'))
    expect(result.current).toEqual({ requirements: { category: true, resolution: true }, error: null })
  })

  it('sends the entity type and the step, or no step at all', () => {
    renderHook(() => useFieldRequirements('incident', 'resolved'))
    expect(apolloFinto.chiamata('GetFieldRequirementRules')).toEqual({ entityType: 'incident', workflowStep: 'resolved' })
    renderHook(() => useFieldRequirements('problem'))
    expect(apolloFinto.chiamata('GetFieldRequirementRules')).toEqual({ entityType: 'problem', workflowStep: null })
    renderHook(() => useFieldRequirements('change', null))
    expect(apolloFinto.chiamata('GetFieldRequirementRules')).toEqual({ entityType: 'change', workflowStep: null })
  })

  it('a failure to load the rules is reported, not taken for «nothing required»', () => {
    apolloFinto.erroriQuery['GetFieldRequirementRules'] = new Error('rules unavailable')
    const { result } = renderHook(() => useFieldRequirements('incident'))
    expect(result.current.requirements).toEqual({})
    expect(result.current.error?.message).toBe('rules unavailable')
  })
})
