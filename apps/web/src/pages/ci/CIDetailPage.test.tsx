import { describe, it, expect } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { gql } from '@apollo/client'
import i18n from '@/i18n/i18n'
import { CIDetailPage } from './CIDetailPage'
import { MetamodelProvider } from '@/contexts/MetamodelContext'
import { GET_CI_TYPES, GET_BLAST_RADIUS, GET_CI_INCIDENTS, GET_CI_CHANGES, GET_WORKFLOW_DEFINITION } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { teamsMock } from '@/test/mocks/gql'

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

const field = (name: string, fieldType: string, order: number, enumValues: string[] = []) => ({
  __typename: 'CIField', id: `f-${name}`, name, label: name, fieldType, required: false, enumValues, order, isSystem: true,
  validationScript: null, visibilityScript: null, defaultScript: null,
})

const ciTypesMock: GqlMock = {
  request: { query: GET_CI_TYPES },
  result: { data: { ciTypes: [{
    __typename: 'CIType', id: 'ct-server', name: 'server', label: 'Server', icon: 'server', color: '#0284c7', active: true,
    validationScript: null, chainFamilies: [],
    fields: [field('name', 'string', 1), field('status', 'enum', 2, ['active', 'inactive']), field('environment', 'enum', 3, ['production', 'staging']), field('ip_address', 'string', 4)],
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

const mocks = () => [
  ciTypesMock, detailMock, teamsMock(),
  any(GET_BLAST_RADIUS, { blastRadius: [] }),
  any(GET_CI_INCIDENTS, { ciIncidents: [] }),
  any(GET_CI_CHANGES, { ciChanges: [] }),
  any(GET_WORKFLOW_DEFINITION, { workflowDefinition: null }),
  any(GET_ATTACHMENTS, { attachments: [] }),
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
