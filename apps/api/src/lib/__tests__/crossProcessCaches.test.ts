/**
 * Revisione totale · C-23, A-15, E-20: tre cache si svuotavano solo nel
 * processo che aveva servito la mutation.
 *
 *  - C-23 trigger e business rule: il worker che ESEGUE le automazioni teneva
 *    la regola vecchia fino a 60 s, compreso il caso in cui l'admin la spegne
 *    perché sta facendo danni;
 *  - A-15 la lingua predefinita del cliente: un allarme arrivato subito dopo
 *    il cambio generava incident e notifiche nella lingua vecchia;
 *  - E-20 le regole di notifica del dispatcher: vive in `events-worker`, e
 *    l'API «invalidava» la propria copia, che non consegna niente.
 *
 * Il canale del metamodello (`lib/metamodelBus.ts`) esisteva già: qui si pinna
 * che queste cache siano registrate su di esso e che le funzioni pubbliche di
 * invalidazione lo usino.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const publisher = vi.fn()

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn(async () => {}) })),
  runQuery: vi.fn(async () => []),
  runQueryOne: vi.fn(async () => null),
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))
vi.mock('@opengraphity/notifications', () => ({
  invalidateRuleCache: vi.fn(),
  invalidateNotificationLocale: vi.fn(),
}))

const { registerMetamodelPublisher, registeredMetamodelCacheClearers, lastInvalidation } = await import('../schemaInvalidator.js')
// Import a effetto: ogni modulo registra il suo clearer al caricamento.
await import('../triggerEngine.js')
await import('../rulesEngine.js')
await import('../tenantLanguage.js')
await import('../notificationRuleCache.js')
const { invalidateTriggerCache } = await import('../triggerEngine.js')
const { invalidateRulesCache } = await import('../rulesEngine.js')
const { invalidateRuleCache, invalidateNotificationLocale } = await import('@opengraphity/notifications')

beforeEach(() => {
  vi.clearAllMocks()
  registerMetamodelPublisher(publisher)
})

describe('cache registrate sul canale fra processi', () => {
  it('trigger, business rule, lingua del cliente e regole di notifica hanno il loro clearer', () => {
    const names = registeredMetamodelCacheClearers()
    expect(names).toContain('automation:trigger')
    expect(names).toContain('automation:br')
    expect(names).toContain('tenant-language')
    expect(names).toContain('notification-rules')
  })

  it('invalidateTriggerCache pubblica sul canale (C-23)', () => {
    invalidateTriggerCache('t1')
    expect(publisher).toHaveBeenCalledTimes(1)
    expect(publisher.mock.calls[0]![0]).toBe('t1')
    expect(lastInvalidation()).toMatchObject({ tenantId: 't1', published: true })
  })

  it('invalidateRulesCache pubblica sul canale (C-23)', () => {
    invalidateRulesCache('t2')
    expect(publisher).toHaveBeenCalledTimes(1)
    expect(publisher.mock.calls[0]![0]).toBe('t2')
  })

  it('un messaggio del canale svuota le regole di notifica e la lingua di QUESTO processo (E-20, A-15)', async () => {
    const { clearLocalMetamodelCaches } = await import('../schemaInvalidator.js')
    const out = clearLocalMetamodelCaches('t3')
    expect(out.failed).toEqual([])
    expect(invalidateRuleCache).toHaveBeenCalledWith('t3')
    expect(invalidateNotificationLocale).toHaveBeenCalledWith('t3')
  })
})
