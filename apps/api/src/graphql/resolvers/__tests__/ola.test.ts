/**
 * OLA/UC CONTRACTS AND THE SLA REPORT — the contract surface of `ola.ts`.
 *
 * These resolvers decide three things a user sees directly:
 *  - which contracts count on a ticket (the OLA box in the ticket detail): a
 *    contract that silently disappears, or one that counts for the wrong team,
 *    tells the team it is on time when it is not;
 *  - the numbers of the SLA report (met / breached / paused / open on track,
 *    attainment per contract): an off-by-one bucket makes a breach look met;
 *  - who can create and change a contract, and with what data: a contract
 *    without a responsible team, or a compliance target above 100%, would be
 *    measured forever against nothing.
 *
 * Every read is tenant-scoped: each Cypher statement must carry `$tenantId`,
 * or one customer would see another's contracts.
 *
 * The database is a scripted router over the Cypher text; the attainment
 * maths (`lib/olaAttainment.ts`) runs for real so the rows are what a user
 * would see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const admin = { tenantId: 't1', userId: 'u1', role: 'admin', permissions: perms('admin') } as never
const viewer = { tenantId: 't1', userId: 'u2', role: 'viewer', permissions: perms('viewer') } as never

type Route = (q: string, params: Record<string, unknown>) => unknown
let many: Route = () => []
let one: Route = () => null
const calls: { q: string; params: Record<string, unknown> }[] = []

vi.mock('@opengraphity/neo4j', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/neo4j')>()
  return {
    ...orig,
    runQuery: vi.fn(async (_s: unknown, q: string, params: Record<string, unknown>) => { calls.push({ q, params }); return many(q, params) }),
    runQueryOne: vi.fn(async (_s: unknown, q: string, params: Record<string, unknown>) => { calls.push({ q, params }); return one(q, params) }),
  }
})
vi.mock('@opengraphity/sla', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/sla')>()
  return { ...orig, calendarFor: vi.fn(async () => null), getTenantTimezone: vi.fn(async () => 'UTC') }
})
vi.mock('../ci-utils.js', () => ({ withSession: async (fn: (s: unknown) => unknown) => fn({}) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../lib/olaChangeUnits.js', () => ({ loadChangeUnits: vi.fn(async () => []) }))
vi.mock('../../../lib/serviceTargets.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../lib/serviceTargets.js')>()
  return {
    ...orig,
    calendarChoice: vi.fn(async (_t: string, id: unknown) => (id ? { calendar_id: id, business_hours: true } : { calendar_id: null, business_hours: false })),
    calendarNameOf: vi.fn(async (_t: string, id: string | null) => (id ? `Calendar ${id}` : null)),
  }
})

const { olaResolvers, olaContracts, ticketOLAs, slaReport, createOLAContract, updateOLAContract, deleteOLAContract } = await import('../ola.js')
const { audit } = await import('../../../lib/audit.js')
const { loadChangeUnits } = await import('../../../lib/olaChangeUnits.js')
const { getTenantTimezone } = await import('@opengraphity/sla')

beforeEach(() => {
  calls.length = 0
  many = () => []
  one = () => null
  vi.mocked(audit).mockClear()
  vi.mocked(loadChangeUnits).mockReset().mockResolvedValue([])
  vi.mocked(getTenantTimezone).mockClear()
})

async function failure(p: Promise<unknown>): Promise<{ message: string; extensions: Record<string, unknown> }> {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e, 'the call should have failed').not.toBeNull()
  return e as { message: string; extensions: Record<string, unknown> }
}

/** Every statement sent to the database must be scoped to the caller's tenant. */
function expectAllTenantScoped() {
  for (const c of calls) {
    expect(c.q).toContain('$tenantId')
    expect(c.params['tenantId']).toBe('t1')
  }
}

const contract = (over: Record<string, unknown> = {}) => ({
  id: 'ola-1', type: 'ola', name: 'Network in 4h', entity_type: 'incident',
  response_minutes: 60, resolve_minutes: 240, business_hours: false, calendar_id: null,
  party_type: 'team', team_id: 'noc', enabled: true, created_at: '2026-01-01T00:00:00.000Z',
  ...over,
})

// ── olaContracts ──────────────────────────────────────────────────────────────

