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
import { screen, within } from '@testing-library/react'
import { EnumDesignerPage } from './EnumDesignerPage'
import { GET_ENUM_TYPES } from '@/graphql/queries'
import { CUSTOMIZE_ENUM_TYPE } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const enumType = (over: Record<string, unknown>) => ({
  __typename: 'EnumTypeDefinition',
  id: 'e-1', name: 'severity', label: 'Severità', values: ['low', 'high'],
  isSystem: true, isShipped: true, scope: 'itil',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

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
  it('l\'elenco distingue «spedito col prodotto» da «tuo»', async () => {
    renderWithProviders(<EnumDesignerPage />, { mocks: mocks() })
    const shippedRow = (await screen.findByRole('button', { name: /Severità/ }))
    expect(within(shippedRow).getByText('Shipped with the product')).toBeInTheDocument()
    const ownRow = screen.getByRole('button', { name: /Colore sede/ })
    expect(within(ownRow).getByText('Yours')).toBeInTheDocument()
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
})
