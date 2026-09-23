/**
 * FIELD RULES, the cases the two other test files do not reach: rules not
 * arrived yet, a rule that HIDES, values read with their Dictionary labels, a
 * field required in every step, requirement changes the server refuses, and
 * forms with too few fields to make a rule.
 *
 * What breaks for an administrator if these regress: a rule list that shows
 * nothing while it is loading is fine, one that crashes is not; «hide» read
 * as «show» inverts the rule in the reader's head; a vocabulary value offered
 * by its technical key where the whole product shows its label; unticking
 * «all steps» deleting nothing; a refused change reported as done. And a rule
 * must never target the very field that triggers it — the target list never
 * offers it, and two defects found below showed how a rule got saved that way
 * anyway.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { withVocabularyLabels } from '@/test/vocabularies'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { FieldRulesPanel } = await import('./FieldRulesPanel')

type Field = { name: string; label: string; fieldType: string; enumValues: string[]; enumTypeName?: string | null }
const FIELDS: Field[] = [
  { name: 'category', label: 'Category', fieldType: 'enum', enumValues: ['hardware', 'software'], enumTypeName: 'incident_category' },
  { name: 'serial', label: 'Serial', fieldType: 'string', enumValues: [] },
  { name: 'notes', label: 'Notes', fieldType: 'string', enumValues: [] },
]
const STEPS = [{ name: 'resolved', label: 'Resolved' }]

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [] }
  apolloFinto.risposte['GetFieldRequirementRules'] = { fieldRequirementRules: [] }
})

const show = (fields: Field[] = FIELDS) =>
  renderWithProviders(<FieldRulesPanel entityType="incident" fields={fields} workflowSteps={STEPS} />)
const addRule = () => screen.getByRole('button', { name: /Add rule/ })

describe('FieldRulesPanel — rules not arrived yet', () => {
  it('lists no visibility rule and requires no field, instead of breaking', () => {
    apolloFinto.risposte['GetFieldVisibilityRules'] = undefined
    apolloFinto.risposte['GetFieldRequirementRules'] = undefined
    show()
    expect(screen.getByText('No visibility rules. Click "Add rule" to add one.')).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox').every((c) => !(c as HTMLInputElement).checked)).toBe(true)
  })
})

describe('FieldRulesPanel — visibility rules', () => {
  it('a rule that hides a field says «Hide»', () => {
    apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [
      { id: 'r1', triggerField: 'category', triggerValue: 'software', targetField: 'serial', action: 'hide' },
    ] }
    show()
    expect(screen.getByText('When category = software → Hide serial')).toBeInTheDocument()
  })

  it('the values of a vocabulary field are offered with their Dictionary labels, and the value is what is saved', async () => {
    const { user } = renderWithProviders(withVocabularyLabels(
      <FieldRulesPanel entityType="incident" fields={FIELDS} workflowSteps={STEPS} />,
      // Only one of the two values has a label: the other is shown as it is.
      { incident_category: { hardware: 'Hardware devices' } },
    ))
    await user.click(addRule())
    const value = screen.getByLabelText('Trigger value')
    expect(within(value).getAllByRole('option').map((o) => o.textContent)).toEqual(['— Choose —', 'Hardware devices', 'software'])
    await user.selectOptions(value, 'Hardware devices')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(apolloFinto.chiamata('CreateFieldVisibilityRule')).toMatchObject({ triggerField: 'category', triggerValue: 'hardware', targetField: 'serial' })
  })

  it('with no field at all, no rule can be saved', async () => {
    const { user } = show([])
    await user.click(addRule())
    await user.type(screen.getByLabelText('Trigger value'), 'x')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(apolloFinto.chiamate['CreateFieldVisibilityRule']).toBeUndefined()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: choosing as trigger the
  // field that was the target left the target ON the trigger. The target list
  // hides the trigger, so it showed another field («Category»), but the rule
  // saved made «serial» show or hide itself.
  it('changing the trigger to the field that was the target does not leave the rule on the trigger itself', async () => {
    const { user } = show(FIELDS.map((f) => ({ ...f, fieldType: 'string' })))
    await user.click(addRule())
    await user.selectOptions(screen.getByLabelText('Trigger field'), 'serial')
    await user.type(screen.getByLabelText('Trigger value'), 'SN-1')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    const saved = apolloFinto.chiamata('CreateFieldVisibilityRule')
    expect(saved?.['targetField']).not.toBe(saved?.['triggerField'])
  })

  // Found by this test (tour of 23 Sep 2026), fixed: with a single field the
  // target defaulted to the trigger itself. The target list was empty, and a
  // rule on the field itself was saved anyway.
  it('with a single field there is nothing to target, and no rule is saved', async () => {
    const { user } = show([FIELDS[1]!])
    await user.click(addRule())
    expect(within(screen.getByLabelText('Target field')).queryAllByRole('option')).toHaveLength(0)
    await user.type(screen.getByLabelText('Trigger value'), 'SN-1')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(apolloFinto.chiamate['CreateFieldVisibilityRule']).toBeUndefined()
  })

  it('with a single field the form says there is nothing to target, and «Save» cannot be pressed', async () => {
    const { user } = show([FIELDS[1]!])
    await user.click(addRule())
    const why = 'No other field to show or hide: a visibility rule needs at least two fields.'
    expect(screen.getByText(why)).toBeInTheDocument()
    expect(screen.getByLabelText('Target field')).toHaveAccessibleDescription(why)
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled()
  })

  it('a rule saved on its own trigger opens on the target the list shows, and is saved with it', async () => {
    apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [
      { id: 'r9', triggerField: 'serial', triggerValue: 'SN-1', targetField: 'serial', action: 'show' },
    ] }
    const { user } = show()
    await user.click(await screen.findByRole('button', { name: 'Edit the rule for «serial»' }))
    expect(screen.getByLabelText('Target field')).toHaveValue('category')
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(apolloFinto.chiamata('UpdateFieldVisibilityRule')).toMatchObject({ id: 'r9', triggerField: 'serial', targetField: 'category' })
  })
})

describe('FieldRulesPanel — required fields', () => {
  it('a field required in every step is ticked under «All steps», and unticking deletes that rule', async () => {
    apolloFinto.risposte['GetFieldRequirementRules'] = { fieldRequirementRules: [
      { id: 'q-all', fieldName: 'serial', required: true, workflowStep: null },
    ] }
    const { user } = show()
    const allSteps = screen.getByRole('checkbox', { name: 'Serial — All steps' })
    expect(allSteps).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Serial — Resolved' })).not.toBeChecked()
    await user.click(allSteps)
    expect(apolloFinto.chiamata('DeleteFieldRequirement')).toEqual({ id: 'q-all' })
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a refused change says why, and reports nothing as done', async () => {
    apolloFinto.esiti['SetFieldRequirement'] = { error: new Error('Field is not on this type') }
    apolloFinto.esiti['DeleteFieldRequirement'] = { error: new Error('Rule already removed') }
    apolloFinto.risposte['GetFieldRequirementRules'] = { fieldRequirementRules: [
      { id: 'q1', fieldName: 'notes', required: true, workflowStep: 'resolved' },
    ] }
    const { user } = show()
    await user.click(screen.getByRole('checkbox', { name: 'Serial — Resolved' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Field is not on this type'))
    await user.click(screen.getByRole('checkbox', { name: 'Notes — Resolved' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Rule already removed'))
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
