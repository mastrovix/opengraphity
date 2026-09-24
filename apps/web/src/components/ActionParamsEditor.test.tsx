/**
 * THE PARAMETERS OF AN AUTOMATION OR WORKFLOW-STEP ACTION.
 *
 * Every action an administrator wires up (assign a team, set a field, open a
 * task, ask for an approval…) is configured here, and what this editor writes
 * is exactly what the engine later reads as `params`. If a control stops
 * offering the right choices, or writes the wrong key, the rule saves fine and
 * then does nothing — or the wrong thing — at runtime, with no error anywhere
 * near the person who configured it. These tests pin, per action type, which
 * choices are offered and which parameter each control writes.
 */
import { useState, type ReactElement } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const { ActionParamsEditor } = await import('./ActionParamsEditor')

// ── Fixtures ────────────────────────────────────────────────────────────────

const f = (name: string, fieldType: string, extra: Record<string, unknown> = {}) =>
  ({ name, label: `L-${name}`, fieldType, enumValues: [], enumTypeName: null, ...extra })

const ITIL_TYPES = [
  {
    name: 'incident',
    fields: [
      f('priority', 'enum', { enumValues: ['p1', 'p2'], enumTypeName: 'priority' }),
      f('severity', 'enum', { enumValues: ['minor', 'major'], enumTypeName: 'severity' }),
      f('category', 'enum', { enumValues: ['hw', 'sw'], enumTypeName: 'category' }),
      f('status', 'enum', { enumValues: ['new', 'closed'] }),
      f('notes', 'string'),
      f('due', 'date'),
      f('count', 'number'),
      f('urgent', 'boolean'),
    ],
  },
  // A type without `priority`: set_priority must fall back to `severity`.
  { name: 'problem', fields: [f('severity', 'enum', { enumValues: ['minor', 'major'], enumTypeName: 'severity' })] },
  { name: 'change', fields: [f('change_type', 'enum', { enumValues: ['normal'] }), f('risk_note', 'string')] },
]

const TEAMS = [{ id: 't1', name: 'Network' }, { id: 't2', name: 'Desk' }]
const USERS = [{ id: 'u1', name: 'Ann', email: 'ann@x.io' }, { id: 'u2', name: '', email: 'bob@x.io' }]

const WORKFLOWS = [
  { id: 'w1', name: 'Inc A', entityType: 'incident', steps: [{ name: 'new', label: 'New' }, { name: 'triage', label: '' }] },
  // Same step name in a second incident workflow: must appear once.
  { id: 'w2', name: 'Inc B', entityType: 'incident', steps: [{ name: 'new', label: 'New again' }] },
  { id: 'w3', name: 'Chg', entityType: 'change', steps: [{ name: 'cab', label: 'CAB' }] },
]

const vocabolari: DomainVocabularies = {
  valuesOf: () => null,
  labelOf: (name, v) => ({ priority: { p1: 'Critical' }, category: { hw: 'Hardware' } } as Record<string, Record<string, string>>)[name]?.[v] ?? null,
  colorOf: () => null,
  entriesOf: (name) => (name === 'change_type' ? [{ value: 'normal', label: 'Normal change', labels: [] }] : null),
  vocabularyLabelOf: () => null,
  loading: false,
  error: null,
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetTeams'] = { teams: TEAMS }
  // The people are searched on the server and named by id (review of 23 Sep 2026): never the whole directory.
  apolloFinto.risposte['SearchUsers'] = (v?: Record<string, unknown>) => ({
    searchUsers: USERS.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(String(v?.['search'] ?? '').toLowerCase())),
  })
  apolloFinto.risposte['UsersByIds'] = (v?: Record<string, unknown>) => ({
    usersByIds: USERS.filter((u) => (v?.['ids'] as string[]).includes(u.id)).map((u) => ({ ...u, active: true })),
  })
  apolloFinto.risposte['GetWorkflowList'] = { workflowDefinitions: WORKFLOWS }
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: ITIL_TYPES }
  apolloFinto.risposte['GetCITypes'] = { ciTypes: [] }
  apolloFinto.risposte['GetMe'] = { me: { id: 'me', role: 'admin', permissions: ['config.automation'] } }
  apolloFinto.risposte['GetRoles'] = { roles: [
    { key: 'cab', name: 'CAB board', permissions: [], isFactory: false, userCount: 1 },
    { key: 'budget_owner', name: 'Budget owner', permissions: [], isFactory: false, userCount: 1 },
  ] }
})

