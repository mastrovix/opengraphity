import { describe, it, expect } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { CIHealthPage } from './CIHealthPage'
import { GET_CI_HEALTH_OVERVIEW, GET_BASE_CI_TYPE } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock, teamsMock } from '@/test/mocks/gql'
import type { CIHealthOverview, CIHealthRow } from '@/types/events'

function row(over: Partial<CIHealthRow> & { id: string; name: string }): CIHealthRow {
  return {
    type: 'server', environment: 'production', health: 'down', healthSource: 'monitoring',
    healthSince: new Date(Date.now() - 42 * 60_000).toISOString(), lastEventAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    firingEvents: 2, dependents: 7, ownerTeam: 'DBA', ...over,
  }
}

const ROWS: CIHealthRow[] = [
  row({ id: 'ci-1', name: 'db-01' }),
  row({ id: 'ci-2', name: 'cache-02', health: 'degraded', firingEvents: 1, dependents: 3, ownerTeam: null }),
  row({ id: 'ci-3', name: 'app-03', type: 'application', health: 'operational', healthSource: 'manual', firingEvents: 0, dependents: 0, healthSince: null, lastEventAt: null }),
]

const OVERVIEW: CIHealthOverview = { down: 2, degraded: 1, operational: 5, unmonitored: 12, total: 3, items: ROWS }

type Vars = { filter: Record<string, unknown> | null; limit: number; offset: number }

