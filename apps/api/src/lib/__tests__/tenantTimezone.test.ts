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

const { setTenantTimezone, isTimeZone, availableTimeZones, localDateTimeIn } = await import('../tenantTimezone.js')
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

/**
 * D14 (tour of 23 Sep 2026): the AI drafts receive wall-clock times in the
 * organization's zone, never raw UTC next to a description in local time.
 */
describe('localDateTimeIn', () => {
  it('writes the instant as wall-clock time in the zone, across daylight saving', () => {
    expect(localDateTimeIn('2026-09-23T04:20:00.000Z', 'Europe/Rome')).toBe('2026-09-23 06:20')
    expect(localDateTimeIn('2026-01-15T23:30:00Z', 'Europe/Rome')).toBe('2026-01-16 00:30')
    expect(localDateTimeIn('2026-09-23T04:20:00Z', 'America/New_York')).toBe('2026-09-23 00:20')
    expect(localDateTimeIn('2026-09-23T04:20:00Z', 'UTC')).toBe('2026-09-23 04:20')
  })

  it('a missing instant stays missing, one that is not a date is an error', () => {
    expect(localDateTimeIn(null, 'Europe/Rome')).toBeNull()
    expect(localDateTimeIn(undefined, 'Europe/Rome')).toBeNull()
    expect(localDateTimeIn('', 'Europe/Rome')).toBeNull()
    expect(() => localDateTimeIn('yesterday', 'Europe/Rome')).toThrow(/"yesterday" is not an instant/)
  })
})
