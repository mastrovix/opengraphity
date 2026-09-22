/**
 * THE DEADLINE EDITOR ITSELF, driven the way a designer drives it.
 *
 * The panel test covers the round trip through `WorkflowStepPanel`; this file
 * covers the editor's own controls. What a user loses if these regress:
 *  - an approval step of a change that silently accepts a deadline (the API
 *    rejects it on save, after the user has filled everything in);
 *  - a protected target step offered as a normal choice;
 *  - the "set fields" rows offering engine-owned or relation fields the API
 *    refuses, or a free-text box for a field that has a vocabulary;
 *  - a summary that reads the internal value (`p1`) instead of the label, or
 *    that says "24×7" when a service calendar was chosen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import { apolloFinto } from '@/test/apolloFinto'
import i18n from '@/i18n/i18n'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { ALWAYS_ON } from '@/components/sla/ServiceTargetFields'
import { StepDeadlineEditor, draftFromDeadline, type DeadlineDraft, type DeadlineTarget } from './StepDeadlineEditor'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const T = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

const vocab: DomainVocabularies = {
  valuesOf: () => null,
  labelOf: (name, value) => (name === 'severity' && value === 'sev1' ? 'Critical' : null),
  colorOf: () => null, entriesOf: () => null, vocabularyLabelOf: () => null, loading: false, error: null,
}
const Wrap = ({ children }: { children: ReactNode }) => (
  <DomainVocabularyContext.Provider value={vocab}>{children}</DomainVocabularyContext.Provider>
)

const metamodel = (entity: string) => ({
  itilTypes: [{
    name: entity,
    fields: [
      { name: 'severity', label: 'Severity', fieldType: 'enum', enumValues: ['sev1', 'sev2'], enumTypeName: 'severity' },
      { name: 'category', label: 'Category', fieldType: 'enum', enumValues: ['hw'], enumTypeName: null },
      { name: 'reopened', label: 'Reopened', fieldType: 'boolean' },
      { name: 'effort', label: 'Effort', fieldType: 'number' },
      { name: 'due', label: 'Due', fieldType: 'date' },
      { name: 'notes', label: 'Notes', fieldType: 'string' },
      { name: 'owner', label: 'Owner', fieldType: 'user' },
      { name: 'status', label: 'Status', fieldType: 'string' },
      { name: 'priority', label: 'Priority', fieldType: 'enum', enumValues: ['p1'], enumTypeName: 'priority' },
    ],
  }],
})

const targets: DeadlineTarget[] = [
  { name: 'closed', label: 'Closed', purpose: null },
  { name: 'scheduled', label: 'Scheduled', purpose: 'scheduled' },
]

const baseDraft = (over: Partial<DeadlineDraft> = {}): DeadlineDraft =>
  ({ enabled: false, after: '', unit: 'days', calendar: ALWAYS_ON, toStep: '', fields: [], ...over })

/** The editor is controlled: a tiny host keeps the draft, as the panel does. */
function Host({ initial, entityType = 'change', sourcePurpose = null, tgts = targets, spy }: {
  initial: DeadlineDraft; entityType?: string; sourcePurpose?: string | null; tgts?: DeadlineTarget[]; spy?: (d: DeadlineDraft) => void
}) {
  const [draft, setDraft] = useState(initial)
  return (
    <Wrap>
      <StepDeadlineEditor
        stepLabel="Review" entityType={entityType} sourcePurpose={sourcePurpose} targets={tgts} draft={draft}
        onChange={(d) => { spy?.(d); setDraft(d) }}
      />
    </Wrap>
  )
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetITILTypes'] = metamodel('change')
  apolloFinto.risposte['GetServiceCalendars'] = { serviceCalendars: [{ id: 'cal-1', name: 'Office hours' }] }
})

