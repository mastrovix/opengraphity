/**
 * THE SETTINGS OF AN ITIL TYPE: label, icon, colour and validation script.
 *
 * The label is how every agent reads the type (a customer may call incidents
 * «Disruptions»), and the script runs on every save of a ticket of the type.
 * The page owns the form and saves it; this panel edits it. If the panel
 * regresses, an edit lands in the wrong field, an edit that arrives when the
 * page holds no form invents a partial one (which would be saved with fields
 * missing), the preview shows an icon other than the one that will be saved,
 * or «Save» can be pressed again while the first save is still running.
 */
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Bug } from 'lucide-react'
import { ITILTypeSettings } from './ITILTypeSettings'
import type { SettingsFormState } from './useITILTypeDesigner'

const FORM: SettingsFormState = { label: 'Incident', icon: 'server', color: '#dc2626', validationScript: 'return true' }

/** Plays the page: holds the form, and hands it to «save» as it is at that moment. */
function Harness({ initial = FORM, saving = false, onSave = vi.fn() }: { initial?: SettingsFormState; saving?: boolean; onSave?: (f: SettingsFormState) => void }) {
  const [form, setForm] = useState<SettingsFormState | null>(initial)
  return <ITILTypeSettings settingsForm={form!} setSettingsForm={setForm} settingsSaving={saving} onSaveSettings={() => onSave(form!)} FallbackIcon={Bug} />
}

describe('ITILTypeSettings', () => {
  it('shows the type as saved: label, icon, colour and script, with the variables the script can use', () => {
    render(<Harness />)
    expect(screen.getByLabelText('Label')).toHaveValue('Incident')
    const icon = screen.getByLabelText('Icon')
    expect(icon).toHaveValue('server')
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('— none —')
    expect(screen.getByLabelText('Colour')).toHaveValue('#dc2626')
    expect(screen.getByLabelText('Validation script (optional)')).toHaveValue('return true')
    // The hint names the variable as code, not as the literal «<code>input</code>».
    expect(screen.getByText('Variables:', { exact: false })).toHaveTextContent('Variables: input. Use throw with a message for a global error.')
    expect(screen.getAllByText('input', { selector: 'code' })).toHaveLength(1)
  })

  it('every edit reaches the form the page saves', async () => {
    const onSave = vi.fn()
    const user = userEvent.setup()
    render(<Harness onSave={onSave} />)
    await user.clear(screen.getByLabelText('Label'))
    await user.type(screen.getByLabelText('Label'), 'Disruption')
    await user.selectOptions(screen.getByLabelText('Icon'), 'bug')
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#112233' } })
    await user.clear(screen.getByLabelText('Validation script (optional)'))
    await user.type(screen.getByLabelText('Validation script (optional)'), 'return input.title')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(onSave).toHaveBeenCalledWith({ label: 'Disruption', icon: 'bug', color: '#112233', validationScript: 'return input.title' })
  })

  it('the preview shows the icon chosen, in the colour chosen', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.getByRole('img', { name: 'server' })).toHaveAttribute('stroke', '#dc2626')
    await user.selectOptions(screen.getByLabelText('Icon'), 'database')
    expect(screen.getByRole('img', { name: 'database' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'server' })).toBeNull()
  })

  it('with no icon the preview shows the type\'s own one; with no colour, the brand colour', async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness initial={{ ...FORM, icon: '', color: '' }} />)
    expect(screen.getByLabelText('Icon')).toHaveValue('')
    const own = container.querySelector('svg.lucide-bug')
    expect(own).toHaveAttribute('stroke', 'var(--color-brand)')
    await user.selectOptions(screen.getByLabelText('Icon'), 'cloud')
    expect(screen.getByRole('img', { name: 'cloud' })).toHaveAttribute('stroke', 'var(--color-brand)')
    expect(container.querySelector('svg.lucide-bug')).toBeNull()
  })

  it('while saving, the button says so and cannot be pressed again', async () => {
    const onSave = vi.fn()
    render(<Harness saving onSave={onSave} />)
    const button = screen.getByRole('button', { name: 'Saving...' })
    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(onSave).not.toHaveBeenCalled()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: four of the icons offered
  // — alert-circle, bug, git-pull-request, inbox, the ITIL ones — were not in
  // the icon registry, so choosing one drew the red «unknown icon» mark
  // wherever the type's icon is shown. The pickers now offer the registry's own list.
  it('every icon offered is drawn as itself', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<Harness />)
    const offered = within(screen.getByLabelText('Icon')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value).filter(Boolean)
    for (const icon of offered) {
      await user.selectOptions(screen.getByLabelText('Icon'), icon)
      expect(screen.getByRole('img', { name: icon })).toBeInTheDocument()
    }
  })

  it('each edit changes only its own field, and never makes a form out of nothing', async () => {
    // Each update is applied the moment it is handed over, as React does: to
    // the form the page holds, and to «no form» (no type selected).
    const seen: { withForm: SettingsFormState | null; withoutForm: SettingsFormState | null }[] = []
    const setSettingsForm = vi.fn((update: React.SetStateAction<SettingsFormState | null>) => {
      const apply = update as (p: SettingsFormState | null) => SettingsFormState | null
      seen.push({ withForm: apply(FORM), withoutForm: apply(null) })
    })
    render(<ITILTypeSettings settingsForm={FORM} setSettingsForm={setSettingsForm} settingsSaving={false} onSaveSettings={vi.fn()} FallbackIcon={Bug} />)
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Disruption' } })
    await userEvent.selectOptions(screen.getByLabelText('Icon'), 'bug')
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#112233' } })
    fireEvent.change(screen.getByLabelText('Validation script (optional)'), { target: { value: 'return 1' } })

    expect(seen.map((s) => s.withForm)).toEqual([
      { ...FORM, label: 'Disruption' },
      { ...FORM, icon: 'bug' },
      { ...FORM, color: '#112233' },
      { ...FORM, validationScript: 'return 1' },
    ])
    // With no form, the edit is dropped, not turned into a one-field form.
    expect(seen.map((s) => s.withoutForm)).toEqual([null, null, null, null])
  })
})
