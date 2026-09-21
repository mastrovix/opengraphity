import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'
import type { InAppNotification } from '../sse.js'

// Revisione totale · E-3: la consegna è deduplicata per canale su Redis. Nei
// test gli eventi riusano lo stesso id, quindi la deduplica va azzerata a
// ogni caso: il contratto della deduplica è pinnato in deliveryDedup.test.ts.
vi.mock('../deliveryDedup.js', () => ({
  deliverOnce: async (_id: string | undefined, _ch: string, deliver: () => Promise<void> | void) => { await deliver(); return true },
  alreadyDelivered: async () => false,
  markDelivered: async () => {},
  resetDeliveryDedup: () => {},
}))

// Complements dispatcher.test.ts (email escaping, notifications_enabled
// recipients, Teams routing on sla.breached). Covered here: NotificationRule
// lookup + cache, in_app fan-out, Slack routing per tenant, email batching,
// the "one channel fails" contract, workflow.step.entered guards.

const runQueries: Array<{ cypher: string; params: Record<string, unknown> }> = []
let userRows: Array<Record<string, unknown>> = []
let channelRows: Array<Record<string, unknown>> = []
let ruleRows: Array<Record<string, unknown>> = []

// Il marchio dell'organizzazione nelle e-mail (ondata 6): qui quello di fabbrica, senza leggere il Tenant.
vi.mock('../brand.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../brand.js')>()
  const { FACTORY_TENANT_BRAND } = await import('@opengraphity/types')
  return { ...real, loadTenantBrand: vi.fn(async () => ({ ...FACTORY_TENANT_BRAND, isDefault: true })) }
})
vi.mock('../locale.js', () => ({ loadNotificationLocale: vi.fn(async () => ({ language: 'en', timeZone: 'UTC' })), invalidateNotificationLocale: vi.fn() }))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      fn({
        run: async (cypher: string, params: Record<string, unknown>) => {
          runQueries.push({ cypher, params })
          if (cypher.includes('MATCH (u:User'))         return { records: userRows.map(r => ({ get: (k: string) => r[k] })) }
          if (cypher.includes('NotificationChannel'))   return { records: channelRows.map(r => ({ get: () => ({ properties: r }) })) }
          if (cypher.includes('NotificationRule'))      return { records: ruleRows.map(r => ({ get: () => ({ properties: r }) })) }
          return { records: [] }
        },
      }),
    close: async () => {},
  }),
}))
vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public queueName: string) {} async start() {} async stop() {} },
  assertSafeOutboundUrl: vi.fn(async () => {}),
  loggableUrl: (u: string) => { try { return new URL(u).host } catch { return '<invalid-url>' } },
}))
const sendEmail = vi.fn<(msg: { to: string[]; subject: string; html: string }) => Promise<void>>(async () => {})
vi.mock('../email.js', () => ({ sendEmail }))

type FetchInit = { method: string; headers: Record<string, string>; body: string }
const fetchMock = vi.fn<(url: string, init: FetchInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(
  async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
)
vi.stubGlobal('fetch', fetchMock)

const { NotificationDispatcher, invalidateRuleCache } = await import('../dispatcher.js')
const { sseManager } = await import('../sse.js')

function rule(channels: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'rule-1', enabled: true, severity_override: 'warning', title_key: 'notification.incident.created.title', channels, target: 'all', ...over }
}
function slackChannel(id: string, events: string[]): Record<string, unknown> {
  return { id, platform: 'slack', webhook_url: `https://hooks.slack.example/${id}`, channel_id: null, event_types: JSON.stringify(events) }
}
function teamsChannel(id: string, events: string[], webhook: string | null = `https://teams.example/${id}`): Record<string, unknown> {
  return { id, platform: 'teams', webhook_url: webhook, channel_id: null, event_types: JSON.stringify(events) }
}
function event(type: string, payload: Record<string, unknown>, tenantId = 't1'): DomainEvent<unknown> {
  return { id: `evt-${type}`, type, tenant_id: tenantId, timestamp: '2026-09-08T10:00:00.000Z', correlation_id: 'c', actor_id: 'u', payload }
}
const incidentPayload = { id: 'inc-1', title: 'DB down', severity: 'critical', status: 'open', assignedTo: 'Mario', ciName: 'db-01' }

let sendToTenant: MockInstance<(tenantId: string, event: InAppNotification) => Promise<void>>

