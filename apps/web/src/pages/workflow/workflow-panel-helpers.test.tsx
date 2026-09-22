/**
 * The workflow designer keeps every action's parameters as TEXT while the
 * admin edits them (`paramsToRaw`) and turns them back into typed values when
 * the step is saved (`buildActionParams`). A mistake in either direction is
 * silent: a boolean saved as the string "false", an approver list saved as
 * one long id, or an action re-saved with empty parameters after being opened
 * — and the workflow keeps running, wrongly, with nothing on screen to say so.
 *
 * `actionLabel` is what the admin reads on the step to know what an action
 * does without opening it: a label that drops the target or the URL host
 * makes two different actions look the same.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  actionLabel, paramsToRaw, buildActionParams, saveButtonStyle,
  PanelHeader, PanelField, ActionBadge, titoliCompitiOffribili,
} from './workflow-panel-helpers'

// A translator that returns the key: the label's STRUCTURE is what is under test.
const t = (k: string) => k

describe('actionLabel', () => {
  it('SLA actions name which clock they start or stop, and fall back to the bare verb', () => {
    expect(actionLabel(t, 'sla_start', { sla_type: 'response' })).toBe('workflow.actions.sla_start workflow.actions.sla_response')
    expect(actionLabel(t, 'sla_stop', { sla_type: 'resolve' })).toBe('workflow.actions.sla_stop workflow.actions.sla_resolve')
    expect(actionLabel(t, 'sla_stop', {})).toBe('workflow.actions.sla_stop')
  })

  it('create_entity shows the entity type only when there is one', () => {
    expect(actionLabel(t, 'create_entity', { entity_type: 'problem' })).toBe('workflow.actions.create_entity: problem')
    expect(actionLabel(t, 'create_entity')).toBe('workflow.actions.create_entity')
  })

  it('assign_to shows the target (id or name, cut to 8 characters) and tolerates a missing target type', () => {
    expect(actionLabel(t, 'assign_to', { target_type: 'team', target_id: 'team-1234567890' })).toBe('workflow.actions.assign_to → team team-123')
    expect(actionLabel(t, 'assign_to', { target_name: 'Ops' })).toBe('workflow.actions.assign_to →  Ops')
    expect(actionLabel(t, 'assign_to', {})).toBe('workflow.actions.assign_to')
  })

  it('update_field shows field=value, with «?» for a value not set yet', () => {
    expect(actionLabel(t, 'update_field', { field: 'priority', value: 'high' })).toBe('workflow.actions.update_field: priority=high')
    expect(actionLabel(t, 'update_field', { field: 'priority' })).toBe('workflow.actions.update_field: priority=?')
    expect(actionLabel(t, 'update_field', {})).toBe('workflow.actions.update_field')
  })

  it('call_webhook shows only the host; a URL that does not parse must not crash the designer', () => {
    expect(actionLabel(t, 'call_webhook', { url: 'https://hooks.example.com/x?y=1' })).toBe('workflow.actions.call_webhook: hooks.example.com')
    expect(actionLabel(t, 'call_webhook', { url: 'not a url' })).toBe('workflow.actions.call_webhook')
    expect(actionLabel(t, 'call_webhook', {})).toBe('workflow.actions.call_webhook')
  })

  it('any other action type is just its translated name', () => {
    expect(actionLabel(t, 'send_notification', { x: 1 })).toBe('workflow.actions.send_notification')
  })
})

describe('paramsToRaw', () => {
  it('no parameters at all → an empty editor, not a crash', () => {
    expect(paramsToRaw('create_entity')).toEqual({})
  })

  it('SLA defaults to the response clock', () => {
    expect(paramsToRaw('sla_start', {})).toEqual({ sla_type: 'response' })
    expect(paramsToRaw('sla_stop', { sla_type: 'resolve' })).toEqual({ sla_type: 'resolve' })
  })

  it('create_entity: defaults, and copy_fields as a comma list whether it arrives as array or string', () => {
    expect(paramsToRaw('create_entity', {})).toEqual({ entity_type: 'incident', title_template: '', link_to_current: 'true', copy_fields: '' })
    expect(paramsToRaw('create_entity', { entity_type: 'problem', title_template: 'T', link_to_current: false, copy_fields: ['a', 'b'] }))
      .toEqual({ entity_type: 'problem', title_template: 'T', link_to_current: 'false', copy_fields: 'a,b' })
    expect(paramsToRaw('create_entity', { copy_fields: 'a,b' }).copy_fields).toBe('a,b')
  })

  it('assign_to defaults to a team with no target', () => {
    expect(paramsToRaw('assign_to', {})).toEqual({ target_type: 'team', target_id: '', target_name: '' })
    expect(paramsToRaw('assign_to', { target_type: 'user', target_id: 'u1', target_name: 'Ann' })).toEqual({ target_type: 'user', target_id: 'u1', target_name: 'Ann' })
  })

  it('update_field and call_webhook fill their defaults (POST for a webhook)', () => {
    expect(paramsToRaw('update_field', {})).toEqual({ field: '', value: '' })
    expect(paramsToRaw('update_field', { field: 'f', value: 3 })).toEqual({ field: 'f', value: '3' })
    expect(paramsToRaw('call_webhook', {})).toEqual({ url: '', method: 'POST', payload_template: '' })
    expect(paramsToRaw('call_webhook', { url: 'u', method: 'PUT', payload_template: '{}' })).toEqual({ url: 'u', method: 'PUT', payload_template: '{}' })
  })

  it('create_approval_request: approvers from a JSON list or a string become one clean comma list', () => {
    expect(paramsToRaw('create_approval_request', {})).toEqual({
      title_template: '', approver_role: 'admin', approval_type: 'any', approver_user_ids: '', approver_team_ids: '',
    })
    expect(paramsToRaw('create_approval_request', {
      title_template: 'OK?', approver_role: 'cab', approval_type: 'all',
      approver_user_ids: [' u1 ', '', 'u2'], approver_team_ids: 't1, ,t2',
    })).toEqual({
      title_template: 'OK?', approver_role: 'cab', approval_type: 'all', approver_user_ids: 'u1,u2', approver_team_ids: 't1,t2',
    })
  })

  it('create_task: a missing due date stays empty (not "undefined"), zero days stays "0"', () => {
    expect(paramsToRaw('create_task', {})).toEqual({ title_template: '', team_id: '', description: '', due_in_days: '', after: '', team_from_field: '' })
    expect(paramsToRaw('create_task', { title_template: 'Do', team_id: 't', description: 'd', due_in_days: 0, after: 'A', team_from_field: 'owner' }))
      .toEqual({ title_template: 'Do', team_id: 't', description: 'd', due_in_days: '0', after: 'A', team_from_field: 'owner' })
  })

  it('an unknown action type keeps its parameters as text instead of opening empty', () => {
    expect(paramsToRaw('custom', { a: 1, b: null, c: 'x' })).toEqual({ a: '1', b: '', c: 'x' })
  })
})

describe('buildActionParams', () => {
  it('SLA defaults to the response clock', () => {
    expect(buildActionParams('sla_start', {})).toEqual({ sla_type: 'response' })
    expect(buildActionParams('sla_stop', { sla_type: 'resolve' })).toEqual({ sla_type: 'resolve' })
  })

  it('create_entity: link_to_current is a real boolean, copy_fields a list and only when present', () => {
    expect(buildActionParams('create_entity', {})).toEqual({ entity_type: 'incident', title_template: '', link_to_current: true })
    expect(buildActionParams('create_entity', { entity_type: 'problem', title_template: 'T', link_to_current: 'false', copy_fields: ' a , ,b ' }))
      .toEqual({ entity_type: 'problem', title_template: 'T', link_to_current: false, copy_fields: ['a', 'b'] })
  })

  it('assign_to writes target id/name only when they have a value', () => {
    expect(buildActionParams('assign_to', {})).toEqual({ target_type: 'team' })
    expect(buildActionParams('assign_to', { target_type: 'user', target_id: 'u1', target_name: 'Ann' })).toEqual({ target_type: 'user', target_id: 'u1', target_name: 'Ann' })
  })

  it('update_field and call_webhook fill their defaults', () => {
    expect(buildActionParams('update_field', {})).toEqual({ field: '', value: '' })
    expect(buildActionParams('call_webhook', {})).toEqual({ url: '', method: 'POST', payload_template: '' })
    expect(buildActionParams('call_webhook', { url: 'u', method: 'PUT', payload_template: 'p' })).toEqual({ url: 'u', method: 'PUT', payload_template: 'p' })
  })

  it('create_approval_request: approver lists are written only when not empty', () => {
    expect(buildActionParams('create_approval_request', {})).toEqual({ title_template: '', approver_role: 'admin', approval_type: 'any' })
    expect(buildActionParams('create_approval_request', { title_template: 'T', approver_role: 'cab', approval_type: 'all', approver_user_ids: 'u1, u2', approver_team_ids: 't1' }))
      .toEqual({ title_template: 'T', approver_role: 'cab', approval_type: 'all', approver_user_ids: ['u1', 'u2'], approver_team_ids: ['t1'] })
  })

  it('create_task: blanks are dropped, days become a number', () => {
    expect(buildActionParams('create_task', { team_id: '  ', description: '', due_in_days: ' ' })).toEqual({ title_template: '' })
    expect(buildActionParams('create_task', { title_template: 'Do', team_id: ' t ', description: ' d ', due_in_days: ' 3 ', after: ' A ', team_from_field: ' f ' }))
      .toEqual({ title_template: 'Do', team_id: 't', description: 'd', due_in_days: 3, after: 'A', team_from_field: 'f' })
  })

  it('an unknown action type keeps what was written in it', () => {
    expect(buildActionParams('custom', { a: '1' })).toEqual({ a: '1' })
  })
})

describe('titoliCompitiOffribili', () => {
  it('drops itself and everyone who already waits for it, directly or through a chain (no wait cycles)', () => {
    const tasks = [
      { titolo: 'A', dopo: '' },
      { titolo: 'B', dopo: 'A' },
      { titolo: 'C', dopo: 'B' },
      { titolo: 'D', dopo: '' },
      { titolo: '', dopo: 'A' },   // an untitled draft is never offered
    ]
    // B waits for A, C waits for B: offering them to A would close a circle.
    expect(titoliCompitiOffribili(tasks, 'A')).toEqual(['D'])
    expect(titoliCompitiOffribili(tasks, 'C')).toEqual(['A', 'B', 'D'])
  })
})

describe('panel pieces', () => {
  it('the save button looks disabled when it is', () => {
    expect(saveButtonStyle(true).cursor).toBe('not-allowed')
    expect(saveButtonStyle(false).cursor).toBe('pointer')
  })

  it('PanelHeader shows the title and its close button is named and works', async () => {
    const onClose = vi.fn()
    render(<PanelHeader title="Step" onClose={onClose} />)
    expect(screen.getByText('Step')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('PanelField labels its control', () => {
    render(<PanelField label="Name"><input /></PanelField>)
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('ActionBadge shows the readable label and keeps the raw type as tooltip', () => {
    render(<ActionBadge type="update_field" params={{ field: 'priority', value: 'high' }} />)
    const badge = screen.getByText('Update field: priority=high')
    expect(badge).toHaveAttribute('title', 'update_field')
  })
})