// ── Harness: a controlled editor, as the real panels use it ───────────────────

type Props = { actionType: string; params?: Record<string, string>; entityType?: string; vocabulary?: 'automation' | 'workflow_step'; siblings?: string[] }

function mount({ actionType, params = {}, entityType = 'incident', vocabulary, siblings }: Props) {
  const writes: [string, string][] = []
  const current: { params: Record<string, string> } = { params }
  function Harness(): ReactElement {
    const [p, setP] = useState(params)
    current.params = p
    return (
      <ActionParamsEditor
        actionType={actionType}
        params={p}
        entityType={entityType}
        vocabulary={vocabulary}
        compitiFratelli={siblings}
        onChange={(k, v) => { writes.push([k, v]); setP((prev) => ({ ...prev, [k]: v })) }}
      />
    )
  }
  const r = renderWithProviders(
    <DomainVocabularyContext.Provider value={vocabolari}><Harness /></DomainVocabularyContext.Provider>,
  )
  return { ...r, writes, current }
}

/** The control under a `Labeled` caption (the caption is a sibling span). */
/** Picks a person in a UserIdPicker: search, then the option. */
async function pickPerson(user: { click: (e: Element) => Promise<void>; type: (e: Element, t: string) => Promise<void> }, label: string, search: string, option: RegExp) {
  const box = screen.getByRole('combobox', { name: label })
  await user.click(box)
  await user.type(box, search)
  await user.click(await screen.findByRole('option', { name: option }))
}

const control = (caption: string) =>
  screen.getByText(caption, { selector: 'span' }).parentElement!.querySelector('select, input, textarea') as HTMLElement

const optionTexts = (el: HTMLElement) => within(el).getAllByRole('option').map((o) => o.textContent)
const optionValues = (el: HTMLElement) => within(el).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)

// ── Automation vocabulary ─────────────────────────────────────────────────────

describe('assignment actions', () => {
  it('assign_team offers the teams and writes team_id', async () => {
    const { user, writes } = mount({ actionType: 'assign_team' })
    const sel = screen.getByRole('combobox')
    expect(optionTexts(sel)).toEqual(['-- Pick a team --', 'Network', 'Desk'])
    await user.selectOptions(sel, 't2')
    expect(writes).toEqual([['team_id', 't2']])
  })

  it('assign_user searches the people who can be given tickets, and writes user_id', async () => {
    const { user, writes } = mount({ actionType: 'assign_user' })
    await pickPerson(user, 'Person', 'ann', /Ann/)
    expect(apolloFinto.chiamata('SearchUsers')).toMatchObject({ permission: 'ticket.assignable' })
    expect(writes).toEqual([['user_id', 'u1']])
    // Review of 23 Sep 2026: the directory is never downloaded.
    expect(apolloFinto.chiamata('GetUsers')).toBeUndefined()
  })

  it('a saved person is named by id', async () => {
    mount({ actionType: 'assign_user', params: { user_id: 'u1' } })
    expect(apolloFinto.chiamata('UsersByIds')).toEqual({ ids: ['u1'] })
    expect(await screen.findByRole('combobox', { name: 'Person' })).toHaveValue('Ann')
  })
})

describe('transition_workflow', () => {
  it('offers only the steps of workflows for this entity type, each name once', async () => {
    const { user, writes } = mount({ actionType: 'transition_workflow' })
    const sel = screen.getByRole('combobox')
    // `cab` belongs to a change workflow; `new` appears in two incident workflows.
    expect(optionValues(sel)).toEqual(['', 'new', 'triage'])
    // A step without a label is shown by its name, not as an empty option.
    expect(optionTexts(sel)).toContain('triage')
    await user.selectOptions(sel, 'triage')
    expect(writes).toEqual([['to_step', 'triage']])
  })
})

