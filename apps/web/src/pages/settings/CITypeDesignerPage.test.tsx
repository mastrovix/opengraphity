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
import { GET_CI_TYPES, GET_BASE_CI_TYPE, GET_ENUM_TYPES, GET_CI_TYPE_DELETION_IMPACT, GET_CI_FIELD_VALUE_COUNT } from '@/graphql/queries'
import { DELETE_CI_TYPE } from '@/graphql/mutations'
import { toast } from 'sonner'
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

    expect(screen.getByText(/ships with the product/)).toBeInTheDocument()
    expect(screen.getByText(/one type for every tenant/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save settings/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Delete the type/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: '● Active' })).toBeDisabled()
  })

  it('«Aggiungi campo» e «Aggiungi relazione» sono disattivati', async () => {
    const r = await openType('Server', [SHIPPED, OWN])
    await r.user.click(screen.getByRole('tab', { name: 'Fields' }))
    expect(screen.getByRole('button', { name: /Add a field/ })).toBeDisabled()
    await r.user.click(screen.getByRole('tab', { name: 'CI relationships' }))
    expect(screen.getByRole('button', { name: /Add a relationship/ })).toBeDisabled()
  })

  it('su un tipo PROPRIO le stesse azioni sono attive', async () => {
    const r = await openType('Load Balancer', [SHIPPED, OWN])
    expect(screen.queryByText(/one type for every tenant/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save settings/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Delete the type/ })).toBeEnabled()
    await r.user.click(screen.getByRole('tab', { name: 'Fields' }))
    expect(screen.getByRole('button', { name: /Add a field/ })).toBeEnabled()
  })
})

describe('il nome del tipo nuovo è validato prima di inviarlo (A-12)', () => {
  async function openCreate(types: unknown[]) {
    const r = renderWithProviders(<CITypeDesignerPage />, { mocks: mocks(types) })
    const nuovo = await waitFor(() => screen.getByRole('button', { name: /New/ }))
    await r.user.click(nuovo)
    return r
  }

  it('un nome già preso: errore accanto al campo e «Crea tipo» spento', async () => {
    const r = await openCreate([SHIPPED, OWN])
    await r.user.type(screen.getByLabelText(/name \(slug/), 'server')
    const err = await screen.findByRole('alert')
    expect(err).toHaveTextContent(/is already taken/)
    // La ragione vera: GraphQL fonde i tipi omonimi in silenzio.
    expect(err).toHaveTextContent(/MERGES them silently/)
    expect(screen.getByRole('button', { name: /Create the type/ })).toBeDisabled()
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
    await r.user.type(screen.getByLabelText(/Label/), 'Firewall')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Create the type/ })).toBeEnabled()
  })
})

