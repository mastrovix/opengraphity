/**
 * THE PROPERTIES OF WHAT IS SELECTED ON THE FORM CANVAS.
 *
 * Three editors, and each one decides something a requester lives with:
 *  - a FIELD in this form: required here or not, half width (only where the
 *    section has a second column — a tick that does nothing is a trap), shown
 *    in the portal or kept to the workspace, read-only;
 *  - a SECTION: its title in every product language (publishing refuses a
 *    missing one), one or two columns, all widths at once;
 *  - the LIBRARY field behind a form field: closed until asked for, and saying
 *    first that a change there reaches every form that uses the field.
 * The editors hold no state of their own: these tests check what each control
 * hands back to the builder, which is what ends up in the published form.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { screen } from '@testing-library/react'
import type { CatalogFormItem, CatalogFormSection } from '@opengraphity/types'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { FormFieldRow } from './FieldLibraryPanel'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const { ProprietaVoce, ProprietaSezione, EditorDelCampoDiLibreria } = await import('./ItemProperties')
const { bozzaDaCampo } = await import('./FieldEditor')

function fieldRow(name: string, fieldType: string, extra: Partial<FormFieldRow> = {}): FormFieldRow {
  return {
    id: `f-${name}`, name, fieldType, label: `Label of ${name}`, labels: [], help: null, helps: [], required: false,
    vocabulary: null, inList: false, formula: null, validationScript: null, tableDefinition: null, usedBy: [], options: [],
    ...extra,
  }
}

const ONE_COLUMN: CatalogFormSection = { id: 'main', title: { en: 'Main' }, items: [] }
const TWO_COLUMNS: CatalogFormSection = { ...ONE_COLUMN, columns: 2 }

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetBaseCIType'] = { baseCIType: { fields: [
    { name: 'status', fieldType: 'enum', enumValues: ['active'] },
    { name: 'environment', fieldType: 'enum', enumValues: ['production'] },
  ] } }
})

function renderItem(
  item: CatalogFormItem, field: FormFieldRow | undefined, section = ONE_COLUMN,
  slots: { conditionEditor?: React.ReactNode; libraryEditor?: React.ReactNode } = {},
) {
  const onItem = vi.fn()
  const onRemove = vi.fn()
  const r = renderWithProviders(
    <ProprietaVoce item={item} campo={field} sezione={section} onItem={onItem} onRimuovi={onRemove}
      editorCondizione={slots.conditionEditor ?? null} campoDiLibreria={slots.libraryEditor} />,
  )
  return { ...r, onItem, onRemove }
}

describe('ProprietaVoce: a field in this form', () => {
  it('names the field and its type; a field the library does not have reads as text', () => {
    const { unmount } = renderItem({ field: 'cost_centre' }, fieldRow('cost_centre', 'enum'))
    expect(screen.getByText('cost_centre · One choice')).toBeInTheDocument()
    unmount()
    renderItem({ field: 'ghost' }, undefined)
    expect(screen.getByText('ghost · Text')).toBeInTheDocument()
  })

  it('required: the form decides, else the library default; ticking writes it on this form only', async () => {
    const { user, onItem, unmount } = renderItem({ field: 'cost_centre' }, fieldRow('cost_centre', 'enum', { required: true }))
    const required = screen.getByRole('checkbox', { name: 'Required in this form' })
    expect(required).toBeChecked()
    await user.click(required)
    expect(onItem).toHaveBeenLastCalledWith({ field: 'cost_centre', required: false })
    unmount()

    // The form said no: the library default does not win.
    renderItem({ field: 'cost_centre', required: false }, fieldRow('cost_centre', 'enum', { required: true }))
    expect(screen.getByRole('checkbox', { name: 'Required in this form' })).not.toBeChecked()
  })

  it('an unknown field starts not required', () => {
    renderItem({ field: 'ghost' }, undefined)
    expect(screen.getByRole('checkbox', { name: 'Required in this form' })).not.toBeChecked()
  })

  it('a note carries no answer, so it cannot be required', () => {
    renderItem({ field: 'instructions' }, fieldRow('instructions', 'note'))
    expect(screen.queryByRole('checkbox', { name: 'Required in this form' })).toBeNull()
  })

  it('half width exists only in a two-column section, where it is the default and can be switched off', async () => {
    const { user, onItem, unmount } = renderItem({ field: 'budget' }, fieldRow('budget', 'number'), TWO_COLUMNS)
    const half = screen.getByRole('checkbox', { name: 'Half width' })
    expect(half).toBeChecked()
    await user.click(half)
    expect(onItem).toHaveBeenLastCalledWith({ field: 'budget', width: 'full' })
    unmount()

    const fullRow = renderItem({ field: 'budget', width: 'full' }, fieldRow('budget', 'number'), TWO_COLUMNS)
    await fullRow.user.click(screen.getByRole('checkbox', { name: 'Half width' }))
    expect(fullRow.onItem).toHaveBeenLastCalledWith({ field: 'budget', width: 'half' })
    fullRow.unmount()

    renderItem({ field: 'budget', width: 'half' }, fieldRow('budget', 'number'), ONE_COLUMN)
    expect(screen.queryByRole('checkbox', { name: 'Half width' })).toBeNull()
    expect(screen.getByText(/Half width only exists in a two-column section/)).toBeInTheDocument()
  })

  it('offered in the portal unless switched off, with what switching it off means', async () => {
    const { user, onItem, unmount } = renderItem({ field: 'budget' }, fieldRow('budget', 'number'))
    const portal = screen.getByRole('checkbox', { name: /^Visible in the service request/ })
    expect(portal).toBeChecked()
    expect(portal).toHaveAccessibleName(/Off, the field stays with whoever works the request from the workspace/)
    await user.click(portal)
    expect(onItem).toHaveBeenLastCalledWith({ field: 'budget', endUser: false })
    unmount()

    const off = renderItem({ field: 'budget', endUser: false }, fieldRow('budget', 'number'))
    await off.user.click(screen.getByRole('checkbox', { name: /^Visible in the service request/ }))
    expect(off.onItem).toHaveBeenLastCalledWith({ field: 'budget', endUser: true })
  })

  it('a CMDB reference must name its CI types to be offered in the portal; people and teams stay in the workspace', () => {
    const needsTypes = /declare which CI types it points to/
    const staffOnly = /A reference to a person or a team stays in the workspace/
    const a = renderItem({ field: 'device' }, fieldRow('device', 'ref_ci'))
    expect(screen.getByText(needsTypes)).toBeInTheDocument()
    a.unmount()
    const b = renderItem({ field: 'device' }, fieldRow('device', 'ref_ci', { refTypes: ['laptop'] }))
    expect(screen.queryByText(needsTypes)).toBeNull()
    expect(screen.queryByText(staffOnly)).toBeNull()
    b.unmount()
    const c = renderItem({ field: 'owner' }, fieldRow('owner', 'ref_team'))
    expect(screen.getByText(staffOnly)).toBeInTheDocument()
    expect(screen.queryByText(needsTypes)).toBeNull()
    c.unmount()
    renderItem({ field: 'budget' }, fieldRow('budget', 'number'))
    expect(screen.queryByText(staffOnly)).toBeNull()
    expect(screen.queryByText(needsTypes)).toBeNull()
  })

  it('read-only in this form, ticked and unticked', async () => {
    const { user, onItem, unmount } = renderItem({ field: 'total', readOnly: true }, fieldRow('total', 'number'))
    const readOnly = screen.getByRole('checkbox', { name: /^Read-only in this form/ })
    expect(readOnly).toBeChecked()
    await user.click(readOnly)
    expect(onItem).toHaveBeenLastCalledWith({ field: 'total', readOnly: false })
    unmount()
    const writable = renderItem({ field: 'total' }, fieldRow('total', 'number'))
    await writable.user.click(screen.getByRole('checkbox', { name: /^Read-only in this form/ }))
    expect(writable.onItem).toHaveBeenLastCalledWith({ field: 'total', readOnly: true })
  })

  it('shows the condition editor and the library editor it is handed, and removes the field', async () => {
    const { user, onRemove } = renderItem({ field: 'budget' }, fieldRow('budget', 'number'), ONE_COLUMN, {
      conditionEditor: <p>Condition editor</p>, libraryEditor: <p>Library editor</p>,
    })
    expect(screen.getByText('Condition editor')).toBeInTheDocument()
    expect(screen.getByText('Library editor')).toBeInTheDocument()
    expect(screen.getByText(/it stays in the library, with its answers/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Remove this field/ }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})

describe('ProprietaSezione: a section', () => {
  /** The builder holds the section: this does the same, so typing a whole word works. */
  function SectionHarness({ initial, languages, onSection, onWidths, onRemove }: {
    initial: CatalogFormSection; languages: string[]; onSection: (s: CatalogFormSection) => void
    onWidths: (w: 'full' | 'half') => void; onRemove: () => void
  }) {
    const [section, setSection] = useState(initial)
    return (
      <ProprietaSezione sezione={section} lingue={languages} onSezione={(next) => { setSection(next); onSection(next) }}
        onRimuovi={onRemove} onLarghezzaInBlocco={onWidths} />
    )
  }

  function renderSection(initial: CatalogFormSection, languages = ['en', 'it', 'de']) {
    const onSection = vi.fn()
    const onWidths = vi.fn()
    const onRemove = vi.fn()
    const r = renderWithProviders(
      <SectionHarness initial={initial} languages={languages} onSection={onSection} onWidths={onWidths} onRemove={onRemove} />,
    )
    return { ...r, onSection, onWidths, onRemove }
  }

  it('asks the title in every product language, each box writing only its own', async () => {
    const { user, onSection } = renderSection({ id: 'main', title: { en: 'Main', it: 'Principale' }, items: [{ field: 'a' }] })
    expect(screen.getByRole('textbox', { name: 'Section title (EN)' })).toHaveValue('Main')
    expect(screen.getByRole('textbox', { name: 'Section title (IT)' })).toHaveValue('Principale')
    expect(screen.getByRole('textbox', { name: 'Section title (DE)' })).toHaveValue('')
    await user.type(screen.getByRole('textbox', { name: 'Section title (DE)' }), 'Haupt')
    expect(onSection).toHaveBeenLastCalledWith({ id: 'main', title: { en: 'Main', it: 'Principale', de: 'Haupt' }, items: [{ field: 'a' }] })
  })

  it('two columns are written down; one column removes the setting, as in every form made before columns', async () => {
    const { user, onSection } = renderSection(ONE_COLUMN)
    const columns = screen.getByRole('combobox', { name: 'Columns' })
    expect(columns).toHaveValue('1')
    await user.selectOptions(columns, 'Two columns')
    expect(onSection).toHaveBeenLastCalledWith({ ...ONE_COLUMN, columns: 2 })
    await user.selectOptions(columns, 'One column')
    const written = JSON.parse(JSON.stringify(onSection.mock.lastCall?.[0])) as CatalogFormSection
    expect(written).toEqual(ONE_COLUMN)
    expect(written).not.toHaveProperty('columns')
  })

  it('sets every width at once, and removes the section', async () => {
    const { user, onWidths, onRemove } = renderSection(TWO_COLUMNS)
    await user.click(screen.getByRole('button', { name: 'All at half width' }))
    expect(onWidths).toHaveBeenLastCalledWith('half')
    await user.click(screen.getByRole('button', { name: 'All at full width' }))
    expect(onWidths).toHaveBeenLastCalledWith('full')
    await user.click(screen.getByRole('button', { name: /Remove this section/ }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})

describe('EditorDelCampoDiLibreria: the library field behind a form field', () => {
  const costCentre = fieldRow('cost_centre', 'enum', {
    label: 'Cost centre', labels: [{ language: 'it', label: 'Centro di costo' }], vocabulary: 'cost_centres', usedBy: ['New laptop'],
  })

  function renderEditor(field: FormFieldRow, draft: ReturnType<typeof bozzaDaCampo> | null, saving = false) {
    const onDraft = vi.fn()
    const onSave = vi.fn()
    const r = renderWithProviders(
      <EditorDelCampoDiLibreria campo={field} bozza={draft} onBozza={onDraft} onSalva={onSave} salvando={saving}
        vocabolari={[{ name: 'cost_centres', label: 'Cost centres' }]} campiLeggibili={[{ name: 'budget', label: 'Budget' }]} />,
    )
    return { ...r, onDraft, onSave }
  }

  it('closed, a button opens the field as the library has it, and says it belongs to the field', async () => {
    const { user, onDraft } = renderEditor(costCentre, null)
    expect(screen.getByText(/they belong to the field, not to this form/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Edit the field/ }))
    expect(onDraft).toHaveBeenCalledWith(expect.objectContaining({
      name: 'cost_centre', fieldType: 'enum', labelIt: 'Centro di costo', labelEn: 'Cost centre', vocabulary: 'cost_centres',
    }))
  })

  it('a field used by several forms says that a change reaches all of them, before and while editing', () => {
    const shared = { ...costCentre, usedBy: ['New laptop', 'App access'] }
    const { unmount } = renderEditor(shared, null)
    expect(screen.getByText('Careful: this field is used by 2 forms. What you change here applies to all of them.')).toBeInTheDocument()
    unmount()
    renderEditor(shared, bozzaDaCampo(shared))
    expect(screen.getByText('Careful: this field is used by 2 forms. What you change here applies to all of them.')).toBeInTheDocument()
  })

  it('a field with no usage information counts as used by this form only', () => {
    renderEditor({ ...costCentre, usedBy: undefined as unknown as string[] }, null)
    expect(screen.getByText(/they belong to the field, not to this form/)).toBeInTheDocument()
  })

  it('open, name and type are locked; Save saves and Cancel closes the editor', async () => {
    const { user, onDraft, onSave } = renderEditor(costCentre, bozzaDaCampo(costCentre))
    expect(screen.queryByText(/Careful: this field is used by/)).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('cost_centre')
    expect(screen.getByRole('combobox', { name: 'Type' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Vocabulary' })).toHaveValue('cost_centres')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onDraft).toHaveBeenLastCalledWith(null)
  })

  it('while saving, the button says so', () => {
    renderEditor(costCentre, bozzaDaCampo(costCentre), true)
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeInTheDocument()
  })
})