describe('set_priority', () => {
  it('uses the priority vocabulary with the Dictionary label, falling back to a capitalised value', async () => {
    const { user, writes } = mount({ actionType: 'set_priority' })
    const sel = screen.getByRole('combobox')
    expect(optionTexts(sel)).toEqual(['-- Pick a priority --', 'Critical', 'P2'])
    await user.selectOptions(sel, 'p1')
    expect(writes).toEqual([['priority', 'p1']])
  })

  it('a type without priority offers its severity values instead', () => {
    mount({ actionType: 'set_priority', entityType: 'problem' })
    expect(optionValues(screen.getByRole('combobox'))).toEqual(['', 'minor', 'major'])
  })

  it('with no entity type it reads the incident vocabulary rather than offering nothing', () => {
    mount({ actionType: 'set_priority', entityType: '' })
    expect(optionValues(screen.getByRole('combobox'))).toEqual(['', 'p1', 'p2'])
  })
})

describe('set_field: the value control follows the type of the chosen field', () => {
  it('before a field is chosen the value box is disabled', () => {
    mount({ actionType: 'set_field' })
    expect(screen.getByPlaceholderText('Pick a field')).toBeDisabled()
  })

  it('choosing a field clears the previous value (a value of another field would be nonsense)', async () => {
    const { user, writes, current } = mount({ actionType: 'set_field', params: { field: 'notes', value: 'old' } })
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'category')
    expect(writes).toEqual([['field', 'category'], ['value', '']])
    expect(current.params).toEqual({ field: 'category', value: '' })
  })

  it('offers the relation fields too (assignee and team), with the metamodel ones', () => {
    mount({ actionType: 'set_field' })
    const values = optionValues(screen.getAllByRole('combobox')[0]!)
    expect(values).toEqual(expect.arrayContaining(['priority', 'notes', 'assigned_to', 'assigned_team']))
  })

  it('an enum field offers its values with Dictionary labels', async () => {
    const { user, writes } = mount({ actionType: 'set_field', params: { field: 'category' } })
    const val = screen.getAllByRole('combobox')[1]!
    expect(optionTexts(val)).toEqual(['-- Value --', 'Hardware', 'sw'])
    await user.selectOptions(val, 'hw')
    expect(writes).toEqual([['value', 'hw']])
  })

  it('an enum field without a vocabulary name shows the raw values', () => {
    mount({ actionType: 'set_field', params: { field: 'status' } })
    expect(optionTexts(screen.getAllByRole('combobox')[1]!)).toEqual(['-- Value --', 'new', 'closed'])
  })

  it('a user field offers people, searched among those who can be given tickets', async () => {
    const { user, writes } = mount({ actionType: 'set_field', params: { field: 'assigned_to' } })
    await pickPerson(user, 'Person', 'ann', /Ann/)
    expect(writes).toEqual([['value', 'u1']])
  })

  it('a team field offers teams', async () => {
    const { user, writes } = mount({ actionType: 'set_field', params: { field: 'assigned_team' } })
    const val = screen.getAllByRole('combobox')[1]!
    expect(optionTexts(val)).toEqual(['-- Team --', 'Network', 'Desk'])
    await user.selectOptions(val, 't1')
    expect(writes).toEqual([['value', 't1']])
  })

  it('a boolean field offers yes/no as the strings the engine compares', async () => {
    const { user, writes } = mount({ actionType: 'set_field', params: { field: 'urgent' } })
    const val = screen.getAllByRole('combobox')[1]!
    expect(optionValues(val)).toEqual(['', 'true', 'false'])
    await user.selectOptions(val, 'false')
    expect(writes).toEqual([['value', 'false']])
  })

  it('date and number fields get the matching input type', async () => {
    const { container, unmount } = mount({ actionType: 'set_field', params: { field: 'due' } })
    expect(container.querySelector('input[type="date"]')).not.toBeNull()
    unmount()
    const { user, writes } = mount({ actionType: 'set_field', params: { field: 'count' } })
    const num = screen.getByPlaceholderText('Value')
    expect(num).toHaveAttribute('type', 'number')
    await user.type(num, '7')
    expect(writes).toEqual([['value', '7']])
  })

  it('a text field is a free input', async () => {
    const { user, writes } = mount({ actionType: 'set_field', params: { field: 'notes' } })
    await user.type(screen.getByPlaceholderText('Value'), 'x')
    expect(writes).toEqual([['value', 'x']])
  })
})

