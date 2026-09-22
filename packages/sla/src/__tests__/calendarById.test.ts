/**
 * NAMED SERVICE CALENDARS.
 *
 * There used to be one calendar per customer (`Tenant.service_calendar`);
 * now they are `ServiceCalendar` nodes and every SLA policy and OLA/UC
 * contract picks one by id — or none, and counts 24x7.
 *
 * The rule worth pinning is that a policy pointing at a calendar that is
 * gone does NOT fall back to 24x7. Falling back would quietly turn an
 * eight-business-hour target into an eight-clock-hour one: the customer is
 * told they missed deadlines they never agreed to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ cypher: string; params: Record<string, unknown> }>,
  closed: 0,
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      fn({
        run: async (cypher: string, params: Record<string, unknown>) => {
          state.queries.push({ cypher, params })
          return { records: state.rows.map((r) => ({ get: (k: string) => r[k] })) }
        },
      }),
    close: async () => { state.closed += 1 },
  }),
}))

const { getServiceCalendarById, calendarFor } = await import('../calendar.js')

const WORKDAYS = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', holidays: ['2026-12-25'] }

beforeEach(() => { state.rows = [WORKDAYS]; state.queries = []; state.closed = 0 })

describe('getServiceCalendarById', () => {
  it('reads the calendar of THIS tenant by id, and closes the session', async () => {
    expect(await getServiceCalendarById('c-one', 'cal-1')).toEqual(WORKDAYS)
    expect(state.queries[0]!.cypher).toContain('MATCH (c:ServiceCalendar {id: $calendarId, tenant_id: $tenantId})')
    expect(state.queries[0]!.params).toEqual({ tenantId: 'c-one', calendarId: 'cal-1' })
    expect(state.closed).toBe(1)
  })

  it('a calendar that does NOT exist throws — it does not fall back to 24x7', async () => {
    // Falling back would turn an eight-business-hour target into an
    // eight-clock-hour one, and the customer would be told they missed
    // deadlines they never agreed to.
    state.rows = []
    await expect(getServiceCalendarById('c-one', 'cal-gone'))
      .rejects.toThrow(/Service calendar cal-gone does not exist for tenant c-one/)
    expect(state.closed).toBe(1)
  })

  it('the days are coerced to numbers, deduplicated and sorted', async () => {
    // The session already converts Neo4j Integers, but a calendar written by
    // an import can hold strings: the parser demands integers, so a missing
    // coercion here would reject a calendar that is perfectly fine.
    state.rows = [{ ...WORKDAYS, days: ['5', 1, 1, '3'] }]
    expect((await getServiceCalendarById('c-one', 'cal-1')).days).toEqual([1, 3, 5])
  })

  it('a calendar with no days at all is refused, not read as "never"', async () => {
    state.rows = [{ ...WORKDAYS, days: null }]
    await expect(getServiceCalendarById('c-one', 'cal-1')).rejects.toThrow(/days must be a non-empty list/)
  })

  it('a calendar with no holidays stored reads as no holidays', async () => {
    state.rows = [{ ...WORKDAYS, holidays: null }]
    expect((await getServiceCalendarById('c-one', 'cal-1')).holidays).toEqual([])
  })

  it('a stored calendar that does not validate surfaces the parser\'s reason', async () => {
    state.rows = [{ ...WORKDAYS, end: '08:00' }]
    await expect(getServiceCalendarById('c-one', 'cal-1')).rejects.toThrow(/the end \(08:00\) must come after the start \(09:00\)/)
  })
})

describe('calendarFor — which calendar a target counts by', () => {
  it('a target that does not count service hours has no calendar: it counts 24x7', async () => {
    expect(await calendarFor('c-one', { name: 'SLA Standard', businessHours: false, calendarId: null })).toBeNull()
    expect(state.queries).toEqual([])
  })

  it('"service hours" with no calendar chosen is incomplete configuration, and the error NAMES who carries it', async () => {
    // The administrator has several policies and contracts; "choose a
    // calendar" without saying which one would send them hunting.
    await expect(calendarFor('c-one', { name: 'OLA Rete — 4h', businessHours: true, calendarId: null }))
      .rejects.toThrow('"OLA Rete — 4h" counts service hours but has no service calendar: choose one in its settings (tenant c-one)')
  })

  it('"service hours" with a calendar loads that calendar', async () => {
    expect(await calendarFor('c-one', { name: 'SLA Gold', businessHours: true, calendarId: 'cal-1' })).toEqual(WORKDAYS)
    expect(state.queries[0]!.params['calendarId']).toBe('cal-1')
  })

  it('a calendar id set but service hours OFF is ignored: the switch decides', async () => {
    expect(await calendarFor('c-one', { name: 'SLA 24x7', businessHours: false, calendarId: 'cal-1' })).toBeNull()
    expect(state.queries).toEqual([])
  })
})
