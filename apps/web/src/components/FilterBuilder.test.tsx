/**
 * FilterBuilder: the "Advanced filters" panel of the list pages.
 *
 * What breaks for a user if these behaviours regress:
 *  - a half-written condition (no field, no value, a "between" with one end,
 *    a "one of" with nothing ticked) must NOT reach the server: it used to be
 *    serialised and refused, and the user could not tell which filter was wrong;
 *  - changing the field or the operator must clear the value, otherwise a date
 *    typed for "after" is sent as a text "contains", or an enum value survives
 *    on a field that does not have it;
 *  - each field type offers only the operators the server understands (a list
 *    field has no "equals", which the database always answers "no" to), and a
 *    field can restrict them further;
 *  - rules restored from the URL show up (panel open, count badge) without
 *    re-applying themselves;
 *  - Reset empties the panel AND tells the page (onApply(null)).
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FilterBuilder, type FieldConfig, type FilterRule } from './FilterBuilder'

const FIELDS: FieldConfig[] = [
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'created', label: 'Created', type: 'date' },
  { key: 'status', label: 'Status', type: 'enum', options: [{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }] },
  { key: 'tags', label: 'Tags', type: 'multi_enum', options: [{ value: 'vip', label: 'VIP' }, { value: 'eu', label: 'EU' }] },
  { key: 'owner', label: 'Owner', type: 'text', operators: ['equals', 'is_empty'] },
]

function setup(initialRules?: FilterRule[], fields: FieldConfig[] = FIELDS) {
  const onApply = vi.fn()
  const user = userEvent.setup()
  render(<FilterBuilder fields={fields} onApply={onApply} initialRules={initialRules} />)
  return { user, onApply }
}

/** Opens the panel and adds `n` empty conditions. */
async function openWith(user: ReturnType<typeof userEvent.setup>, n = 1) {
  await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
  for (let i = 0; i < n; i++) await user.click(screen.getByRole('button', { name: 'Add filter' }))
}

const operatorOptions = (n: number) =>
  within(screen.getByRole('combobox', { name: `Operator of condition ${n}` })).getAllByRole('option').map((o) => o.textContent)

/** The rules passed to the last onApply, without their random ids. */
function applied(onApply: ReturnType<typeof vi.fn>) {
  const group = onApply.mock.calls.at(-1)?.[0] as { rules: FilterRule[] } | null
  return group ? group.rules.map(({ id: _id, ...r }) => r) : null
}

describe('FilterBuilder — panel', () => {
  it('starts closed; opening shows the empty state and the actions', async () => {
    const { user } = setup()
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })

  it('rules from the URL: open, counted, shown — and not re-applied by the panel', () => {
    const { onApply } = setup([{ id: 'r1', field: 'title', operator: 'contains', value: 'disk', logic: 'AND' }])
    // The badge carries the number of conditions next to the title.
    expect(screen.getByRole('button', { name: /Advanced filters/ })).toHaveTextContent('Advanced filters1')
    expect(screen.getByRole('textbox', { name: 'Value of condition 1' })).toHaveValue('disk')
    expect(onApply).not.toHaveBeenCalled()
  })
})