describe('create_notification: who receives it and where (AU-2)', () => {
  it('defaults to everyone, in-app, and offers the tenant roles as targets', async () => {
    const { user, writes } = mount({ actionType: 'create_notification' })
    const target = screen.getByRole('combobox', { name: 'Who receives it' })
    expect(target).toHaveValue('all')
    expect(optionTexts(target)).toContain('Role: CAB board')
    expect(screen.getByRole('combobox', { name: 'Where it arrives' })).toHaveValue('in_app')
    await user.selectOptions(target, 'assignee')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Where it arrives' }), 'email')
    await user.type(screen.getByRole('textbox', { name: 'Notification message...' }), 'H')
    expect(writes).toEqual([['target', 'assignee'], ['channel', 'email'], ['message', 'H']])
  })

  it('a saved target that is not among the options stays visible instead of silently becoming «everyone»', () => {
    mount({ actionType: 'create_notification', params: { target: 'custom_target' } })
    const target = screen.getByRole('combobox', { name: 'Who receives it' })
    expect(target).toHaveValue('custom_target')
  })
})

describe('free-text actions', () => {
  it('create_comment writes `text`', async () => {
    const { user, writes } = mount({ actionType: 'create_comment' })
    await user.type(screen.getByRole('textbox'), 'a')
    expect(writes).toEqual([['text', 'a']])
  })

  it('execute_script writes `code`', async () => {
    const { user, writes } = mount({ actionType: 'execute_script' })
    await user.type(screen.getByRole('textbox'), 'b')
    expect(writes).toEqual([['code', 'b']])
  })

  it('an unknown action type still gets a generic `value` input rather than nothing', async () => {
    const { user, writes } = mount({ actionType: 'something_new' })
    await user.type(screen.getByPlaceholderText('Parameters...'), 'c')
    expect(writes).toEqual([['value', 'c']])
  })

  it('set_sla writes the two minute targets', async () => {
    const { user, writes } = mount({ actionType: 'set_sla' })
    await user.type(screen.getByPlaceholderText('Response (min)'), '5')
    await user.type(screen.getByPlaceholderText('Resolution (min)'), '9')
    expect(writes).toEqual([['response_minutes', '5'], ['resolve_minutes', '9']])
  })
})

describe('call_webhook', () => {
  it('defaults to POST and writes method and url; no payload template for automations', async () => {
    const { user, writes } = mount({ actionType: 'call_webhook' })
    const method = screen.getByRole('combobox')
    expect(method).toHaveValue('POST')
    await user.selectOptions(method, 'PUT')
    await user.type(screen.getByPlaceholderText('https://...'), 'h')
    expect(writes).toEqual([['method', 'PUT'], ['url', 'h']])
    expect(screen.queryByText('payload_template (JSON)')).not.toBeInTheDocument()
  })

  it('a workflow step can also set a payload template (the step engine reads it)', async () => {
    const { user, writes } = mount({ actionType: 'call_webhook', vocabulary: 'workflow_step' })
    await user.type(control('payload_template (JSON)'), 'p')
    expect(writes).toEqual([['payload_template', 'p']])
  })
})

// ── Workflow-step vocabulary ─────────────────────────────────────────────────

describe('sla_start / sla_stop', () => {
  it('default to the response SLA and write sla_type', async () => {
    const { user, writes } = mount({ actionType: 'sla_stop', vocabulary: 'workflow_step' })
    const sel = control('sla_type')
    expect(sel).toHaveValue('response')
    await user.selectOptions(sel, 'resolve')
    expect(writes).toEqual([['sla_type', 'resolve']])
  })
})

describe('create_entity', () => {
  it('asks for a change type only when the new entity is a change, from the tenant vocabulary', async () => {
    const { user, writes } = mount({ actionType: 'create_entity', vocabulary: 'workflow_step' })
    expect(screen.queryByText('change_type')).not.toBeInTheDocument()
    await user.selectOptions(control('entity_type'), 'change')
    const type = control('change_type')
    expect(optionTexts(type)).toEqual(['— Change type —', 'Normal change'])
    await user.selectOptions(type, 'normal')
    await user.type(control('title_template'), 'T')
    await user.selectOptions(control('link_to_current'), 'false')
    await user.type(control('copy_fields (comma-sep)'), 's')
    expect(writes).toEqual([['entity_type', 'change'], ['change_type', 'normal'], ['title_template', 'T'], ['link_to_current', 'false'], ['copy_fields', 's']])
  })
})

