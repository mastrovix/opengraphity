/**
 * useWorkflowSteps is how every page reads the tenant's workflow instead of
 * hard-coding step names. The helpers below are what the pages build on:
 * - `isTerminal` / `isOpen` split lists into live and finished tickets;
 * - `labelFor` must name a step even when it belongs to ANOTHER active
 *   definition (a ticket parked on it used to show the internal name), and
 *   a step nobody labels reads as its name made readable, never raw;
 * - `isKnownStep` tells a truly orphan step from one of another definition;
 * - purpose helpers let a page recognise a renamed approval step;
 * - `reachableFrom` follows the transitions, not the step position (G-9).
 * If one of these regresses, a page shows the wrong status or sends a ticket
 * to the wrong step.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { apolloFinto } from '@/test/apolloFinto'
import { useWorkflowSteps } from './useWorkflowSteps'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const step = (name: string, order: number, over: Record<string, unknown> = {}) => ({
  id: name, name, label: name.toUpperCase(), labels: [], type: 'standard',
  isInitial: false, isTerminal: false, isOpen: false, category: null, purpose: null, order, ...over,
})

beforeEach(() => {
  apolloFinto.reset()
  // Returned out of order on purpose: the hook must sort by `order`.
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: {
    steps: [
      step('closed', 4, { isTerminal: true, category: 'done' }),
      step('new', 1, { isInitial: true, isOpen: true }),
      step('approval', 2, { purpose: 'approval', label: '' }),
      step('review', 3, { purpose: 'approval', isOpen: true }),
    ],
    transitions: [
      { id: 't1', fromStepName: 'new', toStepName: 'review', trigger: 'submit' },
      { id: 't2', fromStepName: 'new', toStepName: 'closed', trigger: 'cancel' },
    ],
  } }
  apolloFinto.risposte['GetWorkflowStepLabels'] = { workflowStepLabels: [
    { name: 'submitted', label: 'Submitted', labels: [] },
    { name: 'blank', label: '', labels: [] },
    { name: 'on_hold', label: '', labels: [] },
  ] }
})

describe('useWorkflowSteps — derived helpers', () => {
  it('sorts steps by flow order and finds the initial step', () => {
    const { result } = renderHook(() => useWorkflowSteps('change'))
    expect(result.current.steps.map((s) => s.name)).toEqual(['new', 'approval', 'review', 'closed'])
    expect(result.current.initialStep?.name).toBe('new')
  })

  it('isTerminal and isOpen answer from the definition, and false for nothing', () => {
    const { result } = renderHook(() => useWorkflowSteps('change'))
    expect(result.current.isTerminal('closed')).toBe(true)
    expect(result.current.isTerminal('new')).toBe(false)
    expect(result.current.isTerminal(null)).toBe(false)
    expect(result.current.isOpen('review')).toBe(true)
    expect(result.current.isOpen('closed')).toBe(false)
    expect(result.current.isOpen(undefined)).toBe(false)
  })

  it('labelFor reads the process first, then any other active definition, then the name made readable', () => {
    const { result } = renderHook(() => useWorkflowSteps('change'))
    expect(result.current.labelFor('review')).toBe('REVIEW')
    // A step of the process with an empty label falls back to its name, never to ''.
    expect(result.current.labelFor('approval')).toBe('approval')
    // A step of ANOTHER definition is still named for the reader.
    expect(result.current.labelFor('submitted')).toBe('Submitted')
    expect(result.current.labelFor('blank')).toBe('blank')
    expect(result.current.labelFor('ghost')).toBe('ghost')
    // Tour of 23 Sep 2026: the name used to come back raw, so every caller's
    // readable fallback was dead and the pages showed «waiting_vendor».
    expect(result.current.labelFor('waiting_vendor')).toBe('waiting vendor')
    expect(result.current.labelFor('on_hold')).toBe('on hold')
    expect(result.current.labelFor(null)).toBe('')
  })

  it('isKnownStep is true for a step of any active definition, false for an orphan', () => {
    const { result } = renderHook(() => useWorkflowSteps('change'))
    expect(result.current.isKnownStep('new')).toBe(true)
    expect(result.current.isKnownStep('submitted')).toBe(true)
    expect(result.current.isKnownStep('ghost')).toBe(false)
    expect(result.current.isKnownStep('')).toBe(false)
  })

  it('category and purpose come from the step, null when absent', () => {
    const { result } = renderHook(() => useWorkflowSteps('change'))
    expect(result.current.categoryOf('closed')).toBe('done')
    expect(result.current.categoryOf('new')).toBeNull()
    expect(result.current.categoryOf(null)).toBeNull()
    expect(result.current.purposeOf('approval')).toBe('approval')
    expect(result.current.purposeOf('ghost')).toBeNull()
    expect(result.current.hasPurpose('review', 'approval')).toBe(true)
    expect(result.current.hasPurpose('new', 'approval')).toBe(false)
    expect(result.current.stepsByPurpose('approval').map((s) => s.name)).toEqual(['approval', 'review'])
  })

  it('reachableFrom follows the transitions in flow order', () => {
    const { result } = renderHook(() => useWorkflowSteps('change'))
    expect(result.current.reachableFrom('new').map((s) => s.name)).toEqual(['review', 'closed'])
    expect(result.current.reachableFrom('closed')).toEqual([])
    expect(result.current.reachableFrom(null)).toEqual([])
    expect(result.current.transitions).toHaveLength(2)
  })
})

describe('useWorkflowSteps — no workflow', () => {
  it('an empty entity type asks nothing and yields empty, safe helpers', () => {
    const { result } = renderHook(() => useWorkflowSteps(''))
    // Skipped: no request for an entity that has no workflow (a CI, an event).
    expect(apolloFinto.chiamate['GetWorkflowDefinition']).toBeUndefined()
    expect(apolloFinto.chiamate['GetWorkflowStepLabels']).toBeUndefined()
    expect(result.current.steps).toEqual([])
    expect(result.current.transitions).toEqual([])
    expect(result.current.initialStep).toBeNull()
    expect(result.current.labelFor('x')).toBe('x')
  })

  it('a missing definition does not crash the page', () => {
    apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: null }
    apolloFinto.risposte['GetWorkflowStepLabels'] = undefined
    const { result } = renderHook(() => useWorkflowSteps('problem'))
    expect(result.current.steps).toEqual([])
    expect(result.current.isKnownStep('x')).toBe(false)
  })
})
