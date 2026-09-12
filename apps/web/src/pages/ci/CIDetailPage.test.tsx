import { describe, it, expect } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { gql } from '@apollo/client'
import i18n from '@/i18n/i18n'
import { CIDetailPage } from './CIDetailPage'
import { MetamodelProvider } from '@/contexts/MetamodelContext'
import { GET_CI_TYPES, GET_BLAST_RADIUS, GET_CI_INCIDENTS, GET_CI_CHANGES, GET_WORKFLOW_DEFINITION, GET_CI_HEALTH, GET_CI_ALIASES, GET_EVENTS, GET_SERVICES_IMPACTED_BY_CI } from '@/graphql/queries'
import { SET_CI_HEALTH_OVERRIDE } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { teamsMock, meMock } from '@/test/mocks/gql'

// Etichette dalla stessa sorgente i18n della pagina (non stringhe copiate a mano).
const T = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

// Il metamodello espone il tipo `server` con un solo campo specifico (ip_address):
// la pagina costruisce la query dinamica sotto, che qui replichiamo.
const DETAIL_QUERY = gql`
  query DynamicDetail_Server($id: ID!) {
    server(id: $id) {
      id name type status environment description createdAt updatedAt notes
      ownerGroup { id name }
      supportGroup { id name }
      dependencies { relation ci { id name type environment status } }
      dependents { relation ci { id name type environment status } }
      ip_address
    }
  }
`
const GET_ATTACHMENTS = gql`
  query GetAttachments($entityType: String!, $entityId: String!) {
    attachments(entityType: $entityType, entityId: $entityId) {
      id filename mimeType sizeBytes uploadedBy uploadedAt description downloadUrl
    }
  }
`

// A-5: `isSystem` qui era `true` su OGNI campo, `ip_address` compreso — ma
// `generateSDL` esclude i campi di sistema dallo SDL, quindi un campo così non
// è interrogabile e la pagina non deve chiederlo. Sul dato vero i campi
// specifici dei tipi spediti hanno `is_system` falso; di sistema sono i 9 campi
// di `__base__` (id, name, status, …), che la pagina esclude comunque per nome.
const field = (name: string, fieldType: string, order: number, enumValues: string[] = [], isSystem = false) => ({
  __typename: 'CIField', id: `f-${name}`, name, label: name, fieldType, required: false, enumValues, order, isSystem,
  validationScript: null, visibilityScript: null, defaultScript: null,
})