describe('assign_to', () => {
  it('lists teams by default and people once the target type is user', async () => {
    const { user, writes } = mount({ actionType: 'assign_to', vocabulary: 'workflow_step' })
    expect(optionTexts(control('target_id'))).toEqual(['-- Team --', 'Network', 'Desk'])
    await user.selectOptions(control('target_type'), 'user')
    await pickPerson(user, 'Person', 'ann', /Ann/)
    await user.type(control('target_name (template)'), 'n')
    expect(writes).toEqual([['target_type', 'user'], ['target_id', 'u1'], ['target_name', 'n']])
  })
})

describe('update_field (B-9: a step never writes the engine-owned fields)', () => {
  it('offers the writable fields only: not status, not the user/team relations', () => {
    mount({ actionType: 'update_field', vocabulary: 'workflow_step' })
    const values = optionValues(control('field'))
    expect(values).toContain('notes')
    expect(values).not.toContain('status')
    expect(values).not.toContain('assigned_to')
    expect(values).not.toContain('assigned_team')
  })

  it('on a change the derived fields are not offered either', () => {
    mount({ actionType: 'update_field', vocabulary: 'workflow_step', entityType: 'change' })
    expect(optionValues(control('field'))).toEqual(['', 'risk_note'])
  })

  it('a saved field that is no longer allowed stays visible and says so', () => {
    mount({ actionType: 'update_field', vocabulary: 'workflow_step', params: { field: 'status' } })
    const sel = control('field')
    expect(sel).toHaveValue('status')
    expect(optionTexts(sel)).toContain('status (not allowed)')
  })

  it('an enum field chooses among its values; changing field clears the value', async () => {
    const { user, writes } = mount({ actionType: 'update_field', vocabulary: 'workflow_step', params: { field: 'category' } })
    const val = control('value')
    expect(optionTexts(val)).toEqual(['-- Value --', 'Hardware', 'sw'])
    await user.selectOptions(val, 'sw')
    await user.selectOptions(control('field'), 'notes')
    expect(writes).toEqual([['value', 'sw'], ['field', 'notes'], ['value', '']])
    // A non-enum field accepts free text (and placeholders such as {title}).
    expect(control('value').tagName).toBe('INPUT')
  })

  it('an enum field without a vocabulary name shows the raw values', () => {
    // `status` is reserved, so use a type where a nameless enum is writable.
    apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ name: 'incident', fields: [f('kind', 'enum', { enumValues: ['a'] })] }] }
    mount({ actionType: 'update_field', vocabulary: 'workflow_step', params: { field: 'kind' } })
    expect(optionTexts(control('value'))).toEqual(['-- Value --', 'a'])
  })
})

describe('create_task', () => {
  it('writes title, team, due days and description; no «from field» or «after» without the data for them', async () => {
    const { user, writes } = mount({ actionType: 'create_task', vocabulary: 'workflow_step' })
    await user.type(control('title_template'), 'T')
    await user.selectOptions(control('team_id'), 't1')
    await user.type(control('due_in_days'), '2')
    await user.type(control('description'), 'd')
    expect(writes).toEqual([['title_template', 'T'], ['team_id', 't1'], ['due_in_days', '2'], ['description', 'd']])
    expect(control('due_in_days')).toHaveAttribute('type', 'number')
    expect(screen.queryByText('or the team from the field')).not.toBeInTheDocument()
    expect(screen.queryByText('starts when this is closed')).not.toBeInTheDocument()
  })

  it('the form reference fields are asked for only by create_task (one query less on every other panel)', () => {
    mount({ actionType: 'assign_team' })
    expect(apolloFinto.chiamate['GetFormReferenceFields']).toBeUndefined()
    mount({ actionType: 'create_task', vocabulary: 'workflow_step' })
    expect(apolloFinto.chiamate['GetFormReferenceFields']).toHaveLength(1)
  })

  it('offers team and CI form fields as the team source, and warns that the field wins over a fixed team', async () => {
    apolloFinto.risposte['GetFormReferenceFields'] = { formReferenceFields: [
      { name: 'site_team', label: 'Site team', fieldType: 'ref_team' },
      { name: 'the_ci', label: '', fieldType: 'ref_ci' },
      { name: 'requester', label: 'Requester', fieldType: 'ref_user' },
    ] }
    const { user } = mount({ actionType: 'create_task', vocabulary: 'workflow_step', params: { team_id: 't1' } })
    const from = control('or the team from the field')
    // A user field cannot give a team; a CI field without label shows its name.
    expect(optionTexts(from)).toEqual(['no field: the team chosen here applies', 'Site team', 'the_ci'])
    expect(screen.queryByText(/the FIELD wins/)).not.toBeInTheDocument()
    await user.selectOptions(from, 'site_team')
    expect(screen.getByText(/the FIELD wins/)).toBeInTheDocument()
  })

  it('with sibling tasks it offers «starts when this is closed»', async () => {
    const { user, writes } = mount({ actionType: 'create_task', vocabulary: 'workflow_step', siblings: ['Prepare', 'Install'] })
    const after = control('starts when this is closed')
    expect(optionTexts(after)).toEqual(['right away, in parallel', 'Prepare', 'Install'])
    await user.selectOptions(after, 'Install')
    expect(writes).toEqual([['after', 'Install']])
  })
})

