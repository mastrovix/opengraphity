/**
 * Revisione del 14 set 2026 · F7: il fuso del cliente si scriveva solo con
 * `onboard-tenant.ts`. Da quel valore dipendono scadenze SLA/OLA, orari
 * lavorativi, digest e ogni data nei testi generati, quindi è una scelta del
 * cliente e si prende dalla pagina Organizzazione.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQueryOne = vi.fn()
const close = vi.fn(async () => {})
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close })),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
const invalidateNotificationLocale = vi.fn()
vi.mock('@opengraphity/notifications', () => ({ invalidateNotificationLocale }))

const { setTenantTimezone, isTimeZone, availableTimeZones } = await import('../tenantTimezone.js')
const { ValidationError, NotFoundError } = await import('../errors.js')

describe('tenant timezone', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('riconosce solo le zone IANA', () => {
    expect(isTimeZone('America/New_York')).toBe(true)
    expect(isTimeZone('Europe/Rome')).toBe(true)
    expect(isTimeZone('Mars/Olympus')).toBe(false)
    expect(isTimeZone('')).toBe(false)
    expect(isTimeZone(42)).toBe(false)
  })

  it("l'elenco offerto è quello del runtime e contiene UTC", () => {
    const zones = availableTimeZones()
    expect(zones).toContain('UTC')
    expect(zones).toContain('Asia/Tokyo')
  })

  it('rifiuta un fuso sconosciuto con una chiave i18n, senza scrivere', async () => {
    const err = await setTenantTimezone('t1', 'Mars/Olympus').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as { extensions: { i18n?: { key: string } } }).extensions.i18n?.key).toBe('errors.tenant.unknownTimezone')
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('scrive il fuso e invalida la copia delle notifiche', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 't1' })
    await expect(setTenantTimezone('t1', 'America/New_York')).resolves.toBe('America/New_York')
    const [, cypher, params] = runQueryOne.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain('SET t.timezone = $timezone')
    expect(params).toMatchObject({ tenantId: 't1', timezone: 'America/New_York' })
    expect(invalidateNotificationLocale).toHaveBeenCalledWith('t1')
  })

  it('tenant inesistente → NotFoundError', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await expect(setTenantTimezone('nope', 'UTC')).rejects.toBeInstanceOf(NotFoundError)
  })
})
