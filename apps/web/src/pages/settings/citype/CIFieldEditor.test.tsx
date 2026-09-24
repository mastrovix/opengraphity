/**
 * The modal that adds or edits a BASE field of a CI type. What an admin types
 * here becomes a property on every CI of that type, so the regressions that
 * matter are the quiet ones:
 * - «Edit» opening an empty (or stale) form and then saving it as a new field
 *   (Revisione totale · G-4: the modal is always mounted);
 * - the technical name accepting characters the graph property cannot carry;
 * - an enum field keeping its dictionary after being turned into a string;
 * - the three scripts not reaching `onSave`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, act } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { CIFieldDef } from '@/contexts/MetamodelContext'
import { CIFieldEditor, emptyFieldForm, fieldToForm, type FieldForm } from './CIFieldEditor'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const ENUMS = [
  { id: 'e1', name: 'env', label: 'Environment', values: ['prod', 'test'], scope: 'ci', isShipped: false },
  { id: 'e2', name: 'tier', label: 'Tier', values: ['gold'], scope: 'ci', isShipped: true },
]

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetEnumTypes'] = { enumTypes: ENUMS }
})

function renderEditor(props: Partial<React.ComponentProps<typeof CIFieldEditor>> = {}) {
  const onSave = props.onSave ?? vi.fn(async () => {})
  const onClose = props.onClose ?? vi.fn()
  const view = renderWithProviders(
    <CIFieldEditor open onClose={onClose} onSave={onSave} initial={null} existingCount={4} {...props} />,
  )
  return { ...view, onSave, onClose }
}

const saved = (onSave: unknown) => (onSave as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as FieldForm

describe('fieldToForm / emptyFieldForm', () => {
  it('a field without optional parts becomes a form with empty strings and no dictionary, never undefined', () => {
    const f = { name: 'ip', label: 'IP', fieldType: 'string', required: true, order: 2 } as unknown as CIFieldDef
    expect(fieldToForm(f)).toEqual({ ...emptyFieldForm(), name: 'ip', label: 'IP', required: true, order: 2 })
  })

  it('keeps the default value and the dictionary of the field (G-3: not an empty string)', () => {
    const f = {
      name: 'env', label: 'Env', fieldType: 'enum', required: false, order: 1, defaultValue: 'prod', enumTypeId: 'e1',
      validationScript: 'v', visibilityScript: 'w', defaultScript: 'd',
    } as unknown as CIFieldDef
    expect(fieldToForm(f)).toMatchObject({ defaultValue: 'prod', enumTypeId: 'e1', validationScript: 'v', visibilityScript: 'w', defaultScript: 'd' })
  })
})

describe('CIFieldEditor', () => {
  it('new field: order starts after the existing fields, the slug is sanitised, and everything typed reaches onSave', async () => {
    const { user, onSave } = renderEditor()
    const dialog = screen.getByRole('dialog', { name: 'Add a field' })
    expect(within(dialog).getByLabelText('Order')).toHaveValue(4)

    await user.type(within(dialog).getByLabelText('Technical name (slug) *'), 'Disk Size-GB')
    // A graph property name: lower case, digits and underscores only.
    expect(within(dialog).getByLabelText('Technical name (slug) *')).toHaveValue('disk_size_gb')
    await user.type(within(dialog).getByLabelText('Label *'), 'Disk size')
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'number')
    await user.clear(within(dialog).getByLabelText('Order'))
    await user.type(within(dialog).getByLabelText('Order'), '7')
    await user.click(within(dialog).getByLabelText('Required'))
    await user.type(within(dialog).getByLabelText('Default value'), '100')

    // The three scripts live behind tabs; each keeps its own text.
    await user.type(within(dialog).getByRole('textbox', { name: /Not a valid URL/ }), 'check()')
    await user.click(within(dialog).getByRole('button', { name: 'visibilityScript' }))
    expect(within(dialog).queryByRole('textbox', { name: /Not a valid URL/ })).not.toBeInTheDocument()
    await user.type(within(dialog).getByRole('textbox', { name: /Show only when/ }), 'show()')
    await user.click(within(dialog).getByRole('button', { name: 'defaultScript' }))
    await user.type(within(dialog).getByRole('textbox', { name: /PostgreSQL/ }), 'def()')

    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(saved(onSave)).toEqual({
      name: 'disk_size_gb', label: 'Disk size', fieldType: 'number', required: true, defaultValue: '100',
      enumTypeId: null, validationScript: 'check()', visibilityScript: 'show()', defaultScript: 'def()', order: 7,
    })
  })

  it('Save is disabled and says «Saving...» while the save is in flight, then comes back', async () => {
    let finish!: () => void
    const onSave = vi.fn(() => new Promise<void>((r) => { finish = r }))
    const { user } = renderEditor({ onSave })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    // A double click must not create the field twice.
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()
    await act(async () => { finish() })
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('an enum field chooses its dictionary and shows its values; switching to another type drops the dictionary', async () => {
    const { user, onSave } = renderEditor()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByLabelText('Reference dictionary *')).not.toBeInTheDocument()
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'enum')
    const dict = within(dialog).getByLabelText('Reference dictionary *')
    expect(within(dict).getByRole('option', { name: 'Environment (ci) — Yours' })).toBeInTheDocument()
    await user.selectOptions(dict, 'e1')
    expect(within(dialog).getByText('prod')).toBeInTheDocument()
    expect(within(dialog).getByText('test')).toBeInTheDocument()

    // Back to «no dictionary»: the value becomes null, not "".
    await user.selectOptions(dict, '')
    expect(within(dialog).queryByText('prod')).not.toBeInTheDocument()
    await user.selectOptions(dict, 'e1')

    await user.selectOptions(within(dialog).getByLabelText('Type'), 'string')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    // A string field that still pointed at a dictionary would validate against it.
    expect(saved(onSave)).toMatchObject({ fieldType: 'string', enumTypeId: null })
  })

  it('edit: the form shows the chosen field with a locked name, and reopening on another field reloads it (G-4)', async () => {
    const first: FieldForm = { ...emptyFieldForm(), name: 'ip', label: 'IP address', order: 1 }
    const second: FieldForm = { ...emptyFieldForm(), name: 'env', label: 'Environment', fieldType: 'enum', enumTypeId: 'e2', order: 2 }
    const onSave = vi.fn(async () => {})
    const { user, rerender } = renderEditor({ initial: first, onSave })
    const dialog = screen.getByRole('dialog', { name: 'Edit field: ip' })
    expect(within(dialog).getByLabelText('Technical name (slug) *')).toBeDisabled()
    // The type of an existing field does not change (review of 23 Sep 2026).
    expect(within(dialog).getByLabelText('Type')).toBeDisabled()
    expect(within(dialog).getByLabelText('Label *')).toHaveValue('IP address')
    await user.type(within(dialog).getByLabelText('Label *'), ' (v4)')

    rerender(<CIFieldEditor open onClose={vi.fn()} onSave={onSave} initial={second} existingCount={4} />)
    const again = screen.getByRole('dialog', { name: 'Edit field: env' })
    // The text typed on the previous field must not leak into this one.
    expect(within(again).getByLabelText('Label *')).toHaveValue('Environment')
    expect(within(again).getByText('gold')).toBeInTheDocument()
    await user.click(within(again).getByRole('button', { name: 'Save' }))
    expect(saved(onSave)).toEqual(second)
  })

  it('Cancel closes without saving', async () => {
    const { user, onSave, onClose } = renderEditor()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('without dictionaries loaded yet the enum picker still opens, just empty', async () => {
    apolloFinto.risposte['GetEnumTypes'] = undefined
    const { user } = renderEditor()
    await user.selectOptions(screen.getByLabelText('Type'), 'enum')
    expect(within(screen.getByLabelText('Reference dictionary *')).getAllByRole('option')).toHaveLength(1)
  })
})
