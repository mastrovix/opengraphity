/**
 * notificationRules.ts (revisione 2, D3.1): la query `notificationRouting`
 * espone la tabella dei canali instradabili così com'è nel pacchetto; create e
 * update rifiutano con BAD_USER_INPUT una regola che chiede un canale che il
 * dispatcher non sa consegnare per quel tipo, PRIMA di scrivere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { ROUTABLE_CHANNELS_BY_EVENT, DEFAULT_ROUTABLE_CHANNELS } from '@opengraphity/notifications'
import { NOTIFICATION_TARGETS, USER_ROLES } from '@opengraphity/types'

const mockSession = { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

// `runQuery` serve a `workflowEventTypeRows` (lib/stepEvent.ts), che il
// resolver usa per dire se il tipo di evento di una regola è prodotto da
// qualcosa (`eventProduced`): nessun workflow nel mock → lista vuota.
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn().mockResolvedValue([]) }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/bullmq.js', () => ({ getQueue: vi.fn() }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('@opengraphity/notifications', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/notifications')>()
  return { ...orig, invalidateRuleCache: vi.fn() }
})

const { notificationRuleResolvers } = await import('../notificationRules.js')
import { isTargetApplicable } from '@opengraphity/types'

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin' }
const ruleNode = (props: Record<string, unknown>) => ({ records: [{ get: () => ({ properties: props }) }] })

async function expectBadInput(p: Promise<unknown>, pattern: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
  expect((err as GraphQLError).message).toMatch(pattern)
}

beforeEach(() => vi.clearAllMocks())

describe('Query.notificationRouting', () => {
  it('restituisce i canali predefiniti e una voce per ogni tipo con formatter dedicato, copiati dal pacchetto', () => {
    const out = notificationRuleResolvers.Query.notificationRouting()
    expect(out.defaultChannels).toEqual([...DEFAULT_ROUTABLE_CHANNELS])
    expect(out.byEventType).toEqual(Object.entries(ROUTABLE_CHANNELS_BY_EVENT).map(([eventType, channels]) => ({ eventType, channels: [...channels] })))
    expect(out.byEventType.find((e) => e.eventType === 'incident.created')!.channels).toEqual(['in_app', 'email', 'slack', 'teams'])
    expect(out.byEventType.find((e) => e.eventType === 'change.approved')!.channels).toEqual(['in_app', 'email', 'slack'])
    expect(out.byEventType.some((e) => e.eventType === 'event.storm_started')).toBe(false)
    // copie: chi legge non può mutare la tabella del pacchetto
    out.defaultChannels.push('sms')
    expect(DEFAULT_ROUTABLE_CHANNELS).toEqual(['in_app', 'email'])
  })
})

describe('createNotificationRule — canali non instradabili → BAD_USER_INPUT prima di scrivere', () => {
  const base = { titleKey: 'k', target: 'all' }

  it('slack su event.storm_started → rifiutato con i canali ammessi nel messaggio', async () => {
    await expectBadInput(
      notificationRuleResolvers.Mutation.createNotificationRule(null, { input: { ...base, eventType: 'event.storm_started', channels: ['in_app', 'slack'] } }, ctx),
      /Channels \[slack\] cannot be routed for event\.storm_started .* Routable: in_app, email/,
    )
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('nessun canale → rifiutato', async () => {
    await expectBadInput(
      notificationRuleResolvers.Mutation.createNotificationRule(null, { input: { ...base, eventType: 'incident.created', channels: [] } }, ctx),
      /at least one channel/,
    )
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('canali instradabili (slack+teams su incident.created) → CREATE', async () => {
    // create ora legge prima se esiste già una regola per lo stesso tipo e lo
    // stesso restringimento (due regole identiche sono ambigue): nessuna.
    mockSession.executeRead.mockImplementationOnce(async () => ({ records: [] }))
    mockSession.executeWrite.mockImplementationOnce(async () => ruleNode({ id: 'r1', event_type: 'incident.created', enabled: true, title_key: 'k', channels: ['in_app', 'slack', 'teams'], target: 'all' }))
    const out = await notificationRuleResolvers.Mutation.createNotificationRule(null, { input: { ...base, eventType: 'incident.created', channels: ['in_app', 'slack', 'teams'] } }, ctx)
    expect(out.channels).toEqual(['in_app', 'slack', 'teams'])
    expect(mockSession.executeWrite).toHaveBeenCalledTimes(1)
  })
})

/**
 * D-23 — il destinatario viene validato in scrittura contro il vocabolario
 * condiviso (`NOTIFICATION_TARGETS`), che ha un bersaglio per ruolo VERO
 * (USER_ROLES). Prima `target` veniva scritto senza controllo e poi ignorato
 * in consegna: `role:manager` era salvabile e non avrebbe mai selezionato
 * nessuno.
 */