describe('create_approval_request', () => {
  it('offers the tenant roles (F-16), defaulting to the first, and the three approval types', async () => {
    const { user, writes } = mount({ actionType: 'create_approval_request', vocabulary: 'workflow_step' })
    const role = control('approver_role')
    expect(optionTexts(role)).toEqual(['CAB board', 'Budget owner'])
    expect(role).toHaveValue('cab')
    await user.selectOptions(role, 'budget_owner')
    await user.selectOptions(control('approval_type'), 'majority')
    await user.type(control('title_template'), 'x')
    expect(writes).toEqual([['approver_role', 'budget_owner'], ['approval_type', 'majority'], ['title_template', 'x']])
  })

  it('people are added to a comma-separated list, once each, shown by name and removable', async () => {
    const { user, current } = mount({ actionType: 'create_approval_request', vocabulary: 'workflow_step' })
    expect(screen.queryByText(/role above is ignored/)).not.toBeInTheDocument()
    await pickPerson(user, 'Add a person…', 'ann', /Ann/)
    expect(apolloFinto.chiamata('SearchUsers')).toMatchObject({ permission: 'approval.decide' })
    await pickPerson(user, 'Add a person…', 'bob', /bob@x\.io/)
    await pickPerson(user, 'Add a person…', 'ann', /Ann/)
    expect(current.params['approver_user_ids']).toBe('u1,u2')
    // The chosen are named by id.
    expect(await screen.findByRole('button', { name: 'Ann ×' })).toBeInTheDocument()
    expect(screen.getByText(/role above is ignored/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Ann ×' }))
    expect(current.params['approver_user_ids']).toBe('u2')
  })

  it('teams work the same way; an id no longer known is still shown (by id) and removable', async () => {
    const { user, current } = mount({ actionType: 'create_approval_request', vocabulary: 'workflow_step', params: { approver_team_ids: 'gone' } })
    expect(screen.getByRole('button', { name: 'gone ×' })).toBeInTheDocument()
    const teams = control('approver_team_ids')
    await user.selectOptions(teams, 't2')
    await user.selectOptions(teams, 't2')
    expect(current.params['approver_team_ids']).toBe('gone,t2')
    expect(screen.getByRole('button', { name: 'Desk ×' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'gone ×' }))
    expect(current.params['approver_team_ids']).toBe('t2')
  })

  it('an unknown saved person id is shown by id', () => {
    mount({ actionType: 'create_approval_request', vocabulary: 'workflow_step', params: { approver_user_ids: 'u9' } })
    expect(screen.getByRole('button', { name: 'u9 ×' })).toBeInTheDocument()
  })

  it('without roles loaded the role choice is empty rather than a made-up role', () => {
    apolloFinto.risposte['GetRoles'] = { roles: [] }
    mount({ actionType: 'create_approval_request', vocabulary: 'workflow_step' })
    expect(within(control('approver_role')).queryAllByRole('option')).toHaveLength(0)
  })
})

describe('while the reference data is still loading', () => {
  it('every list is simply empty (no crash on undefined data)', () => {
    apolloFinto.risposte = {}
    mount({ actionType: 'create_approval_request', vocabulary: 'workflow_step', params: { approver_user_ids: 'u1', approver_team_ids: 't1' } })
    expect(screen.getByRole('button', { name: 'u1 ×' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 't1 ×' })).toBeInTheDocument()
  })

  it('assign lists and steps are empty too', () => {
    apolloFinto.risposte = {}
    mount({ actionType: 'transition_workflow' })
    expect(optionValues(screen.getByRole('combobox'))).toEqual([''])
  })
})