describe('olaContracts', () => {
  it('maps the stored contract, with defaults for fields old contracts never had', async () => {
    many = () => [{
      props: { id: 'o1', type: 'uc', name: 'Cloud', entity_type: 'any', response_minutes: 30, resolve_minutes: 120, created_at: 'c' },
      teamName: null,
    }]
    const [row] = await olaContracts(null, {}, admin)
    // Missing enabled means "on" (contracts predate the flag); missing
    // business_hours means 24x7; missing objective stays null, not 0.
    expect(row).toMatchObject({
      id: 'o1', type: 'uc', description: null, entityType: 'any', responseMinutes: 30, resolveMinutes: 120,
      businessHours: false, calendarId: null, complianceTarget: null, complianceWarning: null,
      partyType: null, partyName: null, teamId: null, teamName: null, enabled: true,
    })
    expect(calls[0]!.q).not.toContain('WHERE o.type')
    expectAllTenantScoped()
  })

  it('filters by type only when a type is asked for, and converts the objective to numbers', async () => {
    many = () => [{ props: contract({ compliance_target: '99.5', compliance_warning: 97, enabled: false }), teamName: 'NOC' }]
    const [row] = await olaContracts(null, { type: 'ola' }, admin)
    expect(calls[0]!.q).toContain('WHERE o.type = $type')
    expect(calls[0]!.params['type']).toBe('ola')
    expect(row).toMatchObject({ complianceTarget: 99.5, complianceWarning: 97, enabled: false, teamName: 'NOC' })
  })
})

// ── ticketOLAs ────────────────────────────────────────────────────────────────

describe('ticketOLAs', () => {
  const ticketFacts = {
    createdAt: '2026-02-01T00:00:00.000Z', concludedAt: '2026-02-01T01:00:00.000Z', currentTeamId: 'noc',
    segments: [{ teamId: 'noc', startedAt: '2026-02-01T00:00:00.000Z', endedAt: '2026-02-01T01:00:00.000Z', inferred: false }],
  }

  it('rejects an entity type that has no contracts, naming the allowed ones', async () => {
    const e = await failure(ticketOLAs(null, { entityType: 'ci', entityId: 'x' }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.notATicketType', params: { entityType: 'ci' } })
    expect(calls).toHaveLength(0)
  })

  it('a ticket that does not exist in this tenant is NotFound, not an empty box', async () => {
    one = () => null
    const e = await failure(ticketOLAs(null, { entityType: 'incident', entityId: 'nope' }, admin))
    expect(e.extensions['code']).toBe('NOT_FOUND')
  })

  it('a change that does not exist is NotFound too', async () => {
    one = () => null
    const e = await failure(ticketOLAs(null, { entityType: 'change', entityId: 'nope' }, admin))
    expect(e.extensions['code']).toBe('NOT_FOUND')
    expect(loadChangeUnits).toHaveBeenCalledWith({}, 't1', { by: 'change', changeId: 'nope' })
  })

  it('no active contract for the type → empty list, without asking the timezone', async () => {
    one = () => ticketFacts
    many = () => []
    expect(await ticketOLAs(null, { entityType: 'incident', entityId: 'i1' }, admin)).toEqual([])
    expect(getTenantTimezone).not.toHaveBeenCalled()
    // Only enabled contracts of the ticket's type (or `any`) are candidates.
    const q = calls.find((c) => c.q.includes('OLAContract'))!
    expect(q.q).toContain("o.entity_type IN [$entityType, 'any']")
    expect(q.q).toContain('coalesce(o.enabled, true) = true')
    expectAllTenantScoped()
  })

  it('a ticket: one row per contract, measured on the contract\'s own team', async () => {
    one = () => ticketFacts
    many = () => [
      { props: contract(), teamName: 'NOC' },
      { props: contract({ id: 'ola-2', name: 'DB in 1h', team_id: 'dba', resolve_minutes: 60 }), teamName: 'DBA' },
    ]
    const rows = await ticketOLAs(null, { entityType: 'incident', entityId: 'i1' }, admin)
    expect(rows).toHaveLength(2)
    // NOC held it for one hour of a four-hour budget and concluded it: met.
    expect(rows[0]).toMatchObject({
      contractId: 'ola-1', teamName: 'NOC', applies: true, reason: null, state: 'met',
      usedMinutes: 60, remainingMinutes: 180, concludedAt: ticketFacts.concludedAt,
      unitKind: null, unitKey: null, ciName: null, startsAt: null,
    })
    // DBA never had the ticket: it is shown with the reason, not hidden.
    expect(rows[1]).toMatchObject({ contractId: 'ola-2', applies: false, reason: 'other_team', state: null })
  })

  it('a change: one row per task measure that counts, carrying the unit it measures', async () => {
    one = () => ({ id: 'c1' })
    const unit = (over: Record<string, unknown>) => ({
      ...ticketFacts, kind: 'assessment', key: 'k1', node: { label: 'AssessmentTask', id: 'a1' }, alerted: [],
      ticketId: 'c1', ticketNumber: 'CHG1', ticketTitle: 'T', ciName: 'db-01', responderRole: 'owner', stepTitle: null,
      ...over,
    })
    vi.mocked(loadChangeUnits).mockResolvedValue([
      unit({}),
      unit({ key: 'k2', ciName: 'web-01', segments: [{ ...ticketFacts.segments[0]!, teamId: 'web' }] }),
    ] as never)
    many = () => [{ props: contract({ entity_type: 'change' }), teamName: 'NOC' }]
    const rows = await ticketOLAs(null, { entityType: 'change', entityId: 'c1' }, admin)
    // Only the NOC measure counts; the web team's task is not NOC's business.
    expect(rows).toEqual([expect.objectContaining({ unitKind: 'assessment', unitKey: 'k1', ciName: 'db-01', responderRole: 'owner', applies: true })])
  })

  it('a change with no measure of the team: a single row saying why (before the contract wins over other team)', async () => {
    one = () => ({ id: 'c1' })
    const early = {
      ...ticketFacts, kind: 'assessment', key: 'k1', ciName: 'db-01', responderRole: 'owner', stepTitle: null,
      segments: [{ teamId: 'noc', startedAt: '2025-01-01T00:00:00.000Z', endedAt: '2025-01-01T01:00:00.000Z', inferred: false }],
      concludedAt: '2025-01-01T01:00:00.000Z',
    }
    vi.mocked(loadChangeUnits).mockResolvedValue([early] as never)
    many = () => [
      { props: contract({ entity_type: 'change' }), teamName: 'NOC' },
      { props: contract({ id: 'ola-3', entity_type: 'any', team_id: 'dba' }), teamName: 'DBA' },
    ]
    const rows = await ticketOLAs(null, { entityType: 'change', entityId: 'c1' }, admin)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ contractId: 'ola-1', applies: false, reason: 'before_contract', remainingMinutes: 240, unitKind: null, concludedAt: null })
    expect(rows[1]).toMatchObject({ contractId: 'ola-3', applies: false, reason: 'other_team' })
  })
})