function overviewMock(over: Partial<CIHealthOverview> = {}, seen?: Vars[]): GqlMock {
  const o = { ...OVERVIEW, ...over }
  return {
    request: { query: GET_CI_HEALTH_OVERVIEW, variables: (v) => { seen?.push(v as Vars); return true } },
    result: { data: { ciHealthOverview: { __typename: 'CIHealthOverview', ...o, items: o.items.map((r) => ({ __typename: 'CIHealthRow', ...r })) } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

/** Tipo base del metamodello con gli enum status/environment (useCIBaseEnums). */
const baseTypeMock = (): GqlMock => ({
  request: { query: GET_BASE_CI_TYPE },
  result: { data: { baseCIType: {
    __typename: 'CIType', id: 'base', name: '__base__', label: 'Base', icon: 'box', color: '#000', active: true, validationScript: null,
    fields: [
      { __typename: 'CIField', id: 'f1', name: 'status',      label: 'Status',      fieldType: 'enum', required: false, enumValues: ['active', 'inactive'], order: 1, isSystem: true, validationScript: null, visibilityScript: null, defaultScript: null },
      { __typename: 'CIField', id: 'f2', name: 'environment', label: 'Environment', fieldType: 'enum', required: false, enumValues: ['production', 'staging'], order: 2, isSystem: true, validationScript: null, visibilityScript: null, defaultScript: null },
    ],
    relations: [], systemRelations: [],
  } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

function renderPage(role: string, opts: { overview?: Partial<CIHealthOverview>; seen?: Vars[] } = {}) {
  return renderWithProviders(<CIHealthPage />, {
    route: '/monitoring/health',
    mocks: [meMock(role), overviewMock(opts.overview, opts.seen), teamsMock([{ id: 't1', name: 'DBA' }]), baseTypeMock()],
  })
}

/** Riquadro-contatore per etichetta (il nome accessibile è "numero etichetta contesto"). */
const tile = (label: 'Down' | 'Degraded' | 'Operational') => screen.getByRole('button', { name: new RegExp(`\\b${label}\\b`) })
const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')

describe('CIHealthPage', () => {
  it('contatori del tenant nei quattro riquadri e righe ordinate con salute, allarmi, impatto, squadra e origine', async () => {
    renderPage('operator')
    expect(await screen.findByRole('heading', { name: 'CI health' })).toBeInTheDocument()

    const down = tile('Down')
    expect(down).toHaveTextContent(/^2Down/)
    expect(down).toHaveAttribute('aria-pressed', 'false')
    expect(down).toHaveTextContent('with 7 dependent CIs')     // somma dei dipendenti delle righe giù in pagina
    expect(tile('Degraded')).toHaveTextContent(/^1Degraded/)
    expect(tile('Operational')).toHaveTextContent(/^5Operational/)
    expect(tile('Operational')).toHaveTextContent('of 8 monitored')
    // "senza monitoraggio" è informativo: nessun bottone, ma numero, etichetta e tooltip
    expect(screen.queryByRole('button', { name: /^12\b/ })).not.toBeInTheDocument()
    expect(screen.getByTitle('CIs no source has sent alarms for yet')).toHaveTextContent('12')
    expect(screen.getByTitle('CIs no source has sent alarms for yet')).toHaveTextContent('Not monitored')
    // giù + degradati > 0 → nessun pannello "tutto bene"
    expect(screen.queryByText('All monitored CIs are operational')).not.toBeInTheDocument()

    const rows = bodyRows()
    expect(rows).toHaveLength(3)
    expect(screen.getByText('3 CIs with health data')).toBeInTheDocument()
    expect(within(rows[0]!).getByRole('link', { name: 'db-01' })).toHaveAttribute('href', '/ci/server/ci-1')
    expect(within(rows[0]!).getByText('Down')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('for 42 min')).toBeInTheDocument()
    expect(within(rows[0]!).getByRole('link', { name: 'View the 2 active alarms of db-01' })).toHaveAttribute('href', '/events?ciId=ci-1')
    expect(within(rows[0]!).getByText('7 dependents')).toHaveAttribute('title', 'At least 5 CIs depend on this one: a failure here spreads')
    expect(within(rows[0]!).getByText('DBA')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('5 min ago')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('Monitoring')).toBeInTheDocument()

    expect(within(rows[1]!).getByText('Degraded')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('3 dependents')).toBeInTheDocument()

    expect(within(rows[2]!).getByText('Operational')).toBeInTheDocument()
    expect(within(rows[2]!).getByText('0')).toBeInTheDocument()               // nessun allarme → non è un link
    expect(within(rows[2]!).queryByRole('link', { name: /active alarms/ })).not.toBeInTheDocument()
    expect(within(rows[2]!).getByText('Never')).toBeInTheDocument()
    expect(within(rows[2]!).getByText('Manual')).toHaveAttribute('title', expect.stringMatching(/forced by an operator/))

    // intestazioni con scope, pulsanti della testata
    for (const th of screen.getAllByRole('columnheader')) expect(th).toHaveAttribute('scope', 'col')
    expect(screen.getByRole('button', { name: 'View on the map' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
  })

  it('il riquadro "Giù" filtra la tabella (aria-pressed) e un secondo clic toglie il filtro', async () => {
    const seen: Vars[] = []
    const { user } = renderPage('operator', { seen })
    await screen.findByRole('heading', { name: 'CI health' })
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen[0]!.filter).toBeNull()

    await user.click(tile('Down'))
    expect(tile('Down')).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(seen.at(-1)!.filter).toEqual({ health: ['down'] }))
    expect(seen.at(-1)).toMatchObject({ limit: 50, offset: 0 })

    await user.click(tile('Down'))
    expect(tile('Down')).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(seen.at(-1)!.filter).toBeNull())
  })

  it('i filtri della riga (ambiente dall\'enum base, squadra) finiscono nelle variabili della query', async () => {
    const seen: Vars[] = []
    const { user } = renderPage('operator', { seen })
    await screen.findByRole('heading', { name: 'CI health' })
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Environment' }), 'staging')
    await waitFor(() => expect(seen.at(-1)!.filter).toEqual({ environment: 'staging' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Team' }), 't1')
    await waitFor(() => expect(seen.at(-1)!.filter).toEqual({ environment: 'staging', team: 't1' }))
  })

  it('"Vedi sulla mappa" porta alla topologia con la salute evidenziata', async () => {
    const { user } = renderPage('viewer')
    await user.click(await screen.findByRole('button', { name: 'View on the map' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/topology?health=1')
  })

  it('stato "tutto bene": giù + degradati = 0 → pannello verde sopra la tabella, tabella sempre visibile', async () => {
    const ops = ROWS.filter((r) => r.health === 'operational')
    renderPage('viewer', { overview: { down: 0, degraded: 0, operational: 3, total: ops.length, items: ops } })
    expect(await screen.findByText('All monitored CIs are operational')).toBeInTheDocument()
    expect(screen.getByText('3 monitored CIs, no active alarm degrading them')).toBeInTheDocument()
    expect(tile('Down')).toHaveTextContent('none right now')
    expect(bodyRows()).toHaveLength(1)
  })

  it('stato vuoto (nessun CI con salute): invito a collegare una sorgente; il pulsante solo per l\'admin', async () => {
    const { user } = renderPage('admin', { overview: { down: 0, degraded: 0, operational: 0, unmonitored: 40, total: 0, items: [] } })
    expect(await screen.findByText('No health data yet')).toBeInTheDocument()
    expect(screen.queryByText('All monitored CIs are operational')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add source' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/monitoring/sources/new')
  })

  it('stato vuoto per il viewer: testo che rimanda all\'amministratore, nessun pulsante', async () => {
    renderPage('viewer', { overview: { down: 0, degraded: 0, operational: 0, unmonitored: 40, total: 0, items: [] } })
    expect(await screen.findByText('No health data yet')).toBeInTheDocument()
    expect(screen.getByText(/Ask an administrator to connect a monitoring tool/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add source' })).not.toBeInTheDocument()
  })

  it('con un filtro attivo e zero righe la tabella dice "nessun CI corrisponde", non lo stato vuoto', async () => {
    const seen: Vars[] = []
    const { user } = renderPage('operator', { overview: { down: 0, degraded: 0, operational: 1, total: 0, items: [] }, seen })
    await screen.findByRole('heading', { name: 'CI health' })
    await user.click(tile('Down'))
    expect(await screen.findByText('No CI matches the filters')).toBeInTheDocument()
    expect(screen.queryByText('No health data yet')).not.toBeInTheDocument()
  })

  it('clic sulla riga → dettaglio CI (ciPath); il link al CI non apre due volte', async () => {
    const { user } = renderPage('viewer')
    await screen.findByRole('heading', { name: 'CI health' })
    await user.click(within(bodyRows()[1]!).getByText('3 dependents'))
    expect(screen.getByTestId('location')).toHaveTextContent('/ci/server/ci-2')
  })
})
