/**
 * Ticket numbering chosen by the customer (lib/ticketNumbering.ts).
 *
 * Why these behaviours matter:
 *  - a tenant without the property keeps the factory format (INC/PRB/CHG/REQ,
 *    8 digits): if that default changed, every existing customer would start
 *    minting numbers in a new shape overnight;
 *  - two ticket types whose prefixes overlap (or a prefix already used by the
 *    existing numbers of another type) would produce numbers that cannot be
 *    told apart in a search or an e-mail — the validation is the only guard;
 *  - a corrupt stored value must fail loudly (house rule: no silent fallback),
 *    not quietly revert to INC… numbers;
 *  - saving a new format must invalidate the cached one, or the API keeps
 *    minting the old prefix until the TTL expires;
 *  - every query is scoped to the tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQuery = vi.fn()
const close = vi.fn(async () => {})
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close })),
  runQuery: (...a: unknown[]) => runQuery(...a),
  toNumber: (v: unknown) => Number(v),
}))

const {
  ticketNumbering, clearTicketNumberingCache, formatTicketNumber, nextTicketNumber,
  assertTicketNumbering, setTicketNumbering, FACTORY_TICKET_NUMBERING,
} = await import('../ticketNumbering.js')

const custom = {
  incident:        { prefix: 'TKT-', digits: 6 },
  problem:         { prefix: 'PB', digits: 5 },
  change:          { prefix: 'RFC', digits: 4 },
  service_request: { prefix: 'SR', digits: 3 },
}

beforeEach(() => { runQuery.mockReset(); close.mockClear(); clearTicketNumberingCache() })

describe('formatTicketNumber', () => {
  it('pads the counter to the chosen digits and never truncates a longer one', () => {
    expect(formatTicketNumber({ prefix: 'INC', digits: 8 }, 42)).toBe('INC00000042')
    // Overflowing the digits must still produce a unique number, not a cut one.
    expect(formatTicketNumber({ prefix: 'SR', digits: 3 }, 12345)).toBe('SR12345')
  })
})

describe('assertTicketNumbering', () => {
  it('accepts a coherent format and returns only the known kinds', () => {
    expect(assertTicketNumbering({ ...custom, extra: { prefix: 'X', digits: 3 } })).toEqual(custom)
  })

  it.each([
    [null], ['text'], [[1, 2]],
  ])('refuses a non-object (%j)', (raw) => {
    expect(() => assertTicketNumbering(raw)).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ i18n: { key: 'errors.ticketNumbering.shape', params: {} } }) }))
  })

  it('refuses a format with a missing ticket type', () => {
    const { change: _c, ...rest } = custom
    expect(() => assertTicketNumbering(rest)).toThrow(/Numbering of change is missing/)
    expect(() => assertTicketNumbering({ ...custom, change: 'CHG' })).toThrow(/Numbering of change is missing/)
  })

  it.each([
    ['inc'], ['1INC'], ['TOOLONGPFX'], ['A--'], [7],
  ])('refuses the prefix %j', (prefix) => {
    expect(() => assertTicketNumbering({ ...custom, problem: { prefix, digits: 5 } }))
      .toThrow(expect.objectContaining({ extensions: expect.objectContaining({ i18n: expect.objectContaining({ key: 'errors.ticketNumbering.prefix' }) }) }))
  })

  it.each([[2], [13], [4.5], ['6']])('refuses %j digits', (digits) => {
    expect(() => assertTicketNumbering({ ...custom, change: { prefix: 'RFC', digits } }))
      .toThrow(expect.objectContaining({ extensions: expect.objectContaining({ i18n: { key: 'errors.ticketNumbering.digits', params: { entityType: 'change', min: 3, max: 12 } } }) }))
  })

  it('refuses prefixes where one starts with the other: numbers would be ambiguous', () => {
    // "SR" is the start of "SRV": SRV001 could be read as a service request.
    expect(() => assertTicketNumbering({ ...custom, incident: { prefix: 'SRV', digits: 3 } }))
      .toThrow(/overlap/)
    expect(() => assertTicketNumbering({ ...custom, change: { prefix: 'PB', digits: 3 } }))
      .toThrow(expect.objectContaining({ extensions: expect.objectContaining({ i18n: expect.objectContaining({ key: 'errors.ticketNumbering.prefixOverlap' }) }) }))
  })
})

describe('ticketNumbering (load + cache)', () => {
  it('a tenant without a stored format uses the factory one, flagged as default', async () => {
    runQuery.mockResolvedValueOnce([{ raw: null }])
    const out = await ticketNumbering('t1')
    expect(out).toEqual({ ...FACTORY_TICKET_NUMBERING, isDefault: true })
    expect(runQuery.mock.calls[0]![2]).toEqual({ tenantId: 't1' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a stored format is parsed and cached per tenant', async () => {
    runQuery.mockResolvedValueOnce([{ raw: JSON.stringify(custom) }])
    expect(await ticketNumbering('t1')).toEqual({ ...custom, isDefault: false })
    expect(await ticketNumbering('t1')).toEqual({ ...custom, isDefault: false })
    expect(runQuery).toHaveBeenCalledTimes(1)
  })

  it('an unknown tenant fails instead of minting factory numbers', async () => {
    runQuery.mockResolvedValueOnce([])
    await expect(ticketNumbering('ghost')).rejects.toThrow(/Tenant ghost does not exist/)
  })

  it('a corrupt stored value fails loudly and names the tenant', async () => {
    runQuery.mockResolvedValueOnce([{ raw: '{not json' }])
    await expect(ticketNumbering('t1')).rejects.toThrow(/Tenant t1: ticket_numbering is not valid JSON/)
  })

  it('a stored value that is valid JSON but incoherent is refused too', async () => {
    runQuery.mockResolvedValueOnce([{ raw: JSON.stringify({ ...custom, problem: { prefix: 'TKT', digits: 5 } }) }])
    await expect(ticketNumbering('t1')).rejects.toThrow(/overlap/)
  })
})

describe('nextTicketNumber', () => {
  it('combines the product counter with the customer format', async () => {
    runQuery.mockResolvedValueOnce([{ raw: JSON.stringify(custom) }])
    const tx = { run: vi.fn(async () => ({ records: [{ get: () => 7 }] })) }
    const n = await nextTicketNumber(tx as never, 't1', 'incident')
    expect(n).toBe('TKT-000007')
    // The counter is per tenant and per kind: the kind is the stable key, not the prefix.
    expect(tx.run.mock.calls[0]).toEqual([expect.stringContaining('MERGE (c:Counter'), { tenantId: 't1', kind: 'incident' }])
  })
})

describe('setTicketNumbering', () => {
  it('refuses an invalid format before opening a session', async () => {
    await expect(setTicketNumbering('t1', { ...custom, incident: { prefix: 'bad', digits: 6 } })).rejects.toThrow(/Prefix of incident/)
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('checks every prefix against the existing numbers of the other types, then saves', async () => {
    runQuery.mockImplementation(async (_s: unknown, cypher: string) => (cypher.includes('SET t.ticket_numbering') ? [{ id: 't1' }] : []))
    const out = await setTicketNumbering('t1', custom)
    expect(out).toEqual({ ...custom, isDefault: false })
    const checks = runQuery.mock.calls.filter((c) => (c[1] as string).includes('n.number =~'))
    // 4 kinds x 3 other kinds.
    expect(checks).toHaveLength(12)
    // The trailing dash is escaped so the regex stays literal.
    expect(checks.some((c) => (c[2] as { re: string }).re === 'TKT\\-[0-9]+')).toBe(true)
    expect(checks.every((c) => (c[2] as { tenantId: string }).tenantId === 't1')).toBe(true)
    const save = runQuery.mock.calls.at(-1)!
    expect(JSON.parse((save[2] as { json: string }).json)).toEqual(custom)
  })

  it('refuses a prefix already used by the existing numbers of another type', async () => {
    runQuery.mockImplementation(async (_s: unknown, cypher: string, params: { re: string }) =>
      (cypher.includes(':Change ') && params.re === 'PB[0-9]+' ? [{ number: 'PB00012' }] : []))
    await expect(setTicketNumbering('t1', custom)).rejects.toMatchObject({
      extensions: { i18n: { key: 'errors.ticketNumbering.prefixInUse', params: { entityType: 'problem', prefix: 'PB', other: 'change', example: 'PB00012' } } },
    })
    expect(runQuery.mock.calls.some((c) => (c[1] as string).includes('SET t.ticket_numbering'))).toBe(false)
    expect(close).toHaveBeenCalled()
  })

  it('an unknown tenant is reported as not found', async () => {
    runQuery.mockResolvedValue([])
    await expect(setTicketNumbering('ghost', custom)).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.notFound' } } })
  })

  it('saving invalidates the cached format, so the next ticket uses the new prefix', async () => {
    runQuery.mockResolvedValueOnce([{ raw: null }])
    expect((await ticketNumbering('t1')).incident.prefix).toBe('INC')
    runQuery.mockImplementation(async (_s: unknown, cypher: string) => {
      if (cypher.includes('SET t.ticket_numbering')) return [{ id: 't1' }]
      if (cypher.includes('t.ticket_numbering AS raw')) return [{ raw: JSON.stringify(custom) }]
      return []
    })
    await setTicketNumbering('t1', custom)
    expect((await ticketNumbering('t1')).incident.prefix).toBe('TKT-')
  })
})
