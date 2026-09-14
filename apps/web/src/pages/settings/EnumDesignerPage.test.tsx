/**
 * Dizionario (B1-4, A-2): l'interfaccia dice DI CHI è un vocabolario e cosa si
 * può farne.
 *
 * Prima, `isSystem` era l'unica cosa mostrata — ed è una protezione, non un
 * proprietario (è vero anche sulle copie per tenant seminate in passato):
 * i vocabolari spediti col prodotto e i propri si vedevano uguali. E un
 * vocabolario spedito non si modifica in posto: l'interfaccia lo dice invece
 * di lasciar provare e fallire, e offre «Personalizza», che ne crea la copia
 * del tenant e apre quella.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { EnumDesignerPage } from './EnumDesignerPage'
import { GET_ENUM_TYPES, GET_ENUM_SHIPPED_DRIFT } from '@/graphql/queries'
import { ACKNOWLEDGE_SHIPPED_VALUES, ADOPT_SHIPPED_VALUES, CUSTOMIZE_ENUM_TYPE, UPDATE_ENUM_TYPE } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

/**
 * `valueLabels` c'è SEMPRE (il server la completa: valore con le iniziali
 * maiuscole dove l'admin non ha scritto un'etichetta), quindi la finzione la
 * deriva dai valori invece di ometterla — altrimenti il test proverebbe una
 * forma che l'API non produce, che è il modo in cui un test finisce per
 * asserire una bugia.
 */
const etichette = (values: string[], scritte: Record<string, string> = {}) =>
  values.map((v) => ({
    __typename: 'EnumValueLabel',
    value: v,
    label: scritte[v] ?? v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    // `labels` porta le lingue DAVVERO scritte: assente = non scritta, non vuota.
    labels: scritte[v] ? [{ __typename: 'LocalizedLabel', language: 'it', label: scritte[v]! }] : [],
  }))

