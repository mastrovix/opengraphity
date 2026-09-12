import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

/**
 * D-23 — il bersaglio della regola viene APPLICATO.
 *
 * Prima: `target` veniva letto dalla regola e mai usato; ogni notifica in-app
 * andava a `sendToTenant` (tutte le connessioni del tenant, `viewer`
 * compresi) e ogni email a tutti gli admin/operator. Dal vivo c-one aveva una
 * regola `incident.created` con `target = 'team_owner'` e 93 notifiche già
 * diffuse a tutto il tenant.
 *
 * Qui si verifica, con connessioni SSE vere (il manager non è mockato): una
 * regola `role:admin` non arriva al `viewer` collegato, una `assignee` arriva
 * solo all'assegnatario, e un bersaglio che non si risolve fa fallire il job
 * con un messaggio che lo nomina, senza consegnare niente a nessuno.
 */

const runQueries: Array<{ cypher: string; params: Record<string, unknown> }> = []
let ruleRows: Array<Record<string, unknown>> = []
let assigneeRows: Array<Record<string, unknown>> = []
let teamRows: Array<Record<string, unknown>> = []
let roleRows: Array<Record<string, unknown>> = []
let broadcastEmailRows: Array<Record<string, unknown>> = []

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      fn({
        run: async (cypher: string, params: Record<string, unknown>) => {
          runQueries.push({ cypher, params })
          // `notificationsEnabled` è la firma delle query dei destinatari
          // (recipients.ts): distingue quelle dalle letture di arricchimento
          // dell'incident, che citano ASSIGNED_TO per il nome dell'assegnatario.
          const isRecipientQuery = cypher.includes('notificationsEnabled')
          const rows =
            cypher.includes('NotificationRule')                              ? ruleRows
            : isRecipientQuery && cypher.includes('ASSIGNED_TO_TEAM')        ? teamRows
            : isRecipientQuery && cypher.includes('[:ASSIGNED_TO]')          ? assigneeRows
            : isRecipientQuery && cypher.includes('WHERE u.role = $role')    ? roleRows
            : cypher.includes('u.role IN')                                   ? broadcastEmailRows
            : []
          return { records: rows.map((r) => ({ get: (k: string) => (k === 'r' ? { properties: r } : r[k]) })) }
        },
      }),
    close: async () => {},
  }),
}))
vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public queueName: string) {} async start() {} async stop() {} },
  assertSafeOutboundUrl: vi.fn(async () => {}),
  loggableUrl: (u: string) => u,
}))
const sendEmail = vi.fn<(msg: { to: string[]; subject: string; html: string }) => Promise<void>>(async () => {})
vi.mock('../email.js', () => ({ sendEmail }))

const { NotificationDispatcher, invalidateRuleCache } = await import('../dispatcher.js')
const { sseManager } = await import('../sse.js')

function rule(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'rule-1', enabled: true, severity_override: 'warning', title_key: 'notification.incident.created.title', channels: ['in_app'], target: 'all', ...over }
}
function event(type: string, payload: Record<string, unknown>, tenantId = 't1'): DomainEvent<unknown> {
  return { id: `evt-${type}`, type, tenant_id: tenantId, timestamp: '2026-09-12T10:00:00.000Z', correlation_id: 'c', actor_id: 'u', payload }
}
const incidentPayload = { id: 'inc-1', title: 'DB down', severity: 'critical', status: 'new' }
const person = (id: string, email: string | null, notificationsEnabled = true) => ({ id, email, notificationsEnabled })

/** Connessioni SSE vere: una per utente, così si vede CHI ha ricevuto. */
const openClients: string[] = []
function connect(userId: string): { writes: string[] } {
  const writes: string[] = []
  openClients.push(sseManager.connect('t1', userId, { write: (d: string) => writes.push(d) }))
  return { writes }
}
/** La query dei destinatari che contiene `marker` (le letture di arricchimento non contano). */
const recipientQuery = (marker: string) => runQueries.find((q) => q.cypher.includes('notificationsEnabled') && q.cypher.includes(marker))
const received = (c: { writes: string[] }) => c.writes.filter((w) => w.includes('notification.incident.created.title')).length

beforeEach(() => {
  runQueries.length = 0
  ruleRows = []
  assigneeRows = []
  teamRows = []
  roleRows = []
  broadcastEmailRows = []
  sendEmail.mockClear()
  invalidateRuleCache('t1')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  // Il manager è un singleton: si chiudono tutte le connessioni del test.
  while (openClients.length) sseManager.disconnect(openClients.pop()!)
  vi.restoreAllMocks()
})

