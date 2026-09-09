import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { EventPolicyPage } from './EventPolicyPage'
import { GET_EVENT_POLICY } from '@/graphql/queries'
import { UPDATE_EVENT_POLICY } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const MAP = { critical: { impact: 'high', urgency: 'high' }, warning: { impact: 'medium', urgency: 'medium' }, info: { impact: 'low', urgency: 'low' } }

const POLICY = {
  __typename: 'EventPolicy',
  openIncidentFrom: 'critical', groupBy: 'ci', openDelaySeconds: 120, autoResolve: true,
  suppressUpstreamHops: 2, flapThreshold: 4, flapWindowMinutes: 15, retentionDays: 30,
  severityMap: JSON.stringify(MAP),
}

const policyMock = (severityMap = POLICY.severityMap): GqlMock => ({
  request: { query: GET_EVENT_POLICY },
  result: { data: { eventPolicy: { ...POLICY, severityMap } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

type Input = Record<string, unknown>

function updateMock(seen: Input[]): GqlMock {
  return {
    request: { query: UPDATE_EVENT_POLICY, variables: (v) => { seen.push((v as { input: Input }).input); return true } },
    result: { data: { updateEventPolicy: { ...POLICY } } },
  }
}

beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

describe('EventPolicyPage', () => {
  it('carica la policy, modifica e salva con toast di esito', async () => {
    const seen: Input[] = []
    const { user } = renderWithProviders(<EventPolicyPage />, { route: '/settings/event-policy', mocks: [policyMock(), updateMock(seen)] })

    const openFrom = await screen.findByLabelText('Open incident from')
    expect(openFrom).toHaveValue('critical')
    expect(screen.getByLabelText('Retention (days)')).toHaveValue(30)
    expect(screen.getByRole('switch', { name: 'Auto-resolve when the source resolves' })).toHaveAttribute('aria-checked', 'true')

    await user.selectOptions(openFrom, 'warning')
    await user.clear(screen.getByLabelText('Retention (days)'))
    await user.type(screen.getByLabelText('Retention (days)'), '45')
    await user.selectOptions(screen.getByLabelText('Warning – Urgency'), 'high')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Event policy saved'))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ openIncidentFrom: 'warning', retentionDays: 45, groupBy: 'ci', autoResolve: true })
    expect(JSON.parse(seen[0]!['severityMap'] as string)).toEqual({ ...MAP, warning: { impact: 'medium', urgency: 'high' } })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('errore del server al salvataggio → toast di errore con il messaggio', async () => {
    const failing: GqlMock = { request: { query: UPDATE_EVENT_POLICY, variables: () => true }, error: new Error('policy locked') }
    const { user } = renderWithProviders(<EventPolicyPage />, { mocks: [policyMock(), failing] })
    await screen.findByLabelText('Open incident from')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Policy save failed: policy locked'))
  })

  it('severityMap malformata → avviso visibile, il form parte dai default (nessun fallback silenzioso)', async () => {
    renderWithProviders(<EventPolicyPage />, { mocks: [policyMock('{not json')] })
    await screen.findByLabelText('Open incident from')
    expect(screen.getByRole('alert')).toHaveTextContent(/Invalid severity map/)
    expect(screen.getByLabelText('Critical – Impact')).toHaveValue('high')
    expect(screen.getByLabelText('Info – Urgency')).toHaveValue('low')
  })
})

describe('EventPolicyPage — spiegazioni (ondata 3)', () => {
  it('riquadro "Come funziona" in quattro righe e riga di aiuto sotto ogni campo', async () => {
    renderWithProviders(<EventPolicyPage />, { mocks: [policyMock()] })
    const how = await screen.findByRole('region', { name: 'How it works' })
    const items = within(how).getAllByRole('listitem')
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent(/Threshold → opening/)
    expect(items[1]).toHaveTextContent(/Grouping/)
    expect(items[2]).toHaveTextContent(/Auto-resolve/)
    expect(items[3]).toHaveTextContent(/Silence in a change window/)

    // ogni controllo è descritto dalla sua riga di aiuto (aria-describedby)
    expect(screen.getByLabelText('Open incident from')).toHaveAccessibleDescription(/Minimum severity from which an alarm opens an incident/)
    expect(screen.getByLabelText('Open delay (seconds)')).toHaveAccessibleDescription(/0 = open immediately/)
    expect(screen.getByLabelText('Upstream suppression (hops)')).toHaveAccessibleDescription(/change in its window/)
    expect(screen.getByLabelText('Group by')).toHaveAccessibleDescription(/one incident per CI/)
    expect(screen.getByText(/a new alarm reopens it/)).toBeInTheDocument()
    expect(screen.getByText(/the priority derives from them/)).toBeInTheDocument()
  })
})
