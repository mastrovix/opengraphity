/**
 * THE FIELD EDITOR: one editor, two places (library page and form builder).
 *
 * Every field of every catalog form is written here. What regresses silently
 * if this breaks:
 *  - the name proposed from the label in the builder keeps overwriting a name
 *    someone typed by hand, or collides with a field that already exists;
 *  - name and type become editable on an existing field, and the answers
 *    already collected on tickets become unreadable;
 *  - a vocabulary, CI-type list or CMDB filter is sent for a type that does
 *    not carry it (the API refuses the save) or is lost for one that does;
 *  - a label or help text in one language is blanked on edit, and the other
 *    language is deleted at the first save.
 * The CMDB filter builder is replaced by a stub: its own behaviour has its own
 * tests, and what matters here is what the editor gives it and does with what
 * it returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { screen, within } from '@testing-library/react'
import { emptyFormTable } from '@opengraphity/types'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { FieldConfig, FilterGroup, FilterRule } from '@/components/FilterBuilder'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('@/lib/ciEnums', () => ({
  useCIBaseEnums: () => ({ statuses: ['active', 'retired'], environments: ['production'], loading: false, error: null }),
}))
vi.mock('@/components/FilterBuilder', () => ({
  FilterBuilder: ({ fields, initialRules, onApply }: { fields: FieldConfig[]; initialRules?: FilterRule[]; onApply: (g: FilterGroup | null) => void }) => (
    <div data-testid="filter-builder">
      <span data-testid="filter-fields">{fields.map((f) => `${f.key}:${f.type}`).join(',')}</span>
      <span data-testid="filter-initial">{initialRules?.length ?? 0}</span>
      <button type="button" onClick={() => onApply({ rules: [{ id: 'r1', field: 'environment', operator: 'equals', value: 'production', logic: 'AND' }] })}>apply one rule</button>
      <button type="button" onClick={() => onApply({ rules: [] })}>apply empty</button>
      <button type="button" onClick={() => onApply(null)}>clear filter</button>
    </div>
  ),
}))

const { FieldEditor, BOZZA_VUOTA, bozzaDaCampo, inputDaBozza } = await import('../FieldEditor')
type Bozza = typeof BOZZA_VUOTA
type Props = Parameters<typeof FieldEditor>[0]

/** The editor is controlled: this harness holds the draft as both places do, and exposes the last one. */
let latest: Bozza
function Harness({ initial = BOZZA_VUOTA, ...props }: Partial<Omit<Props, 'bozza' | 'onBozza'>> & { initial?: Bozza }) {
  const [bozza, setBozza] = useState(initial)
  latest = bozza
  return (
    <FieldEditor
      bozza={bozza}
      onBozza={(b) => { latest = b; setBozza(b) }}
      vocabolari={props.vocabolari ?? []}
      onSalva={props.onSalva ?? vi.fn()}
      onAnnulla={props.onAnnulla ?? vi.fn()}
      etichettaSalva={props.etichettaSalva ?? 'Create field'}
      {...props}
    />
  )
}

const CI_TYPES = [
  { name: 'server', label: 'Server', active: true, fields: [{ name: 'os', label: 'Operating system', fieldType: 'enum', enumValues: ['linux'] }] },
  { name: 'printer', label: '', active: true, fields: [{ name: 'toner', label: 'Toner', fieldType: 'string' }] },
  { name: 'mainframe', label: 'Mainframe', active: false, fields: [] },
]

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetCITypes'] = { ciTypes: CI_TYPES }
})

const box = (label: string) => screen.getByLabelText(label)