describe('il nome del campo nuovo è validato prima di inviarlo (A-12)', () => {
  async function openNewField() {
    const r = await openType('Load Balancer', [SHIPPED, OWN])
    await r.user.click(screen.getByRole('tab', { name: 'Fields' }))
    await r.user.click(screen.getByRole('button', { name: /Add a field/ }))
    return r
  }

  it('tenantId: il messaggio dice che il CI nascerebbe in un altro cliente, e «Salva» è spento', async () => {
    const r = await openNewField()
    await r.user.type(screen.getByLabelText(/name \(camelCase/), 'tenantId')
    const err = await screen.findByRole('alert')
    expect(err).toHaveTextContent('tenant_id')
    expect(err).toHaveTextContent(/the CI would be born in the tenant chosen by the caller/)
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled()
  })

  it('un campo base: lo dice invece di produrre un campo dichiarato due volte', async () => {
    const r = await openNewField()
    await r.user.type(screen.getByLabelText(/name \(camelCase/), 'status')
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists on every CI/)
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
    expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled()
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

// ── Regola del 15 set 2026: la cancellazione di un tipo ──────────────────────
// Blocca solo un ticket che cita un CI del tipo; il resto va via col tipo,
// quindi la conferma lo elenca PRIMA.

describe('eliminare un tipo: la conferma dice cosa va via, e solo un ticket la blocca', () => {
  const ZERO = { __typename: 'CITypeDeletionImpact', cis: 0, ticketCIs: 0, tickets: 0, ticketCIExclusions: 0, groupsUpdated: 0, groupsDeleted: 0, fieldVisibilityRules: 0, fieldRequirementRules: 0, businessRules: 0, autoTriggers: 0, customWidgets: 0, reportSections: 0, assessmentQuestionLinks: 0, blockingServiceMaps: [] as string[] }
  const impactMock = (over: Record<string, number | string[]>): GqlMock => ({
    request: { query: GET_CI_TYPE_DELETION_IMPACT, variables: { id: 't-own' } },
    result: { data: { ciTypeDeletionImpact: { ...ZERO, ...over } } },
  })

  async function open(extra: GqlMock[]) {
    const r = renderWithProviders(<CITypeDesignerPage />, { mocks: [...mocks([OWN]), ...extra] })
    await r.user.click(await waitFor(() => screen.getByText('Load Balancer')))
    return r
  }

  it('un tipo appena creato: la conferma elenca solo i collegamenti alle domande, e si cancella', async () => {
    const seen: unknown[] = []
    const del: GqlMock = { request: { query: DELETE_CI_TYPE, variables: (v) => { seen.push(v); return true } }, result: { data: { deleteCIType: true } } }
    const r = await open([impactMock({ assessmentQuestionLinks: 2 }), del])
    await r.user.click(screen.getByRole('button', { name: /Delete the type/ }))
    const body = await screen.findByTestId('ci-type-deletion-impact')
    expect(body).toHaveTextContent('Together with the type, these are deleted:')
    expect(body).toHaveTextContent('the links to 2 assessment questions (the questions stay)')
    await r.user.click(screen.getByRole('button', { name: /^Delete$|Confirm/ }))
    await waitFor(() => expect(seen).toEqual([{ id: 't-own' }]))
  })

  it('CI e riferimenti: ogni voce col suo numero', async () => {
    const r = await open([impactMock({ cis: 12, groupsDeleted: 1, businessRules: 2 })])
    await r.user.click(screen.getByRole('button', { name: /Delete the type/ }))
    const body = await screen.findByTestId('ci-type-deletion-impact')
    expect(body).toHaveTextContent('12 CIs of this type, with their relationships')
    expect(body).toHaveTextContent('1 dynamic group that listed only this type')
    expect(body).toHaveTextContent('2 business rules')
  })

  it('in un ticket: nessuna conferma, il motivo coi numeri', async () => {
    const r = await open([impactMock({ cis: 5, ticketCIs: 3, tickets: 4 })])
    await r.user.click(screen.getByRole('button', { name: /Delete the type/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('«Load Balancer» cannot be deleted: 3 of its CIs are linked to 4 ticket(s), closed ones included.'))
    expect(screen.queryByTestId('ci-type-deletion-impact')).not.toBeInTheDocument()
  })

  it('U-16: una mappa di servizio che segue le sue relazioni lo blocca, e lo si dice prima della conferma', async () => {
    const r = await open([impactMock({ cis: 1, blockingServiceMaps: ['Portale clienti'] })])
    await r.user.click(screen.getByRole('button', { name: /Delete the type/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('its relationships are followed by service map «Portale clienti»')))
    expect(screen.queryByTestId('ci-type-deletion-impact')).not.toBeInTheDocument()
  })
})

// ── Secondo giro UI del 15 set 2026 · V-15 ───────────────────────────────────
describe('CITypeDesignerPage — cancellazione di un campo con valori', () => {
  it('la conferma dice su quanti CI il valore se ne va', async () => {
    const field = { __typename: 'CIFieldDefinition', id: 'f-porta', name: 'porta', label: 'Porta', fieldType: 'number', required: false, enumValues: [], order: 1, enumTypeName: null, isSystem: false, validationScript: null, visibilityScript: null, defaultScript: null }
    const typed = ciType({ fields: [field] })
    const count: GqlMock = { request: { query: GET_CI_FIELD_VALUE_COUNT, variables: { typeId: 't-own', fieldId: 'f-porta' } }, result: { data: { ciFieldValueCount: 3 } } }
    const r = renderWithProviders(<CITypeDesignerPage />, { mocks: [...mocks([typed]), count] })
    await r.user.click(await waitFor(() => screen.getByText('Load Balancer')))
    await r.user.click(await screen.findByRole('tab', { name: 'Fields' }))
    await r.user.click(await screen.findByRole('button', { name: 'Delete porta' }))
    expect(await screen.findByText('3 CIs have a value in this field: they are deleted with the field (the previous values stay in the Audit Log).')).toBeInTheDocument()
  })
})

