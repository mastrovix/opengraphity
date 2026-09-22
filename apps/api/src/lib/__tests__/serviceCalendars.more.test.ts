/**
 * Named service calendars: the rest of the contract beyond create/delete-in-use.
 *
 * Why these behaviours matter:
 *  - every read and write is scoped to the caller's tenant: a calendar of one
 *    customer must never be listed, renamed or deleted from another;
 *  - the "used by" lists are what stops an administrator from deleting a
 *    calendar that SLA policies, OLA contracts or workflow deadlines still
 *    count with — if they came back unsorted or with null names the refusal
 *    message would be noisy, and if they came back empty the deadlines would
 *    silently lose their calendar;
 *  - an update that finds nothing must say "not found" rather than pretend it
 *    saved, and a rename must not collide with the calendar itself;
 *  - the diagnostics list (business hours without a calendar) is how an admin
 *    finds deadlines the engine cannot compute.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQuery = vi.fn()
const runQueryOne = vi.fn()
const close = vi.fn(async () => {})
const getSession = vi.fn((..._a: unknown[]) => ({ close }))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: (...a: unknown[]) => getSession(...a),
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
const parseSpy = vi.fn()
vi.mock('@opengraphity/sla', async () => {
  const cal = await import('../../../../../packages/sla/src/calendar.js')
  parseSpy.mockImplementation(cal.parseServiceCalendar)
  return { parseServiceCalendar: (raw: unknown) => parseSpy(raw), ServiceCalendarError: cal.ServiceCalendarError }
})
const cal = await import('../../../../../packages/sla/src/calendar.js')

const {
  serviceCalendars, createServiceCalendar, updateServiceCalendar, deleteServiceCalendar,
  assertServiceCalendarExists, businessHoursWithoutCalendar, SERVICE_CALENDAR_NAME_MAX,
} = await import('../serviceCalendars.js')

const WEEK = { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', holidays: [] as string[] }
const row = (over: Record<string, unknown> = {}) => ({ id: 'cal-1', name: 'NOC shift', ...WEEK, policies: [], contracts: [], steps: [], ...over })

beforeEach(() => {
  runQuery.mockReset(); runQueryOne.mockReset(); close.mockClear(); getSession.mockClear()
  parseSpy.mockReset(); parseSpy.mockImplementation(cal.parseServiceCalendar)
})

describe('serviceCalendars (list)', () => {
  it('reads only the tenant calendars and normalises the stored values', async () => {
    runQuery.mockResolvedValueOnce([
      // Neo4j integers can arrive as strings/objects: days are coerced to numbers.
      row({ days: ['5', '1'], policies: ['Z policy', null, 'A policy'], contracts: ['OLA net'], steps: ['WF · Step 2', 'WF · Step 1'] }),
      row({ id: 'cal-2', name: 'Bare', days: [2], holidays: null, policies: null, contracts: null, steps: null }),
    ])
    const out = await serviceCalendars('t1')
    expect(runQuery.mock.calls[0]![2]).toEqual({ tenantId: 't1' })
    expect(out[0]).toMatchObject({
      id: 'cal-1', days: [1, 5],
      // Sorted and without nulls: this is the list the delete refusal names.
      usedBySlaPolicies: ['A policy', 'Z policy'], usedByOlaContracts: ['OLA net'], usedByWorkflowSteps: ['WF · Step 1', 'WF · Step 2'],
    })
    expect(out[1]).toMatchObject({ id: 'cal-2', holidays: [], usedBySlaPolicies: [], usedByOlaContracts: [], usedByWorkflowSteps: [] })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a stored calendar with no days is reported as corrupt, not shown as empty', async () => {
    runQuery.mockResolvedValueOnce([row({ days: null })])
    await expect(serviceCalendars('t1')).rejects.toThrow(/days must be a non-empty list/)
    // The session is released even when mapping fails.
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('createServiceCalendar', () => {
  it('rejects a name longer than the maximum', async () => {
    await expect(createServiceCalendar('t1', { name: 'x'.repeat(SERVICE_CALENDAR_NAME_MAX + 1), calendar: WEEK }))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.serviceCalendar.name' } } })
    await expect(createServiceCalendar('t1', { name: 42, calendar: WEEK }))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.serviceCalendar.name' } } })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('an unexpected parser failure is not disguised as a validation error', async () => {
    parseSpy.mockImplementationOnce(() => { throw new TypeError('boom') })
    await expect(createServiceCalendar('t1', { name: 'Ok', calendar: WEEK })).rejects.toBeInstanceOf(TypeError)
  })

  it('the duplicate check is case-insensitive, tenant-scoped and excludes nothing on create', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    runQuery.mockResolvedValueOnce([])
    await createServiceCalendar('t1', { name: 'Ok', calendar: WEEK })
    expect(runQueryOne.mock.calls[0]![2]).toEqual({ tenantId: 't1', name: 'Ok', exceptId: null })
    expect(runQueryOne.mock.calls[0]![1]).toContain('toLower(c.name) = toLower($name)')
  })
})

describe('updateServiceCalendar', () => {
  it('with nothing to change it refuses without touching the database', async () => {
    await expect(updateServiceCalendar('t1', 'cal-1', {})).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.nothingToUpdate' } } })
    expect(getSession).not.toHaveBeenCalled()
  })

  it('a rename keeps the unique key in step and does not collide with itself', async () => {
    runQueryOne
      .mockResolvedValueOnce(null)              // no other calendar with this name
      .mockResolvedValueOnce({ id: 'cal-1' })   // SET matched
    runQuery.mockResolvedValueOnce([row({ name: 'Night' })])
    const out = await updateServiceCalendar('t1', 'cal-1', { name: ' Night ' })
    // The calendar being renamed is excluded from the duplicate check.
    expect(runQueryOne.mock.calls[0]![2]).toMatchObject({ exceptId: 'cal-1', name: 'Night' })
    const params = runQueryOne.mock.calls[1]![2] as Record<string, unknown>
    expect(params).toMatchObject({ id: 'cal-1', tenantId: 't1', sets: { name: 'Night', name_key: 'night' } })
    expect(out.name).toBe('Night')
  })

  it('a rename onto another calendar name is refused before writing', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 'cal-2' })
    await expect(updateServiceCalendar('t1', 'cal-1', { name: 'Taken' })).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.serviceCalendar.duplicateName' } } })
    expect(runQueryOne).toHaveBeenCalledTimes(1)
  })

  it('changing the hours writes the normalised calendar', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 'cal-1' })
    runQuery.mockResolvedValueOnce([row({ start: '09:00' })])
    await updateServiceCalendar('t1', 'cal-1', { calendar: { ...WEEK, days: [3, 1, 1], start: '09:00' } })
    expect((runQueryOne.mock.calls[0]![2] as { sets: unknown }).sets).toEqual({ days: [1, 3], start: '09:00', end: '18:00', holidays: [] })
  })

  it('an invalid calendar is refused with the problem key', async () => {
    await expect(updateServiceCalendar('t1', 'cal-1', { calendar: { ...WEEK, holidays: ['25/12'] } }))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.tenant.serviceCalendar.holidays' } } })
  })

  it('a calendar of another tenant (or missing) is not found, not silently "updated"', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await expect(updateServiceCalendar('t1', 'cal-x', { calendar: WEEK })).rejects.toThrow(/ServiceCalendar/)
    expect(close).toHaveBeenCalled()
  })

  it('if the calendar vanishes between the write and the read-back it is reported as not found', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 'cal-1' })
    runQuery.mockResolvedValueOnce([row({ id: 'other' })])
    await expect(updateServiceCalendar('t1', 'cal-1', { calendar: WEEK })).rejects.toThrow(/ServiceCalendar/)
  })
})

describe('deleteServiceCalendar', () => {
  it('an unknown id is not found and nothing is deleted', async () => {
    runQuery.mockResolvedValueOnce([])
    await expect(deleteServiceCalendar('t1', 'cal-1')).rejects.toThrow(/ServiceCalendar/)
    expect(runQuery).toHaveBeenCalledTimes(1)
  })

  it('a calendar used only by workflow deadlines is still protected', async () => {
    runQuery.mockResolvedValueOnce([row({ steps: ['Change WF · Approval'] })])
    await expect(deleteServiceCalendar('t1', 'cal-1')).rejects.toMatchObject({
      extensions: { i18n: { key: 'errors.serviceCalendar.inUse', params: { users: 'Change WF · Approval' } } },
    })
  })

  it('an unused calendar is deleted within the tenant', async () => {
    runQuery.mockResolvedValueOnce([row()]).mockResolvedValueOnce([])
    await deleteServiceCalendar('t1', 'cal-1')
    expect(runQuery.mock.calls[1]![1]).toContain('DELETE c')
    expect(runQuery.mock.calls[1]![2]).toEqual({ id: 'cal-1', tenantId: 't1' })
  })
})

describe('assertServiceCalendarExists', () => {
  it('passes for an existing calendar of the tenant', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 'cal-1' })
    await expect(assertServiceCalendarExists('t1', 'cal-1')).resolves.toBeUndefined()
    expect(runQueryOne.mock.calls[0]![2]).toEqual({ id: 'cal-1', tenantId: 't1' })
  })

  it('refuses an id the engine would not find, so a policy never stores it', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await expect(assertServiceCalendarExists('t1', 'ghost')).rejects.toMatchObject({
      extensions: { i18n: { key: 'errors.serviceCalendar.unknown', params: { id: 'ghost' } } },
    })
    expect(close).toHaveBeenCalled()
  })
})

describe('businessHoursWithoutCalendar', () => {
  it('returns the names of the owners the engine cannot compute', async () => {
    runQuery.mockResolvedValueOnce([{ name: 'OLA net' }, { name: 'P1 policy' }])
    await expect(businessHoursWithoutCalendar('t1')).resolves.toEqual(['OLA net', 'P1 policy'])
    expect(runQuery.mock.calls[0]![2]).toEqual({ tenantId: 't1' })
  })
})