const ciTypesMock: GqlMock = {
  request: { query: GET_CI_TYPES },
  result: { data: { ciTypes: [{
    __typename: 'CIType', id: 'ct-server', name: 'server', label: 'Server', icon: 'server', color: '#0284c7', active: true,
    validationScript: null, chainFamilies: [],
    fields: [
      field('name', 'string', 1, [], true), field('status', 'enum', 2, ['active', 'inactive'], true),
      field('environment', 'enum', 3, ['production', 'staging'], true), field('ip_address', 'string', 4),
      // Campo di sistema aggiunto al `__base__` condiviso: NON è nello SDL,
      // quindi la query dinamica non deve chiederlo (se lo chiedesse, la
      // pagina di dettaglio di ogni CI di ogni cliente risponderebbe
      // `Cannot query field "costo_annuo" on type "Server"`).
      field('costo_annuo', 'string', 5, [], true),
    ],
    relations: [], systemRelations: [],
  }] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

const ciRef = (id: string, name: string) => ({ __typename: 'CI', id, name, type: 'server', environment: 'production', status: 'active' })

const detailMock: GqlMock = {
  request: { query: DETAIL_QUERY, variables: () => true },
  result: { data: { server: {
    __typename: 'Server', id: 'srv-1', name: 'web-01', type: 'server', status: 'active', environment: 'production',
    description: 'Front-end web server', createdAt: '2026-01-01T00:00:00Z', updatedAt: null, notes: null,
    ownerGroup: null, supportGroup: null,
    dependencies: [{ __typename: 'CIRelation', relation: 'DEPENDS_ON', ci: ciRef('db-1', 'db-prod') }],
    dependents:   [{ __typename: 'CIRelation', relation: 'HOSTED_ON',  ci: ciRef('app-1', 'crm-app') }],
    ip_address: '10.0.0.7',
  } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

const any = (query: GqlMock['request']['query'], data: Record<string, unknown>): GqlMock =>
  ({ request: { query, variables: () => true }, result: { data }, maxUsageCount: Number.POSITIVE_INFINITY })

// Sezione "Salute" (Event Management): ciHealth + alias + ultimi eventi del CI.
const healthMock = (health: string | null, healthSource: string | null = health ? 'monitoring' : null): GqlMock => ({
  request: { query: GET_CI_HEALTH, variables: { ciId: 'srv-1' } },
  result: { data: { ciHealth: { __typename: 'CIHealthInfo', ciId: 'srv-1', health, healthSource, lastEventAt: health ? '2026-09-09T10:00:00Z' : null, firingEvents: health === 'down' ? 2 : 0 } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const mocks = (health: string | null = null, role = 'operator') => [
  ciTypesMock, detailMock, teamsMock(), meMock(role, { maxUsageCount: Number.POSITIVE_INFINITY }),
  any(GET_BLAST_RADIUS, { blastRadius: [] }),
  any(GET_CI_INCIDENTS, { ciIncidents: [] }),
  any(GET_CI_CHANGES, { ciChanges: [] }),
  any(GET_WORKFLOW_DEFINITION, { workflowDefinition: null }),
  any(GET_ATTACHMENTS, { attachments: [] }),
  healthMock(health),
  any(GET_CI_ALIASES, { ciAliases: [{ __typename: 'CIAlias', id: 'al-1', kind: 'hostname', value: 'web-01.acme.local', source: 'manual', createdAt: '2026-09-01T00:00:00Z', ci: { __typename: 'ConfigurationItemRef', id: 'srv-1', name: 'web-01', type: 'server', status: 'active', health } }] }),
  any(GET_EVENTS, { events: { __typename: 'EventPage', total: 0, items: [] } }),
  // Servizi monitorati che includono il CI: nessuno → la sezione non compare.
  any(GET_SERVICES_IMPACTED_BY_CI, { servicesImpactedByCI: [] }),
]

function renderPage(opts: { mocks?: GqlMock[]; route?: string; showWarnings?: boolean } = {}) {
  return renderWithProviders(
    <MetamodelProvider><CIDetailPage /></MetamodelProvider>,
    { mocks: opts.mocks ?? mocks(), route: opts.route ?? '/ci/server/srv-1', path: '/ci/:typeName/:id', showWarnings: opts.showWarnings },
  )
}

const location = () => screen.getByTestId('location').textContent
const relationsCard = () => screen.getByRole('button', { name: new RegExp(`^${T('pages.ci.relations')} \\(2\\)`) })
const dependencyRow = () => screen.getByRole('button', { name: /db-prod/ })

/** Apre la card Relazioni e il gruppo DEPENDS ON. */
async function openDependencies(user: ReturnType<typeof renderPage>['user']) {
  await screen.findByRole('heading', { level: 1, name: 'web-01' })
  const card = relationsCard()
  if (card.getAttribute('aria-expanded') === 'false') await user.click(card)
  const group = screen.getByRole('button', { name: /DEPENDS ON/ })
  if (group.getAttribute('aria-expanded') === 'false') await user.click(group)
}

describe('CIDetailPage', () => {
  it('carica il CI dal metamodello: titolo, campo specifico, icona del tipo e link alla lista', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { level: 1, name: 'web-01' })).toBeInTheDocument()
    expect(screen.getByText('10.0.0.7')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'server' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '← Server' })).toBeInTheDocument()
  })

  it('le righe delle relazioni sono bottoni navigabili (click e tastiera)', async () => {
    const { user } = renderPage()
    await openDependencies(user)
    const row = dependencyRow()
    expect(row).not.toHaveAttribute('aria-disabled')
    expect(row).toHaveAttribute('tabindex', '0')
    await user.click(row)
    await waitFor(() => expect(location()).toBe('/ci/server/db-1'))
  })

  it('in modalità modifica la navigazione dalle relazioni è bloccata, con tooltip; Annulla la riabilita', async () => {
    const { user } = renderPage()
    await openDependencies(user)

    await user.click(screen.getByRole('button', { name: T('common.edit') }))
    expect(await screen.findByDisplayValue('web-01')).toBeInTheDocument()       // form di edit aperto
    expect(screen.queryByRole('button', { name: T('common.edit') })).not.toBeInTheDocument()

    const row = dependencyRow()
    expect(row).toHaveAttribute('aria-disabled', 'true')
    expect(row).toHaveAttribute('title', T('pages.ci.navigationLockedWhileEditing'))
    expect(row).toHaveStyle({ cursor: 'not-allowed' })
    await user.click(row)
    row.focus()
    await user.keyboard('{Enter}')
    expect(location()).toBe('/ci/server/srv-1')                                 // nessuna navigazione

    // anche i dipendenti sono bloccati
    await user.click(screen.getByRole('button', { name: /HOSTED ON/ }))
    expect(screen.getByRole('button', { name: /crm-app/ })).toHaveAttribute('aria-disabled', 'true')

    await user.click(screen.getByRole('button', { name: T('common.cancel') }))
    expect(screen.queryByDisplayValue('web-01')).not.toBeInTheDocument()
    expect(dependencyRow()).not.toHaveAttribute('aria-disabled')
    dependencyRow().focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(location()).toBe('/ci/server/db-1'))
  })

  it('tipo CI assente dal metamodello → messaggio esplicito', async () => {
    renderPage({ route: '/ci/toaster/x-1', showWarnings: false })
    expect(await screen.findByText(T('pages.cmdb.notFound', { type: 'toaster' }))).toBeInTheDocument()
  })

  it('CI non trovato → messaggio e link di ritorno alla lista del tipo', async () => {
    const nullDetail: GqlMock = { request: { query: DETAIL_QUERY, variables: () => true }, result: { data: { server: null } }, maxUsageCount: Number.POSITIVE_INFINITY }
    const { user } = renderPage({ mocks: [ciTypesMock, nullDetail, teamsMock(), any(GET_BLAST_RADIUS, { blastRadius: [] })], route: '/ci/server/ghost' })
    expect(await screen.findByText(T('pages.ci.notFound'))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: T('pages.ci.backTo', { label: 'Server' }) }))
    expect(location()).toBe('/ci/server')
  })

  it('errore della query di dettaglio → QueryError con il messaggio', async () => {
    const err: GqlMock = { request: { query: DETAIL_QUERY, variables: () => true }, error: new Error('neo4j unavailable') }
    renderPage({ mocks: [ciTypesMock, err, teamsMock(), any(GET_BLAST_RADIUS, { blastRadius: [] })] })
    expect(await screen.findByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByText('neo4j unavailable')).toBeInTheDocument()
  })

  it('la card Relazioni conta dipendenze + dipendenti e le raggruppa', async () => {
    const { user } = renderPage()
    await screen.findByRole('heading', { level: 1, name: 'web-01' })
    const card = relationsCard()
    await user.click(card)
    const panel = document.getElementById(card.getAttribute('aria-controls')!)!
    expect(within(panel).getByText(T('pages.ci.dependencies'))).toBeInTheDocument()
    expect(within(panel).getByText(T('pages.ci.dependents'))).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: /DEPENDS ON \(1\)/ })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: /HOSTED ON \(1\)/ })).toBeInTheDocument()
  })
})