const enumType = (over: Record<string, unknown>) => {
  const base: Record<string, unknown> = {
    __typename: 'EnumTypeDefinition',
    id: 'e-1', name: 'severity', label: 'Severità', values: ['low', 'high'],
    isSystem: true, isShipped: true, scope: 'itil',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
  return { ...base, valueLabels: base.valueLabels ?? etichette(base.values as string[]), valueColors: base.valueColors ?? [] }
}

const SHIPPED = enumType({})
const OWN     = enumType({ id: 'e-2', name: 'colore_sede', label: 'Colore sede', values: ['rosso'], isSystem: false, isShipped: false, scope: 'cmdb' })
const COPY    = enumType({ id: 'e-3', isSystem: false, isShipped: false })

const listMock = (items: unknown[]): GqlMock => ({
  request: { query: GET_ENUM_TYPES },
  result:  { data: { enumTypes: items } },
})

const customizeMock: GqlMock = {
  request: { query: CUSTOMIZE_ENUM_TYPE, variables: { id: 'e-1' } },
  result:  { data: { customizeEnumType: COPY } },
}

const mocks = (extra: readonly GqlMock[] = []) => [
  listMock([SHIPPED, OWN]),
  ...extra,
  { ...listMock([SHIPPED, OWN, COPY]), maxUsageCount: Number.POSITIVE_INFINITY },
]

describe('Dizionario — di chi è il vocabolario', () => {
  /**
   * Terza revisione: il distintivo stava anche nelle righe della lista, e con
   * `flexShrink: 0` e la parola intera schiacciava il NOME a 16 pixel — una
   * lettera e i puntini, senza `title`. Ora l'appartenenza sta nel NOME
   * ACCESSIBILE della riga (dove la legge chi non vede l'icona) e il distintivo
   * intero resta nel pannello di destra. Il test si sposta con lei: non si
   * pinna il pixel, si pinna che l'informazione ci sia ancora.
   */
  it('l\'elenco dice di chi e il vocabolario, nel nome accessibile della riga', async () => {
    renderWithProviders(<EnumDesignerPage />, { mocks: mocks() })
    const shippedRow = await screen.findByRole('button', { name: /Severità/ })
    expect(shippedRow).toHaveAccessibleName(/Shipped with the product/)
    expect(shippedRow).toHaveAccessibleName(/2 values/)
    const ownRow = screen.getByRole('button', { name: /Colore sede/ })
    expect(ownRow).toHaveAccessibleName(/Yours/)
  })

  it('e il nome del vocabolario resta recuperabile col puntatore anche se la colonna lo taglia', async () => {
    renderWithProviders(<EnumDesignerPage />, { mocks: mocks() })
    const row = await screen.findByRole('button', { name: /Severità/ })
    // `title` sul nome: senza, un nome tagliato era irrecuperabile.
    expect(row.querySelector('[title="Severità"]')).not.toBeNull()
  })

  it('un vocabolario spedito non si modifica in posto: campi in sola lettura, spiegazione, nessuna eliminazione', async () => {
    const { user } = renderWithProviders(<EnumDesignerPage />, { mocks: mocks() })
    await user.click(await screen.findByRole('button', { name: /Severità/ }))

    expect(screen.getByText(/it is the same for every customer/)).toBeInTheDocument()
    expect(screen.getByLabelText('Label')).toHaveAttribute('readonly')
    expect(screen.getByLabelText('Scope')).toBeDisabled()
    // niente aggiunta o rimozione di valori, niente elimina
    expect(screen.queryByRole('textbox', { name: 'Add value' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Remove value low')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Customize/ })).toBeInTheDocument()
  })

  it('un vocabolario proprio resta modificabile (ed eliminabile)', async () => {
    const { user } = renderWithProviders(<EnumDesignerPage />, { mocks: mocks() })
    await user.click(await screen.findByRole('button', { name: /Colore sede/ }))

    expect(screen.getByLabelText('Label')).not.toHaveAttribute('readonly')
    expect(screen.getByRole('textbox', { name: 'Add value' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Customize/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/it is the same for every customer/)).not.toBeInTheDocument()
  })

  it('«Personalizza» crea la copia del tenant e apre QUELLA in modifica', async () => {
    const { user } = renderWithProviders(<EnumDesignerPage />, { mocks: mocks([customizeMock]) })
    await user.click(await screen.findByRole('button', { name: /Severità/ }))
    await user.click(screen.getByRole('button', { name: /Customize/ }))

    // la copia è selezionata: stessi valori, ma modificabile
    expect(await screen.findByRole('textbox', { name: 'Add value' })).toBeInTheDocument()
    expect(screen.getByLabelText('Label')).not.toHaveAttribute('readonly')
    expect(screen.getByLabelText('Technical name')).toHaveValue('severity')
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Customize/ })).not.toBeInTheDocument()
  })

  /**
   * Revisione del 14 set 2026 · F9: il colore di un valore si sceglie qui,
   * accanto all'etichetta, da una palette chiusa. Prima era una tabella nel web.
   */
  it('il colore di un valore si sceglie dal Dizionario e si salva con gli altri', async () => {
    const seen: unknown[] = []
    const OWN_COLORED = enumType({ id: 'e-2', name: 'colore_sede', label: 'Colore sede', values: ['rosso', 'verde'], isSystem: false, isShipped: false, scope: 'cmdb',
      valueColors: [{ __typename: 'EnumValueColor', value: 'verde', color: 'success' }] })
    const update: GqlMock = {
      request: { query: UPDATE_ENUM_TYPE, variables: (v) => { seen.push(v); return true } },
      result: { data: { updateEnumType: { ...OWN_COLORED } } },
    }
    const { user } = renderWithProviders(<EnumDesignerPage />, {
      mocks: [{ ...listMock([SHIPPED, OWN_COLORED]), maxUsageCount: Number.POSITIVE_INFINITY }, update],
    })
    await user.click(await screen.findByRole('button', { name: /Colore sede/ }))
    expect(screen.getByLabelText('Color of value verde')).toHaveValue('success')
    await user.selectOptions(screen.getByLabelText('Color of value rosso'), 'danger')
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ id: 'e-2', input: { valueColors: [{ value: 'rosso', color: 'danger' }, { value: 'verde', color: 'success' }] } })
  })

  it('su un vocabolario spedito il colore si vede ma non si cambia in posto', async () => {
    const SHIPPED_COLORED = enumType({ valueColors: [{ __typename: 'EnumValueColor', value: 'high', color: 'orange' }] })
    const { user } = renderWithProviders(<EnumDesignerPage />, { mocks: [{ ...listMock([SHIPPED_COLORED, OWN]), maxUsageCount: Number.POSITIVE_INFINITY }] })
    await user.click(await screen.findByRole('button', { name: /Severità/ }))
    expect(screen.getByLabelText('Color of value high')).toBeDisabled()
    expect(screen.getByLabelText('Color of value high')).toHaveValue('orange')
  })
})

