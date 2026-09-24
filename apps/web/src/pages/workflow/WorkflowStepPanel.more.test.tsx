/**
 * THE STEP PANEL, BEYOND THE PROPERTIES TAB.
 *
 * The designer edits every step through this panel, and what it saves is what
 * the engine runs on each ticket that enters the step. The behaviours pinned
 * here are the ones whose regression would silently change a live process:
 *  - the deadline tab only offers steps reachable by an arc (a deadline follows
 *    an arc), and an unreadable saved deadline blocks Save instead of being
 *    overwritten with nothing;
 *  - a missing workflow definition is SAID, not turned into an empty entity type
 *    that makes every field list empty without explanation;
 *  - exit actions are edited, updated and removed in their own list, and the
 *    save carries them (an exit action saved as an enter one runs at the wrong time);
 *  - the notification on entry is saved as a `notify_rule` action with the
 *    chosen severity, channels and recipient;
 *  - deleting a step asks first, and only a "yes" deletes it.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import i18n from '@/i18n/i18n'
import { WorkflowStepPanel } from './WorkflowStepPanel'
import type { WFStep } from './workflow-types'
import { GET_WORKFLOW_DEFINITION_BY_ID } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { teamsMock, usersMock, workflowListMock, itilTypesMock, meMock, rolesMock } from '@/test/mocks/gql'

const DEF_ID = 'wf-incident'
const T = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

type DefShape = {
  steps?: { name: string; label: string; purpose: string | null }[]
  transitions?: { fromStepName: string; toStepName: string }[]
} | null

function definitionMock(def: DefShape | 'error' = {}): GqlMock {
  const request = { query: GET_WORKFLOW_DEFINITION_BY_ID, variables: { id: DEF_ID } }
  if (def === 'error') return { request, error: new Error('network down'), maxUsageCount: Number.POSITIVE_INFINITY }
  return {
    request,
    result: { data: { workflowDefinitionById: def === null ? null : {
      __typename: 'WorkflowDefinition', id: DEF_ID, name: 'Incident', entityType: 'incident', category: null, version: 1, active: true,
      steps: (def.steps ?? []).map((s) => ({ __typename: 'WorkflowStep', ...s })),
      transitions: (def.transitions ?? []).map((tr) => ({ __typename: 'WorkflowTransition', ...tr })),
    } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

const baseMocks = (def: DefShape | 'error' = {}) => [
  definitionMock(def), itilTypesMock(), teamsMock(), usersMock([]), workflowListMock(),
  meMock('admin', { maxUsageCount: Number.POSITIVE_INFINITY }), rolesMock([{ key: 'service_desk', name: 'Service Desk' }]),
]

function step(overrides: Partial<WFStep> = {}): WFStep {
  return { id: 's-1', name: 'in_progress', label: 'In progress', type: 'standard', enterActions: null, exitActions: null, isInitial: false, isTerminal: false, ...overrides }
}

function renderPanel(s: WFStep, opts: { def?: DefShape | 'error'; onDelete?: (n: string) => void } = {}) {
  const onSaved = vi.fn(); const onSaveLocally = vi.fn()
  const r = renderWithProviders(
    <WorkflowStepPanel step={s} definitionId={DEF_ID} onClose={() => {}} onSaved={onSaved} onSaveLocally={onSaveLocally} onDelete={opts.onDelete} />,
    { mocks: baseMocks(opts.def === undefined ? {} : opts.def) },
  )
  return { ...r, onSaved, onSaveLocally }
}

const saveButton = () => screen.getByRole('button', { name: T('common.save') })
const listOf = (key: 'enter_actions' | 'exit_actions') => screen.getByText(T(`workflow.panel.${key}`)).parentElement!
const actionTypeSelect = () => screen.getByDisplayValue('sla_start') as HTMLSelectElement

describe('WorkflowStepPanel — deadline tab', () => {
  it('offers as targets only the steps reachable by an arc from this step, never the step itself', async () => {
    const { user } = renderPanel(step(), {
      def: {
        steps: [
          { name: 'in_progress', label: 'In progress', purpose: null },
          { name: 'resolved', label: 'Resolved', purpose: null },
          { name: 'closed', label: 'Closed', purpose: null },
        ],
        transitions: [
          { fromStepName: 'in_progress', toStepName: 'resolved' },
          { fromStepName: 'in_progress', toStepName: 'resolved' }, // duplicated arc: one option
          { fromStepName: 'in_progress', toStepName: 'in_progress' }, // self loop
          { fromStepName: 'resolved', toStepName: 'closed' },        // not from here
          { fromStepName: 'in_progress', toStepName: 'ghost' },      // unknown step: its name is the label
        ],
      },
    })
    await user.click(screen.getByRole('tab', { name: T('pages.workflowStep.tabDeadline') }))
    await user.click(screen.getByRole('switch', { name: T('workflow.deadline.enable') }))
    const moveTo = await screen.findByRole('combobox', { name: T('workflow.deadline.moveTo') })
    await waitFor(() => expect(within(moveTo).queryByRole('option', { name: 'Resolved' })).toBeInTheDocument())
    const labels = within(moveTo).getAllByRole('option').map((o) => o.textContent)
    expect(labels).toContain('ghost')
    expect(labels).not.toContain('Closed')
    expect(labels).not.toContain('In progress')
    expect(labels.filter((l) => l === 'Resolved')).toHaveLength(1)

    // Back on the properties tab the label editor is there again.
    await user.click(screen.getByRole('tab', { name: T('pages.workflowStep.tabProps') }))
    expect(screen.getByDisplayValue('In progress')).toBeInTheDocument()
  })

  it('an unreadable saved deadline is shown as an error and blocks Save (saving would erase it)', async () => {
    const { user } = renderPanel(step({ deadline: '{not json' }))
    await user.click(screen.getByRole('tab', { name: T('pages.workflowStep.tabDeadline') }))
    const alert = screen.getAllByRole('alert').find((a) => a.textContent?.startsWith(T('workflow.deadline.corrupted', { error: '' }).slice(0, 10)))
    expect(alert).toBeDefined()
    expect(screen.queryByRole('switch', { name: T('workflow.deadline.enable') })).not.toBeInTheDocument()
    // Even a real change elsewhere cannot unlock Save.
    await user.click(screen.getByRole('tab', { name: T('pages.workflowStep.tabProps') }))
    await user.type(screen.getByDisplayValue('In progress'), '!')
    expect(saveButton()).toBeDisabled()
  })
})

describe('WorkflowStepPanel — the workflow definition cannot be read', () => {
  it('a definition that does not exist is named in an alert', async () => {
    renderPanel(step(), { def: null })
    // The key names the missing definition, so the designer knows which one to fix.
    const alert = await screen.findByText(/not found/)
    expect(alert).toHaveTextContent(DEF_ID)
  })

  it('a network error is shown with its message', async () => {
    renderPanel(step(), { def: 'error' })
    expect(await screen.findByText(/network down/)).toBeInTheDocument()
  })
})

describe('WorkflowStepPanel — editing the action lists', () => {
  it('an action added to the EXIT list is saved as an exit action', async () => {
    const { user, onSaved } = renderPanel(step())
    await user.click(within(listOf('exit_actions')).getByRole('button', { name: `+ ${T('workflow.addAction')}` }))
    // `create_task` is never offered on exit: the engine runs exit actions with
    // the instance already on the next step, so the task would carry the wrong step.
    expect(within(actionTypeSelect()).queryByRole('option', { name: 'create_task' })).not.toBeInTheDocument()
    await user.selectOptions(actionTypeSelect(), 'sla_stop')
    await user.click(screen.getByRole('button', { name: T('common.confirm') }))
    await user.click(saveButton())
    const saved = onSaved.mock.calls[0]![0] as { enterActions: string | null; exitActions: string | null }
    expect(saved.enterActions).toBeNull()
    expect(JSON.parse(saved.exitActions!)).toEqual([expect.objectContaining({ type: 'sla_stop' })])
  })

  it('create_task is offered on ENTER for a ticket workflow', async () => {
    const { user } = renderPanel(step())
    await user.click(within(listOf('enter_actions')).getByRole('button', { name: `+ ${T('workflow.addAction')}` }))
    await waitFor(() => expect(within(actionTypeSelect()).getByRole('option', { name: 'create_task' })).toBeInTheDocument())
  })

  it('cancelling a new action leaves the list as it was', async () => {
    const { user } = renderPanel(step())
    await user.click(within(listOf('enter_actions')).getByRole('button', { name: `+ ${T('workflow.addAction')}` }))
    await user.click(screen.getByRole('button', { name: T('common.cancel') }))
    expect(screen.queryByTitle('sla_start')).not.toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
  })

  it('the parameters and the AND/OR logic of a new action are what gets saved', async () => {
    const { user, onSaved } = renderPanel(step())
    await user.click(within(listOf('enter_actions')).getByRole('button', { name: `+ ${T('workflow.addAction')}` }))
    const slaType = screen.getByDisplayValue('response')
    await user.selectOptions(slaType, 'resolve')

    const addCondition = screen.getByRole('button', { name: `+ ${T('pages.businessRules.addCondition')}` })
    await user.click(addCondition)
    await user.click(addCondition)
    await user.click(addCondition)
    // With two or more rows the logic becomes a choice.
    await user.click(screen.getByRole('radio', { name: 'OR' }))
    expect(screen.getByRole('radio', { name: 'OR' })).toBeChecked()
    // Removing a row removes exactly one.
    const removeButtons = screen.getAllByRole('button', { name: T('conditionEditor.remove') })
    expect(removeButtons).toHaveLength(3)
    await user.click(removeButtons[2]!)
    expect(screen.getAllByRole('button', { name: T('conditionEditor.remove') })).toHaveLength(2)

    const fields = await screen.findAllByDisplayValue(T('conditionEditor.fieldPlaceholder'))
    await waitFor(() => expect(within(fields[0]!).getByText(/severity/)).toBeInTheDocument())
    await user.selectOptions(fields[0]!, 'severity')
    await user.selectOptions(fields[1]!, 'severity')
    await user.click(screen.getByRole('button', { name: T('common.confirm') }))
    await user.click(saveButton())

    const saved = JSON.parse((onSaved.mock.calls[0]![0] as { enterActions: string }).enterActions) as Array<Record<string, unknown>>
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ type: 'sla_start', params: { sla_type: 'resolve' }, conditions_logic: 'OR' })
    expect(saved[0]!['conditions']).toHaveLength(2)
  })

  it('an exit action can be opened, re-typed and updated in place; clicking it again closes the editor', async () => {
    const { user, onSaved } = renderPanel(step({ exitActions: JSON.stringify([{ type: 'sla_stop', params: { sla_type: 'resolve' } }]) }))
    const badge = () => screen.getByTitle('sla_stop').closest('button')!
    await user.click(badge())
    expect(badge()).toHaveAttribute('aria-expanded', 'true')
    await user.click(badge())
    expect(badge()).toHaveAttribute('aria-expanded', 'false')

    await user.click(badge())
    await user.selectOptions(screen.getByDisplayValue('sla_stop'), 'sla_start')
    await user.click(screen.getByRole('button', { name: T('pages.workflowStep.update') }))
    await user.click(saveButton())
    const saved = onSaved.mock.calls[0]![0] as { exitActions: string }
    // Changing the type resets the parameters: the old ones belong to another action.
    expect(JSON.parse(saved.exitActions)).toEqual([{ type: 'sla_start', params: expect.any(Object) }])
  })

  it('cancelling an edit keeps the saved action untouched', async () => {
    const { user } = renderPanel(step({ enterActions: JSON.stringify([{ type: 'sla_start', params: { sla_type: 'response' } }]) }))
    await user.click(screen.getByTitle('sla_start').closest('button')!)
    await user.selectOptions(screen.getByDisplayValue('sla_start'), 'sla_stop')
    await user.click(screen.getByRole('button', { name: T('common.cancel') }))
    expect(screen.getByTitle('sla_start')).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
  })

  it('removing an action from each list is saved as removed', async () => {
    const { user, onSaved } = renderPanel(step({
      enterActions: JSON.stringify([{ type: 'sla_start', params: { sla_type: 'response' } }]),
      exitActions:  JSON.stringify([{ type: 'sla_stop', params: { sla_type: 'resolve' } }]),
    }))
    await user.click(within(listOf('enter_actions')).getByRole('button', { name: T('workflow.removeAction') }))
    await user.click(within(listOf('exit_actions')).getByRole('button', { name: T('workflow.removeAction') }))
    await user.click(saveButton())
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ enterActions: null, exitActions: null }))
  })

  it('the titles of the other tasks of the step are offered as "starts after"', async () => {
    const { user } = renderPanel(step({ enterActions: JSON.stringify([
      { type: 'create_task', params: { title_template: 'Prepare the laptop', team_id: 't1' } },
      { type: 'create_task', params: { title_template: 'Create the account', team_id: 't1', after: 'Prepare the laptop' } },
    ]) }))
    await user.click(within(listOf('enter_actions')).getByRole('button', { name: `+ ${T('workflow.addAction')}` }))
    await waitFor(() => expect(within(actionTypeSelect()).getByRole('option', { name: 'create_task' })).toBeInTheDocument())
    await user.selectOptions(actionTypeSelect(), 'create_task')
    await user.type(screen.getByPlaceholderText(T('workflow.actionParams.taskTitleExample')), 'Ship it')
    const after = await screen.findByRole('option', { name: 'Prepare the laptop' })
    // Both siblings are offered: neither waits for the new task, so no cycle is possible.
    expect(within(after.parentElement!).getByRole('option', { name: 'Create the account' })).toBeInTheDocument()
  })
})

describe('WorkflowStepPanel — metadata', () => {
  it('"open step" can be switched off on a non-terminal step and is saved', async () => {
    const { user, onSaved } = renderPanel(step())
    await user.click(screen.getByRole('tab', { name: T('pages.workflowStep.tabMetadata') }))
    const open = screen.getByRole('checkbox', { name: T('workflow.panel.isOpenStep') })
    expect(open).toBeChecked()
    await user.click(open)
    await user.click(saveButton())
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ isOpen: false }))
  })
})

describe('WorkflowStepPanel — notification on entry', () => {
  it('is saved as a notify_rule action with the chosen severity, channels and recipient', async () => {
    const { user, onSaved } = renderPanel(step())
    await user.click(screen.getByRole('tab', { name: T('pages.workflowStep.tabNotify') }))
    await user.click(screen.getByRole('switch', { name: T('pages.workflowStep.notifyOnEnter') }))
    await user.type(screen.getByPlaceholderText(T('workflow.panel.titleKeyPlaceholder')), '  notify.step.entered  ')
    const [severity, target] = screen.getAllByRole('combobox') as HTMLSelectElement[]
    await user.selectOptions(severity!, 'warning')
    await waitFor(() => expect(within(target!).getByRole('option', { name: /Service Desk/ })).toBeInTheDocument())
    await user.selectOptions(target!, 'role:service_desk')
    await user.click(screen.getByRole('checkbox', { name: 'In-App' }))
    await user.click(screen.getByRole('checkbox', { name: 'Email' }))
    await user.click(saveButton())

    const saved = JSON.parse((onSaved.mock.calls[0]![0] as { enterActions: string }).enterActions) as unknown[]
    expect(saved).toEqual([{
      type: 'notify_rule',
      params: { title_key: 'notify.step.entered', severity: 'warning', channels: ['email'], target: 'role:service_desk' },
    }])
  })

  // Review of 23 Sep 2026: this was saved WITHOUT the notification, silently. Now it cannot be saved at all.
  it('an enabled notification without a title key blocks the save instead of being dropped', async () => {
    const { user, onSaved } = renderPanel(step())
    await user.click(screen.getByRole('tab', { name: T('pages.workflowStep.tabNotify') }))
    await user.click(screen.getByRole('switch', { name: T('pages.workflowStep.notifyOnEnter') }))
    expect(saveButton()).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(T('workflow.panel.titleKeyRequired'))
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('a saved notification is loaded into the tab and survives an unrelated save', async () => {
    const nr = { type: 'notify_rule', params: { title_key: 'k', severity: 'error', channels: ['email'], target: 'all' } }
    const { user, onSaved } = renderPanel(step({ enterActions: JSON.stringify([nr]) }))
    // The notify_rule is not listed among the enter actions: it has its own tab.
    expect(screen.queryByTitle('notify_rule')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: T('pages.workflowStep.tabNotify') }))
    expect(screen.getByRole('switch', { name: T('pages.workflowStep.notifyOnEnter') })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByDisplayValue('k')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: T('pages.workflowStep.tabProps') }))
    await user.type(screen.getByDisplayValue('In progress'), '!')
    await user.click(saveButton())
    expect(JSON.parse((onSaved.mock.calls[0]![0] as { enterActions: string }).enterActions)).toEqual([nr])
  })
})

describe('WorkflowStepPanel — deleting a deletable step', () => {
  it('asks first: "no" keeps the step, "yes" deletes it by name', async () => {
    const onDelete = vi.fn()
    const { user } = renderPanel(step({ currentInstances: 0 }), { onDelete })
    const del = screen.getByRole('button', { name: T('pages.workflowStep.deleteStep') })

    await user.click(del)
    let dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: T('common.cancel') }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onDelete).not.toHaveBeenCalled()

    await user.click(del)
    dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('In progress')
    // A danger confirmation: its button says "Delete".
    await user.click(within(dialog).getByRole('button', { name: T('common.delete') }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('in_progress'))
  })
})
