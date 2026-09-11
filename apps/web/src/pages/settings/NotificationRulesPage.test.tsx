/**
 * NotificationRulesPage (revisione 2, D3.1): i canali offerti per ogni regola
 * sono SOLO quelli che il server dichiara consegnabili per quel tipo
 * (`notificationRouting`); un canale già salvato ma non consegnabile resta
 * visibile con un avviso così si può togliere; il dialogo della nuova regola
 * segue il tipo scelto; le regole dei due sottosistemi hanno la loro sezione.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import NotificationRulesPage from './NotificationRulesPage'
import { GET_NOTIFICATION_RULES, GET_NOTIFICATION_ROUTING } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

function rule(id: string, eventType: string, channels: string[]) {
  return {
    __typename: 'NotificationRule', id, eventType, enabled: true, severityOverride: 'info', titleKey: `notification.${eventType}.title`,
    channels, target: 'all', conditions: null, isSeed: true,
    escalationDelayMinutes: null, escalationTarget: null, escalationMessage: null,
    slaWarningThresholdPercent: null, slaWarningTarget: null, digestTime: null, digestRecipients: null,
  }
}

const rulesMock: GqlMock = {
  request: { query: GET_NOTIFICATION_RULES },
  result: { data: { notificationRules: [
    rule('r1', 'incident.created',        ['in_app']),
    rule('r2', 'event.storm_started',     ['in_app']),
    rule('r3', 'service.incident_opened', ['in_app', 'slack']),   // slack non consegnabile: regola scritta prima della migrazione 1150
    rule('r4', 'change.approved',         ['in_app']),
  ] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

const routingMock: GqlMock = {
  request: { query: GET_NOTIFICATION_ROUTING },
  result: { data: { notificationRouting: {
    __typename: 'NotificationRouting',
    defaultChannels: ['in_app', 'email'],
    byEventType: [
      { __typename: 'NotificationRoutableChannels', eventType: 'incident.created', channels: ['in_app', 'email', 'slack', 'teams'] },
      { __typename: 'NotificationRoutableChannels', eventType: 'change.approved',  channels: ['in_app', 'email', 'slack'] },
    ],
  } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

// il titolo (titleKey non tradotto) ricade sul tipo di evento: la riga lo mostra due volte
const rowOf = (eventType: string) => screen.getAllByText(eventType)[0]!.closest('tr')!
const channelsOf = (eventType: string) => within(rowOf(eventType)).getAllByRole('checkbox').map((cb) => cb.closest('label')!.textContent!.trim())

describe('NotificationRulesPage — canali consegnabili', () => {
  it('ogni riga offre solo i canali che il server dichiara per quel tipo', async () => {
    renderWithProviders(<NotificationRulesPage />, { mocks: [rulesMock, routingMock] })
    expect((await screen.findAllByText('event.storm_started')).length).toBeGreaterThan(0)

    expect(channelsOf('incident.created')).toEqual(['In app', 'Email', 'Slack', 'Teams'])
    expect(channelsOf('change.approved')).toEqual(['In app', 'Email', 'Slack'])
    expect(channelsOf('event.storm_started')).toEqual(['In app', 'Email'])
  })

  it('un canale salvato ma non consegnabile resta visibile, spuntato e con l\'avviso, così si può togliere', async () => {
    renderWithProviders(<NotificationRulesPage />, { mocks: [rulesMock, routingMock] })
    await screen.findAllByText('service.incident_opened')

    const row = rowOf('service.incident_opened')
    expect(channelsOf('service.incident_opened')).toEqual(['In app', 'Email', 'Slack'])
    const slack = within(row).getByRole('checkbox', { name: /Slack/ })
    expect(slack).toBeChecked()
    expect(within(row).getByLabelText(/Channel not deliverable for this event: the dispatcher has no format for Slack/)).toBeInTheDocument()
    // nessun avviso sui canali consegnabili
    expect(within(rowOf('incident.created')).queryByLabelText(/not deliverable/)).not.toBeInTheDocument()
  })

  it('le regole degli allarmi e dei servizi hanno la loro sezione (non «Custom»)', async () => {
    renderWithProviders(<NotificationRulesPage />, { mocks: [rulesMock, routingMock] })
    await screen.findAllByText('event.storm_started')
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(['Incident', 'Change', 'Alarms and CI health', 'Monitored services'])
    expect(within(screen.getByRole('region', { name: 'Monitored services' })).getAllByText('service.incident_opened').length).toBeGreaterThan(0)
  })

  it('nuova regola: i canali seguono il tipo scelto (incident.created → 4, event.storm_started → 2)', async () => {
    const { user } = renderWithProviders(<NotificationRulesPage />, { mocks: [rulesMock, routingMock] })
    await screen.findAllByText('event.storm_started')
    await user.click(screen.getByRole('button', { name: 'New rule' }))

    const dialog = screen.getByRole('dialog')
    const labels = () => within(dialog).getAllByRole('checkbox').map((cb) => cb.closest('label')!.textContent!.trim())
    // nessun tipo scelto → canali predefiniti
    expect(labels()).toEqual(['In app', 'Email'])

    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Event type' }), 'incident.created')
    expect(labels()).toEqual(['In app', 'Email', 'Slack', 'Teams'])
    await user.click(within(dialog).getByRole('checkbox', { name: 'Slack' }))
    expect(within(dialog).getByRole('checkbox', { name: 'Slack' })).toBeChecked()

    // cambiando tipo, Slack sparisce dalle opzioni (e non verrebbe inviato)
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Event type' }), 'event.storm_started')
    expect(labels()).toEqual(['In app', 'Email'])
    expect(within(dialog).getByText('Only the channels the system can deliver for this event type.')).toBeInTheDocument()
  })

  it('se la tabella dei canali non arriva, la pagina mostra l\'errore invece di un elenco di canali a prescindere', async () => {
    const routingError: GqlMock = { request: { query: GET_NOTIFICATION_ROUTING }, error: new Error('routing unavailable') }
    renderWithProviders(<NotificationRulesPage />, { mocks: [rulesMock, routingError], showWarnings: false })
    expect(await screen.findByText('routing unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})
