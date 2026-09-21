/**
 * Verifica «Cosa resta cablato», ondata 3: la scadenza del passo nel disegnatore.
 * Le regole dell'API si dicono prima: il passo di arrivo protetto dalle
 * approvazioni è spento, la bozza incompleta blocca il Salva, e quello che si
 * salva è la stessa forma che l'API legge.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { GET_SERVICE_CALENDARS, GET_WORKFLOW_DEFINITION_BY_ID } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { itilTypesMock, teamsMock, usersMock, workflowListMock } from '@/test/mocks/gql'
import i18n from '@/i18n/i18n'
import { ALWAYS_ON } from '@/components/sla/ServiceTargetFields'
import { WorkflowStepPanel } from './WorkflowStepPanel'
import { deadlineFromDraft, draftFromDeadline, draftProblem, type DeadlineDraft } from './StepDeadlineEditor'

const T = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

describe('la bozza della scadenza', () => {
  const targets = [
    { name: 'closed', label: 'Closed', purpose: null },
    { name: 'scheduled', label: 'Scheduled', purpose: 'scheduled' },
  ]
  const draft = (over: Partial<DeadlineDraft> = {}): DeadlineDraft =>
    ({ enabled: true, after: '7', unit: 'days', calendar: ALWAYS_ON, toStep: 'closed', fields: [], ...over })

  it('andata e ritorno: quello che si salva è quello che si rilegge', () => {
    const json = deadlineFromDraft(draft({ calendar: 'cal-1', fields: [{ field: 'outcome', value: 'successful' }] }))
    expect(JSON.parse(json)).toEqual({ after: 7, unit: 'days', calendar_id: 'cal-1', to_step: 'closed', set_fields: [{ field: 'outcome', value: 'successful' }] })
    expect(draftFromDeadline(json).draft).toEqual(draft({ calendar: 'cal-1', fields: [{ field: 'outcome', value: 'successful' }] }))
    expect(deadlineFromDraft(draft({ enabled: false }))).toBe('')
  })

  it('una scadenza illeggibile lo dice, invece di sembrare «nessuna»', () => {
    expect(draftFromDeadline('{rotto').error).not.toBeNull()
    expect(draftFromDeadline(null)).toEqual({ draft: expect.objectContaining({ enabled: false }), error: null })
  })

  it('i problemi che l\'API rifiuterebbe', () => {
    expect(draftProblem(draft({ after: '0' }), targets, 'change', null)).toBe('workflow.deadline.problemAfter')
    expect(draftProblem(draft({ after: '1.5' }), targets, 'change', null)).toBe('workflow.deadline.problemAfter')
    expect(draftProblem(draft({ toStep: '' }), targets, 'change', null)).toBe('workflow.deadline.problemTarget')
    expect(draftProblem(draft({ toStep: 'scheduled' }), targets, 'change', null)).toBe('workflow.deadline.problemProtected')
    // Il varco è delle change: per un incident lo stesso scopo non conta.
    expect(draftProblem(draft({ toStep: 'scheduled' }), targets, 'incident', null)).toBeNull()
    expect(draftProblem(draft(), targets, 'change', 'approval')).toBe('workflow.deadline.problemSource')
    expect(draftProblem(draft({ fields: [{ field: 'outcome', value: '' }] }), targets, 'change', null)).toBe('workflow.deadline.problemFields')
    expect(draftProblem(draft({ fields: [{ field: 'a', value: '1' }, { field: 'a', value: '2' }] }), targets, 'change', null)).toBe('workflow.deadline.problemDuplicate')
    expect(draftProblem(draft(), targets, 'change', 'review')).toBeNull()
  })
})

describe('WorkflowStepPanel — la scheda Scadenza', () => {
  const DEF_ID = 'wf-change'
  const mocks = (): GqlMock[] => [
    {
      request: { query: GET_WORKFLOW_DEFINITION_BY_ID, variables: { id: DEF_ID } },
      result: { data: { workflowDefinitionById: {
        __typename: 'WorkflowDefinition', id: DEF_ID, name: 'Change', entityType: 'incident', category: null, version: 1, active: true,
        steps: [
          { __typename: 'WorkflowStep', id: 's-1', name: 'resolved', label: 'Resolved', type: 'standard', enterActions: null, exitActions: null, isInitial: false, isTerminal: true, isOpen: false, category: 'resolved', purpose: null, deadline: null, order: 7, currentInstances: 0, positionX: null, positionY: null },
          { __typename: 'WorkflowStep', id: 's-2', name: 'closed', label: 'Closed', type: 'end', enterActions: null, exitActions: null, isInitial: false, isTerminal: true, isOpen: false, category: 'closed', purpose: null, deadline: null, order: 8, currentInstances: 0, positionX: null, positionY: null },
        ],
        transitions: [
          { __typename: 'WorkflowTransitionDef', id: 't-1', fromStepName: 'resolved', toStepName: 'closed', trigger: 'timer', label: 'Close', requiresInput: false, inputField: null, condition: null, timerHours: null, sourceHandle: null, targetHandle: null },
        ],
      } } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    },
    { request: { query: GET_SERVICE_CALENDARS }, result: { data: { serviceCalendars: [] } }, maxUsageCount: Number.POSITIVE_INFINITY },
    itilTypesMock(), teamsMock(), usersMock([]), workflowListMock(),
  ]

  it('la chiusura automatica di fabbrica si legge com\'è: 72 ore 24×7 verso Closed', async () => {
    const deadline = JSON.stringify({ after: 72, unit: 'hours', calendar_id: null, to_step: 'closed', set_fields: [] })
    const { user } = renderWithProviders(
      <WorkflowStepPanel step={{ id: 's-1', name: 'resolved', label: 'Resolved', type: 'standard', enterActions: null, exitActions: null, deadline }} definitionId={DEF_ID} onClose={() => {}} onSaved={vi.fn()} />,
      { mocks: mocks() },
    )
    await user.click(screen.getByRole('tab', { name: T('pages.workflowStep.tabDeadline') }))
    expect(screen.getByRole('switch', { name: T('workflow.deadline.enable') })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText(T('workflow.deadline.amount'))).toHaveValue(72)
    await waitFor(() => expect(screen.getByRole('option', { name: 'Closed' })).toBeInTheDocument())
    expect(screen.getByText(/After 72 hours in «Resolved», counted 24×7, the ticket moves to «Closed»/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('accesa e completata, il pannello la manda al disegnatore; spenta manda la stringa vuota', async () => {
    const onSaveLocally = vi.fn()
    const { user } = renderWithProviders(
      <WorkflowStepPanel step={{ id: 's-1', name: 'resolved', label: 'Resolved', type: 'standard', enterActions: null, exitActions: null, deadline: null }} definitionId={DEF_ID} onClose={() => {}} onSaved={vi.fn()} onSaveLocally={onSaveLocally} />,
      { mocks: mocks() },
    )
    await user.click(screen.getByRole('tab', { name: T('pages.workflowStep.tabDeadline') }))
    await user.click(screen.getByRole('switch', { name: T('workflow.deadline.enable') }))
    const save = screen.getByRole('button', { name: 'Save' })
    // Incompleta: il motivo si vede e il Salva resta spento.
    expect(screen.getByRole('alert')).toHaveTextContent(T('workflow.deadline.problemAfter'))
    expect(save).toBeDisabled()

    await user.type(screen.getByLabelText(T('workflow.deadline.amount')), '48')
    await waitFor(() => expect(screen.getByRole('option', { name: 'Closed' })).toBeInTheDocument())
    await user.selectOptions(screen.getByLabelText(T('workflow.deadline.moveTo')), 'closed')
    expect(save).toBeEnabled()
    await user.click(save)
    expect(onSaveLocally).toHaveBeenCalledWith(expect.objectContaining({ stepName: 'resolved' }))
    const sent = onSaveLocally.mock.calls[0]![0] as { deadline: string }
    expect(JSON.parse(sent.deadline)).toEqual({ after: 48, unit: 'days', calendar_id: null, to_step: 'closed', set_fields: [] })
  })
})