describe('bozzaDaCampo', () => {
  const campo = {
    name: 'cost_centre', fieldType: 'text', label: 'Centro di costo', help: null,
    labels: [{ language: 'en', label: 'Cost centre' }], helps: [],
    required: true, vocabulary: null, inList: false, formula: null, validationScript: null,
  }

  it('a language without its own label falls back to the base one instead of being blank', () => {
    // Blank would delete that language at the first save.
    const b = bozzaDaCampo(campo)
    expect(b.labelEn).toBe('Cost centre')
    expect(b.labelIt).toBe('Centro di costo')
    expect(b.helpIt).toBe('')
    expect(b).toMatchObject({ vocabulary: '', formula: '', validationScript: '', refTypes: [], refFilter: '', shared: false })
    expect(b.tabella).toEqual(emptyFormTable())
  })

  it('reads the table columns, the CI types, the filter and the shared flag', () => {
    const tabella = { version: 1, columns: [{ name: 'role', type: 'text', labels: [], required: false }] }
    const b = bozzaDaCampo({ ...campo, tableDefinition: JSON.stringify(tabella), refTypes: ['server'], refFilter: '{"rules":[]}', shared: true })
    expect(b.tabella).toEqual(tabella)
    expect(b).toMatchObject({ refTypes: ['server'], refFilter: '{"rules":[]}', shared: true })
  })

  it('an unreadable table definition is reported and replaced by an empty table, not a crash', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const b = bozzaDaCampo({ ...campo, tableDefinition: '{not json' })
    expect(b.tabella).toEqual(emptyFormTable())
    expect(err).toHaveBeenCalledWith(expect.stringContaining('cost_centre'), expect.anything())
  })
})

describe('inputDaBozza', () => {
  const b: Bozza = { ...BOZZA_VUOTA, labelIt: '  ', labelEn: ' Cost ', helpIt: '', helpEn: 'Where it is billed',
    formula: '  return 1  ', vocabulary: '', refTypes: ['server'], refFilter: '  ' }

  it('sends only the languages that have text, and the base label/help falls back to English', () => {
    const input = inputDaBozza(b, 'text')
    expect(input.labels).toEqual([{ language: 'en', text: ' Cost ' }])
    expect(input.label).toBe('Cost')
    expect(input.help).toBe('Where it is billed')
    expect(input.formula).toBe('return 1')
    expect(input.vocabulary).toBeNull()
  })

  it('CI types, filter and table columns travel only with the type that carries them', () => {
    // The API refuses them on another type.
    expect(inputDaBozza(b, 'text')).toMatchObject({ refTypes: [], refFilter: null, tableDefinition: null })
    expect(inputDaBozza(b, 'ref_ci')).toMatchObject({ refTypes: ['server'], refFilter: null })
    expect(inputDaBozza({ ...b, refFilter: '{"rules":[1]}' }, 'ref_ci').refFilter).toBe('{"rules":[1]}')
    expect(inputDaBozza(b, 'table').tableDefinition).toBe(JSON.stringify(emptyFormTable()))
  })

  it('no help in either language is null, not an empty string', () => {
    expect(inputDaBozza({ ...BOZZA_VUOTA, labelIt: 'X' }, 'text').help).toBeNull()
  })
})

describe('name proposed from the label (form builder)', () => {
  it('follows the Italian label, avoiding names already taken', async () => {
    const { user } = renderWithProviders(<Harness nomeDallEtichetta nomiPresi={['centro_di_costo']} />)
    await user.type(box('Label (Italian)'), 'Centro di costo')
    expect(latest.name).not.toBe('centro_di_costo')
    expect(latest.name).toMatch(/^centro_di_costo/)
    expect(box('Name')).toHaveValue(latest.name)
  })

  it('with only an English label, the English one names the field; emptying it empties the name', async () => {
    const { user } = renderWithProviders(<Harness nomeDallEtichetta />)
    await user.type(box('Label (English)'), 'Serial')
    expect(latest.name).toBe('serial')
    await user.clear(box('Label (English)'))
    expect(latest.name).toBe('')
  })

  it('the Italian label wins over the English one when both exist', async () => {
    const { user } = renderWithProviders(<Harness nomeDallEtichetta />)
    await user.type(box('Label (Italian)'), 'Matricola')
    await user.type(box('Label (English)'), 'Serial')
    expect(latest.name).toBe('matricola')
  })

  it('stops following the label as soon as the name is typed by hand', async () => {
    const { user } = renderWithProviders(<Harness nomeDallEtichetta />)
    await user.type(box('Name'), 'my_name')
    await user.type(box('Label (Italian)'), 'Altro')
    expect(latest.name).toBe('my_name')
  })

  it('in the library (no proposal) the label never touches the name', async () => {
    const { user } = renderWithProviders(<Harness />)
    await user.type(box('Label (Italian)'), 'Centro')
    expect(latest.name).toBe('')
    expect(screen.getByText(/cannot be changed later/)).toBeInTheDocument()
  })
})