// ── slaReport ─────────────────────────────────────────────────────────────────

describe('slaReport', () => {
  it('buckets are disjoint: open on track is what is left, breach rate is over concluded SLAs only', async () => {
    many = (q) => {
      if (q.includes('count(s)')) return [{ total: 10, met: 5, breached: 2, paused: 1 }]
      if (q.includes('AS priority')) return [{ priority: 'P1', total: 3, met: 2, breached: 1 }]
      if (q.includes('SLAPolicyNode')) return [
        { policyId: 'p1', policyName: 'Gold', setByRule: null, entityType: 'incident', responseMinutes: 15, resolveMinutes: 60, complianceTarget: 99, complianceWarning: 95, total: 4, met: 3, breached: 1, paused: 0 },
        { total: 1, met: 0, breached: 0, paused: 1 },
      ]
      if (q.includes('avgMinutes')) return [{ avgMinutes: 42.5 }]
      return []
    }
    const r = await slaReport(null, {}, admin)
    expect(r.windowDays).toBe(30)
    expect(r.sla).toMatchObject({ total: 10, met: 5, breached: 2, paused: 1, openOnTrack: 2, avgResolutionMinutes: 42.5 })
    expect(r.sla.breachRate).toBeCloseTo((2 / 7) * 100)
    expect(r.sla.byPriority).toEqual([{ priority: 'P1', total: 3, met: 2, breached: 1 }])
    expect(r.sla.byPolicy[0]).toMatchObject({ policyId: 'p1', policyName: 'Gold', complianceTarget: 99, resolveMinutes: 60 })
    // An SLA created before provenance was recorded stays in its own row, nothing guessed.
    expect(r.sla.byPolicy[1]).toMatchObject({ policyId: null, policyName: null, setByRule: null, entityType: null, responseMinutes: null, resolveMinutes: null, complianceTarget: null, complianceWarning: null, paused: 1 })
    // No contract → no timezone lookup, empty OLA section.
    expect(r.ola).toEqual([])
    expect(getTenantTimezone).not.toHaveBeenCalled()
    expectAllTenantScoped()
  })

  it('an empty tenant gives zeros, not NaN, and no average', async () => {
    const r = await slaReport(null, { windowDays: 7 }, admin)
    expect(r.sla).toMatchObject({ total: 0, met: 0, breached: 0, paused: 0, openOnTrack: 0, breachRate: 0, avgResolutionMinutes: null })
  })

  it.each([[0, 1], [-5, 1], [9999, 365], [90, 90]])('window %i days is clamped to %i', async (asked, used) => {
    const before = Date.now()
    const r = await slaReport(null, { windowDays: asked }, admin)
    expect(r.windowDays).toBe(used)
    const cutoff = Date.parse(calls[0]!.params['cutoff'] as string)
    expect(before - cutoff).toBeGreaterThanOrEqual(used * 86_400_000 - 1000)
    expect(before - cutoff).toBeLessThanOrEqual(used * 86_400_000 + 1000)
  })

  it('attainment per contract: `any` spans every ticket type, a change is measured on its task units', async () => {
    const concluded = {
      createdAt: '2026-02-01T00:00:00.000Z', concludedAt: '2026-02-01T01:00:00.000Z', currentTeamId: 'noc',
      segments: [{ teamId: 'noc', startedAt: '2026-02-01T00:00:00.000Z', endedAt: '2026-02-01T01:00:00.000Z', inferred: true }],
    }
    const late = { ...concluded, concludedAt: '2026-02-01T10:00:00.000Z', segments: [{ ...concluded.segments[0]!, endedAt: '2026-02-01T10:00:00.000Z', inferred: false }] }
    many = (q) => {
      if (q.includes('properties(o) AS props')) return [
        { props: contract({ entity_type: 'any', compliance_target: 95, compliance_warning: 80 }) },
        { props: contract({ id: 'ola-2', type: 'uc', entity_type: '', team_id: null, party_type: 'supplier', party_name: 'Acme' }) },
      ]
      if (q.includes('MATCH (e:Incident')) return [concluded, late]
      return []
    }
    vi.mocked(loadChangeUnits).mockResolvedValue([concluded] as never)
    const r = await slaReport(null, {}, admin)
    expect(getTenantTimezone).toHaveBeenCalledWith('t1')
    const [anyContract, legacy] = r.ola
    // `any` → incident, problem, service_request (router: incidents only) + change units.
    expect(loadChangeUnits).toHaveBeenCalledWith({}, 't1', expect.objectContaining({ by: 'concluded', teamId: 'noc' }))
    expect(anyContract).toMatchObject({ id: 'ola-1', entityType: 'any', evaluated: 3, met: 2, breached: 1, inferred: 2, complianceTarget: 95, complianceWarning: 80 })
    expect(anyContract!.attainmentPct).toBeCloseTo((2 / 3) * 100)
    // A contract with no entity type is an incident contract (legacy data).
    expect(legacy).toMatchObject({ entityType: 'incident', partyType: 'supplier', partyName: 'Acme', evaluated: 2, complianceTarget: null, complianceWarning: null })
    expect(loadChangeUnits).toHaveBeenCalledTimes(1)
  })

  it('a contract with nothing evaluated has no attainment, not 0%', async () => {
    many = (q) => (q.includes('properties(o) AS props') ? [{ props: contract({ party_type: null }) }] : [])
    const r = await slaReport(null, {}, admin)
    expect(r.ola[0]).toMatchObject({ evaluated: 0, attainmentPct: null, partyType: null, partyName: null })
  })
})