beforeEach(() => {
  runQueries.length = 0
  userRows = []
  channelRows = []
  ruleRows = []
  sendEmail.mockClear()
  fetchMock.mockClear()
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
  for (const t of ['t1', 't2', 't3']) invalidateRuleCache(t)
  sendToTenant = vi.spyOn(sseManager, 'deliverToTenant').mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── Rule lookup ──────────────────────────────────────────────────────────────

describe('NotificationDispatcher.process — rule lookup', () => {
  it('no NotificationRule for (tenant, event) → no dispatch on any channel', async () => {
    const d = new NotificationDispatcher()
    await d.process(event('incident.created', incidentPayload))
    const q = runQueries.find(q => q.cypher.includes('NotificationRule'))!
    expect(q.params).toEqual({ tenantId: 't1', eventType: 'incident.created' })
    expect(sendToTenant).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('a disabled rule behaves like no rule', async () => {
    ruleRows = [rule(['in_app', 'email', 'slack'], { enabled: false })]
    await new NotificationDispatcher().process(event('incident.created', incidentPayload))
    expect(sendToTenant).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rule with in_app → one SSE broadcast to the tenant with title_key/severity_override/entity fields', async () => {
    ruleRows = [rule(['in_app'])]
    await new NotificationDispatcher().process(event('incident.created', incidentPayload))
    expect(sendToTenant).toHaveBeenCalledTimes(1)
    const [tenantId, n] = sendToTenant.mock.calls[0]!
    expect(tenantId).toBe('t1')
    expect(n).toMatchObject({
      type: 'incident.created',
      title: 'notification.incident.created.title',
      severity: 'warning',
      entity_id: 'inc-1',
      entity_type: 'incident',
      message: 'DB down — critical — Mario',
      timestamp: '2026-09-08T10:00:00.000Z',
      read: false,
    })
    expect(n.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  /**
   * CONTRATTO RINEGOZIATO (revisione totale · E-44). Prima una regola senza
   * canali o senza bersaglio ripiegava su `['in_app']` e `'all'`: una regola
   * scritta male via API o da una migrazione TRASMETTEVA a tutto il tenant,
   * viewer compresi — lo stesso difetto di riservatezza già chiuso (D-23),
   * per una via secondaria. Ora è un dato rotto e si dice.
   */
  it('regola senza canali o senza bersaglio → errore che la nomina, nessuna trasmissione (E-44)', async () => {
    ruleRows = [{ id: 'r-rotta', enabled: true, title_key: 'k', event_type: 'incident.created' }]
    await expect(new NotificationDispatcher().process(event('incident.created', incidentPayload)))
      .rejects.toThrow(/NotificationRule r-rotta .* has no channels/)
    expect(sendToTenant).not.toHaveBeenCalled()

    ruleRows = [{ id: 'r-senza-target', enabled: true, title_key: 'k', event_type: 'incident.created', channels: ['in_app'] }]
    await expect(new NotificationDispatcher().process(event('incident.created', incidentPayload)))
      .rejects.toThrow(/has no target/)
    expect(sendToTenant).not.toHaveBeenCalled()
  })


  it('caches the rule per (tenant, event) for 60s; invalidateRuleCache and TTL expiry re-query', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T10:00:00.000Z'))
    ruleRows = [rule(['in_app'])]
    const d = new NotificationDispatcher()
    const ruleQueries = () => runQueries.filter(q => q.cypher.includes('NotificationRule')).length

    await d.process(event('incident.created', incidentPayload))
    await d.process(event('incident.created', incidentPayload))
    expect(ruleQueries()).toBe(1)

    // another tenant is a different cache key
    await d.process(event('incident.created', incidentPayload, 't2'))
    expect(ruleQueries()).toBe(2)

    invalidateRuleCache('t1', 'incident.created')
    await d.process(event('incident.created', incidentPayload))
    expect(ruleQueries()).toBe(3)

    vi.setSystemTime(new Date('2026-09-08T10:01:00.001Z'))   // 60s + 1ms later
    await d.process(event('incident.created', incidentPayload))
    expect(ruleQueries()).toBe(4)

    // a null (no rule) result is cached too
    ruleRows = []
    invalidateRuleCache('t1')
    await d.process(event('incident.created', incidentPayload))
    await d.process(event('incident.created', incidentPayload))
    expect(ruleQueries()).toBe(5)
    expect(sendToTenant).toHaveBeenCalledTimes(5)   // the two "no rule" calls broadcast nothing
  })
})

// ── Slack / Teams routing ────────────────────────────────────────────────────

describe('NotificationDispatcher — Slack routing per tenant', () => {
  it('incident.created with a slack rule → only the tenant slack channels subscribed to "assigned"', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [
      slackChannel('s-assigned', ['assigned']),
      slackChannel('s-other', ['resolved']),
      teamsChannel('t-assigned', ['assigned']),   // rule says slack only
    ]
    await new NotificationDispatcher().process(event('incident.created', incidentPayload))

    const channelQuery = runQueries.find(q => q.cypher.includes('NotificationChannel'))!
    expect(channelQuery.params).toEqual({ tenantId: 't1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://hooks.slack.example/s-assigned')
    const text = init.body
    expect(text).toContain('DB down')
    expect(text).toContain('*Affected CI:* db-01')
    expect(text).toContain('*Assigned to:* Mario')
    expect(sendToTenant).not.toHaveBeenCalled()
  })

  it('rule with slack AND teams → both platforms of the tenant, each with its own format', async () => {
    ruleRows = [rule(['slack', 'teams'])]
    channelRows = [slackChannel('s', ['escalation']), teamsChannel('t', ['escalation'])]
    await new NotificationDispatcher().process(event('incident.escalated', incidentPayload))
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://hooks.slack.example/s', 'https://teams.example/t'])
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toHaveProperty('blocks')
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toHaveProperty('attachments')
  })

  it('incident.resolved → "resolved", incident.assigned → "assigned" subscriptions', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s-res', ['resolved']), slackChannel('s-asg', ['assigned'])]
    const d = new NotificationDispatcher()
    await d.process(event('incident.resolved', incidentPayload))
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://hooks.slack.example/s-res'])
    fetchMock.mockClear()
    await d.process(event('incident.assigned', incidentPayload))
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://hooks.slack.example/s-asg'])
  })

  it('incident event without id/title → explicit error (no half-formatted message)', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s', ['assigned'])]
    await expect(new NotificationDispatcher().process(event('incident.created', { id: 'inc-1' })))
      .rejects.toThrow('incident notification event missing id/title: incident.created')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * CONTRATTO RINEGOZIATO (revisione totale · E-3). Prima il canale non
   * instradabile veniva rifiutato DOPO aver consegnato in-app ed e-mail: il
   * job fallliva, BullMQ lo ritentava quattro volte e ogni tentativo rifaceva
   * quelle consegne — quattro notifiche identiche per ogni evento, per
   * sempre, finché la regola restava scritta così. Ora il rifiuto viene
   * PRIMA: nessuna consegna, un solo errore, la regola si corregge.
   */
  it('event type with no Slack/Teams formatter (e.g. problem.created) with a slack rule → rifiuto PRIMA di consegnare, niente in_app (E-3)', async () => {
    ruleRows = [rule(['slack', 'in_app'])]
    channelRows = [slackChannel('s', ['assigned'])]
    await expect(new NotificationDispatcher().process(event('problem.created', { id: 'prb-1', title: 'x' })))
      .rejects.toThrow('problem.created notification rule requests channels [slack] that the dispatcher cannot route for this event type — routable: [in_app, email]')
    expect(sendToTenant).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(runQueries.some(q => q.cypher.includes('NotificationChannel'))).toBe(false)
  })

  it('change.approved con slack E teams → entrambi i canali ricevono (E-18)', async () => {
    ruleRows = [rule(['slack', 'teams'])]
    channelRows = [slackChannel('s-chg', ['change_approved']), teamsChannel('t-chg', ['change_approved'])]
    await new NotificationDispatcher().process(event('change.approved', { id: 'chg-1', title: 'Upgrade', type: 'normal', status: 'approved' }))
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['https://hooks.slack.example/s-chg', 'https://teams.example/t-chg'])
  })

  it('change.approved → slack channels subscribed to change_approved (Change enrichment query on the tenant)', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s-chg', ['change_approved']), slackChannel('s-inc', ['assigned'])]
    await new NotificationDispatcher().process(event('change.approved', { id: 'chg-1', title: 'Upgrade', type: 'normal', status: 'approved' }))
    expect(runQueries.find(q => q.cypher.includes('MATCH (c:Change'))!.params).toEqual({ id: 'chg-1', tenantId: 't1' })
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://hooks.slack.example/s-chg'])
  })

  /**
   * CONTRATTO RINEGOZIATO (revisione totale · E-17): un `change.approved`
   * senza id o titolo uscriva in silenzio, quindi un produttore che pubblica
   * `entity_id` invece di `id` lasciava la regola attiva e muta per sempre —
   * mentre lo stesso caso su un incident lancia. Ora lancia anche qui.
   */
  it('change.approved senza id/title → errore che nomina il campo (E-17)', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s-chg', ['change_approved'])]
    await expect(new NotificationDispatcher().process(event('change.approved', { id: 'chg-1' })))
      .rejects.toThrow('change.approved payload has no "title"')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('change.task_assigned → canali Slack E Teams abbonati (E-18)', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s-task', ['change_task_assigned']), teamsChannel('t-task', ['change_task_assigned'])]
    await new NotificationDispatcher().process(event('change.task_assigned', {
      changeId: 'chg-1', changeTitle: 'Upgrade', taskId: 'task-1', ciName: 'db-01', teamName: 'DBA', assignedTo: 'Mario',
    }))
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://hooks.slack.example/s-task', 'https://teams.example/t-task'])
  })

  it('sla.breached on an incident → slack channels subscribed to sla_breach with a synthetic title', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s-sla', ['sla_breach']), slackChannel('s-asg', ['assigned'])]
    await new NotificationDispatcher().process(event('sla.breached', { entity_type: 'incident', entity_id: 'inc-9', breached_at: 'x', number: 'INC00000009', title: 'Rete giù' }))
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://hooks.slack.example/s-sla'])
    expect(fetchMock.mock.calls[0]![1].body).toContain('SLA breached on INC00000009: Rete giù')
  })

  it('sla.breached on a problem with a teams channel lacking webhook_url → explicit error', async () => {
    ruleRows = [rule(['teams'])]
    channelRows = [teamsChannel('t-broken', ['sla_breach'], null)]
    await expect(new NotificationDispatcher().process(event('sla.breached', { entity_type: 'problem', entity_id: 'prb-1', number: 'PRB00000001', title: 'Rete giù' })))
      .rejects.toThrow('Teams NotificationChannel t-broken has no webhook_url')
  })

  /**
   * Revisione totale · E-4: per un'entità che non è un incident esisteva SOLO
   * il ramo Teams. Una regola «SLA violato → Slack» su un problem o su una
   * richiesta non mandava niente, senza errore e senza log: la pagina mostrava
   * la regola attiva e instradabile.
   */
  it('sla.breached su un problem con una regola Slack → il messaggio parte (E-4)', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s-sla', ['sla_breach'])]
    await new NotificationDispatcher().process(event('sla.breached', {
      entity_type: 'problem', entity_id: 'prb-1', number: 'PRB00000001', title: 'Rete giù',
      breached_at: '2026-09-16T08:00:00.000Z', severity: 'low', status: 'change_requested',
    }))
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://hooks.slack.example/s-sla'])
    const body = fetchMock.mock.calls[0]![1].body as string
    expect(body).toContain('PRB00000001')
    // E-8: la gravità e lo stato sono quelli VERI del ticket, non «HIGH/open».
    expect(body).toContain('LOW')
    expect(body).toContain('change_requested')
    expect(body).not.toContain('HIGH')
  })

  /**
   * Revisione totale · E-8: la card della violazione su un incident scriveva
   * «Severity: HIGH · Status: open» CABLATI, per qualunque incident — anche un
   * critical in escalation.
   */
  it('sla.breached su un incident: gravità e stato sono quelli dell\'evento, non cablati (E-8)', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s-sla', ['sla_breach'])]
    await new NotificationDispatcher().process(event('sla.breached', {
      entity_type: 'incident', entity_id: 'inc-9', breached_at: 'x', number: 'INC00000009', title: 'Rete giù',
      severity: 'critical', status: 'escalated',
    }))
    const body = fetchMock.mock.calls[0]![1].body as string
    expect(body).toContain('CRITICAL')
    expect(body).toContain('escalated')
    expect(body).not.toContain('HIGH')
  })

  it('evento vecchio senza gravità e stato: si vede che è un ripiego, non «high/open»', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s-sla', ['sla_breach'])]
    await new NotificationDispatcher().process(event('sla.breached', { entity_type: 'incident', entity_id: 'inc-9', breached_at: 'x', number: 'INC00000009', title: 'Rete giù' }))
    const body = fetchMock.mock.calls[0]![1].body as string
    expect(body).toContain('UNKNOWN')
  })
})

