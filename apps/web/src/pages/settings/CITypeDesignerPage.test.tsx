/**
 * Disegnatore dei tipi CI (A-12 / A-6): il nome è un identificatore, e
 * l'interfaccia dice quali azioni hanno effetto.
 *
 * Prima: un tipo spedito col prodotto si selezionava come gli altri e offriva
 * «Salva impostazioni», «Aggiungi campo», «Aggiungi relazione», «Elimina
 * tipo» — tutte mutation con `WHERE t.scope = 'tenant'`, che su quei tipi
 * eseguivano ZERO righe senza lanciare; il toast su `onCompleted` diceva
 * «Salvato» e i dati erano quelli di prima.
 *
 * E il nome di un tipo nuovo non era validato da nessuna parte lato server: un
 * tipo chiamato `server` verrebbe FUSO in silenzio col tipo del prodotto.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { CITypeDesignerPage } from './CITypeDesignerPage'
import { GET_CI_TYPES, GET_BASE_CI_TYPE, GET_ENUM_TYPES } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const ciType = (over: Record<string, unknown>) => ({
  __typename: 'CITypeDefinition',
  id: 't-own', name: 'load_balancer', label: 'Load Balancer', icon: 'box', color: '#0284c7',
  active: true, scope: 'tenant', tenantId: 'c-two',
  validationScript: null, chainFamilies: ['Infrastructure'], serviceRole: null,
  fields: [], relations: [], systemRelations: [],
  ...over,
})

const OWN     = ciType({})
const SHIPPED = ciType({ id: 't-server', name: 'server', label: 'Server', scope: 'base', tenantId: 'system' })

const mocks = (types: unknown[]): GqlMock[] => [
  { request: { query: GET_CI_TYPES },     result: { data: { ciTypes: types } },     maxUsageCount: 10 },
  { request: { query: GET_BASE_CI_TYPE }, result: { data: { baseCIType: ciType({ id: 'b', name: '__base__', label: '__base__', scope: 'base', tenantId: 'system' }) } }, maxUsageCount: 10 },
  { request: { query: GET_ENUM_TYPES },   result: { data: { enumTypes: [] } },      maxUsageCount: 10 },
]

async function openType(label: string, types: unknown[]) {
  const r = renderWithProviders(<CITypeDesignerPage />, { mocks: mocks(types) })
  const btn = await waitFor(() => screen.getByText(label))
  await r.user.click(btn)
  return r
}

describe('un tipo spedito col prodotto: le azioni sono spente e il perché si legge (A-6)', () => {
  it('mostra il badge, la nota, e disattiva salva/elimina/attivo', async () => {
    await openType('Server', [SHIPPED, OWN])

    expect(screen.getByText(/spedito col prodotto/)).toBeInTheDocument()
    expect(screen.getByText(/è un solo tipo per tutti i clienti/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Salva impostazioni/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Elimina tipo/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: '● active' })).toBeDisabled()
  })

  it('«Aggiungi campo» e «Aggiungi relazione» sono disattivati', async () => {
    const r = await openType('Server', [SHIPPED, OWN])
    await r.user.click(screen.getByRole('tab', { name: 'Campi' }))
    expect(screen.getByRole('button', { name: /Aggiungi campo/ })).toBeDisabled()
    await r.user.click(screen.getByRole('tab', { name: 'Relazioni CI' }))
    expect(screen.getByRole('button', { name: /Aggiungi relazione/ })).toBeDisabled()
  })

  it('su un tipo PROPRIO le stesse azioni sono attive', async () => {
    const r = await openType('Load Balancer', [SHIPPED, OWN])
    expect(screen.queryByText(/è un solo tipo per tutti i clienti/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Salva impostazioni/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Elimina tipo/ })).toBeEnabled()
    await r.user.click(screen.getByRole('tab', { name: 'Campi' }))
    expect(screen.getByRole('button', { name: /Aggiungi campo/ })).toBeEnabled()
  })
})

describe('il nome del tipo nuovo è validato prima di inviarlo (A-12)', () => {
  async function openCreate(types: unknown[]) {
    const r = renderWithProviders(<CITypeDesignerPage />, { mocks: mocks(types) })
    const nuovo = await waitFor(() => screen.getByRole('button', { name: /Nuovo/ }))
    await r.user.click(nuovo)
    return r
  }

  it('un nome già preso: errore accanto al campo e «Crea tipo» spento', async () => {
    const r = await openCreate([SHIPPED, OWN])
    await r.user.type(screen.getByLabelText(/name \(slug/), 'server')
    const err = await screen.findByRole('alert')
    expect(err).toHaveTextContent(/già preso/)
    // La ragione vera: GraphQL fonde i tipi omonimi in silenzio.
    expect(err).toHaveTextContent(/FONDE in silenzio/)
    expect(screen.getByRole('button', { name: /Crea tipo/ })).toBeDisabled()
  })

  it('un nome non identificatore: dice la regola e cosa scrivere invece', async () => {
    const r = await openCreate([OWN])
    // Il campo sanifica in snake_case, quindi il caso che resta è la cifra
    // iniziale — che `toPascalCase` porterebbe in un tipo GraphQL non valido.
    await r.user.type(screen.getByLabelText(/name \(slug/), '2fa')
    const err = await screen.findByRole('alert')
    expect(err).toHaveTextContent('^[a-z][a-z0-9_]*$')
    expect(err).toHaveTextContent('fa2')
  })

  it('un nome libero: nessun errore e «Crea tipo» attivo', async () => {
    const r = await openCreate([SHIPPED, OWN])
    await r.user.type(screen.getByLabelText(/name \(slug/), 'firewall')
    await r.user.type(screen.getByLabelText(/label/), 'Firewall')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Crea tipo/ })).toBeEnabled()
  })
})

describe('il nome del campo nuovo è validato prima di inviarlo (A-12)', () => {
  async function openNewField() {
    const r = await openType('Load Balancer', [SHIPPED, OWN])
    await r.user.click(screen.getByRole('tab', { name: 'Campi' }))
    await r.user.click(screen.getByRole('button', { name: /Aggiungi campo/ }))
    return r
  }

  it('tenantId: il messaggio dice che il CI nascerebbe in un altro cliente, e «Salva» è spento', async () => {
    const r = await openNewField()
    await r.user.type(screen.getByLabelText(/name \(camelCase/), 'tenantId')
    const err = await screen.findByRole('alert')
    expect(err).toHaveTextContent('tenant_id')
    expect(err).toHaveTextContent(/il CI nascerebbe nel cliente scelto dal chiamante/)
    expect(screen.getByRole('button', { name: /Salva/ })).toBeDisabled()
  })

  it('un campo base: lo dice invece di produrre un campo dichiarato due volte', async () => {
    const r = await openNewField()
    await r.user.type(screen.getByLabelText(/name \(camelCase/), 'status')
    expect(await screen.findByRole('alert')).toHaveTextContent(/esiste già su ogni CI/)
  })

  it('il campo non accetta più i trattini basso: li toglie mentre si scrive', async () => {
    const r = await openNewField()
    const input = screen.getByLabelText(/name \(camelCase/)
    await r.user.type(input, 'cost_center')
    expect(input).toHaveValue('costcenter')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('un nome camelCase libero: nessun errore', async () => {
    const r = await openNewField()
    await r.user.type(screen.getByLabelText(/name \(camelCase/), 'costCenter')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Salva/ })).toBeEnabled()
  })
})

// ── Ondata 6 · A-10: il ruolo nella mappa di un servizio è del TIPO ─────────
// Prima era una tabella per etichetta nel codice dell'API: un tipo creato dal
// cliente non aveva ruolo, e quindi non poteva entrare in nessuna mappa.

describe('ruolo nella mappa di un servizio (A-10)', () => {
  it('la tendina c\'è, parte da «proposto dal prodotto» e offre i tre ruoli (mai «ingresso»)', async () => {
    await openType('Load Balancer', [OWN])
    const select = screen.getByRole('combobox', { name: /Role in a service map/ })
    expect(select).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Proposed by the product' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Component/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Infrastructure/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Certificate/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /entry/i })).not.toBeInTheDocument()
  })

  it('il ruolo già dichiarato dal tipo è quello selezionato', async () => {
    await openType('Load Balancer', [ciType({ serviceRole: 'component' })])
    expect(screen.getByRole('combobox', { name: /Role in a service map/ })).toHaveValue('component')
  })

  it('su un tipo spedito col prodotto la tendina è spenta come il resto', async () => {
    await openType('Server', [SHIPPED, OWN])
    expect(screen.getByRole('combobox', { name: /Role in a service map/ })).toBeDisabled()
  })
})
