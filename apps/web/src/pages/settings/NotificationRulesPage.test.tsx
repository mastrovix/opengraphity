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
import { GET_NOTIFICATION_RULES, GET_NOTIFICATION_ROUTING, GET_WORKFLOW_EVENT_TYPES } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { NOTIFICATION_TARGETS, USER_ROLES, WORKFLOW_STEP_PURPOSES } from '@opengraphity/types'
import i18n from '@/i18n/i18n'

const T2 = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

function rule(id: string, eventType: string, channels: string[], over: Record<string, unknown> = {}) {
  return {
    __typename: 'NotificationRule', id, eventType, enabled: true, severityOverride: 'info', titleKey: `notification.${eventType}.title`,
    channels, target: 'all', conditions: null, isSeed: true,
    // Ondata 4 (D-22): restringimento della regola di passo ed «è prodotto da
    // qualcosa?», entrambi dal server.
    stepPurpose: null, stepCategory: null, eventProduced: true,
    escalationDelayMinutes: null, escalationTarget: null, escalationMessage: null,
    slaWarningThresholdPercent: null, slaWarningTarget: null, digestTime: null, digestRecipients: null,
    ...over,
  }
}

/** I tipi di evento veri dei workflow del tenant (`workflowEventTypes`). */
function eventType(over: Record<string, unknown>) {
  return {
    __typename: 'WorkflowEventType', eventType: '', entityType: 'incident',
    stepName: null, stepLabel: null, stepPurpose: null, stepCategory: null, stable: false, ...over,
  }
}

