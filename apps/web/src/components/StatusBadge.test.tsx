/**
 * THE TWO KINDS OF STATUS ON SCREEN.
 *
 * A CI status comes from a VOCABULARY (the Dictionary label per value); a
 * ticket status is the name of a WORKFLOW STEP (the label written on the step
 * in the designer). Asking the wrong source does not fail, it shows the raw
 * internal name — which is exactly the «closed» next to «Chiuso» that these
 * components exist to prevent. The tests pin where each one reads its label,
 * the readable fallback, and that an orphan step is flagged only once the
 * steps are loaded (flashing «orphan» on every row while loading would lie).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { apolloFinto } from '@/test/apolloFinto'
import { withVocabularyLabels } from '@/test/vocabularies'

/** Operation names whose answer has not arrived yet (the fake answers at once otherwise). */
const inFlight = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const base = moduloApollo()
  return {
    ...base,
    useQuery: (doc: Parameters<typeof base.useQuery>[0], opts?: Parameters<typeof base.useQuery>[1]) => {
      const r = base.useQuery(doc, opts)
      return inFlight.has(nomeOperazione(doc)) ? { ...r, data: undefined, loading: true } : r
    },
  }
})

const { StatusBadge, TicketStatusBadge } = await import('./StatusBadge')

const step = (name: string, label: string) => ({
  id: name, name, label, labels: [], type: 'state', isInitial: false, isTerminal: false, isOpen: true,
  category: null, purpose: null, order: 1,
})

beforeEach(() => {
  apolloFinto.reset()
  inFlight.clear()
})

describe('StatusBadge (a vocabulary value, by default the CI status)', () => {
  it('shows the Dictionary label, keeping the internal value as the tooltip', () => {
    render(withVocabularyLabels(<StatusBadge value="decommissioned" />, { ci_status: { decommissioned: 'Retired' } }))
    expect(screen.getByText('Retired')).toHaveAttribute('title', 'decommissioned')
  })

  it('reads the vocabulary the caller names, not the CI status', () => {
    render(withVocabularyLabels(<StatusBadge value="p1" vocabulary="priority" />, { ci_status: { p1: 'Wrong source' }, priority: { p1: 'Critical' } }))
    expect(screen.getByText('Critical')).toBeInTheDocument()
    expect(screen.queryByText('Wrong source')).not.toBeInTheDocument()
  })

  it('a value nobody labelled is shown readable, without underscores', () => {
    render(withVocabularyLabels(<StatusBadge value="under_maintenance" />, {}))
    expect(screen.getByText('under maintenance')).toHaveAttribute('title', 'under_maintenance')
  })
})

describe('TicketStatusBadge (a workflow step)', () => {
  it('a step of the process shows the label written on the step', () => {
    apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: [step('in_progress', 'Being worked on')], transitions: [] } }
    render(<TicketStatusBadge value="in_progress" entityType="incident" />)
    expect(screen.getByText('Being worked on')).toHaveAttribute('title', 'in_progress')
    // It asks the workflow of THIS entity: two entities can name a step alike.
    expect(apolloFinto.chiamata('GetWorkflowDefinition')).toEqual({ entityType: 'incident' })
  })

  it('a step that only another active definition declares still reads with its label', () => {
    apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: [], transitions: [] } }
    apolloFinto.risposte['GetWorkflowStepLabels'] = { workflowStepLabels: [{ name: 'submitted', label: 'Submitted', labels: [] }] }
    render(<TicketStatusBadge value="submitted" entityType="service_request" />)
    expect(screen.getByText('Submitted')).toBeInTheDocument()
  })

  it('a step no process declares any more is flagged as an orphan, with the reason in the tooltip', () => {
    apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: [step('new', 'New')], transitions: [] } }
    render(<TicketStatusBadge value="old_triage" entityType="incident" />)
    const badge = screen.getByText('old triage')
    expect(badge).toHaveAttribute('title', expect.stringContaining('«old_triage» is not (any more) a step of this process'))
    expect(badge).toHaveStyle({ fontStyle: 'italic' })
  })

  it('while the steps are loading nobody is accused: the raw value is shown plainly', () => {
    inFlight.add('GetWorkflowDefinition')
    render(<TicketStatusBadge value="waiting_parts" entityType="incident" />)
    const badge = screen.getByText('waiting parts')
    expect(badge).toHaveAttribute('title', 'waiting_parts')
    expect(badge).not.toHaveStyle({ fontStyle: 'italic' })
  })
})
