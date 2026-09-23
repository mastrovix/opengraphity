/**
 * THE PARAMETERS OF AN ACTION — the cases `ActionParamsEditor.test.tsx` leaves
 * out.
 *
 * What an administrator configures here is what the engine reads at runtime,
 * so each gap is a rule that saves fine and then does nothing: a date that is
 * never written, a starting SLA that does not default to «response», the
 * catalog form fields of a service request missing from «set field» (or
 * offered twice), a tenant without change types being offered a made-up one,
 * or a placeholder option that adds an empty approver.
 */
import { useState, type ReactElement } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
// A channel the platform added before the web learnt its label.
vi.mock('@opengraphity/types', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opengraphity/types')>()),
  AUTOMATION_NOTIFICATION_CHANNELS: ['in_app', 'email', 'pager'],
}))

const { ActionParamsEditor } = await import('./ActionParamsEditor')

const f = (name: string, fieldType: string, extra: Record<string, unknown> = {}) =>
  ({ name, label: `L-${name}`, fieldType, enumValues: [], enumTypeName: null, ...extra })

const TEAMS = [{ id: 't1', name: 'Network' }, { id: 't2', name: 'Desk' }]
const USERS = [{ id: 'u1', name: 'Ann', email: 'ann@x.io' }]

const noVocabularies: DomainVocabularies = {
  valuesOf: () => null, labelOf: () => null, colorOf: () => null, entriesOf: () => null,
  vocabularyLabelOf: () => null, loading: false, error: null,
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetTeams'] = { teams: TEAMS }
  apolloFinto.risposte['GetUsers'] = { users: USERS }
  apolloFinto.risposte['GetWorkflowList'] = { workflowDefinitions: [] }
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [
    { name: 'incident', fields: [f('due', 'date'), f('notes', 'string')] },
    { name: 'service_request', fields: [f('cost_center', 'string', { label: 'Cost centre (metamodel)' })] },
  ] }
  apolloFinto.risposte['GetMe'] = { me: { id: 'me', role: 'admin', permissions: ['config.automation'] } }
  apolloFinto.risposte['GetRoles'] = { roles: [{ key: 'cab', name: 'CAB board', permissions: [], isFactory: false, userCount: 1 }] }
})

function mount(actionType: string, { params = {}, entityType = 'incident', vocabulary }: { params?: Record<string, string>; entityType?: string; vocabulary?: 'automation' | 'workflow_step' } = {}) {
  const writes: [string, string][] = []
  function Harness(): ReactElement {
    const [p, setP] = useState(params)
    return (
      <ActionParamsEditor
        actionType={actionType} params={p} entityType={entityType} vocabulary={vocabulary}
        onChange={(k, v) => { writes.push([k, v]); setP((prev) => ({ ...prev, [k]: v })) }}
      />
    )
  }
  const r = renderWithProviders(<DomainVocabularyContext.Provider value={noVocabularies}><Harness /></DomainVocabularyContext.Provider>)
  return { ...r, writes }
}

/** The control under a `Labeled` caption (the caption is a sibling span). */
const control = (caption: string) =>
  screen.getByText(caption, { selector: 'span' }).parentElement!.querySelector('select, input, textarea') as HTMLElement
const optionTexts = (el: HTMLElement) => within(el).getAllByRole('option').map((o) => o.textContent)
const optionValues = (el: HTMLElement) => within(el).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)