describe('FilterBuilder — building and applying', () => {
  it('a text condition is applied with its value', async () => {
    const { user, onApply } = setup()
    await openWith(user)
    // No operator or value before a field is chosen.
    expect(screen.queryByRole('combobox', { name: 'Operator of condition 1' })).toBeNull()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), 'title')
    expect(operatorOptions(1)).toEqual(['Contains', 'Starts with', 'Ends with', 'Equals', 'Not equals', 'Is empty', 'Is not empty'])
    await user.type(screen.getByRole('textbox', { name: 'Value of condition 1' }), 'disk')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(applied(onApply)).toEqual([{ field: 'title', operator: 'contains', value: 'disk', value2: undefined, logic: 'AND' }])
  })

  it('incomplete conditions are dropped; with none left the page gets null', async () => {
    const { user, onApply } = setup()
    await openWith(user, 2)
    // Condition 1: no field at all. Condition 2: a field but no value.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 2' }), 'title')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onApply).toHaveBeenLastCalledWith(null)
  })

  it('an operator with no value ("is empty") applies without one and hides the input', async () => {
    const { user, onApply } = setup()
    await openWith(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), 'title')
    await user.type(screen.getByRole('textbox', { name: 'Value of condition 1' }), 'stale')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Operator of condition 1' }), 'is_empty')
    expect(screen.queryByRole('textbox', { name: 'Value of condition 1' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    // The value typed for the previous operator is gone, not sent along.
    expect(applied(onApply)).toEqual([{ field: 'title', operator: 'is_empty', value: null, value2: undefined, logic: 'AND' }])
  })

  it('changing the field resets operator and value to the new type', async () => {
    const { user, onApply } = setup()
    await openWith(user)
    const field = screen.getByRole('combobox', { name: 'Field of condition 1' })
    await user.selectOptions(field, 'title')
    await user.type(screen.getByRole('textbox', { name: 'Value of condition 1' }), 'x')
    await user.selectOptions(field, 'created')
    expect(screen.getByRole('combobox', { name: 'Operator of condition 1' })).toHaveValue('after')
    expect(operatorOptions(1)).toEqual(['After', 'Before', 'Between', 'Today', 'Last 7 days', 'Last 30 days'])
    const date = screen.getByLabelText('Value of condition 1')
    expect(date).toHaveAttribute('type', 'date')
    expect(date).toHaveValue('')
    // A date input is set, not typed: jsdom has no date picker to type into.
    fireEvent.change(date, { target: { value: '2026-09-01' } })
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(applied(onApply)).toEqual([{ field: 'created', operator: 'after', value: '2026-09-01', value2: undefined, logic: 'AND' }])

    // Back to "no field": the operator falls back to the text default and the value is cleared.
    await user.selectOptions(field, '')
    expect(screen.queryByRole('combobox', { name: 'Operator of condition 1' })).toBeNull()
  })

  it('"between" needs BOTH ends before it is applied', async () => {
    const { user, onApply } = setup()
    await openWith(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), 'created')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Operator of condition 1' }), 'between')
    fireEvent.change(screen.getByLabelText('Start of condition 1'), { target: { value: '2026-09-01' } })
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onApply).toHaveBeenLastCalledWith(null)
    fireEvent.change(screen.getByLabelText('End of condition 1'), { target: { value: '2026-09-30' } })
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(applied(onApply)).toEqual([{ field: 'created', operator: 'between', value: '2026-09-01', value2: '2026-09-30', logic: 'AND' }])
  })

  it('enum: a single value from a select, or several ticked with "is one of"', async () => {
    const { user, onApply } = setup()
    await openWith(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), 'status')
    expect(screen.getByRole('combobox', { name: 'Operator of condition 1' })).toHaveValue('equals')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Value of condition 1' }), 'closed')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(applied(onApply)?.[0]).toMatchObject({ operator: 'equals', value: 'closed' })

    await user.selectOptions(screen.getByRole('combobox', { name: 'Operator of condition 1' }), 'in')
    const group = screen.getByRole('group', { name: 'Value of condition 1' })
    // Nothing ticked: "is one of nothing" is not a filter.
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onApply).toHaveBeenLastCalledWith(null)
    await user.click(within(group).getByRole('checkbox', { name: 'Open' }))
    await user.click(within(group).getByRole('checkbox', { name: 'Closed' }))
    await user.click(within(group).getByRole('checkbox', { name: 'Open' }))
    expect(within(group).getByRole('checkbox', { name: 'Open' })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(applied(onApply)?.[0]).toMatchObject({ operator: 'in', value: ['closed'] })
  })

  it('a list field offers list operators only, and defaults to "has any of"', async () => {
    const { user, onApply } = setup()
    await openWith(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), 'tags')
    expect(operatorOptions(1)).toEqual(['has any of', 'has all of', 'has none of', 'Is empty', 'Is not empty'])
    await user.click(within(screen.getByRole('group', { name: 'Value of condition 1' })).getByRole('checkbox', { name: 'VIP' }))
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(applied(onApply)?.[0]).toMatchObject({ field: 'tags', operator: 'has_any', value: ['vip'] })
  })

  it('a field that restricts its operators offers only those', async () => {
    const { user } = setup()
    await openWith(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), 'owner')
    expect(operatorOptions(1)).toEqual(['Equals', 'Is empty'])
  })

  it('an enum field with no options still renders an empty choice, not a crash', async () => {
    const { user } = setup(undefined, [{ key: 'kind', label: 'Kind', type: 'enum' }])
    await openWith(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), 'kind')
    expect(within(screen.getByRole('combobox', { name: 'Value of condition 1' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['Select'])
    await user.selectOptions(screen.getByRole('combobox', { name: 'Operator of condition 1' }), 'in')
    expect(within(screen.getByRole('group', { name: 'Value of condition 1' })).queryAllByRole('checkbox')).toHaveLength(0)
  })
})

describe('FilterBuilder — connectors, removal, reset', () => {
  it('AND/OR sits between two conditions and is sent with the first one', async () => {
    const { user, onApply } = setup([
      { id: 'a', field: 'title', operator: 'contains', value: 'disk', logic: 'AND' },
      { id: 'b', field: 'title', operator: 'contains', value: 'cpu', logic: 'AND' },
    ])
    // One connector for two rules: nothing dangles after the last one.
    expect(screen.getAllByRole('button', { name: 'OR' })).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'OR' }))
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(applied(onApply)?.map((r) => r.logic)).toEqual(['OR', 'AND'])
  })

  it('removing a condition removes exactly that one', async () => {
    const { user, onApply } = setup([
      { id: 'a', field: 'title', operator: 'contains', value: 'disk', logic: 'AND' },
      { id: 'b', field: 'title', operator: 'contains', value: 'cpu', logic: 'AND' },
    ])
    const remove = screen.getByRole('button', { name: 'Remove condition 1' })
    await user.hover(remove)
    await user.unhover(remove)
    await user.click(remove)
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(applied(onApply)?.map((r) => r.value)).toEqual(['cpu'])
  })

  it('Reset empties the panel and tells the page there is no filter', async () => {
    const { user, onApply } = setup([{ id: 'a', field: 'title', operator: 'contains', value: 'disk', logic: 'AND' }])
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(onApply).toHaveBeenLastCalledWith(null)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByRole('button', { name: /Advanced filters/ })).toHaveTextContent(/^Advanced filters$/)
  })
})