describe('CIDetailPage — sezione Salute (monitoraggio)', () => {
  const healthCard = () => screen.getByRole('button', { name: /^Health/ })

  it('salute sconosciuta: scheda chiusa, messaggio esplicito, alias elencati', async () => {
    const { user } = renderPage({ mocks: mocks(null) })
    await screen.findByRole('heading', { level: 1, name: 'web-01' })
    await waitFor(() => expect(healthCard()).toHaveAttribute('aria-expanded', 'false'))
    await user.click(healthCard())
    expect(await screen.findByText('No alarm has concerned this CI yet: health is unknown.')).toBeInTheDocument()
    expect(screen.getByText('web-01.acme.local')).toBeInTheDocument()
    expect(screen.getByText('No alarms for this CI.')).toBeInTheDocument()
  })

  it('CI giù: scheda aperta con badge, allarmi attivi con link alla console filtrata, forzatura per operator', async () => {
    const seen: unknown[] = []
    const overrideMock: GqlMock = {
      request: { query: SET_CI_HEALTH_OVERRIDE, variables: (v) => { seen.push(v); return true } },
      result: { data: { setCIHealthOverride: { __typename: 'CIHealthInfo', ciId: 'srv-1', health: 'degraded', healthSource: 'manual', lastEventAt: null, firingEvents: 2 } } },
    }
    const { user } = renderPage({ mocks: [...mocks('down'), overrideMock] })
    await screen.findByRole('heading', { level: 1, name: 'web-01' })
    await waitFor(() => expect(healthCard()).toHaveAttribute('aria-expanded', 'true'))
    expect(screen.getAllByText('Health: Down').length).toBeGreaterThan(0)
    expect(screen.getByText('Monitoring')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /View in the console/ })).toHaveAttribute('href', '/events?ciId=srv-1')

    // la forzatura parte con "Applica", non al cambio del select (D·1.12)
    await user.selectOptions(screen.getByLabelText('Force health'), 'degraded')
    expect(seen).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(seen).toEqual([{ ciId: 'srv-1', health: 'degraded' }]))
  })

  it('viewer: nessun controllo di forzatura né gestione alias', async () => {
    const { user } = renderPage({ mocks: mocks('operational', 'viewer') })
    await screen.findByRole('heading', { level: 1, name: 'web-01' })
    await waitFor(() => expect(healthCard()).toHaveAttribute('aria-expanded', 'true'))
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByLabelText('Force health')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
    await user.click(healthCard())
    expect(healthCard()).toHaveAttribute('aria-expanded', 'false')
  })
})
