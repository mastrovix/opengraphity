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
  version: 3, updatedAt: '2026-09-08T10:00:00Z',
  openIncidentFrom: 'critical', groupBy: 'ci', openDelaySeconds: 120, autoResolve: true,
  suppressUpstreamHops: 2, flapThreshold: 4, flapWindowMinutes: 15, flapStableMinutes: 10,
  stormThresholdPerMinute: 50, stormCooldownMinutes: 5, retentionDays: 30,
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
    // la versione letta viaggia come expectedVersion (modifica concorrente → rifiuto lato API)
    expect(seen[0]).toMatchObject({ openIncidentFrom: 'warning', retentionDays: 45, groupBy: 'ci', autoResolve: true, expectedVersion: 3 })
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

describe('EventPolicyPage — sfarfallio, tempeste, conservazione (ondata 4)', () => {
  it('i tre campi nuovi partono dalla policy, hanno l\'aiuto e vengono salvati', async () => {
    const seen: Input[] = []
    const { user } = renderWithProviders(<EventPolicyPage />, { mocks: [policyMock(), updateMock(seen)] })
    const stable   = await screen.findByLabelText('Stable minutes before resuming')
    const thresh   = screen.getByLabelText('Storm threshold (new alarms per minute)')
    const cooldown = screen.getByLabelText('Minutes below threshold to end the storm')
    expect(stable).toHaveValue(10)
    expect(thresh).toHaveValue(50)
    expect(cooldown).toHaveValue(5)
    expect(stable).toHaveAccessibleDescription(/before leaving the flapping state/)
    expect(thresh).toHaveAccessibleDescription(/grouped into a single incident/)
    expect(cooldown).toHaveAccessibleDescription(/storm ends once the rate stays below/)

    await user.clear(stable);   await user.type(stable, '20')
    await user.clear(thresh);   await user.type(thresh, '80')
    await user.clear(cooldown); await user.type(cooldown, '3')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Event policy saved'))
    expect(seen[0]).toMatchObject({ flapStableMinutes: 20, stormThresholdPerMinute: 80, stormCooldownMinutes: 3, flapThreshold: 4, flapWindowMinutes: 15, retentionDays: 30 })
  })

  it('i campi sono raggruppati in quattro riquadri titolati', async () => {
    renderWithProviders(<EventPolicyPage />, { mocks: [policyMock()] })
    const incidents = await screen.findByRole('group', { name: 'Incident opening and closing' })
    expect(within(incidents).getByLabelText('Open incident from')).toBeInTheDocument()
    expect(within(incidents).getByLabelText('Open delay (seconds)')).toBeInTheDocument()
    expect(within(incidents).getByLabelText('Critical – Impact')).toBeInTheDocument()
    const change = screen.getByRole('group', { name: 'Silence in a change window' })
    expect(within(change).getByLabelText('Upstream suppression (hops)')).toBeInTheDocument()
    const flapStorm = screen.getByRole('group', { name: 'Flapping and storms' })
    expect(within(flapStorm).getByLabelText('Flap threshold (transitions)')).toBeInTheDocument()
    expect(within(flapStorm).getByLabelText('Stable minutes before resuming')).toBeInTheDocument()
    expect(within(flapStorm).getByLabelText('Storm threshold (new alarms per minute)')).toBeInTheDocument()
    expect(within(flapStorm).getByLabelText('Minutes below threshold to end the storm')).toBeInTheDocument()
    const retention = screen.getByRole('group', { name: 'Retention' })
    expect(within(retention).getByLabelText('Retention (days)')).toBeInTheDocument()
  })

  it('validazione: stabilità e cooldown ≥ 1, soglia di tempesta ≥ 0, campo vuoto segnalato; il salvataggio è bloccato', async () => {
    const seen: Input[] = []
    const { user } = renderWithProviders(<EventPolicyPage />, { mocks: [policyMock(), updateMock(seen)] })
    const stable = await screen.findByLabelText('Stable minutes before resuming')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeEnabled()

    // 0 non basta per la stabilità
    await user.clear(stable); await user.type(stable, '0')
    expect(screen.getByRole('alert')).toHaveTextContent('The minimum value is 1.')
    expect(stable).toHaveAttribute('aria-invalid', 'true')
    expect(stable).toHaveAccessibleDescription(/The minimum value is 1\./)
    expect(save).toBeDisabled()
    expect(screen.getByText('Fix the highlighted fields to save.')).toBeInTheDocument()

    // campo vuoto: non è "0", è un valore mancante
    await user.clear(stable)
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number (minimum 1).')
    expect(save).toBeDisabled()

    // valore valido: l'errore sparisce e si salva
    await user.type(stable, '7')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // la soglia di tempesta accetta 0, il cooldown no
    const thresh = screen.getByLabelText('Storm threshold (new alarms per minute)')
    await user.clear(thresh); await user.type(thresh, '0')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    const cooldown = screen.getByLabelText('Minutes below threshold to end the storm')
    await user.clear(cooldown); await user.type(cooldown, '0')
    expect(screen.getByRole('alert')).toHaveTextContent('The minimum value is 1.')
    await user.clear(cooldown); await user.type(cooldown, '2')

    await user.click(save)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Event policy saved'))
    expect(seen[0]).toMatchObject({ flapStableMinutes: 7, stormThresholdPerMinute: 0, stormCooldownMinutes: 2 })
  })
})

describe('EventPolicyPage — spiegazioni (ondata 3)', () => {
  it('riquadro "Come funziona" in quattro righe e riga di aiuto sotto ogni campo', async () => {
    renderWithProviders(<EventPolicyPage />, { mocks: [policyMock()] })
    const how = await screen.findByRole('region', { name: 'How it works' })
    const items = within(how).getAllByRole('listitem')
    expect(items).toHaveLength(6)
    expect(items[0]).toHaveTextContent(/Threshold → opening/)
    expect(items[1]).toHaveTextContent(/Grouping/)
    expect(items[2]).toHaveTextContent(/Auto-resolve/)
    expect(items[3]).toHaveTextContent(/Silence in a change window/)
    expect(items[4]).toHaveTextContent(/Flapping.*no incident opened or closed/)
    expect(items[5]).toHaveTextContent(/Storm.*single storm incident/)

    // ogni controllo è descritto dalla sua riga di aiuto (aria-describedby)
    expect(screen.getByLabelText('Open incident from')).toHaveAccessibleDescription(/Minimum severity from which an alarm opens an incident/)
    expect(screen.getByLabelText('Open delay (seconds)')).toHaveAccessibleDescription(/0 = open immediately/)
    expect(screen.getByLabelText('Upstream suppression (hops)')).toHaveAccessibleDescription(/change in its window/)
    expect(screen.getByLabelText('Group by')).toHaveAccessibleDescription(/one incident per CI/)
    expect(screen.getByText(/a new alarm reopens it/)).toBeInTheDocument()
    expect(screen.getByText(/the priority derives from them/)).toBeInTheDocument()
  })
})
