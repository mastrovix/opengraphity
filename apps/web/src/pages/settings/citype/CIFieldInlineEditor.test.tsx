/**
 * The inline editor is where an admin adds or changes a field of a CI type.
 * What must not regress:
 * - the technical name becomes a Neo4j property, so a dangerous or duplicate
 *   name (A-12: `tenantId` would write the owning tenant) must be refused
 *   BEFORE saving, and an existing field's name must be locked;
 * - choosing a non-enum type must drop the dictionary reference, or a string
 *   field would be saved still pointing at a dictionary;
 * - the three scripts must each land in their own slot.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CIFieldInlineEditor, FormField } from './CIFieldInlineEditor'
import type { FieldForm } from './CIFieldEditor'

const ENUMS = [
  { id: 'e1', name: 'env', label: 'Environment', values: ['prod', 'test'], scope: 'base', isShipped: true },
  { id: 'e2', name: 'tier', label: 'Tier', values: ['gold'], scope: 'tenant', isShipped: false },
]

const existing: FieldForm = {
  name: 'costCenter', label: 'Cost center', fieldType: 'enum', required: true,
  defaultValue: '', enumTypeId: 'e1', validationScript: '', visibilityScript: '', defaultScript: '', order: 3,
}

function setup(props: Partial<React.ComponentProps<typeof CIFieldInlineEditor>> = {}) {
  const onSave = vi.fn()
  const onCancel = vi.fn()
  const user = userEvent.setup()
  render(
    <CIFieldInlineEditor initial={null} existingCount={4} isSystem={false} enumTypes={ENUMS}
      onSave={onSave} onCancel={onCancel} {...props} />,
  )
  return { user, onSave, onCancel }
}

describe('CIFieldInlineEditor — new field', () => {
  it('keeps only letters and digits in the technical name and saves the whole form', async () => {
    const { user, onSave } = setup()
    await user.type(screen.getByLabelText(/Technical name/), 'cost_center-1')
    await user.type(screen.getByLabelText('Label *'), 'Cost center')
    await user.clear(screen.getByLabelText('Order'))
    await user.type(screen.getByLabelText('Order'), '7')
    await user.click(screen.getByRole('checkbox', { name: 'Required' }))
    await user.type(screen.getByLabelText('Default value'), 'CC-01')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    // `cost_center` and `costCenter` would map to the same Neo4j property: underscores are stripped.
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      name: 'costcenter1', label: 'Cost center', order: 7, required: true, defaultValue: 'CC-01', fieldType: 'string',
    }))
  })

  it('starts the order after the existing fields', () => {
    setup({ existingCount: 4 })
    expect(screen.getByLabelText('Order')).toHaveValue(4)
  })

  it('refuses a reserved name before saving and says why', async () => {
    const { user, onSave } = setup()
    await user.type(screen.getByLabelText(/Technical name/), 'tenantId')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toBe('')
    expect(screen.getByLabelText(/Technical name/)).toHaveAttribute('aria-invalid', 'true')
    const save = screen.getByRole('button', { name: /Save/ })
    expect(save).toBeDisabled()
    await user.click(save)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('refuses a name the type already has', async () => {
    const { user } = setup({ existingFieldNames: ['owner'], typeLabel: 'Server' })
    await user.type(screen.getByLabelText(/Technical name/), 'owner')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled()
  })

  it('an enum field shows the dictionary values; switching back to string drops the reference', async () => {
    const { user, onSave } = setup()
    await user.type(screen.getByLabelText(/Technical name/), 'env')
    await user.selectOptions(screen.getByLabelText('Type'), 'enum')
    const dict = screen.getByLabelText('Reference dictionary *')
    await user.selectOptions(dict, 'e1')
    expect(screen.getByText('prod')).toBeInTheDocument()
    expect(screen.getByText('test')).toBeInTheDocument()
    // Clearing the choice goes back to null, not to an empty-string id.
    await user.selectOptions(dict, '')
    expect(screen.queryByText('prod')).not.toBeInTheDocument()
    await user.selectOptions(dict, 'e2')
    await user.selectOptions(screen.getByLabelText('Type'), 'string')
    expect(screen.queryByLabelText('Reference dictionary *')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ fieldType: 'string', enumTypeId: null }))
  })

  it('writes each script into its own slot', async () => {
    const { user, onSave } = setup()
    await user.type(screen.getByLabelText(/Technical name/), 'port')
    await user.click(screen.getByText(/Advanced scripts/))
    await user.type(screen.getByRole('textbox', { name: /Not a valid URL/ }), 'v1')
    await user.click(screen.getByRole('button', { name: 'visibilityScript' }))
    await user.type(screen.getByRole('textbox', { name: /Show only when/ }), 'v2')
    await user.click(screen.getByRole('button', { name: 'defaultScript' }))
    await user.type(screen.getByRole('textbox', { name: /PostgreSQL/ }), 'v3')
    await user.click(screen.getByRole('button', { name: 'validationScript' }))
    expect(screen.getByRole('textbox', { name: /Not a valid URL/ })).toHaveValue('v1')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ validationScript: 'v1', visibilityScript: 'v2', defaultScript: 'v3' }))
  })

  it('cancel does not save', async () => {
    const { user, onSave, onCancel } = setup()
    await user.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('CIFieldInlineEditor — existing field', () => {
  it('locks the technical name (renaming would orphan the stored property) and shows the chosen dictionary', () => {
    setup({ initial: existing })
    expect(screen.getByLabelText(/Technical name/)).toBeDisabled()
    expect(screen.getByLabelText(/Technical name/)).toHaveValue('costCenter')
    expect(screen.getByText('prod')).toBeInTheDocument()
    // No validation on a locked name: nothing to complain about.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a system field cannot change type or required flag', () => {
    setup({ initial: existing, isSystem: true })
    expect(screen.getByLabelText('Type')).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Required' })).toBeDisabled()
  })
})

describe('FormField', () => {
  it('with htmlFor it labels the single control', () => {
    render(<FormField label="Name" htmlFor="x"><input id="x" /></FormField>)
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
  })

  it('without htmlFor it renders a group heading around its children', () => {
    render(<FormField label="Options"><span>child</span></FormField>)
    expect(screen.getByText('Options')).toBeInTheDocument()
    expect(screen.getByText('child')).toBeInTheDocument()
  })
})