/**
 * Revisione del 14 set 2026 · F20: il prodotto ha aggiunto valori a un
 * vocabolario spedito DOPO che il cliente l'ha personalizzato. La copia non si
 * sovrascrive, ma il Dizionario lo dice e fa decidere: aggiungerli o tenerli fuori.
 */
describe('Dizionario — valori spediti dopo la copia', () => {
  const BEHIND = enumType({ id: 'e-4', name: 'priority', label: 'Priorità', values: ['low', 'high'], isSystem: false, isShipped: false, scope: 'itil' })
  const drift = (values: string[]): GqlMock => ({
    request: { query: GET_ENUM_SHIPPED_DRIFT },
    result:  { data: { enumTypes: [{ __typename: 'EnumTypeDefinition', id: 'e-4', newShippedValues: values }, { __typename: 'EnumTypeDefinition', id: 'e-2', newShippedValues: [] }] } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  })
  const list: GqlMock = { ...listMock([BEHIND, OWN]), maxUsageCount: Number.POSITIVE_INFINITY }

  it('la copia indietro mostra i valori nuovi; «Add them» li aggiunge', async () => {
    const seen: unknown[] = []
    const adopt: GqlMock = {
      request: { query: ADOPT_SHIPPED_VALUES, variables: (v) => { seen.push(v); return true } },
      result:  { data: { adoptShippedValues: { ...BEHIND, values: ['low', 'high', 'critical'], valueLabels: etichette(['low', 'high', 'critical']) } } },
    }
    const { user } = renderWithProviders(<EnumDesignerPage />, { mocks: [list, drift(['critical']), adopt] })
    await user.click(await screen.findByRole('button', { name: /Priorità/ }))
    expect(await screen.findByText(/added values .* after you customized it: critical/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add them' }))
    await vi.waitFor(() => expect(seen).toEqual([{ id: 'e-4' }]))
  })

  it('«Keep my list» li tiene fuori', async () => {
    const seen: unknown[] = []
    const acknowledge: GqlMock = {
      request: { query: ACKNOWLEDGE_SHIPPED_VALUES, variables: (v) => { seen.push(v); return true } },
      result:  { data: { acknowledgeShippedValues: BEHIND } },
    }
    const { user } = renderWithProviders(<EnumDesignerPage />, { mocks: [list, drift(['critical']), acknowledge] })
    await user.click(await screen.findByRole('button', { name: /Priorità/ }))
    await user.click(await screen.findByRole('button', { name: 'Keep my list' }))
    await vi.waitFor(() => expect(seen).toEqual([{ id: 'e-4' }]))
  })

  it('una copia al passo non mostra niente', async () => {
    const { user } = renderWithProviders(<EnumDesignerPage />, { mocks: [list, drift([])] })
    await user.click(await screen.findByRole('button', { name: /Priorità/ }))
    expect(screen.queryByRole('button', { name: 'Add them' })).not.toBeInTheDocument()
  })
})
