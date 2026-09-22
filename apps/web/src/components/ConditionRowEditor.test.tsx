/**
 * One condition of a business rule, auto-trigger or workflow step:
 * field · operator · value.
 *
 * What a regression costs the admin: the value control must match the field
 * type. A team or a user must be picked by id (a name typed by hand never
 * matches), a vocabulary value must be picked from the vocabulary (`produzione`
 * instead of `production` is a rule that never fires, silently). A saved field
 * or operator the editor does not know must stay selected and flagged — if it
 * fell back to the first option, saving would rewrite the rule into a
 * different one without anyone noticing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import type { FieldMeta } from '@/hooks/useEntityFields'
import { ConditionRowEditor, type Condition } from './ConditionRowEditor'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

// The field lists come from the metamodel and the catalogue forms: the test decides them.
const fields = vi.hoisted(() => ({ metamodel: [] as FieldMeta[], form: [] as FieldMeta[], error: null as string | null }))
vi.mock('@/hooks/useEntityFields', () => ({
  useEntityFieldMetas: () => ({ fields: fields.metamodel, error: fields.error }),
  useFormFieldMetas: () => fields.form,
}))

const f = (name: string, fieldType: string, over: Partial<FieldMeta> = {}): FieldMeta =>
  ({ name, label: name.toUpperCase(), fieldType, enumValues: [], enumTypeName: null, ...over })

const VOCAB: DomainVocabularies = {
  valuesOf: () => null, entriesOf: () => null, colorOf: () => null, vocabularyLabelOf: () => null,
  labelOf: (voc, v) => (voc === 'environment' && v === 'production' ? 'Production' : null),
  loading: false, error: null,
}

function mount(condition: Condition, opts: { layout?: 'row' | 'stack' } = {}) {
  const onChange = vi.fn()
  const onRemove = vi.fn()
  const r = renderWithProviders(
    <DomainVocabularyContext.Provider value={VOCAB}>
      <ConditionRowEditor condition={condition} entityType="incident" onChange={onChange} onRemove={onRemove} layout={opts.layout} />
    </DomainVocabularyContext.Provider>,
  )
  return { ...r, onChange, onRemove }
}

const selects = () => screen.getAllByRole('combobox')
const optionTexts = (el: HTMLElement) => within(el).getAllByRole('option').map((o) => o.textContent)

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetTeams'] = { teams: [{ id: 't1', name: 'Network' }] }
  apolloFinto.risposte['GetUsers'] = { users: [{ id: 'u1', name: 'Ada', email: 'ada@x.io' }] }
  fields.metamodel = [
    f('assignee', 'user'), f('team', 'team'), f('env', 'enum', { enumValues: ['production', 'test'], enumTypeName: 'environment' }),
    f('free', 'enum'), f('vip', 'boolean'), f('due', 'date'), f('count', 'number'), f('title', 'string'),
  ]
  fields.form = []
  fields.error = null
})

describe('ConditionRowEditor — the value control follows the field type', () => {
  it('a user field is picked from the users, by id', async () => {
    const { user, onChange } = mount({ field: 'assignee', operator: 'equals', value: '' })
    const value = selects()[2]!
    expect(optionTexts(value)).toEqual(['-- User --', 'Ada (ada@x.io)'])
    await user.selectOptions(value, 'u1')
    expect(onChange).toHaveBeenCalledWith({ value: 'u1' })
  })

  it('a team field is picked from the teams, by id', async () => {
    const { user, onChange } = mount({ field: 'team', operator: 'equals', value: '' })
    const value = selects()[2]!
    expect(optionTexts(value)).toEqual(['-- Team --', 'Network'])
    await user.selectOptions(value, 't1')
    expect(onChange).toHaveBeenCalledWith({ value: 't1' })
  })

  it('a vocabulary field offers its values with their labels, and stores the value itself', async () => {
    const { user, onChange } = mount({ field: 'env', operator: 'equals', value: '' })
    const value = selects()[2]!
    // "test" has no label in the vocabulary: the raw value is shown, it is still true.
    expect(optionTexts(value)).toEqual(['-- Value --', 'Production', 'test'])
    await user.selectOptions(value, 'production')
    expect(onChange).toHaveBeenCalledWith({ value: 'production' })
  })

  it('an enum field without known values falls back to a free text input', () => {
    mount({ field: 'free', operator: 'equals', value: 'x' })
    expect(screen.getByPlaceholderText('Value')).toHaveValue('x')
  })

  it('a boolean field is Yes/No', async () => {
    const { user, onChange } = mount({ field: 'vip', operator: 'equals', value: '' })
    const value = selects()[2]!
    expect(optionTexts(value)).toEqual(['-- Value --', 'Yes', 'No'])
    await user.selectOptions(value, 'true')
    expect(onChange).toHaveBeenCalledWith({ value: 'true' })
  })

  it('date and number fields get a typed input', async () => {
    const first = mount({ field: 'due', operator: 'equals', value: '2026-09-01' })
    const date = first.container.querySelector('input[type="date"]')!
    expect(date).toHaveValue('2026-09-01')
    // A date input is not typed into key by key: the browser sets the whole value.
    fireEvent.change(date, { target: { value: '2026-10-02' } })
    expect(first.onChange).toHaveBeenCalledWith({ value: '2026-10-02' })
    first.unmount()
    const { user, onChange } = mount({ field: 'count', operator: 'greater_than', value: '' })
    const number = screen.getByRole('spinbutton')
    await user.type(number, '5')
    expect(onChange).toHaveBeenCalledWith({ value: '5' })
  })

  it('a string field is free text', async () => {
    const { user, onChange } = mount({ field: 'title', operator: 'contains', value: '' })
    await user.type(screen.getByPlaceholderText('Value'), 'a')
    expect(onChange).toHaveBeenCalledWith({ value: 'a' })
  })

  it('an operator that needs no value (is null) hides the value control', () => {
    mount({ field: 'title', operator: 'is_null', value: '' })
    expect(screen.queryByPlaceholderText('Value')).toBeNull()
  })
})

describe('ConditionRowEditor — field and operator', () => {
  it('changing field resets the value (a value of another field is meaningless); changing operator keeps it', async () => {
    const { user, onChange } = mount({ field: 'title', operator: 'equals', value: 'x' })
    await user.selectOptions(selects()[0]!, 'vip')
    expect(onChange).toHaveBeenCalledWith({ field: 'vip', value: '' })
    await user.selectOptions(selects()[1]!, 'not_equals')
    expect(onChange).toHaveBeenCalledWith({ operator: 'not_equals' })
  })

  it('catalogue form fields are offered too, but a name the metamodel already has is not duplicated', () => {
    fields.form = [f('title', 'string', { label: 'Form title' }), f('cost_center', 'string', { label: 'Cost center' })]
    mount({ field: '', operator: 'equals', value: '' })
    const labels = optionTexts(selects()[0]!)
    expect(labels).toContain('Cost center (text)')
    expect(labels.filter((l) => l?.startsWith('TITLE') || l?.startsWith('Form title'))).toEqual(['TITLE (text)'])
  })

  it('a saved field the metamodel no longer has stays selected and flagged, instead of falling back', async () => {
    const { user, onChange } = mount({ field: 'gone_field', operator: 'equals', value: 'x' })
    const field = selects()[0]!
    expect(field).toHaveValue('gone_field')
    expect(field).toHaveAttribute('title', 'field "gone_field" not in the metamodel')
    expect(within(field).getByRole('option', { name: '?gone_field (not in the metamodel)' })).toBeInTheDocument()
    // No field meta: the value is free text, and still editable.
    expect(screen.getByPlaceholderText('Value')).toHaveValue('x')
    await user.type(screen.getByPlaceholderText('Value'), 'y')
    expect(onChange).toHaveBeenCalledWith({ value: 'xy' })
  })

  it('a saved operator the editor does not support stays selected and flagged', () => {
    mount({ field: 'title', operator: 'gte', value: '' })
    const op = selects()[1]!
    expect(op).toHaveValue('gte')
    expect(op).toHaveAttribute('title', 'operator "gte" not supported by the editor')
  })

  it('when the field list cannot be loaded the reason is shown', () => {
    fields.metamodel = []
    fields.error = 'metamodel offline'
    mount({ field: '', operator: 'equals', value: '' })
    expect(screen.getByText(/Fields unavailable: metamodel offline/)).toBeInTheDocument()
  })
})

describe('ConditionRowEditor — layouts and removal', () => {
  it.each(['row', 'stack'] as const)('the remove button works in the %s layout', async (layout) => {
    fields.error = 'x'
    const { user, onRemove } = mount({ field: 'title', operator: 'equals', value: '' }, { layout })
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Fields unavailable/)).toBeInTheDocument()
  })
})