describe('target — validato in scrittura contro NOTIFICATION_TARGETS', () => {
  it('il vocabolario ha un bersaglio per ogni ruolo vero e nessun role:manager', () => {
    expect(NOTIFICATION_TARGETS).toEqual(['all', 'assignee', 'team_owner', ...USER_ROLES.map((r) => `role:${r}`)])
    expect(NOTIFICATION_TARGETS).not.toContain('role:manager')
  })

  it('create con role:manager → BAD_USER_INPUT con i valori ammessi, nessuna scrittura', async () => {
    await expectBadInput(
      notificationRuleResolvers.Mutation.createNotificationRule(null, { input: { titleKey: 'k', eventType: 'incident.created', channels: ['in_app'], target: 'role:manager' } }, ctx),
      /Target "role:manager" non è un destinatario valido\. Ammessi: all, assignee, team_owner, role:admin/,
    )
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('update con un bersaglio inventato → BAD_USER_INPUT, nessuna lettura e nessuna scrittura', async () => {
    await expectBadInput(
      notificationRuleResolvers.Mutation.updateNotificationRule(null, { id: 'r1', input: { target: 'squadra' } }, ctx),
      /Target "squadra" non è un destinatario valido/,
    )
    expect(mockSession.executeRead).not.toHaveBeenCalled()
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('update con role:operator → scrittura', async () => {
    // Cambiare il bersaglio ora legge prima il tipo di evento dal nodo: serve
    // per dire se quel bersaglio è risolvibile per quell'evento.
    mockSession.executeRead.mockImplementationOnce(async () => ({ records: [{ get: () => 'incident.created' }] }))
    mockSession.executeWrite.mockImplementationOnce(async () => ruleNode({ id: 'r1', event_type: 'incident.created', enabled: true, title_key: 'k', channels: ['in_app'], target: 'role:operator' }))
    const out = await notificationRuleResolvers.Mutation.updateNotificationRule(null, { id: 'r1', input: { target: 'role:operator' } }, ctx)
    expect(out.target).toBe('role:operator')
  })
})

describe('updateNotificationRule — il tipo si legge dal nodo, poi i canali vengono verificati', () => {
  it('teams su una regola change.approved → BAD_USER_INPUT, nessuna scrittura', async () => {
    mockSession.executeRead.mockImplementationOnce(async () => ({ records: [{ get: () => 'change.approved' }] }))
    await expectBadInput(
      notificationRuleResolvers.Mutation.updateNotificationRule(null, { id: 'r1', input: { channels: ['in_app', 'teams'] } }, ctx),
      /Channels \[teams\] cannot be routed for change\.approved/,
    )
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('regola inesistente → NOT_FOUND già alla lettura del tipo', async () => {
    mockSession.executeRead.mockImplementationOnce(async () => ({ records: [] }))
    const err = await notificationRuleResolvers.Mutation.updateNotificationRule(null, { id: 'nope', input: { channels: ['in_app'] } }, ctx).then(() => null, (e: unknown) => e)
    expect((err as GraphQLError).extensions['code']).toBe('NOT_FOUND')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('update senza channels (solo enabled) → nessuna lettura del tipo, scrittura diretta', async () => {
    mockSession.executeWrite.mockImplementationOnce(async () => ruleNode({ id: 'r1', event_type: 'event.storm_started', enabled: false, title_key: 'k', channels: ['in_app'], target: 'all' }))
    const out = await notificationRuleResolvers.Mutation.updateNotificationRule(null, { id: 'r1', input: { enabled: false } }, ctx)
    expect(out.enabled).toBe(false)
    expect(mockSession.executeRead).not.toHaveBeenCalled()
  })

  it('canali instradabili → scrittura', async () => {
    mockSession.executeRead.mockImplementationOnce(async () => ({ records: [{ get: () => 'sla.breached' }] }))
    mockSession.executeWrite.mockImplementationOnce(async () => ruleNode({ id: 'r1', event_type: 'sla.breached', enabled: true, title_key: 'k', channels: ['in_app', 'teams'], target: 'all' }))
    const out = await notificationRuleResolvers.Mutation.updateNotificationRule(null, { id: 'r1', input: { channels: ['in_app', 'teams'] } }, ctx)
    expect(out.channels).toEqual(['in_app', 'teams'])
  })

})

describe('target — applicabilità per tipo di evento', () => {
  // Il bersaglio esiste nel vocabolario ma non può essere risolto per QUEL
  // tipo di evento: alla nascita di un incident non ci sono ancora
  // assegnatario e team, quindi la regola non consegnerebbe mai niente.
  it('rifiuta un bersaglio impossibile per il tipo di evento, e accetta lo stesso bersaglio su un evento successivo', async () => {
    await expectBadInput(
      notificationRuleResolvers.Mutation.createNotificationRule(
        null,
        { input: { eventType: 'incident.created', titleKey: 'x', channels: ['in_app'], target: 'team_owner' } },
        ctx,
      ),
      /non può essere risolto per l'evento "incident\.created"/,
    )
    await expectBadInput(
      notificationRuleResolvers.Mutation.createNotificationRule(
        null,
        { input: { eventType: 'event.storm_started', titleKey: 'x', channels: ['in_app'], target: 'assignee' } },
        ctx,
      ),
      /non può essere risolto/,
    )
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    // lo stesso bersaglio su un evento in cui l'assegnazione esiste: nessun errore di applicabilità
    expect(isTargetApplicable('incident.assigned', 'team_owner')).toBe(true)
    expect(isTargetApplicable('change.task_assigned', 'assignee')).toBe(true)
  })
})