// ── createOLAContract ─────────────────────────────────────────────────────────

const INPUT = {
  type: 'ola', name: 'Network in 4h', entityType: 'incident',
  responseMinutes: 60, resolveMinutes: 240, complianceTarget: 95, complianceWarning: 80,
  teamId: 'noc',
}

describe('createOLAContract', () => {
  beforeEach(() => {
    one = (q) => (q.includes('t.sourcing') ? { name: 'NOC', sourcing: 'internal' } : null)
    many = () => [{ props: contract(), teamName: 'NOC' }]
  })

  it('needs config.sla', async () => {
    const e = await failure(createOLAContract(null, { input: INPUT }, viewer))
    expect(e.extensions['code']).toBe('FORBIDDEN')
    expect(calls).toHaveLength(0)
  })

  it.each([
    [{ type: 'sla' }, 'errors.ola.typeOneOf'],
    [{ type: undefined }, 'errors.ola.typeOneOf'],
    [{ entityType: 'ci' }, 'errors.ola.entityTypeOneOf'],
    [{ entityType: undefined }, 'errors.ola.entityTypeOneOf'],
    [{ name: '   ' }, 'errors.ola.nameRequired'],
    [{ responseMinutes: 0 }, 'errors.ola.responseMinutes'],
    [{ responseMinutes: -1 }, 'errors.ola.responseMinutes'],
    [{ resolveMinutes: undefined }, 'errors.ola.resolveMinutes'],
    [{ complianceTarget: 120 }, 'errors.compliance.target'],
    [{ complianceWarning: 99 }, 'errors.compliance.warning'],
  ])('rejects %o with %s before writing anything', async (over, key) => {
    const e = await failure(createOLAContract(null, { input: { ...INPUT, ...over } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key })
    expect(calls.some((c) => c.q.includes('CREATE'))).toBe(false)
  })

  it('without partyType the responsible is an internal team, and the team is required', async () => {
    const e = await failure(createOLAContract(null, { input: { ...INPUT, teamId: undefined } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.teamRequired' })
  })

  it('a supplier without a team gets its own message', async () => {
    const e = await failure(createOLAContract(null, { input: { ...INPUT, partyType: 'supplier', teamId: '  ' } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.supplierTeamRequired' })
  })

  it('an unknown partyType is refused', async () => {
    const e = await failure(createOLAContract(null, { input: { ...INPUT, partyType: 'vendor' } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.partyTypeOneOf', params: { allowed: 'team, supplier' } })
  })

  it('a team of another tenant (or none) is unknown here', async () => {
    one = () => null
    const e = await failure(createOLAContract(null, { input: INPUT }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.teamUnknown', params: { team: 'noc' } })
    expect(calls[0]!.params).toMatchObject({ teamId: 'noc', tenantId: 't1' })
  })

  it('creates the contract trimmed, tenant-scoped, enabled, and audits it', async () => {
    const out = await createOLAContract(null, { input: { ...INPUT, name: '  Network in 4h  ', calendarId: 'cal-1', description: 'd' } }, admin)
    const create = calls.find((c) => c.q.includes('CREATE (o:OLAContract'))!
    expect(create.q).toContain('enabled: true')
    expect(create.params).toMatchObject({
      tenantId: 't1', name: 'Network in 4h', description: 'd', calendarId: 'cal-1', businessHours: true,
      complianceTarget: 95, complianceWarning: 80, teamId: 'noc', partyType: null,
    })
    expect(out).toMatchObject({ id: 'ola-1', teamName: 'NOC' })
    expect(audit).toHaveBeenCalledWith(admin, 'ola_contract.created', 'OLAContract', create.params['id'])
  })
})

// ── deleteOLAContract ─────────────────────────────────────────────────────────

describe('deleteOLAContract', () => {
  it('a contract of another tenant (no row) is NotFound and nothing is audited', async () => {
    many = () => []
    const e = await failure(deleteOLAContract(null, { id: 'x' }, admin))
    expect(e.extensions['code']).toBe('NOT_FOUND')
    expect(audit).not.toHaveBeenCalled()
    expectAllTenantScoped()
  })

  it('deletes and keeps the previous state in the Audit Log', async () => {
    many = () => [{ props: contract() }]
    expect(await deleteOLAContract(null, { id: 'ola-1' }, admin)).toBe(true)
    expect(calls[0]!.q).toContain('DETACH DELETE o')
    expect(audit).toHaveBeenCalledWith(admin, 'ola_contract.deleted', 'OLAContract', 'ola-1', { previous: contract() })
  })
})

// ── updateOLAContract ─────────────────────────────────────────────────────────

describe('updateOLAContract', () => {
  const setsOf = () => calls.find((c) => c.q.includes('SET o += $sets'))!.params['sets'] as Record<string, unknown>

  beforeEach(() => { many = () => [{ props: contract(), teamName: 'NOC' }] })

  it('needs config.sla', async () => {
    const e = await failure(updateOLAContract(null, { id: 'ola-1', input: { name: 'x' } }, viewer))
    expect(e.extensions['code']).toBe('FORBIDDEN')
  })

  it('the type cannot change (an OLA does not become an UC)', async () => {
    const e = await failure(updateOLAContract(null, { id: 'ola-1', input: { type: 'uc' } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.typeImmutable' })
  })

  it('an invalid entity type is refused', async () => {
    const e = await failure(updateOLAContract(null, { id: 'ola-1', input: { entityType: 'ci' } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.entityTypeOneOf' })
  })

  it('an empty input is an error, not a silent no-op', async () => {
    const e = await failure(updateOLAContract(null, { id: 'ola-1', input: {} }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.nothingToUpdate' })
  })

  it('writes only the given fields, and a calendar change brings business_hours with it', async () => {
    await updateOLAContract(null, { id: 'ola-1', input: {
      name: 'N', description: 'D', entityType: 'any', responseMinutes: 5, resolveMinutes: 50, calendarId: null, enabled: false,
    } }, admin)
    expect(setsOf()).toEqual({
      name: 'N', description: 'D', entity_type: 'any', response_minutes: 5, resolve_minutes: 50,
      calendar_id: null, business_hours: false, enabled: false,
    })
    expect(audit).toHaveBeenCalledWith(admin, 'ola_contract.updated', 'OLAContract', 'ola-1')
    expectAllTenantScoped()
  })

  it('changing only the warning is validated against the STORED target', async () => {
    one = (q) => (q.includes('compliance_target AS target') ? { target: 90, warning: 70 } : null)
    const e = await failure(updateOLAContract(null, { id: 'ola-1', input: { complianceWarning: 95 } }, admin))
    // 95 is fine alone, but not above the stored 90% target.
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.compliance.warning', params: { target: 90 } })

    await updateOLAContract(null, { id: 'ola-1', input: { complianceTarget: 99 } }, admin)
    expect(setsOf()).toMatchObject({ compliance_target: 99, compliance_warning: 70 })
  })

  it('an objective on a contract that is gone has nothing to merge with: refused', async () => {
    one = () => null
    const e = await failure(updateOLAContract(null, { id: 'gone', input: { complianceTarget: 99 } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.compliance.warning' })
  })

  it('switching team → supplier alone is checked against the team already stored', async () => {
    one = (q) => {
      if (q.includes('o.party_type AS partyType')) return { partyType: 'team', teamId: 'noc' }
      if (q.includes('t.sourcing')) return { name: 'NOC', sourcing: 'internal' }
      return null
    }
    const e = await failure(updateOLAContract(null, { id: 'ola-1', input: { partyType: 'supplier' } }, admin))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ola.teamWrongSourcing', params: { team: 'NOC' } })
  })

  it('a new team keeps the stored party type, and the hand-written name is cleared', async () => {
    one = (q) => {
      if (q.includes('o.party_type AS partyType')) return { partyType: 'supplier', teamId: 'old' }
      if (q.includes('t.sourcing')) return { name: 'Acme', sourcing: 'external' }
      return null
    }
    await updateOLAContract(null, { id: 'ola-1', input: { teamId: 'acme' } }, admin)
    expect(setsOf()).toEqual({ team_id: 'acme', party_name: null })
  })

  it('a responsible change on a contract that does not exist is NotFound', async () => {
    one = () => null
    const e = await failure(updateOLAContract(null, { id: 'gone', input: { teamId: 'noc' } }, admin))
    expect(e.extensions['code']).toBe('NOT_FOUND')
  })

  it('the update itself finding no contract is NotFound, not a null result', async () => {
    many = () => []
    const e = await failure(updateOLAContract(null, { id: 'gone', input: { name: 'x' } }, admin))
    expect(e.extensions['code']).toBe('NOT_FOUND')
    expect(audit).not.toHaveBeenCalled()
  })
})

// ── calendarName field ────────────────────────────────────────────────────────

describe('calendarName', () => {
  it('is read from the live calendar, for contracts and ticket rows alike', async () => {
    expect(await olaResolvers.OLAContract.calendarName({ calendarId: 'cal-1' }, null, admin)).toBe('Calendar cal-1')
    expect(await olaResolvers.TicketOLA.calendarName({ calendarId: null }, null, admin)).toBeNull()
  })
})
