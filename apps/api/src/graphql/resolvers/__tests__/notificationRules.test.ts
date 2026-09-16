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
import { NOTIFICATION_TARGETS, USER_ROLES, NOTIFICATION_SEVERITIES } from '@opengraphity/types'

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
// I ruoli dell'organizzazione (ondata 7): i quattro di fabbrica più «service_desk», creato dall'admin.
vi.mock('../../../lib/roles.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/roles.js')>()
  const keys = new Set(['admin', 'operator', 'viewer', 'end_user', 'service_desk'])
  return {
    ...real,
    assertRolesExist: vi.fn(async (_t: string, roleKeys: readonly string[]) => {
      const missing = roleKeys.filter((k) => !keys.has(k))
      if (missing.length) throw new (await import('../../../lib/errors.js')).ValidationError(`Recipients name roles this organization does not have: ${missing.join(', ')}`, { key: 'errors.role.unknownTarget', params: { roles: missing.join(', ') } })
    }),
  }
})
vi.mock('@opengraphity/notifications', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/notifications')>()
  return { ...orig, invalidateRuleCache: vi.fn() }
})

const { notificationRuleResolvers } = await import('../notificationRules.js')
import { isTargetApplicable } from '@opengraphity/types'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin', permissions: perms('admin') }
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
    // Revisione totale · E-18: le change hanno anche la card Teams.
    expect(out.byEventType.find((e) => e.eventType === 'change.approved')!.channels).toEqual(['in_app', 'email', 'slack', 'teams'])
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
 * D-23 — il destinatario viene validato in scrittura: la forma contro il
 * vocabolario condiviso, e un bersaglio per ruolo contro i ruoli
 * dell'organizzazione (ondata 7). Prima `target` veniva scritto senza controllo
 * e poi ignorato in consegna: `role:manager` era salvabile e non avrebbe mai
 * selezionato nessuno.
 */
describe('target — validato in scrittura contro NOTIFICATION_TARGETS', () => {
  it('il vocabolario ha un bersaglio per ogni ruolo vero e nessun role:manager', () => {
    expect(NOTIFICATION_TARGETS).toEqual(['all', 'assignee', 'team_owner', ...USER_ROLES.map((r) => `role:${r}`)])
    expect(NOTIFICATION_TARGETS).not.toContain('role:manager')
  })

  it('create con role:manager (un ruolo che l\'organizzazione non ha) → BAD_USER_INPUT, nessuna scrittura', async () => {
    await expectBadInput(
      notificationRuleResolvers.Mutation.createNotificationRule(null, { input: { titleKey: 'k', eventType: 'incident.created', channels: ['in_app'], target: 'role:manager' } }, ctx),
      /roles this organization does not have: manager/,
    )
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('create con un bersaglio malformato → BAD_USER_INPUT con i valori ammessi', async () => {
    await expectBadInput(
      notificationRuleResolvers.Mutation.createNotificationRule(null, { input: { titleKey: 'k', eventType: 'incident.created', channels: ['in_app'], target: 'role:Service Desk' } }, ctx),
      /Target "role:Service Desk" is not a valid recipient\. Allowed: all, assignee, team_owner, role:<role>/,
    )
  })

  it('update con un bersaglio inventato → BAD_USER_INPUT, nessuna lettura e nessuna scrittura', async () => {
    await expectBadInput(
      notificationRuleResolvers.Mutation.updateNotificationRule(null, { id: 'r1', input: { target: 'squadra' } }, ctx),
      /Target "squadra" is not a valid recipient/,
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
  /**
   * Revisione totale · E-18: `teams` su una regola `change.approved` ORA è
   * ammesso (la card Teams delle change esiste). Il rifiuto resta per i tipi
   * che davvero non hanno un formatter, come `event.storm_started`.
   */
  it('slack su una regola event.storm_started → BAD_USER_INPUT, nessuna scrittura', async () => {
    mockSession.executeRead.mockImplementationOnce(async () => ({ records: [{ get: () => 'event.storm_started' }] }))
    await expectBadInput(
      notificationRuleResolvers.Mutation.updateNotificationRule(null, { id: 'r1', input: { channels: ['in_app', 'slack'] } }, ctx),
      /Channels \[slack\] cannot be routed for event\.storm_started/,
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
      /cannot be resolved for the "incident\.created" event/,
    )
    await expectBadInput(
      notificationRuleResolvers.Mutation.createNotificationRule(
        null,
        { input: { eventType: 'event.storm_started', titleKey: 'x', channels: ['in_app'], target: 'assignee' } },
        ctx,
      ),
      /cannot be resolved/,
    )
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    // lo stesso bersaglio su un evento in cui l'assegnazione esiste: nessun errore di applicabilità
    expect(isTargetApplicable('incident.assigned', 'team_owner')).toBe(true)
    expect(isTargetApplicable('change.task_assigned', 'assignee')).toBe(true)
  })
})

/**
 * Revisione del 14 set 2026 · NT-1: la pagina offre info/success/warning/error;
 * l'API accettava low/medium/high/critical. Dal vivo, cambiare la severità di
 * una regola falliva sempre. Il vocabolario ora è uno solo.
 */
describe('severità della regola — lo stesso vocabolario della pagina', () => {
  it('update: ogni severità che la pagina offre si salva', async () => {
    for (const severity of NOTIFICATION_SEVERITIES) {
      mockSession.executeWrite.mockImplementationOnce(async () => ruleNode({ id: 'r1', event_type: 'incident.created', enabled: true, title_key: 'k', channels: ['in_app'], target: 'all', severity_override: severity }))
      const out = await notificationRuleResolvers.Mutation.updateNotificationRule(null, { id: 'r1', input: { severityOverride: severity } }, ctx)
      expect(out.severityOverride).toBe(severity)
    }
  })

  it('update e create: una priorità del ticket non è una severità → BAD_USER_INPUT, nessuna scrittura', async () => {
    await expectBadInput(
      notificationRuleResolvers.Mutation.updateNotificationRule(null, { id: 'r1', input: { severityOverride: 'high' } }, ctx),
      /severityOverride must be one of: info, success, warning, error/,
    )
    await expectBadInput(
      notificationRuleResolvers.Mutation.createNotificationRule(null, { input: { titleKey: 'k', eventType: 'incident.created', channels: ['in_app'], target: 'all', severityOverride: 'critical' } }, ctx),
      /severityOverride must be one of/,
    )
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })
})

/** NT-8: i campi che nessuno leggeva sono rifiutati con il motivo; l'ora del digest è validata. */
describe('campi speciali delle regole', () => {
  it('escalationTarget, slaWarningTarget e slaWarningThresholdPercent non si scrivono più', async () => {
    for (const input of [{ escalationTarget: 'all' }, { slaWarningTarget: 'all' }, { slaWarningThresholdPercent: 80 }]) {
      await expectBadInput(notificationRuleResolvers.Mutation.updateNotificationRule(null, { id: 'r1', input }, ctx), /no longer a rule field/)
    }
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })
  it('digestTime deve essere HH:MM', async () => {
    await expectBadInput(notificationRuleResolvers.Mutation.updateNotificationRule(null, { id: 'r1', input: { digestTime: '8' } }, ctx), /HH:MM/)
  })
})
