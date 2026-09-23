/**
 * THE CUSTOMER'S OWN FIELDS IN A CREATE OR EDIT FORM (wave 4).
 *
 * Every field the customer added to a ticket type is filled here, and what the
 * form reports back is what the API stores. So the control must suit the type
 * (a vocabulary is a choice with the customer's words, a yes/no is Yes/No, a
 * date is a date), the customer's form rules decide what is shown and what is
 * required, and an error must be read next to its field. A regression here
 * stores a wrong value, or asks for a field that the rules have hidden.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import type { FieldRules } from '@/hooks/useFormFieldRules'
import { CustomFieldsForm } from './CustomFieldsForm'
import type { CustomFieldDefView } from './customFields'

const def = (over: Partial<CustomFieldDefView>): CustomFieldDefView => ({
  name: 'x', label: 'X', fieldType: 'string', required: false, enumValues: [], enumTypeName: null, visibleToEndUser: false, ...over,
})

const vocabularies: DomainVocabularies = {
  valuesOf: () => null,
  labelOf: (name, value) => (name === 'env' && value === 'prod' ? 'Production' : null),
  colorOf: () => null,
  entriesOf: () => null,
  vocabularyLabelOf: () => null,
  loading: false,
  error: null,
}

function show(props: { defs: CustomFieldDefView[]; values?: Record<string, string>; rules?: Record<string, FieldRules>; errors?: Record<string, string> }) {
  const onChange = vi.fn()
  const view = renderWithProviders(
    <DomainVocabularyContext.Provider value={vocabularies}>
      <section aria-label="Custom fields">
        <CustomFieldsForm defs={props.defs} values={props.values ?? {}} rules={props.rules} errors={props.errors} onChange={onChange} inputStyle={{}} labelStyle={{}} />
      </section>
    </DomainVocabularyContext.Provider>,
  )
  return { ...view, onChange }
}

describe('CustomFieldsForm — the control follows the type', () => {
  it('a vocabulary field offers the customer\'s words, and the raw value where the vocabulary has none', async () => {
    const { user, onChange } = show({ defs: [
      def({ name: 'environment', label: 'Environment', fieldType: 'enum', enumValues: ['prod', 'lab'], enumTypeName: 'env' }),
      def({ name: 'tier', label: 'Tier', fieldType: 'enum', enumValues: ['gold'] }),
    ] })
    const env = screen.getByLabelText('Environment')
    expect([...env.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['— Choose —', 'Production', 'lab'])
    expect(screen.getByRole('option', { name: 'gold' })).toBeInTheDocument()
    await user.selectOptions(env, 'Production')
    // What goes back is the value, never the label.
    expect(onChange).toHaveBeenLastCalledWith('environment', 'prod')
  })

  it('a yes/no field is a choice of Yes or No, reported as "true" or "false"', async () => {
    const { user, onChange } = show({ defs: [def({ name: 'approved', label: 'Approved', fieldType: 'boolean' })], values: { approved: 'true' } })
    const approved = screen.getByLabelText('Approved')
    expect(approved).toHaveDisplayValue('Yes')
    expect([...approved.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['— Choose —', 'Yes', 'No'])
    await user.selectOptions(approved, 'No')
    expect(onChange).toHaveBeenLastCalledWith('approved', 'false')
  })

  it('a number is a number box; a date is a date box showing only the day of a stored timestamp', async () => {
    const { user, onChange } = show({
      defs: [def({ name: 'budget', label: 'Budget', fieldType: 'number' }), def({ name: 'go_live', label: 'Go live', fieldType: 'date' })],
      values: { go_live: '2026-09-30T00:00:00.000Z' },
    })
    expect(screen.getByLabelText('Budget')).toHaveAttribute('type', 'number')
    const goLive = screen.getByLabelText('Go live')
    expect(goLive).toHaveAttribute('type', 'date')
    expect(goLive).toHaveValue('2026-09-30')
    await user.type(screen.getByLabelText('Budget'), '7')
    expect(onChange).toHaveBeenLastCalledWith('budget', '7')
  })

  it('any other type is a text box, empty when the ticket has no value yet', async () => {
    const { user, onChange } = show({ defs: [def({ name: 'cost_center', label: 'Cost center' })] })
    const box = screen.getByLabelText('Cost center')
    expect(box).toHaveAttribute('type', 'text')
    expect(box).toHaveValue('')
    await user.type(box, 'I')
    expect(onChange).toHaveBeenLastCalledWith('cost_center', 'I')
  })
})

describe('CustomFieldsForm — the customer\'s rules and the errors', () => {
  it('a field the rules hide is not offered; one they require is starred like a required field', () => {
    show({
      defs: [def({ name: 'a', label: 'Asset tag', required: true }), def({ name: 'b', label: 'Budget code' }), def({ name: 'c', label: 'Hidden note' })],
      rules: { b: { visible: true, required: true }, c: { visible: false, required: false } },
    })
    expect(screen.queryByLabelText(/Hidden note/)).toBeNull()
    expect(screen.getByText('Asset tag').closest('label')).toHaveTextContent('Asset tag*')
    expect(screen.getByText('Budget code').closest('label')).toHaveTextContent('Budget code*')
  })

  it('when the rules hide every field the form draws nothing', () => {
    show({ defs: [def({ name: 'c', label: 'Hidden note' })], rules: { c: { visible: false, required: false } } })
    expect(screen.getByRole('region', { name: 'Custom fields' })).toBeEmptyDOMElement()
  })

  it('an error is announced under its own field', () => {
    show({ defs: [def({ name: 'a', label: 'Asset tag', required: true }), def({ name: 'b', label: 'Budget code' })], errors: { a: 'Required field' } })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Required field')
    expect(alert.parentElement).toContainElement(screen.getByLabelText(/Asset tag/))
    expect(alert.parentElement).not.toContainElement(screen.getByLabelText('Budget code'))
  })
})