describe('editing an existing field', () => {
  const inModifica = { id: 'f1', name: 'cost_centre', fieldType: 'enum', label: 'Cost centre' }

  it('name and type are locked, show the stored ones, and say why', async () => {
    const { user } = renderWithProviders(<Harness inModifica={inModifica} nomeDallEtichetta vocabolari={[{ name: 'cc', label: 'CC' }]} />)
    expect(box('Name')).toBeDisabled()
    expect(box('Name')).toHaveValue('cost_centre')
    expect(box('Type')).toBeDisabled()
    expect(box('Type')).toHaveValue('enum')
    expect(screen.getByText(/The name cannot change/)).toBeInTheDocument()
    expect(screen.getByText(/The type cannot change/)).toBeInTheDocument()
    // The vocabulary follows the STORED type, not the draft's default 'text'.
    expect(box('Vocabulary')).toBeInTheDocument()
    await user.type(box('Label (Italian)'), 'Nuovo')
    expect(latest.name).toBe('')
  })
})

describe('type-dependent options', () => {
  const VOCABS = [
    { name: 'ci_status', label: 'CI Status', isShipped: true },
    { name: 'ci_status', label: 'CI Status', isShipped: false },
    { name: 'priority', label: '', isShipped: true },
  ]

  it('a choice type offers each vocabulary once, marks factory ones, and keeps it when switching to another choice type', async () => {
    const { user } = renderWithProviders(<Harness vocabolari={VOCABS} />)
    expect(screen.queryByLabelText('Vocabulary')).toBeNull()
    await user.selectOptions(box('Type'), 'enum')
    const options = within(box('Vocabulary')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Select', 'CI Status · ci_status', 'priority · priority · factory'])
    await user.selectOptions(box('Vocabulary'), 'ci_status')
    await user.selectOptions(box('Type'), 'multi_enum')
    expect(latest.vocabulary).toBe('ci_status')
    // A type without choices must not keep a vocabulary: the API would refuse it.
    await user.selectOptions(box('Type'), 'number')
    expect(latest.vocabulary).toBe('')
  })

  it('"column in lists" is offered only to types that become a ticket property', async () => {
    const { user } = renderWithProviders(<Harness />)
    await user.click(screen.getByRole('checkbox', { name: /Show as a column/ }))
    expect(latest.inList).toBe(true)
    await user.selectOptions(box('Type'), 'attachment')
    expect(screen.queryByRole('checkbox', { name: /Show as a column/ })).toBeNull()
  })

  it('required, shared and the help texts are written into the draft', async () => {
    const { user } = renderWithProviders(<Harness />)
    await user.click(screen.getByRole('checkbox', { name: /Required in forms/ }))
    await user.click(screen.getByRole('checkbox', { name: /Share it in the library/ }))
    await user.type(box('Help text (Italian)'), 'Aiuto')
    await user.type(box('Help text (English)'), 'Help')
    expect(latest).toMatchObject({ required: true, shared: true, helpIt: 'Aiuto', helpEn: 'Help' })
  })

  it('a computable type offers the formula; the validation script is always there', async () => {
    const { user } = renderWithProviders(<Harness />)
    await user.type(box('Formula (computed field)'), 'return 1')
    await user.type(box('Validation script'), 'x')
    expect(latest).toMatchObject({ formula: 'return 1', validationScript: 'x' })
    await user.selectOptions(box('Type'), 'attachment')
    expect(screen.queryByLabelText('Formula (computed field)')).toBeNull()
  })

  it('a table has its columns editor, and adding a column changes the draft', async () => {
    const { user } = renderWithProviders(<Harness />)
    expect(screen.queryByRole('button', { name: /Add a column/ })).toBeNull()
    await user.selectOptions(box('Type'), 'table')
    await user.click(screen.getByRole('button', { name: /Add a column/ }))
    expect(latest.tabella.columns).toHaveLength(1)
  })
})

describe('reference to the CMDB', () => {
  it('the CI types are not even asked for on a non-reference field', () => {
    renderWithProviders(<Harness />)
    expect(apolloFinto.chiamate['GetCITypes']).toBeUndefined()
    expect(screen.queryByTestId('filter-builder')).toBeNull()
  })

  it('offers only active CI types, and ticking/unticking narrows the search', async () => {
    const { user } = renderWithProviders(<Harness initial={{ ...BOZZA_VUOTA, fieldType: 'ref_ci' }} />)
    expect(screen.getByRole('checkbox', { name: 'Server' })).toBeInTheDocument()
    // No label: the name stands in.
    expect(screen.getByRole('checkbox', { name: 'printer' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Mainframe' })).toBeNull()
    await user.click(screen.getByRole('checkbox', { name: 'Server' }))
    await user.click(screen.getByRole('checkbox', { name: 'printer' }))
    expect(latest.refTypes).toEqual(['server', 'printer'])
    await user.click(screen.getByRole('checkbox', { name: 'Server' }))
    expect(latest.refTypes).toEqual(['printer'])
    // The filter offers the common fields plus only the chosen type's own properties.
    expect(screen.getByTestId('filter-fields')).toHaveTextContent('toner:text')
    expect(screen.getByTestId('filter-fields')).not.toHaveTextContent('os:')
    // Status and environment are choices from the metamodel, not free text.
    expect(screen.getByTestId('filter-fields')).toHaveTextContent('status:enum')
    expect(screen.getByTestId('filter-fields')).toHaveTextContent('health:enum')
  })

  it('with no CI type defined it says so', () => {
    apolloFinto.risposte['GetCITypes'] = { ciTypes: [] }
    renderWithProviders(<Harness initial={{ ...BOZZA_VUOTA, fieldType: 'ref_ci' }} />)
    expect(screen.getByText('No CI type is defined yet.')).toBeInTheDocument()
  })

  it('an applied filter is stored as JSON and counted; clearing or emptying it removes it', async () => {
    const { user } = renderWithProviders(<Harness initial={{ ...BOZZA_VUOTA, fieldType: 'ref_ci' }} />)
    expect(screen.getByText(/No filter: the search offers every CI/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'apply one rule' }))
    expect(JSON.parse(latest.refFilter)).toMatchObject({ rules: [{ field: 'environment', value: 'production' }] })
    expect(screen.getByText(/One rule: the search only offers/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'apply empty' }))
    expect(latest.refFilter).toBe('')
    await user.click(screen.getByRole('button', { name: 'apply one rule' }))
    await user.click(screen.getByRole('button', { name: 'clear filter' }))
    expect(latest.refFilter).toBe('')
  })

  it('a saved filter reopens with its rules; an unreadable or rule-less one opens empty', () => {
    const rules = { rules: [{ id: 'a' }, { id: 'b' }] }
    const { unmount } = renderWithProviders(<Harness initial={{ ...BOZZA_VUOTA, fieldType: 'ref_ci', refFilter: JSON.stringify(rules) }} />)
    expect(screen.getByTestId('filter-initial')).toHaveTextContent('2')
    expect(screen.getByText(/2 rules: the search only offers/)).toBeInTheDocument()
    unmount()
    const rem = renderWithProviders(<Harness initial={{ ...BOZZA_VUOTA, fieldType: 'ref_ci', refFilter: '{"other":1}' }} />)
    expect(screen.getByTestId('filter-initial')).toHaveTextContent('0')
    rem.unmount()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderWithProviders(<Harness initial={{ ...BOZZA_VUOTA, fieldType: 'ref_ci', refFilter: 'garbage' }} />)
    // An unreadable filter must not stop the editor: it opens empty and says why in the console.
    expect(screen.getAllByTestId('filter-initial').at(-1)).toHaveTextContent('0')
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Unreadable CMDB filter'), expect.anything())
  })
})

describe('save and cancel', () => {
  it('the save button carries the caller label, or "Saving..." while saving; both buttons call back', async () => {
    const onSalva = vi.fn()
    const onAnnulla = vi.fn()
    const { user, rerender } = renderWithProviders(<Harness onSalva={onSalva} onAnnulla={onAnnulla} etichettaSalva="Add to form" />)
    await user.click(screen.getByRole('button', { name: 'Add to form' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onSalva).toHaveBeenCalledTimes(1)
    expect(onAnnulla).toHaveBeenCalledTimes(1)
    rerender(<Harness onSalva={onSalva} onAnnulla={onAnnulla} etichettaSalva="Add to form" salvando />)
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeInTheDocument()
  })
})