describe('ActionParamsEditor (more)', () => {
  it('sla_start defaults to the response SLA and writes sla_type, like sla_stop', async () => {
    const { user, writes } = mount('sla_start', { vocabulary: 'workflow_step' })
    const sel = control('sla_type')
    expect(sel).toHaveValue('response')
    expect(optionValues(sel)).toEqual(['response', 'resolve'])
    await user.selectOptions(sel, 'resolve')
    expect(writes).toEqual([['sla_type', 'resolve']])
  })

  it('set_field on a date field writes the chosen day', () => {
    const { container, writes } = mount('set_field', { params: { field: 'due' } })
    const date = container.querySelector('input[type="date"]') as HTMLInputElement
    fireEvent.change(date, { target: { value: '2026-10-01' } })
    expect(writes).toEqual([['value', '2026-10-01']])
    expect(date).toHaveValue('2026-10-01')
  })

  it('set_field on a service request also offers the catalog form fields an automation may write, once each', () => {
    apolloFinto.risposte['EntityFilterFields'] = { entityFilterFields: [
      // Same name as a metamodel field: the metamodel one is what the ticket really writes.
      { name: 'cost_center', kind: 'SCALAR', scalarName: 'String', enumValues: null, label: 'Cost centre (form)', choices: [], formFieldType: 'text', vocabulary: null, settableByAutomation: true },
      { name: 'laptop_model', kind: 'SCALAR', scalarName: 'String', enumValues: null, label: 'Laptop model', choices: [], formFieldType: 'text', vocabulary: null, settableByAutomation: true },
      // Computed by a formula: the server refuses to write it, so it is not offered.
      { name: 'total_cost', kind: 'SCALAR', scalarName: 'Float', enumValues: null, label: 'Total cost', choices: [], formFieldType: 'number', vocabulary: null, settableByAutomation: false },
    ] }
    mount('set_field', { entityType: 'service_request' })
    const field = screen.getAllByRole('combobox')[0]!
    const values = optionValues(field)
    expect(values.filter((v) => v === 'cost_center')).toHaveLength(1)
    expect(values).toContain('laptop_model')
    expect(values).not.toContain('total_cost')
    expect(optionTexts(field)).toContain('Cost centre (metamodel) (text)')
    expect(optionTexts(field)).not.toContain('Cost centre (form) (text)')
    expect(apolloFinto.chiamata('EntityFilterFields')).toEqual({ typeName: 'ServiceRequest' })
  })

  it('create_entity for a change, on a tenant without change types, offers only the prompt (no made-up type)', async () => {
    const { user } = mount('create_entity', { vocabulary: 'workflow_step' })
    await user.selectOptions(control('entity_type'), 'change')
    expect(optionValues(control('change_type'))).toEqual([''])
  })

  it('transition_workflow skips a definition that has no steps and keeps the others', () => {
    apolloFinto.risposte['GetWorkflowList'] = { workflowDefinitions: [
      { id: 'w0', name: 'Draft', entityType: 'incident', steps: null },
      { id: 'w1', name: 'Main', entityType: 'incident', steps: [{ name: 'triage', label: 'Triage' }] },
    ] }
    mount('transition_workflow')
    expect(optionTexts(screen.getByRole('combobox'))).toEqual(['-- Pick a step --', 'Triage'])
  })

  it('create_notification offers a channel without a known label by its name instead of a blank option', () => {
    mount('create_notification')
    const channel = screen.getByRole('combobox', { name: 'Where it arrives' })
    expect(optionValues(channel)).toEqual(['in_app', 'email', 'pager'])
    expect(optionTexts(channel)[2]).toBe('pager')
  })

  describe('create_approval_request', () => {
    it('picking the «add» prompt again adds nobody', () => {
      const { writes } = mount('create_approval_request', { vocabulary: 'workflow_step' })
      fireEvent.change(control('approver_user_ids'), { target: { value: '' } })
      fireEvent.change(control('approver_team_ids'), { target: { value: '' } })
      expect(writes).toEqual([])
      expect(screen.queryByText(/role above is ignored/)).not.toBeInTheDocument()
    })

    it('the first approving team starts the list', async () => {
      const { user, writes } = mount('create_approval_request', { vocabulary: 'workflow_step' })
      await user.selectOptions(control('approver_team_ids'), 't1')
      expect(writes).toEqual([['approver_team_ids', 't1']])
      expect(screen.getByRole('button', { name: 'Network ×' })).toBeInTheDocument()
      expect(screen.getByText(/role above is ignored/)).toBeInTheDocument()
    })
  })
})
