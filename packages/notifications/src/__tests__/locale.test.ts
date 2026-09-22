/**
 * THE LANGUAGE AND TIME ZONE OF WHAT GOES OUT.
 *
 * An e-mail, a Slack message and a Teams card are read by the customer, not
 * by the server: they take the language the customer picked in the
 * Organization page and the customer's time zone. Getting this wrong is the
 * kind of defect nobody reports as a bug — the message simply arrives in
 * another language, or says 03:00 for something that happened at 05:00.
 *
 * The time zone is an ERROR when missing, the language is not: there is a
 * product default for the language (and the API's diagnostics tell the admin
 * about it), while a missing time zone would silently mean "the server's",
 * which is not any customer's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ cypher: string; params: Record<string, unknown> }>,
  closed: 0,
  failWith: null as Error | null,
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: (_db: unknown, mode: string) => {
    state.queries.push({ cypher: `__session__${mode}`, params: {} })
    return {
      executeRead: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
        fn({
          run: async (cypher: string, params: Record<string, unknown>) => {
            state.queries.push({ cypher, params })
            if (state.failWith) throw state.failWith
            return { records: state.rows.map((r) => ({ get: (k: string) => r[k] })) }
          },
        }),
      close: async () => { state.closed += 1 },
    }
  },
}))

const { loadNotificationLocale, invalidateNotificationLocale } = await import('../locale.js')

const reads = () => state.queries.filter((q) => q.cypher.includes('MATCH (t:Tenant')).length

beforeEach(() => {
  state.rows = [{ language: 'it', timeZone: 'Europe/Rome' }]
  state.queries = []
  state.closed = 0
  state.failWith = null
  invalidateNotificationLocale()
})

describe('loadNotificationLocale', () => {
  it('reads the tenant language and time zone, in a READ session it then closes', async () => {
    expect(await loadNotificationLocale('c-one')).toEqual({ language: 'it', timeZone: 'Europe/Rome' })
    expect(state.queries[0]!.cypher).toBe('__session__READ')
    expect(state.queries[1]!.params).toEqual({ tenantId: 'c-one' })
    expect(state.closed).toBe(1)
  })

  it('a language the product does not have falls back to the first one, it does not fail', async () => {
    // A vocabulary value can be anything the customer typed; a notification
    // must still go out. The time zone has no such fallback (see below).
    for (const language of ['de', '', null, undefined, 42]) {
      invalidateNotificationLocale()
      state.rows = [{ language, timeZone: 'Europe/Rome' }]
      expect((await loadNotificationLocale('c-one')).language).toBe('en')
    }
  })

  it('a missing time zone is an ERROR that says what cannot be written', async () => {
    // Falling back to the server's zone would put a wrong hour in every date
    // of every message, and nobody would report it as a bug.
    for (const timeZone of [null, undefined, '', 42]) {
      invalidateNotificationLocale()
      state.rows = [{ language: 'it', timeZone }]
      await expect(loadNotificationLocale('c-one')).rejects.toThrow(/has no time zone configured/)
    }
  })

  it('a tenant that does not exist is an error naming it', async () => {
    state.rows = []
    await expect(loadNotificationLocale('c-ghost')).rejects.toThrow('[notifications] Tenant c-ghost not found')
  })

  it('the session is closed even when the read throws', async () => {
    state.failWith = new Error('Neo4j down')
    await expect(loadNotificationLocale('c-one')).rejects.toThrow('Neo4j down')
    expect(state.closed).toBe(1)
  })

  it('the answer is cached: a second notification for the same tenant does not read again', async () => {
    await loadNotificationLocale('c-one')
    await loadNotificationLocale('c-one')
    expect(reads()).toBe(1)
  })

  it('the cache is per tenant', async () => {
    await loadNotificationLocale('c-one')
    await loadNotificationLocale('c-two')
    expect(reads()).toBe(2)
  })

  it('invalidating one tenant leaves the others cached; invalidating everything clears them all', async () => {
    // The mutation that changes the Organization language calls this: without
    // it the customer would keep receiving the old language for half a minute.
    await loadNotificationLocale('c-one')
    await loadNotificationLocale('c-two')
    invalidateNotificationLocale('c-one')
    await loadNotificationLocale('c-one')
    await loadNotificationLocale('c-two')
    expect(reads()).toBe(3)

    invalidateNotificationLocale()
    await loadNotificationLocale('c-one')
    await loadNotificationLocale('c-two')
    expect(reads()).toBe(5)
  })

  it('the cached entry expires, and the new language is read', async () => {
    vi.useFakeTimers()
    try {
      await loadNotificationLocale('c-one')
      state.rows = [{ language: 'en', timeZone: 'Europe/Rome' }]
      vi.advanceTimersByTime(29_000)
      expect((await loadNotificationLocale('c-one')).language).toBe('it')   // still cached
      vi.advanceTimersByTime(2_000)
      expect((await loadNotificationLocale('c-one')).language).toBe('en')   // read again
      expect(reads()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
