/**
 * THE PREVIEW OF AN ITIL TYPE'S FORM: the customer's fields as an agent
 * will fill them.
 *
 * An administrator checks here what the fields just designed look like. The
 * preview must show the customer's fields — not the system ones, which the
 * ticket draws itself — every one of them whatever its visibility script,
 * and it must never save anything: «Save» only says it is a preview, and
 * «Cancel» goes back to the Fields tab, where fields are edited. A type with
 * no field says where to add them instead of drawing an empty form.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { getQuickJS } from 'quickjs-emscripten'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { ITILField, ITILType } from './useITILTypeDesigner'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { ITILTypePreview } = await import('./ITILTypePreview')

const field = (over: Partial<ITILField>): ITILField => ({
  id: 'f-x', name: 'x', label: 'X', fieldType: 'string', required: false, enumValues: [], order: 1, isSystem: false,
  enumTypeId: null, enumTypeName: null, validationScript: null, visibilityScript: null, defaultScript: null, ...over,
})

const TITLE = field({ id: 'f-title', name: 'title', label: 'Title', isSystem: true, order: 1 })
const INCIDENT: ITILType = {
  id: 'it-inc', name: 'incident', label: 'Incident', icon: '', color: '', active: true, validationScript: null,
  fields: [
    TITLE,
    // A script that would hide the field must not hide it here: the preview shows every field.
    field({ id: 'f-cc', name: 'cost_center', label: 'Cost center', order: 3, visibilityScript: 'return false' }),
    field({ id: 'f-area', name: 'impact_area', label: 'Impact area', fieldType: 'enum', enumValues: ['network', 'storage'], order: 2 }),
  ],
}

// The form validates in the scripting sandbox; loading it once here keeps
// the time a save takes out of what the tests measure.
beforeAll(async () => { await getQuickJS() })

beforeEach(() => {
  apolloFinto.reset()
  toast.info.mockReset()
  apolloFinto.risposte['GetBaseCIType'] = { baseCIType: { fields: [
    { name: 'status', fieldType: 'enum', enumValues: ['active'] },
    { name: 'environment', fieldType: 'enum', enumValues: ['production'] },
  ] } }
})

async function pressSave(type: ITILType) {
  const setActiveTab = vi.fn()
  const { user } = renderWithProviders(<ITILTypePreview selectedType={type} setActiveTab={setActiveTab} />)
  await screen.findByLabelText('Cost center')
  await user.type(screen.getByLabelText(/^Name/), 'Preview ticket')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  return { setActiveTab }
}

describe('ITILTypePreview', () => {
  it('shows every customer field, not the system ones, with the note that every field is visible', async () => {
    renderWithProviders(<ITILTypePreview selectedType={INCIDENT} setActiveTab={vi.fn()} />)
    expect(screen.getByText('Form preview — every field visible.')).toBeInTheDocument()
    expect(await screen.findByLabelText('Cost center')).toBeInTheDocument()
    expect(screen.getByLabelText('Impact area')).toBeInTheDocument()
    expect(screen.queryByLabelText('Title')).toBeNull()
  })

  it('«Save» saves nothing: it says it is a preview', async () => {
    const { setActiveTab } = await pressSave(INCIDENT)
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Preview — nothing saved'))
    expect(setActiveTab).not.toHaveBeenCalled()
  })

  it('«Cancel» goes back to the Fields tab', async () => {
    const setActiveTab = vi.fn()
    const { user } = renderWithProviders(<ITILTypePreview selectedType={INCIDENT} setActiveTab={setActiveTab} />)
    await screen.findByLabelText('Cost center')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(setActiveTab).toHaveBeenCalledWith('fields')
  })

  it('a type with no field says where to add them, and draws no form', () => {
    renderWithProviders(<ITILTypePreview selectedType={{ ...INCIDENT, fields: [] }} setActiveTab={vi.fn()} />)
    expect(screen.getByText('No field. Add fields in the "Fields" tab.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('a type with only system fields has no customer field to preview either', () => {
    renderWithProviders(<ITILTypePreview selectedType={{ ...INCIDENT, fields: [TITLE] }} setActiveTab={vi.fn()} />)
    expect(screen.getByText('No field. Add fields in the "Fields" tab.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the preview handed the
  // SYSTEM fields to the form too. The form does not draw them but validated
  // them, so a required system field — an incident's title — failed on a
  // field nobody could see or fill: «Save» did nothing, with no message.
  it('«Save» answers the same on a type whose system fields are required', async () => {
    await pressSave({ ...INCIDENT, fields: [{ ...TITLE, required: true }, ...INCIDENT.fields.slice(1)] })
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Preview — nothing saved'))
  })
})