describe('target role:<ruolo> — solo gli utenti con quel ruolo', () => {
  it('una regola role:admin non arriva al viewer collegato, e l\'email va ai soli admin', async () => {
    const admin  = connect('u-admin')
    const viewer = connect('u-viewer')
    ruleRows = [rule({ target: 'role:admin', channels: ['in_app', 'email'] })]
    roleRows = [person('u-admin', 'admin@x.example')]
    broadcastEmailRows = [{ email: 'chiunque@x.example' }]

    await new NotificationDispatcher().process(event('incident.created', incidentPayload))

    expect(received(admin)).toBe(1)
    expect(received(viewer)).toBe(0)
    const roleQuery = recipientQuery('WHERE u.role = $role')!
    expect(roleQuery.params).toEqual({ tenantId: 't1', role: 'admin' })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(sendEmail.mock.calls[0]![0].to).toEqual(['admin@x.example'])
    // la trasmissione ad admin/operator NON viene nemmeno interrogata
    expect(runQueries.some((q) => q.cypher.includes('u.role IN'))).toBe(false)
  })

  it('un ruolo senza utenti → il job FALLISCE nominando il bersaglio e nessuno riceve nulla', async () => {
    const admin  = connect('u-admin')
    const viewer = connect('u-viewer')
    ruleRows = [rule({ target: 'role:admin', channels: ['in_app', 'email'] })]
    roleRows = []

    await expect(new NotificationDispatcher().process(event('incident.created', incidentPayload)))
      .rejects.toThrow(/targets "role:admin" but tenant t1 has no user with role "admin"/)

    expect(received(admin)).toBe(0)
    expect(received(viewer)).toBe(0)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('un bersaglio fuori vocabolario (role:manager, ruolo che non esiste) → job fallito con i valori ammessi', async () => {
    ruleRows = [rule({ target: 'role:manager' })]
    await expect(new NotificationDispatcher().process(event('incident.created', incidentPayload)))
      .rejects.toThrow(/target "role:manager", which is not one of \[all, assignee, team_owner, role:admin, role:operator, role:viewer, role:end_user\]/)
  })
})

describe('target assignee / team_owner — risolti dall\'entità', () => {
  it('assignee: solo l\'assegnatario riceve, e l\'email va solo a lui', async () => {
    const assignee = connect('u-assignee')
    const other    = connect('u-other')
    ruleRows = [rule({ target: 'assignee', channels: ['in_app', 'email'] })]
    assigneeRows = [person('u-assignee', 'ass@x.example')]

    await new NotificationDispatcher().process(event('incident.created', incidentPayload))

    expect(received(assignee)).toBe(1)
    expect(received(other)).toBe(0)
    expect(recipientQuery('[:ASSIGNED_TO]')!.params).toEqual({ tenantId: 't1', entityId: 'inc-1' })
    expect(sendEmail.mock.calls[0]![0].to).toEqual(['ass@x.example'])
  })

  it('assignee su un\'entità senza assegnatario → job fallito che nomina entità e bersaglio', async () => {
    ruleRows = [rule({ target: 'assignee' })]
    assigneeRows = []
    await expect(new NotificationDispatcher().process(event('incident.created', incidentPayload)))
      .rejects.toThrow(/targets "assignee" but incident inc-1 has no assignee/)
  })

  it('team_owner: membri e responsabile del team; chi ha spento le notifiche resta in-app ma non via email', async () => {
    const member  = connect('u-member')
    const manager = connect('u-manager')
    const other   = connect('u-other')
    ruleRows = [rule({ target: 'team_owner', channels: ['in_app', 'email'] })]
    teamRows = [person('u-member', 'm@x.example'), person('u-manager', 'g@x.example', false)]

    await new NotificationDispatcher().process(event('incident.created', incidentPayload))

    expect([received(member), received(manager), received(other)]).toEqual([1, 1, 0])
    expect(sendEmail.mock.calls[0]![0].to).toEqual(['m@x.example'])
  })

  it('un payload senza id dell\'entità → job fallito (il destinatario non è ricavabile)', async () => {
    ruleRows = [rule({ target: 'assignee' })]
    await expect(new NotificationDispatcher().process(event('change.task_assigned', { changeId: 'chg-1', taskId: 'task-1' })))
      .rejects.toThrow(/has no entity id/)
  })
})

describe('target all — la trasmissione resta la trasmissione', () => {
  it('in-app a tutte le connessioni del tenant, email ad admin/operator: nessuna risoluzione di destinatari', async () => {
    const admin  = connect('u-admin')
    const viewer = connect('u-viewer')
    ruleRows = [rule({ target: 'all', channels: ['in_app', 'email'] })]
    broadcastEmailRows = [{ email: 'ops@x.example' }]

    await new NotificationDispatcher().process(event('incident.created', incidentPayload))

    expect([received(admin), received(viewer)]).toEqual([1, 1])
    expect(sendEmail.mock.calls[0]![0].to).toEqual(['ops@x.example'])
    expect(recipientQuery('WHERE u.role = $role')).toBeUndefined()
  })

  it('una regola con soli canali Slack non risolve destinatari: il bersaglio non riguarda i canali del tenant', async () => {
    ruleRows = [rule({ target: 'assignee', channels: ['slack'] })]
    // nessun NotificationChannel configurato → niente da mandare, e soprattutto
    // nessuna risoluzione del bersaglio (che qui non c'entra)
    await new NotificationDispatcher().process(event('incident.created', incidentPayload))
    expect(recipientQuery('[:ASSIGNED_TO]')).toBeUndefined()
  })
})

describe('workflow.step.entered — stesso bersaglio, stesse regole', () => {
  it('una regola di passo con target assignee arriva solo all\'assegnatario dell\'entità del passo', async () => {
    const assignee = connect('u-assignee')
    const other    = connect('u-other')
    assigneeRows = [person('u-assignee', null)]

    await new NotificationDispatcher().process(event('workflow.step.entered', {
      stepName: 'Assessment', entityType: 'change', entityId: 'chg-1',
      notifyRule: { title_key: 'notification.incident.created.title', severity: 'info', channels: ['in_app'], target: 'assignee' },
    }))

    expect([received(assignee), received(other)]).toEqual([1, 0])
    expect(recipientQuery('[:ASSIGNED_TO]')!.params).toEqual({ tenantId: 't1', entityId: 'chg-1' })
  })

  it('una regola di passo senza target (scritta prima dei bersagli) resta una trasmissione', async () => {
    const admin  = connect('u-admin')
    const viewer = connect('u-viewer')
    await new NotificationDispatcher().process(event('workflow.step.entered', {
      stepName: 'Assessment', entityType: 'change', entityId: 'chg-1',
      notifyRule: { title_key: 'notification.incident.created.title', severity: 'info', channels: ['in_app'] },
    }))
    expect([received(admin), received(viewer)]).toEqual([1, 1])
  })
})