describe('StepDeadlineEditor', () => {
  it('on an approval step of a change the switch is off-limits and says why', () => {
    render(<Host initial={baseDraft()} sourcePurpose="approval" />)
    expect(screen.getByRole('switch', { name: T('workflow.deadline.enable') })).toBeDisabled()
    expect(screen.getByRole('note')).toHaveTextContent(T('workflow.deadline.problemSource'))
  })

  it('a deadline already stored on a protected source can still be switched off', async () => {
    const user = userEvent.setup()
    const spy = vi.fn()
    render(<Host initial={baseDraft({ enabled: true, after: '3', toStep: 'closed' })} sourcePurpose="approval" spy={spy} />)
    const sw = screen.getByRole('switch', { name: T('workflow.deadline.enable') })
    // Otherwise the user could not get rid of the deadline the API now refuses.
    expect(sw).toBeEnabled()
    await user.click(sw)
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }))
    expect(screen.queryByLabelText(T('workflow.deadline.amount'))).not.toBeInTheDocument()
  })

  it('builds a complete deadline and summarises it in the tenant\'s words', async () => {
    const user = userEvent.setup()
    const spy = vi.fn()
    render(<Host initial={baseDraft()} spy={spy} />)

    await user.click(screen.getByRole('switch', { name: T('workflow.deadline.enable') }))
    expect(screen.getByRole('alert')).toHaveTextContent(T('workflow.deadline.problemAfter'))

    await user.type(screen.getByLabelText(T('workflow.deadline.amount')), '2')
    await user.selectOptions(screen.getByLabelText(T('workflow.deadline.unit')), 'hours')
    // The protected target is visible but disabled, with the reason in its text.
    const protectedOpt = screen.getByRole('option', { name: T('workflow.deadline.protectedOption', { step: 'Scheduled' }) })
    expect(protectedOpt).toBeDisabled()
    await user.selectOptions(screen.getByLabelText(T('workflow.deadline.moveTo')), 'closed')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText(/After 2 hours in «Review», counted 24×7, the ticket moves to «Closed»/)).toBeInTheDocument()

    // A service calendar: the summary names it; the service-day hint is for days only.
    await user.selectOptions(screen.getByLabelText(T('serviceTargets.timeCounting')), 'cal-1')
    expect(screen.queryByText(T('workflow.deadline.serviceDayHint'))).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText(T('workflow.deadline.unit')), 'days')
    expect(screen.getByText(T('workflow.deadline.serviceDayHint'))).toBeInTheDocument()
    expect(screen.getByText(/counted with the «Office hours» calendar/)).toBeInTheDocument()

    // Add a field: only writable, non-relation fields are offered.
    await user.click(screen.getByRole('button', { name: new RegExp(T('workflow.deadline.addField')) }))
    expect(screen.getByRole('alert')).toHaveTextContent(T('workflow.deadline.problemFields'))
    // No field chosen yet: the value box is off.
    expect(screen.getByLabelText(T('workflow.deadline.value'))).toBeDisabled()
    const fieldSelect = screen.getByLabelText(T('workflow.deadline.field'))
    const offered = within(fieldSelect).getAllByRole('option').map((o) => o.getAttribute('value'))
    // status is engine-owned, priority derived for a change, owner is a relation.
    expect(offered).toEqual(['', 'severity', 'category', 'reopened', 'effort', 'due', 'notes'])

    await user.selectOptions(fieldSelect, 'severity')
    const valueSelect = screen.getByLabelText(T('workflow.deadline.value'))
    // Vocabulary values show the dictionary label, or the value without one.
    expect(within(valueSelect).getByRole('option', { name: 'Critical' })).toHaveValue('sev1')
    expect(within(valueSelect).getByRole('option', { name: 'sev2' })).toBeInTheDocument()
    await user.selectOptions(valueSelect, 'sev1')
    expect(screen.getByText(/It also sets Severity = Critical\./)).toBeInTheDocument()

    expect(spy).toHaveBeenLastCalledWith({
      enabled: true, after: '2', unit: 'days', calendar: 'cal-1', toStep: 'closed',
      fields: [{ field: 'severity', value: 'sev1' }],
    })

    // Setting the same field twice is refused before the API sees it.
    await user.click(screen.getByRole('button', { name: new RegExp(T('workflow.deadline.addField')) }))
    const second = screen.getAllByLabelText(T('workflow.deadline.field'))[1]!
    await user.selectOptions(second, 'severity')
    await user.selectOptions(screen.getAllByLabelText(T('workflow.deadline.value'))[1]!, 'sev2')
    expect(screen.getByRole('alert')).toHaveTextContent(T('workflow.deadline.problemDuplicate'))

    await user.click(screen.getAllByRole('button', { name: T('workflow.deadline.removeField') })[1]!)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ fields: [{ field: 'severity', value: 'sev1' }] }))
  })

  it('offers the right input for each field type', async () => {
    const user = userEvent.setup()
    apolloFinto.risposte['GetITILTypes'] = metamodel('incident')
    const spy = vi.fn()
    render(<Host
      entityType="incident"
      spy={spy}
      initial={baseDraft({
        enabled: true, after: '1', toStep: 'closed',
        fields: [
          { field: 'reopened', value: '' }, { field: 'effort', value: '' }, { field: 'due', value: '' },
          { field: 'notes', value: '' }, { field: 'legacy_flag', value: 'x' },
        ],
      })}
    />)
    const values = screen.getAllByLabelText(T('workflow.deadline.value'))
    // Boolean: a yes/no choice, not free text.
    expect(within(values[0]!).getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual(['', 'true', 'false'])
    expect(values[1]).toHaveAttribute('type', 'number')
    expect(values[2]).toHaveAttribute('type', 'date')
    expect(values[3]).toHaveAttribute('type', 'text')
    // A stored field the metamodel no longer knows stays visible by its name, so it is not lost.
    const lastField = screen.getAllByLabelText(T('workflow.deadline.field'))[4]!
    expect(lastField).toHaveValue('legacy_flag')
    expect(values[4]).toBeDisabled()

    await user.selectOptions(values[0]!, 'true')
    await user.type(values[1]!, '5')
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({
      fields: expect.arrayContaining([{ field: 'reopened', value: 'true' }, { field: 'effort', value: '5' }]),
    }))
    // Changing the field clears the value: a value of the old field means nothing for the new one.
    await user.selectOptions(screen.getAllByLabelText(T('workflow.deadline.field'))[0]!, 'category')
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({
      fields: expect.arrayContaining([{ field: 'category', value: '' }]),
    }))
  })

  it('summarises raw values for fields with no vocabulary label, and unknown fields by name', () => {
    apolloFinto.risposte['GetITILTypes'] = metamodel('incident')
    render(<Host
      entityType="incident"
      initial={baseDraft({
        enabled: true, after: '1', toStep: 'closed',
        fields: [{ field: 'category', value: 'hw' }, { field: 'severity', value: 'sev2' }, { field: 'legacy_flag', value: 'x' }],
      })}
    />)
    expect(screen.getByText(/It also sets Category = hw, Severity = sev2, legacy_flag = x\./)).toBeInTheDocument()
    expect(screen.getByText(/After 1 day in «Review»/)).toBeInTheDocument()
  })

  it('tells the designer to draw an arc first when no step is reachable', () => {
    render(<Host tgts={[]} initial={baseDraft({ enabled: true, after: '1', toStep: 'closed' })} />)
    expect(screen.getByRole('note')).toHaveTextContent(T('workflow.deadline.noArcs', { step: 'Review' }))
    expect(screen.queryByLabelText(T('workflow.deadline.moveTo'))).not.toBeInTheDocument()
    // The draft points to a step that is no longer reachable: it cannot be saved.
    expect(screen.getByRole('alert')).toHaveTextContent(T('workflow.deadline.problemTarget'))
  })

  it('a hours deadline beyond the maximum is refused like the API does', () => {
    render(<Host initial={baseDraft({ enabled: true, after: '999999', unit: 'hours', toStep: 'closed' })} />)
    expect(screen.getByRole('alert')).toHaveTextContent(T('workflow.deadline.problemAfter'))
  })
})

describe('draftFromDeadline', () => {
  it('keeps the stored calendar and fields', () => {
    const { draft, error } = draftFromDeadline(JSON.stringify({ after: 2, unit: 'hours', calendar_id: 'cal-1', to_step: 'closed', set_fields: [{ field: 'a', value: 'b' }] }))
    expect(error).toBeNull()
    expect(draft).toEqual({ enabled: true, after: '2', unit: 'hours', calendar: 'cal-1', toStep: 'closed', fields: [{ field: 'a', value: 'b' }] })
  })
})
