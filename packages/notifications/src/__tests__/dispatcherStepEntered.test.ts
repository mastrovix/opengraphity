import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

/**
 * D-22 / B-16 — l'ingresso in un passo notifica anche quando il cliente ha
 * rinominato o aggiunto il passo.
 *
 * Prima: il tipo dell'evento era composto col NOME del passo
 * (`incident.lavorazione`), nessuna regola corrispondeva e il dispatcher
 * usciva su `if (!rule) return` — nessuna notifica **e nessun log**. Ora
 * l'evento stabile `incident.step_entered` porta nome, etichetta, scopo e
 * categoria del passo nel payload, e la regola si scegli per scopo o per
 * categoria. L'alias col nome del passo resta pubblicato perché le regole già
 * agganciate (35 di fabbrica più quelle dei tenant) continuino a funzionare, e
 * il dispatcher non consegna due volte.
 */

const runQueries: Array<{ cypher: string; params: Record<string, unknown> }> = []
/** Regole per (tenant, event_type), come le trova la query del dispatcher. */
let rulesByType: Record<string, Array<Record<string, unknown>>> = {}

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      fn({
        run: async (cypher: string, params: Record<string, unknown>) => {
          runQueries.push({ cypher, params })
          if (cypher.includes('NotificationRule')) {
            const rows = rulesByType[String(params['eventType'])] ?? []
            return { records: rows.map((r) => ({ get: () => ({ properties: r }) })) }
          }
          return { records: [] }
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
vi.mock('../email.js', () => ({ sendEmail: vi.fn(async () => {}) }))

const { NotificationDispatcher, invalidateRuleCache, pickStepRule } = await import('../dispatcher.js')
const { sseManager } = await import('../sse.js')

function rule(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rule-1', enabled: true, severity_override: 'warning',
    title_key: 'notification.incident.on_hold.title', channels: ['in_app'], target: 'all',
    step_purpose: null, step_category: null, ...over,
  }
}

/** Il passo che il cliente ha rinominato: il nome non dice niente, lo scopo sì. */
const RENAMED_STEP = {
  step_id: 'st-1', step_name: 'in_attesa_fornitore', step_label: 'In attesa del fornitore',
  step_purpose: null, step_category: 'waiting',
}

function stepEvent(over: Record<string, unknown> = {}, type = 'incident.step_entered'): DomainEvent<unknown> {
  return {
    id: 'evt-1', type, tenant_id: 't1', timestamp: '2026-09-14T10:00:00.000Z',
    correlation_id: 'c', actor_id: 'u',
    payload: { id: 'inc-1', title: 'DB down', severity: 'critical', status: 'in_attesa_fornitore', ...RENAMED_STEP, ...over },
  }
}

const openClients: string[] = []
function connect(userId: string): { writes: string[] } {
  const writes: string[] = []
  openClients.push(sseManager.connect('t1', userId, { write: (d: string) => writes.push(d) }))
  return { writes }
}

beforeEach(() => {
  runQueries.length = 0
  rulesByType = {}
  invalidateRuleCache('t1')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  while (openClients.length) sseManager.disconnect(openClients.pop()!)
  vi.restoreAllMocks()
})

describe('pickStepRule — dalla più specifica alla più generica', () => {
  const byPurpose  = { ...rule({ id: 'p' }), stepPurpose: 'approval',  stepCategory: null,      enabled: true } as never
  const byCategory = { ...rule({ id: 'c' }), stepPurpose: null,        stepCategory: 'waiting', enabled: true } as never
  const generic    = { ...rule({ id: 'g' }), stepPurpose: null,        stepCategory: null,      enabled: true } as never
  const facts = (over: Record<string, unknown> = {}) => ({ ...RENAMED_STEP, ...over } as never)

  it('lo scopo batte la categoria, la categoria batte la regola senza restringimento', () => {
    const all = [generic, byCategory, byPurpose]
    expect(pickStepRule(all, facts({ step_purpose: 'approval' }))?.id).toBe('p')
    expect(pickStepRule(all, facts({ step_purpose: null }))?.id).toBe('c')
    expect(pickStepRule(all, facts({ step_purpose: null, step_category: 'active' }))?.id).toBe('g')
  })

  it('una regola ristretta a un altro scopo non c\'entra: non viene scelta', () => {
    expect(pickStepRule([byPurpose], facts({ step_purpose: 'implementation' }))).toBeNull()
    expect(pickStepRule([byCategory], facts({ step_category: 'active' }))).toBeNull()
  })

  it('le regole spente non vengono scelte', () => {
    const off = { ...(byCategory as never as Record<string, unknown>), enabled: false } as never
    expect(pickStepRule([off], facts())).toBeNull()
  })
})

describe('ingresso in un passo rinominato', () => {
  it('la regola ristretta alla CATEGORIA del passo scatta anche se il passo ha un nome nuovo', async () => {
    const client = connect('u-1')
    rulesByType['incident.step_entered'] = [rule({ step_category: 'waiting' })]

    await new NotificationDispatcher().process(stepEvent())

    expect(client.writes).toHaveLength(1)
    const sent = JSON.parse(client.writes[0]!.replace(/^data: /, '')) as Record<string, unknown>
    expect(sent['title']).toBe('notification.incident.on_hold.title')
    // B-16: il titolo di ripiego è l'ETICHETTA del passo, non la chiave grezza
    expect(sent['title_fallback']).toBe('In attesa del fornitore')
    // il corpo nomina il passo con la sua etichetta, non con il nome tecnico
    expect(sent['message']).toBe('DB down — In attesa del fornitore')
  })

  it('la regola ristretta allo SCOPO scatta su un passo con quello scopo, con qualunque nome', async () => {
    const client = connect('u-1')
    rulesByType['incident.step_entered'] = [rule({ step_purpose: 'approval' })]

    await new NotificationDispatcher().process(stepEvent({ step_purpose: 'approval', step_name: 'cab_settimanale', step_label: 'CAB settimanale' }))

    expect(client.writes).toHaveLength(1)
  })

  it('nessuna regola per quel passo → NESSUNA notifica, ma un avviso che nomina passo, scopo e tipo', async () => {
    const client = connect('u-1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    rulesByType['incident.step_entered'] = [rule({ step_purpose: 'approval' })]

    await new NotificationDispatcher().process(stepEvent())

    expect(client.writes).toHaveLength(0)
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(msg).toContain('in_attesa_fornitore')
    expect(msg).toContain('waiting')
    expect(msg).toContain('incident.step_entered')
    expect(msg).toContain('incident.in_attesa_fornitore')
  })

  it('un payload senza step_name ferma il job invece di notificare a caso', async () => {
    rulesByType['incident.step_entered'] = [rule()]
    await expect(new NotificationDispatcher().process(stepEvent({ step_name: undefined })))
      .rejects.toThrow(/step_name/)
  })
})

describe('nessuna doppia notifica: alias e tipo stabile sono la stessa transizione', () => {
  it('se esiste una regola per l\'alias del passo, l\'evento stabile non consegna niente', async () => {
    const client = connect('u-1')
    rulesByType['incident.step_entered']       = [rule({ step_category: 'waiting' })]
    rulesByType['incident.in_attesa_fornitore'] = [rule({ id: 'alias' })]

    await new NotificationDispatcher().process(stepEvent())

    expect(client.writes).toHaveLength(0)
  })

  it('una regola dell\'alias SPENTA non fa scattare quella stabile al suo posto', async () => {
    const client = connect('u-1')
    rulesByType['incident.step_entered']       = [rule({ step_category: 'waiting' })]
    rulesByType['incident.in_attesa_fornitore'] = [rule({ id: 'alias', enabled: false })]

    await new NotificationDispatcher().process(stepEvent())

    expect(client.writes).toHaveLength(0)
  })

  it('l\'evento alias consegna come sempre (le 35 regole di fabbrica non cambiano comportamento)', async () => {
    const client = connect('u-1')
    rulesByType['incident.in_progress'] = [rule({ id: 'seed', title_key: 'notification.incident.in_progress.title' })]

    await new NotificationDispatcher().process(stepEvent(
      { step_name: 'in_progress', step_label: 'In lavorazione', step_category: 'active' },
      'incident.in_progress',
    ))

    expect(client.writes).toHaveLength(1)
    const sent = JSON.parse(client.writes[0]!.replace(/^data: /, '')) as Record<string, unknown>
    expect(sent['type']).toBe('incident.in_progress')
    expect(sent['title']).toBe('notification.incident.in_progress.title')
  })
})

describe('workflow.step.entered (azione notify_rule del passo) — titolo di ripiego', () => {
  it('il titolo di ripiego è l\'etichetta del passo, mai la chiave i18n grezza (B-16)', async () => {
    const client = connect('u-1')
    const event: DomainEvent<unknown> = {
      id: 'e', type: 'workflow.step.entered', tenant_id: 't1',
      timestamp: '2026-09-14T10:00:00.000Z', correlation_id: 'c', actor_id: 'u',
      payload: {
        stepName: 'standard_x_1757', stepLabel: 'Verifica del fornitore',
        entityType: 'incident', entityId: 'inc-1',
        notifyRule: { title_key: 'notification.custom.step.title', severity: 'info', channels: ['in_app'], target: 'all' },
      },
    }
    await new NotificationDispatcher().process(event)

    const sent = JSON.parse(client.writes[0]!.replace(/^data: /, '')) as Record<string, unknown>
    expect(sent['title']).toBe('notification.custom.step.title')
    expect(sent['title_fallback']).toBe('Verifica del fornitore')
    expect(sent['message']).toBe('Verifica del fornitore')
  })
})
