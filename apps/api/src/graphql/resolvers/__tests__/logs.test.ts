/**
 * The Logs page resolver (resolvers/logs.ts).
 *
 * Why these behaviours matter: this page is where an admin goes AFTER
 * something went wrong. It must
 *  - refuse anyone without `admin.audit` before reading a single line;
 *  - read only the caller's tenant, from both halves (server ring buffer and
 *    persisted browser errors), merged newest-first;
 *  - fail loudly on malformed filters: silently ignoring them would show ALL
 *    logs while the admin believes the list is filtered;
 *  - say when the persisted window is truncated, so a list that looks
 *    complete does not pretend to be.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LogEntry } from '../../../lib/logBuffer.js'

const getLogs = vi.fn()
const righePersistite = vi.fn()

vi.mock('../../../lib/logBuffer.js', () => ({ getLogs }))
vi.mock('../../../lib/persistedLogs.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/persistedLogs.js')>()
  // `fondi` (the merge) stays real: the order of the timeline is part of the contract.
  return { ...real, righePersistite }
})

const { logsResolvers } = await import('../logs.js')
const { MAX_RIGHE } = await import('../../../lib/persistedLogs.js')
const logs = logsResolvers.Query.logs

const ctx = (...perms: string[]) => ({
  tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: new Set(perms),
}) as never
const ADMIN = ctx('admin.audit')

const entry = (id: string, timestamp: string, over: Partial<LogEntry> = {}): LogEntry => ({
  id, timestamp, level: 'info', module: 'api', message: `msg ${id}`, data: null, tenantId: 't1', ...over,
})

const MEMORY = [
  entry('m1', '2026-09-20T10:00:00.000Z', { level: 'error', module: 'workflow', message: 'Step failed' }),
  entry('m2', '2026-09-20T12:00:00.000Z', { level: 'warn', module: 'sla' }),
]
const PERSISTED = [
  entry('p1', '2026-09-20T11:00:00.000Z', { module: 'frontend', message: 'TypeError in page' }),
  entry('p2', '2026-09-19T09:00:00.000Z', { module: 'frontend', level: 'error', data: '{"x":1}' }),
]

const ids = (r: { entries: LogEntry[] }) => r.entries.map((e) => e.id)

beforeEach(() => {
  vi.clearAllMocks()
  getLogs.mockReturnValue(MEMORY)
  righePersistite.mockResolvedValue({ righe: PERSISTED, totale: PERSISTED.length })
})

describe('permission and tenant scoping', () => {
  it('refuses a caller without admin.audit before reading anything', async () => {
    await expect(logs(undefined, {}, ctx('workspace.use'))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(getLogs).not.toHaveBeenCalled()
    expect(righePersistite).not.toHaveBeenCalled()
  })

  it('reads both halves for the caller tenant only', async () => {
    await logs(undefined, {}, ADMIN)
    expect(getLogs).toHaveBeenCalledWith('t1')
    expect(righePersistite).toHaveBeenCalledWith('t1')
  })
})

describe('the merged timeline', () => {
  it('merges server and browser lines newest-first, with window metadata', async () => {
    const r = await logs(undefined, {}, ADMIN)
    expect(ids(r)).toEqual(['m2', 'p1', 'm1', 'p2'])
    expect(r.total).toBe(4)
    expect(r.truncated).toBe(false)
    expect(r.windowSize).toBe(MAX_RIGHE)
  })

  it('flags truncation when the archive holds more than the window read', async () => {
    righePersistite.mockResolvedValue({ righe: PERSISTED, totale: 5000 })
    expect((await logs(undefined, {}, ADMIN)).truncated).toBe(true)
  })

  it('pages with limit/offset while total counts the whole (filtered) window', async () => {
    const r = await logs(undefined, { limit: 2, offset: 1 }, ADMIN)
    expect(ids(r)).toEqual(['p1', 'm1'])
    expect(r.total).toBe(4)
  })
})

describe('filters', () => {
  type Rule = { field: string; operator: string; value?: string | string[] | null; value2?: string; logic?: 'AND' | 'OR' }
  const run = (rules: Rule[]) => logs(undefined, { filters: JSON.stringify({ rules }) }, ADMIN)

  it('malformed JSON is an error, never "no filter"', async () => {
    await expect(logs(undefined, { filters: '{broken' }, ADMIN)).rejects.toThrow(/Invalid log filters JSON/)
  })

  it('a group without rules leaves the list untouched', async () => {
    expect((await logs(undefined, { filters: '{}' }, ADMIN)).total).toBe(4)
    expect((await run([])).total).toBe(4)
  })

  /*
   * Review of 23 Sep 2026: the page sends the FilterBuilder's operators
   * (`equals`, `in`, `after`…) and this knew `eq`/`starts`/`gte` and let the
   * rest through — «Level equals error» showed every level, and `in` (a list)
   * crashed on `.toLowerCase()`.
   */
  it('equals / not_equals compare case-insensitively', async () => {
    expect(ids(await run([{ field: 'level', operator: 'equals', value: 'ERROR' }]))).toEqual(['m1', 'p2'])
    expect(ids(await run([{ field: 'module', operator: 'not_equals', value: 'Frontend' }]))).toEqual(['m2', 'm1'])
  })

  it('in / not_in take the list the enum fields send', async () => {
    expect(ids(await run([{ field: 'level', operator: 'in', value: ['warn', 'error'] }]))).toEqual(['m2', 'm1', 'p2'])
    expect(ids(await run([{ field: 'module', operator: 'not_in', value: ['frontend', 'sla'] }]))).toEqual(['m1'])
  })

  it('contains / starts_with / ends_with match on the lowered text; is_empty / is_not_empty', async () => {
    expect(ids(await run([{ field: 'message', operator: 'contains', value: 'typeerror' }]))).toEqual(['p1'])
    expect(ids(await run([{ field: 'message', operator: 'starts_with', value: 'step' }]))).toEqual(['m1'])
    expect(ids(await run([{ field: 'message', operator: 'ends_with', value: 'P2' }]))).toEqual(['p2'])
    expect(ids(await run([{ field: 'message', operator: 'is_not_empty', value: null }]))).toHaveLength(4)
    expect(ids(await run([{ field: 'message', operator: 'is_empty', value: null }]))).toEqual([])
  })

  it('after / before / between compare instants', async () => {
    expect(ids(await run([{ field: 'timestamp', operator: 'after', value: '2026-09-20T10:30:00.000Z' }]))).toEqual(['m2', 'p1'])
    expect(ids(await run([{ field: 'timestamp', operator: 'before', value: '2026-09-20' }]))).toEqual(['p2'])
    expect(ids(await run([{ field: 'timestamp', operator: 'between', value: '2026-09-20T10:00:00.000Z', value2: '2026-09-20T11:00:00.000Z' }]))).toEqual(['p1', 'm1'])
  })

  it('OR keeps a rule with the next one, AND closes the group — as the Cypher filters read it', async () => {
    // (level = warn OR module = frontend) AND message contains «page»
    expect(ids(await run([
      { field: 'level', operator: 'equals', value: 'warn', logic: 'OR' },
      { field: 'module', operator: 'equals', value: 'frontend', logic: 'AND' },
      { field: 'message', operator: 'contains', value: 'page' },
    ]))).toEqual(['p1'])
    // Without a connector the rules are AND-ed.
    expect(ids(await run([
      { field: 'level', operator: 'equals', value: 'error' },
      { field: 'module', operator: 'equals', value: 'frontend' },
    ]))).toEqual(['p2'])
  })

  it('an unknown operator or field is an error with its key, never a rule that lets everything through', async () => {
    await expect(run([{ field: 'level', operator: 'eq', value: 'error' }]))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.logs.filterOperator' } } })
    await expect(run([{ field: 'tenantId', operator: 'equals', value: 't2' }]))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.logs.filterField' } } })
  })
})

describe('sorting', () => {
  it('sorts ascending by any field by default', async () => {
    // frontend, frontend, sla, workflow — ties keep the timeline order (stable sort).
    expect(ids(await logs(undefined, { sortField: 'module' }, ADMIN))).toEqual(['p1', 'p2', 'm2', 'm1'])
  })

  it('sorts descending on request, with nulls treated as empty', async () => {
    const r = await logs(undefined, { sortField: 'data', sortDirection: 'desc' }, ADMIN)
    expect(r.entries[0]!.id).toBe('p2')
  })

  it('ascending by timestamp reverses the default newest-first order', async () => {
    expect(ids(await logs(undefined, { sortField: 'timestamp', sortDirection: 'asc' }, ADMIN))).toEqual(['p2', 'm1', 'p1', 'm2'])
  })
})
