import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
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
