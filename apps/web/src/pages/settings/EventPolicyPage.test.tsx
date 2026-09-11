import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { EventPolicyPage } from './EventPolicyPage'
import { GET_EVENT_POLICY } from '@/graphql/queries'
import { UPDATE_EVENT_POLICY } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { baseCITypeMock, baseCITypeErrorMock } from '@/test/mocks/gql'

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
  matchShortHostname: false,
  ignoreLifecycleStatuses: ['decommissioned'],
  severityMap: JSON.stringify(MAP),
}

const policyMock = (over: Partial<typeof POLICY> = {}): GqlMock => ({
  request: { query: GET_EVENT_POLICY },
  result: { data: { eventPolicy: { ...POLICY, ...over } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

type Input = Record<string, unknown>

/** Come l'API: risponde con la policy salvata (input applicato, versione incrementata). */
function updateMock(seen: Input[]): GqlMock {
  return {
    request: { query: UPDATE_EVENT_POLICY, variables: (v) => { seen.push((v as { input: Input }).input); return true } },
    result: (vars) => {
      const { expectedVersion: _v, ...input } = (vars as { input: Input }).input
      return { data: { updateEventPolicy: { ...POLICY, ...input, version: POLICY.version + 1, updatedAt: '2026-09-10T10:00:00Z' } } }
    },
  }
}

beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

describe('EventPolicyPage', () => {
  it('carica la policy, modifica e salva con toast di esito; dopo il salvataggio il form è allineato alla risposta (cache di GET_EVENT_POLICY)', async () => {
    const seen: Input[] = []
    const { user } = renderWithProviders(<EventPolicyPage />, { route: '/settings/event-policy', mocks: [baseCITypeMock(), policyMock(), updateMock(seen)] })

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

    // D·1.5: la risposta è scritta nella cache → il form riparte da lì, senza modifiche pendenti
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No changes to save'))
    expect(screen.getByLabelText('Open incident from')).toHaveValue('warning')
    expect(screen.getByLabelText('Retention (days)')).toHaveValue(45)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('errore del server al salvataggio → toast di errore con il messaggio', async () => {
    const failing: GqlMock = { request: { query: UPDATE_EVENT_POLICY, variables: () => true }, error: new Error('policy locked') }
    const { user } = renderWithProviders(<EventPolicyPage />, { mocks: [baseCITypeMock(), policyMock(), failing] })
    await user.selectOptions(await screen.findByLabelText('Open incident from'), 'warning')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Policy save failed: policy locked'))
    // le modifiche restano in pagina
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes')
  })

  it('severityMap malformata → avviso visibile (i18n), il form parte dai default e si può salvare anche senza altre modifiche (nessun fallback silenzioso)', async () => {
    const seen: Input[] = []
    const { user } = renderWithProviders(<EventPolicyPage />, { mocks: [baseCITypeMock(), policyMock({ severityMap: '{"critical":{"impact":"high","urgency":"high"}}' }), updateMock(seen)] })
    await screen.findByLabelText('Open incident from')
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid severity map (severityMap: severity "warning" is missing): defaults restored, save to fix.')
    expect(screen.getByLabelText('Critical – Impact')).toHaveValue('high')
    expect(screen.getByLabelText('Info – Urgency')).toHaveValue('low')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(JSON.parse(seen[0]!['severityMap'] as string)).toEqual(MAP)
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})

describe('EventPolicyPage — modifiche non salvate e «Mai» (revisione D·2.5)', () => {
  it('senza modifiche Salva e Ripristina sono disabilitati; una modifica accende "Modifiche non salvate"; Ripristina torna ai valori letti', async () => {
    const { user } = renderWithProviders(<EventPolicyPage />, { mocks: [baseCITypeMock(), policyMock()] })
    const retention = await screen.findByLabelText('Retention (days)')
    expect(screen.getByRole('status')).toHaveTextContent('No changes to save')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()

    await user.clear(retention); await user.type(retention, '60')
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(retention).toHaveValue(30)
    expect(screen.getByRole('status')).toHaveTextContent('No changes to save')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('con «Mai» raggruppamento, ritardo, chiusura automatica e mappa severità sono disabilitati con la nota; tornando a una severità si riattivano', async () => {
    const { user } = renderWithProviders(<EventPolicyPage />, { mocks: [baseCITypeMock(), policyMock()] })
    const openFrom = await screen.findByLabelText('Open incident from')
    expect(screen.getByLabelText('Group by')).toBeEnabled()
    expect(screen.queryByRole('note')).not.toBeInTheDocument()

    await user.selectOptions(openFrom, 'never')
    expect(screen.getByRole('note')).toHaveTextContent('Not used with “Never”: monitoring opens no incident')
    expect(screen.getByLabelText('Group by')).toBeDisabled()
    expect(screen.getByLabelText('Open delay (seconds)')).toBeDisabled()
    expect(screen.getByLabelText('Open delay (seconds)')).toHaveAccessibleDescription(/Not used with “Never”/)
    expect(screen.getByRole('switch', { name: 'Auto-resolve when the source resolves' })).toBeDisabled()
    expect(screen.getByLabelText('Critical – Impact')).toBeDisabled()
    // il resto resta modificabile
    expect(screen.getByLabelText('Upstream suppression (hops)')).toBeEnabled()
    expect(screen.getByLabelText('Retention (days)')).toBeEnabled()

    await user.selectOptions(openFrom, 'info')
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Group by')).toBeEnabled()
    expect(screen.getByLabelText('Critical – Impact')).toBeEnabled()
  })
})

describe('EventPolicyPage — sfarfallio, tempeste, conservazione (ondata 4)', () => {
  it('i tre campi nuovi partono dalla policy, hanno l\'aiuto (0 = tempeste disattivate) e vengono salvati', async () => {
    const seen: Input[] = []
    const { user } = renderWithProviders(<EventPolicyPage />, { mocks: [baseCITypeMock(), policyMock(), updateMock(seen)] })
    const stable   = await screen.findByLabelText('Stable minutes before resuming')
    const thresh   = screen.getByLabelText('Storm threshold (new alarms per minute)')
    const cooldown = screen.getByLabelText('Minutes below threshold to end the storm')
    expect(stable).toHaveValue(10)
    expect(thresh).toHaveValue(50)
    expect(cooldown).toHaveValue(5)
    expect(stable).toHaveAccessibleDescription(/before leaving the flapping state/)
    expect(thresh).toHaveAccessibleDescription(/grouped into a single incident.*0 = storm detection off/)
    expect(cooldown).toHaveAccessibleDescription(/storm ends once the rate stays below/)

    await user.clear(stable);   await user.type(stable, '20')
    await user.clear(thresh);   await user.type(thresh, '80')
    await user.clear(cooldown); await user.type(cooldown, '3')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Event policy saved'))
    expect(seen[0]).toMatchObject({ flapStableMinutes: 20, stormThresholdPerMinute: 80, stormCooldownMinutes: 3, flapThreshold: 4, flapWindowMinutes: 15, retentionDays: 30 })
  })

  it('i campi sono raggruppati in quattro riquadri titolati', async () => {
    renderWithProviders(<EventPolicyPage />, { mocks: [baseCITypeMock(), policyMock()] })
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
    const { user } = renderWithProviders(<EventPolicyPage />, { mocks: [baseCITypeMock(), policyMock(), updateMock(seen)] })
    const stable = await screen.findByLabelText('Stable minutes before resuming')
    const save = screen.getByRole('button', { name: 'Save' })

    // 0 non basta per la stabilità
    await user.clear(stable); await user.type(stable, '0')
    expect(screen.getByRole('alert')).toHaveTextContent('The minimum value is 1.')
    expect(stable).toHaveAttribute('aria-invalid', 'true')
    expect(stable).toHaveAccessibleDescription(/The minimum value is 1\./)
    expect(save).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Fix the highlighted fields to save.')

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

describe('EventPolicyPage — riconoscimento del CI (revisione A-2)', () => {
  it('interruttore "nome corto ↔ FQDN" nel riquadro "CI recognition": parte dalla policy (spento), ha l\'aiuto, e viene salvato', async () => {
    const seen: Input[] = []
    const { user } = renderWithProviders(<EventPolicyPage />, { mocks: [baseCITypeMock(), policyMock(), updateMock(seen)] })
    const group = await screen.findByRole('group', { name: 'CI recognition' })
    const toggle = within(group).getByRole('switch', { name: 'Match short hostname and FQDN as the same host' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(within(group).getByText(/also try the short name \(db-01\), and vice versa/)).toBeInTheDocument()

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Event policy saved'))
    expect(seen[0]).toMatchObject({ matchShortHostname: true, expectedVersion: 3 })
  })
})

describe('EventPolicyPage — spiegazioni (ondata 3)', () => {
  it('riquadro "Come funziona" in quattro righe e riga di aiuto sotto ogni campo', async () => {
    renderWithProviders(<EventPolicyPage />, { mocks: [baseCITypeMock(), policyMock()] })
    const how = await screen.findByRole('region', { name: 'How it works' })
    const items = within(how).getAllByRole('listitem')
    expect(items).toHaveLength(7)
    expect(items[0]).toHaveTextContent(/Threshold → opening/)
    expect(items[1]).toHaveTextContent(/Grouping/)
    expect(items[2]).toHaveTextContent(/Auto-resolve/)
    expect(items[3]).toHaveTextContent(/Silence in a change window/)
    expect(items[4]).toHaveTextContent(/Lifecycle.*open no incident/)
    expect(items[5]).toHaveTextContent(/Flapping.*no incident opened or closed/)
    expect(items[6]).toHaveTextContent(/Storm.*single storm incident/)

    // ogni controllo è descritto dalla sua riga di aiuto (aria-describedby)
    expect(screen.getByLabelText('Open incident from')).toHaveAccessibleDescription(/Minimum severity from which an alarm opens an incident/)
    expect(screen.getByLabelText('Open delay (seconds)')).toHaveAccessibleDescription(/0 = open immediately/)
    expect(screen.getByLabelText('Upstream suppression (hops)')).toHaveAccessibleDescription(/change in its window/)
    expect(screen.getByLabelText('Group by')).toHaveAccessibleDescription(/one incident per CI/)
    expect(screen.getByText(/a new alarm reopens it/)).toBeInTheDocument()
    expect(screen.getByText(/the priority derives from them/)).toBeInTheDocument()
  })
})

describe('EventPolicyPage — stati del ciclo di vita da ignorare (revisione 2, D6.3)', () => {
  it('scelta multipla dal vocabolario del metamodello, «dismesso» spuntato dalla policy, conteggio con plurale e salvataggio dei valori scelti', async () => {
    const seen: Input[] = []
    const { user } = renderWithProviders(<EventPolicyPage />, { mocks: [baseCITypeMock(), policyMock(), updateMock(seen)] })

    const group = await screen.findByRole('group', { name: 'Lifecycle statuses to ignore' })
    // una casella per ogni stato del metamodello, nel suo ordine
    expect(within(group).getAllByRole('checkbox')).toHaveLength(4)
    const decommissioned = within(group).getByRole('checkbox', { name: 'Decommissioned' })
    const inactive = within(group).getByRole('checkbox', { name: 'Inactive' })
    expect(decommissioned).toBeChecked()
    expect(inactive).not.toBeChecked()
    expect(group).toHaveAccessibleDescription(/open no incident and do not change the CI health/)
    expect(screen.getByTestId('lifecycle-selected')).toHaveTextContent('1 status ignored.')

    // il riquadro ha il suo titolo, come gli altri
    expect(within(screen.getByRole('group', { name: 'CI lifecycle' })).getByText('Lifecycle statuses to ignore')).toBeInTheDocument()

    await user.click(inactive)
    expect(screen.getByTestId('lifecycle-selected')).toHaveTextContent('2 statuses ignored.')
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen).toHaveLength(1))
    // l'ordine è quello del vocabolario, non quello dei clic
    expect(seen[0]).toMatchObject({ ignoreLifecycleStatuses: ['inactive', 'decommissioned'], expectedVersion: 3 })
  })

  it('togliendo tutti gli stati il conteggio dice cosa comporta e si salva una lista vuota', async () => {
    const seen: Input[] = []
    const { user } = renderWithProviders(<EventPolicyPage />, { mocks: [baseCITypeMock(), policyMock(), updateMock(seen)] })
    const group = await screen.findByRole('group', { name: 'Lifecycle statuses to ignore' })
    await user.click(within(group).getByRole('checkbox', { name: 'Decommissioned' }))
    expect(screen.getByTestId('lifecycle-selected')).toHaveTextContent('No status ignored: alarms are evaluated on every CI.')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ ignoreLifecycleStatuses: [] })
  })

  it('uno stato salvato che il metamodello non conosce resta spuntabile e detto in chiaro (nessuna riga muta)', async () => {
    renderWithProviders(<EventPolicyPage />, {
      mocks: [baseCITypeMock(['active', 'decommissioned']), policyMock({ ignoreLifecycleStatuses: ['decommissioned', 'retired'] }), updateMock([])],
    })
    const group = await screen.findByRole('group', { name: 'Lifecycle statuses to ignore' })
    expect(within(group).getByRole('checkbox', { name: 'Unknown: retired' })).toBeChecked()
    expect(screen.getByTestId('lifecycle-selected')).toHaveTextContent('2 statuses ignored.')
  })

  it('metamodello non raggiungibile: l\'errore è visibile e restano solo gli stati già salvati', async () => {
    renderWithProviders(<EventPolicyPage />, { mocks: [baseCITypeErrorMock(), policyMock()] })
    const group = await screen.findByRole('group', { name: 'Lifecycle statuses to ignore' })
    expect(within(group).getAllByRole('checkbox')).toHaveLength(1)
    expect(within(group).getByRole('checkbox', { name: 'Unknown: decommissioned' })).toBeChecked()
    expect(screen.getByRole('alert')).toHaveTextContent('Lifecycle statuses unavailable from the metamodel (metamodel down): only the ones already saved in the policy can be ticked.')
  })
})
