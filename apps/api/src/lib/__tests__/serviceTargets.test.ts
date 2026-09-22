/**
 * lib/serviceTargets.ts — compliance objective and calendar shared by SLA
 * policies and OLA/UC contracts.
 *
 * Why these behaviours matter: the report colours a contract green/amber/red
 * from these two thresholds; an inverted pair (warning >= target) or a
 * percentage above 100 would make a breached contract look healthy. The
 * calendar decides business-hours counting: an unknown id must be refused
 * (not silently become 24×7), and it must be looked up in the caller's tenant
 * only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../serviceCalendars.js', () => ({ assertServiceCalendarExists: vi.fn() }))

const { assertComplianceObjective, calendarChoice, calendarNameOf } = await import('../serviceTargets.js')
const { getSession, runQueryOne } = await import('@opengraphity/neo4j')
const { assertServiceCalendarExists } = await import('../serviceCalendars.js')

const session = { close: vi.fn(async () => undefined) }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
})

/** The extensions of the error thrown by `fn` (the UI translates from `i18n.key`). */
const extensionsOf = (fn: () => unknown): Record<string, unknown> => {
  try { fn() } catch (e) { return (e as { extensions: Record<string, unknown> }).extensions }
  throw new Error('expected an error')
}

describe('assertComplianceObjective', () => {
  it('accepts numeric strings and numbers, returning numbers', () => {
    expect(assertComplianceObjective('99.5', 97)).toEqual({ target: 99.5, warning: 97 })
    expect(assertComplianceObjective(100, '0.5')).toEqual({ target: 100, warning: 0.5 })
  })

  it.each([[null], [undefined], [0], [-1], [100.01], ['abc'], [Infinity]])('rejects target %s', (target) => {
    expect(() => assertComplianceObjective(target, 50)).toThrow(/compliance target/)
  })

  it.each([[null], [0], [99.5], [120], ['x']])('rejects warning %s with target 99.5 (must stay strictly below it)', (warning) => {
    expect(() => assertComplianceObjective(99.5, warning)).toThrow(/attention threshold/)
  })

  it('errors are BAD_USER_INPUT with an i18n key, so the UI can translate them', () => {
    expect(extensionsOf(() => assertComplianceObjective(0, 1))).toMatchObject({ code: 'BAD_USER_INPUT', i18n: { key: 'errors.compliance.target' } })
    expect(extensionsOf(() => assertComplianceObjective(90, 95))).toMatchObject({ code: 'BAD_USER_INPUT', i18n: { key: 'errors.compliance.warning', params: { target: 90 } } })
  })
})

describe('calendarChoice', () => {
  it('null or empty → 24×7 (no calendar, no business hours), without touching the graph', async () => {
    expect(await calendarChoice('t1', null)).toEqual({ calendar_id: null, business_hours: false })
    expect(await calendarChoice('t1', undefined)).toEqual({ calendar_id: null, business_hours: false })
    expect(await calendarChoice('t1', '')).toEqual({ calendar_id: null, business_hours: false })
    expect(assertServiceCalendarExists).not.toHaveBeenCalled()
  })

  it('a non-string id is refused', async () => {
    await expect(calendarChoice('t1', 42)).rejects.toThrow(/calendarId must be a calendar id/)
  })

  it('an existing calendar of THIS tenant → business hours on', async () => {
    vi.mocked(assertServiceCalendarExists).mockResolvedValue(undefined)
    expect(await calendarChoice('t1', 'cal-1')).toEqual({ calendar_id: 'cal-1', business_hours: true })
    expect(assertServiceCalendarExists).toHaveBeenCalledWith('t1', 'cal-1')
  })

  it('an unknown calendar propagates the refusal instead of falling back to 24×7', async () => {
    vi.mocked(assertServiceCalendarExists).mockRejectedValue(new Error('Service calendar cal-x does not exist.'))
    await expect(calendarChoice('t1', 'cal-x')).rejects.toThrow(/does not exist/)
  })
})

describe('calendarNameOf', () => {
  it('no calendar → null without opening a session', async () => {
    expect(await calendarNameOf('t1', null)).toBeNull()
    expect(getSession).not.toHaveBeenCalled()
  })

  it('reads the name scoped to the tenant and closes the session', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ name: 'Office hours' } as never)
    expect(await calendarNameOf('t1', 'cal-1')).toBe('Office hours')
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('tenant_id: $tenantId')
    expect(params).toEqual({ id: 'cal-1', tenantId: 't1' })
    expect(session.close).toHaveBeenCalled()
  })

  it('a calendar that disappeared → null; a failing query still closes the session', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null as never)
    expect(await calendarNameOf('t1', 'gone')).toBeNull()
    vi.mocked(runQueryOne).mockRejectedValue(new Error('db'))
    await expect(calendarNameOf('t1', 'cal-1')).rejects.toThrow('db')
    expect(session.close).toHaveBeenCalledTimes(2)
  })
})