const workflowEventTypesMock: GqlMock = {
  request: { query: GET_WORKFLOW_EVENT_TYPES },
  result: { data: { workflowEventTypes: [
    eventType({ eventType: 'incident.step_entered', stable: true }),
    eventType({ eventType: 'incident.created',            stepName: 'created',   stepLabel: 'Creato',     stepCategory: 'active'  }),
    eventType({ eventType: 'incident.in_attesa_fornitore', stepName: 'in_attesa_fornitore', stepLabel: 'In attesa del fornitore', stepCategory: 'waiting' }),
  ] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
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
    // I bersagli applicabili per evento (il server li calcola dalla tabella in
    // @opengraphity/types): alla NASCITA di un incident non esistono ancora
    // assegnatario e team, quindi non vengono offerti.
    defaultTargets: [...NOTIFICATION_TARGETS],
    targetsByEventType: [
      { __typename: 'NotificationEventTargets', eventType: 'incident.created',     targets: NOTIFICATION_TARGETS.filter((t) => t !== 'assignee' && t !== 'team_owner') },
      { __typename: 'NotificationEventTargets', eventType: 'incident.assigned',    targets: [...NOTIFICATION_TARGETS] },
      { __typename: 'NotificationEventTargets', eventType: 'event.storm_started',  targets: NOTIFICATION_TARGETS.filter((t) => t !== 'assignee' && t !== 'team_owner') },
    ],
  } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

// il titolo (titleKey non tradotto) ricade sul tipo di evento: la riga lo mostra due volte
const rowOf = (eventType: string) => screen.getAllByText(eventType)[0]!.closest('tr')!
const channelsOf = (eventType: string) => within(rowOf(eventType)).getAllByRole('checkbox').map((cb) => cb.closest('label')!.textContent!.trim())

describe('NotificationRulesPage — canali consegnabili', () => {
  it('ogni riga offre solo i canali che il server dichiara per quel tipo', async () => {
    renderWithProviders(<NotificationRulesPage />, { mocks: [rulesMock, routingMock, workflowEventTypesMock] })
    expect((await screen.findAllByText('event.storm_started')).length).toBeGreaterThan(0)

    expect(channelsOf('incident.created')).toEqual(['In app', 'Email', 'Slack', 'Teams'])
    expect(channelsOf('change.approved')).toEqual(['In app', 'Email', 'Slack'])
    expect(channelsOf('event.storm_started')).toEqual(['In app', 'Email'])
  })

  it('un canale salvato ma non consegnabile resta visibile, spuntato e con l\'avviso, così si può togliere', async () => {
    renderWithProviders(<NotificationRulesPage />, { mocks: [rulesMock, routingMock, workflowEventTypesMock] })
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
    renderWithProviders(<NotificationRulesPage />, { mocks: [rulesMock, routingMock, workflowEventTypesMock] })
    await screen.findAllByText('event.storm_started')
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(['Incident', 'Change', 'Alarms and CI health', 'Monitored services'])
    expect(within(screen.getByRole('region', { name: 'Monitored services' })).getAllByText('service.incident_opened').length).toBeGreaterThan(0)
  })

  it('nuova regola: i canali seguono il tipo scelto (incident.created → 4, event.storm_started → 2)', async () => {
    const { user } = renderWithProviders(<NotificationRulesPage />, { mocks: [rulesMock, routingMock, workflowEventTypesMock] })
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

  /**
   * D-23 + D-13: i destinatari offerti sono il vocabolario condiviso
   * (`NOTIFICATION_TARGETS`), che ha un bersaglio per ogni ruolo VERO
   * (`USER_ROLES`). Prima la tendina offriva `role:manager`, un ruolo che
   * l'autenticazione non conosce: la regola si salvava e non avrebbe mai
   * selezionato nessuno.
   *
   * E i bersagli offerti seguono il TIPO DI EVENTO: alla nascita di un
   * incident non esistono ancora assegnatario e team, quindi non si possono
   * offrire (il server rifiuterebbe la regola).
   */
  it('i destinatari offerti sono quelli applicabili all\'evento, e i ruoli offerti sono quelli che l\'autenticazione accetta', async () => {
    renderWithProviders(<NotificationRulesPage />, { mocks: [rulesMock, routingMock, workflowEventTypesMock] })
    await screen.findAllByText('event.storm_started')

    // nella riga ci sono due tendine: gravità e destinatari (nell'ordine delle colonne)
    const select = within(rowOf('incident.created')).getAllByRole('combobox')[1]!
    const values = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)
    expect(values).not.toContain('assignee')
    expect(values).not.toContain('team_owner')

    const offeredRoles = values.filter((v) => v.startsWith('role:')).map((v) => v.slice('role:'.length))
    expect(offeredRoles).toEqual([...USER_ROLES])
    expect(values).not.toContain('role:manager')
    // ogni opzione ha un'etichetta tradotta, non il valore grezzo
    expect(within(select).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['Everyone', 'Admins only', 'Operators only', 'Viewers only', 'Portal users only'])
  })

  it('se la tabella dei canali non arriva, la pagina mostra l\'errore invece di un elenco di canali a prescindere', async () => {
    const routingError: GqlMock = { request: { query: GET_NOTIFICATION_ROUTING }, error: new Error('routing unavailable') }
    renderWithProviders(<NotificationRulesPage />, { mocks: [rulesMock, routingError, workflowEventTypesMock], showWarnings: false })
    expect(await screen.findByText('routing unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})

/**
 * Ondata 4 — D-22 / B-16: le regole del passo e quelle che non scatteranno mai.
 *
 * - una regola sul tipo stabile può essere ristretta allo SCOPO o alla
 *   CATEGORIA del passo, ed è ciò che la fa sopravvivere a una rinomina: la
 *   riga lo dice, invece di mostrare solo il tipo di evento;
 * - più regole possono condividere lo stesso tipo (una per scopo/categoria):
 *   la pagina le mostra tutte, non una sola;
 * - una regola il cui evento non è prodotto da niente — era il caso di
 *   `incident.on_hold`, viva in ogni tenant e morta da sempre — è marcata con
 *   un avviso: prima non risultava da nessuna parte;
 * - il dialogo offre i tipi VERI dei workflow del tenant, non sei costanti.
 */
describe('NotificationRulesPage — regole di passo e regole morte (ondata 4)', () => {
  const stepRules: GqlMock = {
    request: { query: GET_NOTIFICATION_RULES },
    result: { data: { notificationRules: [
      rule('r1', 'incident.step_entered', ['in_app'], { stepCategory: 'waiting', titleKey: 'notification.incident.on_hold.title' }),
      rule('r2', 'incident.step_entered', ['in_app'], { id: 'r2', stepPurpose: 'approval', titleKey: 'x.approval' }),
      rule('r3', 'incident.on_hold',      ['in_app'], { id: 'r3', eventProduced: false }),
    ] } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }

  it('mostra TUTTE le regole dello stesso tipo, ciascuna col suo restringimento', async () => {
    renderWithProviders(<NotificationRulesPage />, { mocks: [stepRules, routingMock, workflowEventTypesMock] })
    await screen.findAllByText('incident.step_entered')

    const rows = new Set(screen.getAllByText('incident.step_entered').map((el) => el.closest('tr')))
    expect(rows.size).toBe(2)
    expect(screen.getByText(T2('notificationRules.narrowCategory', { category: 'waiting' }))).toBeInTheDocument()
    expect(screen.getByText(T2('notificationRules.narrowPurpose', { purpose: T2('workflow.purposeOption.approval') }))).toBeInTheDocument()
  })

  it('una regola il cui evento non è prodotto da niente porta l\'avviso; le altre no', async () => {
    renderWithProviders(<NotificationRulesPage />, { mocks: [stepRules, routingMock, workflowEventTypesMock] })
    await screen.findAllByText('incident.on_hold')

    const dead = screen.getAllByText('incident.on_hold')[0]!.closest('tr')!
    expect(within(dead).getByLabelText(T2('notificationRules.eventNotProduced', { eventType: 'incident.on_hold' }))).toBeInTheDocument()
    const alive = screen.getAllByText('incident.step_entered')[0]!.closest('tr')!
    expect(within(alive).queryByLabelText(/non scatterà mai|will never fire/)).not.toBeInTheDocument()
  })

  it('il dialogo offre i passi dei workflow del tenant, e per il tipo stabile chiede scopo o categoria', async () => {
    const { user } = renderWithProviders(<NotificationRulesPage />, { mocks: [stepRules, routingMock, workflowEventTypesMock] })
    await screen.findAllByText('incident.step_entered')
    await user.click(screen.getByRole('button', { name: 'New rule' }))
    const dialog = screen.getByRole('dialog')
    const typeSelect = within(dialog).getByRole('combobox', { name: 'Event type' })

    // il passo del cliente è offerto con la sua etichetta: prima non c'era modo
    // di indovinare il nome del tipo generato
    expect(within(typeSelect).getByRole('option', { name: /incident\.in_attesa_fornitore — In attesa del fornitore/ })).toBeInTheDocument()

    // nessun restringimento finché il tipo non è quello stabile
    expect(within(dialog).queryByRole('combobox', { name: T2('notificationRules.stepPurpose') })).not.toBeInTheDocument()
    await user.selectOptions(typeSelect, 'incident.step_entered')
    const purpose = within(dialog).getByRole('combobox', { name: T2('notificationRules.stepPurpose') })
    expect(within(purpose).getAllByRole('option').length).toBe(WORKFLOW_STEP_PURPOSES.length + 1)
    // le categorie offerte sono quelle che i passi del tenant usano davvero
    const category = within(dialog).getByRole('combobox', { name: T2('notificationRules.stepCategory') })
    expect(within(category).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['', 'active', 'waiting'])
  })
})
