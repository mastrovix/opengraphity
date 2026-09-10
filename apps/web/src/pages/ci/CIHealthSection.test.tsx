/**
 * Sezione "Salute" del dettaglio CI: apertura solo con salute nota, forzatura
 * con select + "Applica" (admin/operator), viewer senza controlli, errore
 * della query degli ultimi allarmi visibile (D·1.6), alias condivisi.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { CIHealthSection } from './CIHealthSection'
import { GET_CI_HEALTH, GET_CI_ALIASES, GET_EVENTS } from '@/graphql/queries'
import { SET_CI_HEALTH_OVERRIDE } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

const CI_REF = { __typename: 'ConfigurationItemRef', id: 'srv-1', name: 'web-01', type: 'server', status: 'active', health: 'down' }

const healthMock = (health: string | null, healthSource: string | null = health ? 'monitoring' : null): GqlMock => ({
  request: { query: GET_CI_HEALTH, variables: { ciId: 'srv-1' } },
  result: { data: { ciHealth: { __typename: 'CIHealthInfo', ciId: 'srv-1', health, healthSource, lastEventAt: health ? '2026-09-09T10:00:00Z' : null, firingEvents: health === 'down' ? 2 : 0 } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const aliasesMock = (): GqlMock => ({
  request: { query: GET_CI_ALIASES, variables: { ciId: 'srv-1' } },
  result: { data: { ciAliases: [
    { __typename: 'CIAlias', id: 'al-1', kind: 'hostname', value: 'web-01.acme.local', source: 'manual', createdAt: '2026-09-01T00:00:00Z', ci: CI_REF },
  ] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const eventsMock = (items: Record<string, unknown>[] = []): GqlMock => ({
  request: { query: GET_EVENTS, variables: { filter: { ciId: 'srv-1' }, limit: 5, offset: 0 } },
  result: { data: { events: { __typename: 'EventPage', total: items.length, items } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})
const eventsErrorMock = (): GqlMock => ({
  request: { query: GET_EVENTS, variables: { filter: { ciId: 'srv-1' }, limit: 5, offset: 0 } },
  error: new Error('events down'),
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const RECENT = [{
  __typename: 'Event', id: 'e1', status: 'firing', severity: 'critical', title: 'CPU high on web-01', resource: 'web-01', resourceKind: 'hostname',
  count: 3, lastSeenAt: '2026-09-09T10:00:00Z', acknowledgedAt: null,
  source: { __typename: 'MonitoringSourceRef', id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager' },
  ci: CI_REF, incident: null, suppressedBy: null, correlation: 'opened', correlationAt: '2026-09-09T10:00:00Z',
  flappingSince: null, transitions24h: 0, matchReason: 'name',
}]

function renderSection(role: string, mocks: GqlMock[]) {
  return renderWithProviders(<CIHealthSection ciId="srv-1" ciName="web-01" />, { mocks: [meMock(role, { maxUsageCount: Number.POSITIVE_INFINITY }), ...mocks] })
}

const card = () => screen.getByRole('button', { name: /^Health/ })

describe('CIHealthSection', () => {
  it('salute sconosciuta: chiusa, messaggio esplicito, alias elencati, "nessun allarme" solo dopo la risposta', async () => {
    const { user } = renderSection('operator', [healthMock(null), aliasesMock(), eventsMock([])])
    await waitFor(() => expect(card()).toHaveAttribute('aria-expanded', 'false'))
    await user.click(card())
    expect(await screen.findByText('No alarm has concerned this CI yet: health is unknown.')).toBeInTheDocument()
    expect(await screen.findByText('web-01.acme.local')).toBeInTheDocument()
    expect(await screen.findByText('No events for this CI.')).toBeInTheDocument()
  })

  it('CI giù: aperta con badge, allarmi attivi con link interno alla console, ultimi allarmi', async () => {
    renderSection('viewer', [healthMock('down'), aliasesMock(), eventsMock(RECENT)])
    await waitFor(() => expect(card()).toHaveAttribute('aria-expanded', 'true'))
    expect(screen.getAllByText('Health: Down').length).toBeGreaterThan(0)
    expect(screen.getByText('Monitoring')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /View in the console/ })).toHaveAttribute('href', '/events?ciId=srv-1')
    expect(await screen.findByRole('link', { name: 'CPU high on web-01' })).toHaveAttribute('href', '/events/e1')
  })

  it('operator: la forzatura parte solo con "Applica" (non al cambio del select)', async () => {
    const seen: unknown[] = []
    const overrideMock: GqlMock = {
      request: { query: SET_CI_HEALTH_OVERRIDE, variables: (v) => { seen.push(v); return true } },
      result: { data: { setCIHealthOverride: { __typename: 'CIHealthInfo', ciId: 'srv-1', health: 'degraded', healthSource: 'manual', lastEventAt: null, firingEvents: 2 } } },
    }
    const { user } = renderSection('operator', [healthMock('down'), aliasesMock(), eventsMock([]), overrideMock])
    const select = await screen.findByLabelText('Force health')
    const apply = screen.getByRole('button', { name: 'Apply' })
    expect(apply).toBeDisabled()                      // nessuna modifica in sospeso

    await user.selectOptions(select, 'degraded')
    expect(seen).toEqual([])                          // scorrere le opzioni non forza nulla
    expect(apply).toBeEnabled()

    await user.click(apply)
    await waitFor(() => expect(seen).toEqual([{ ciId: 'srv-1', health: 'degraded' }]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Health forced to Degraded'))
  })

  it('admin con forzatura in vigore: "Rimuovi forzatura" manda health = null', async () => {
    const seen: unknown[] = []
    const overrideMock: GqlMock = {
      request: { query: SET_CI_HEALTH_OVERRIDE, variables: (v) => { seen.push(v); return true } },
      result: { data: { setCIHealthOverride: { __typename: 'CIHealthInfo', ciId: 'srv-1', health: 'down', healthSource: 'monitoring', lastEventAt: null, firingEvents: 2 } } },
    }
    const { user } = renderSection('admin', [healthMock('degraded', 'manual'), aliasesMock(), eventsMock([]), overrideMock])
    expect(await screen.findByText('Manual override')).toBeInTheDocument()
    expect(screen.getByLabelText('Force health')).toHaveValue('degraded')
    await user.click(screen.getByRole('button', { name: 'Remove override' }))
    await waitFor(() => expect(seen).toEqual([{ ciId: 'srv-1', health: null }]))
    // admin: può anche aggiungere alias
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })

  it('viewer: nessun controllo di forzatura né gestione alias', async () => {
    renderSection('viewer', [healthMock('operational'), aliasesMock(), eventsMock([])])
    await waitFor(() => expect(card()).toHaveAttribute('aria-expanded', 'true'))
    await screen.findByText('web-01.acme.local')
    expect(screen.queryByLabelText('Force health')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete alias/ })).not.toBeInTheDocument()
  })

  it('errore della query degli ultimi allarmi → errore visibile con Riprova, mai "nessun allarme"', async () => {
    renderSection('operator', [healthMock('down'), aliasesMock(), eventsErrorMock()])
    await waitFor(() => expect(card()).toHaveAttribute('aria-expanded', 'true'))
    expect(await screen.findByText('events down')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
    expect(screen.queryByText('No events for this CI.')).not.toBeInTheDocument()
  })

  it('errore della mutation → toast di errore', async () => {
    const failing: GqlMock = { request: { query: SET_CI_HEALTH_OVERRIDE, variables: () => true }, error: new Error('override denied') }
    const { user } = renderSection('operator', [healthMock('down'), aliasesMock(), eventsMock([]), failing])
    await user.selectOptions(await screen.findByLabelText('Force health'), 'operational')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: override denied'))
  })
})