// ── Email ────────────────────────────────────────────────────────────────────

describe('NotificationDispatcher — email channel', () => {
  it('no eligible recipient → sendEmail not called', async () => {
    ruleRows = [rule(['email'])]
    userRows = []
    await new NotificationDispatcher().process(event('incident.created', incidentPayload))
    expect(runQueries.some(q => q.cypher.includes('MATCH (u:User'))).toBe(true)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  // NT-2: oggetto e titolo sono la FRASE della chiave nella lingua del cliente
  // (prima: «[t1] notification.incident.created.title: …»).
  it('subject = translated title: message(≤80 chars); html carries the entity link; recipients batched by 50', async () => {
    ruleRows = [rule(['email'])]
    userRows = Array.from({ length: 120 }, (_, i) => ({ email: `u${i}@x.example` }))
    const longTitle = 'x'.repeat(200)
    await new NotificationDispatcher().process(event('incident.created', { ...incidentPayload, title: longTitle }))

    expect(sendEmail).toHaveBeenCalledTimes(3)
    const sizes = sendEmail.mock.calls.map(c => c[0].to.length)
    expect(sizes).toEqual([50, 50, 20])
    const first = sendEmail.mock.calls[0]![0]
    expect(first.subject.startsWith('New incident: ')).toBe(true)
    expect(first.subject.length).toBe('New incident: '.length + 80)
    expect(first.subject).not.toContain('notification.')
    expect(first.html).toContain('>New incident</h2>')
    expect(first.html).toContain('View details')
    expect(first.html).toContain('/incidents/inc-1')
    expect(first.to[0]).toBe('u0@x.example')
  })

  it('a failing sendEmail propagates (job fails → retry), after the in_app broadcast already went out', async () => {
    ruleRows = [rule(['in_app', 'email'])]
    userRows = [{ email: 'ops@x.example' }]
    sendEmail.mockRejectedValueOnce(new Error('resend down'))
    await expect(new NotificationDispatcher().process(event('incident.created', incidentPayload))).rejects.toThrow('resend down')
    expect(sendToTenant).toHaveBeenCalledTimes(1)
  })

  it('pinned order + contract: slack fails → error propagates and the email channel is NOT attempted', async () => {
    ruleRows = [rule(['slack', 'email'])]
    channelRows = [slackChannel('s', ['assigned'])]
    userRows = [{ email: 'ops@x.example' }]
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    await expect(new NotificationDispatcher().process(event('incident.created', incidentPayload)))
      .rejects.toThrow('Slack webhook rejected the message: HTTP 503')
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

// ── workflow.step.entered ────────────────────────────────────────────────────

describe('NotificationDispatcher — workflow.step.entered (rule embedded in the payload)', () => {
  const step = (channels: string[]) => event('workflow.step.entered', {
    stepName: 'Assessment', entityType: 'change', entityId: 'chg-1',
    notifyRule: { title_key: 'wf.step', severity: 'info', channels, target: 'all' },
  })

  it('does not look up NotificationRule; in_app → SSE with the step name as message', async () => {
    await new NotificationDispatcher().process(step(['in_app']))
    expect(runQueries.some(q => q.cypher.includes('NotificationRule'))).toBe(false)
    expect(sendToTenant).toHaveBeenCalledTimes(1)
    expect(sendToTenant.mock.calls[0]![1]).toMatchObject({ title: 'wf.step', message: 'Assessment', entity_id: 'chg-1', entity_type: 'change' })
  })

  it('missing notifyRule → explicit error', async () => {
    await expect(new NotificationDispatcher().process(event('workflow.step.entered', { stepName: 's' })))
      .rejects.toThrow('workflow.step.entered event without notifyRule payload')
  })

  it('unsupported channel (slack/teams) → rifiuto PRIMA di consegnare in_app/email (E-3)', async () => {
    userRows = [{ email: 'ops@x.example' }]
    await expect(new NotificationDispatcher().process(step(['in_app', 'email', 'slack', 'teams'])))
      .rejects.toThrow('unsupported channels [slack, teams]')
    expect(sendToTenant).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
