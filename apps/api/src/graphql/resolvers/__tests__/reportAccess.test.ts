import { describe, it, expect, vi } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import {
  assertReportTemplateAccess, assertDashboardAccess, assertDashboardOwnerByWidget, resolveDashboardIdForWidget,
} from '../reportAccess.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function sessionReturning(...rowsPerCall: Array<Record<string, unknown>[]>) {
  let call = 0
  const executeRead = vi.fn().mockImplementation((fn: (tx: unknown) => unknown) => {
    const rows = rowsPerCall[call++] ?? []
    const tx = { run: vi.fn().mockResolvedValue({ records: rows.map(r => ({ get: (k: string) => r[k] })) }) }
    return fn(tx)
  })
  return { executeRead, executeWrite: vi.fn(), close: vi.fn() }
}

function ctx(overrides: Partial<GraphQLContext> = {}): GraphQLContext {
  return { tenantId: 't1', userId: 'u1', userEmail: 'u1@x', role: 'operator', ...overrides }
}

async function code(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null }
  catch (e) { return (e as GraphQLError).extensions?.code as string }
}

// ── Report templates ──────────────────────────────────────────────────────────

describe('assertReportTemplateAccess', () => {
  const tpl = (createdBy: string, visibility: string, isTeamMember = false) => [{ createdBy, visibility, isTeamMember }]

  const table: Array<{ name: string; row: Record<string, unknown>[]; ctx: GraphQLContext; mode: 'read' | 'write'; expect: string | null }> = [
    { name: 'owner reads private',              row: tpl('u1', 'private'),        ctx: ctx(),                    mode: 'read',  expect: null },
    { name: 'owner writes private',             row: tpl('u1', 'private'),        ctx: ctx(),                    mode: 'write', expect: null },
    { name: 'other user reads private',         row: tpl('u2', 'private'),        ctx: ctx(),                    mode: 'read',  expect: 'FORBIDDEN' },
    { name: 'admin reads private of other',     row: tpl('u2', 'private'),        ctx: ctx({ role: 'admin' }),   mode: 'read',  expect: 'FORBIDDEN' },
    { name: 'admin writes private of other',    row: tpl('u2', 'private'),        ctx: ctx({ role: 'admin' }),   mode: 'write', expect: 'FORBIDDEN' },
    { name: 'anyone reads visibility=all',      row: tpl('u2', 'all'),            ctx: ctx({ role: 'viewer' }),  mode: 'read',  expect: null },
    { name: 'non-owner writes visibility=all',  row: tpl('u2', 'all'),            ctx: ctx(),                    mode: 'write', expect: 'FORBIDDEN' },
    { name: 'admin writes visibility=all',      row: tpl('u2', 'all'),            ctx: ctx({ role: 'admin' }),   mode: 'write', expect: null },
    { name: 'team member reads groups',         row: tpl('u2', 'groups', true),   ctx: ctx(),                    mode: 'read',  expect: null },
    { name: 'non-member reads groups',          row: tpl('u2', 'groups', false),  ctx: ctx(),                    mode: 'read',  expect: 'FORBIDDEN' },
    { name: 'team member writes groups',        row: tpl('u2', 'groups', true),   ctx: ctx(),                    mode: 'write', expect: 'FORBIDDEN' },
    { name: 'admin writes groups',              row: tpl('u2', 'groups', false),  ctx: ctx({ role: 'admin' }),   mode: 'write', expect: null },
    { name: 'missing visibility treated private', row: [{ createdBy: 'u2', visibility: null, isTeamMember: false }], ctx: ctx(), mode: 'read', expect: 'FORBIDDEN' },
    { name: 'not found (other tenant)',         row: [],                          ctx: ctx(),                    mode: 'read',  expect: 'NOT_FOUND' },
  ]

  it.each(table)('$name → $expect', async ({ row, ctx: c, mode, expect: exp }) => {
    const session = sessionReturning(row)
    expect(await code(assertReportTemplateAccess(session as never, 'r1', c, mode))).toBe(exp)
    expect(session.executeRead).toHaveBeenCalledTimes(1)
  })

  it('queries by id AND tenant_id with the caller userId', async () => {
    const session = sessionReturning([{ createdBy: 'u1', visibility: 'private', isTeamMember: false }])
    await assertReportTemplateAccess(session as never, 'r1', ctx(), 'read')
    const fn = session.executeRead.mock.calls[0]![0] as (tx: { run: (q: string, p: unknown) => unknown }) => unknown
    const run = vi.fn().mockResolvedValue({ records: [] })
    await fn({ run })
    const [q, p] = run.mock.calls[0]!
    expect(q).toContain('ReportTemplate {id: $id, tenant_id: $tenantId}')
    expect(p).toEqual({ id: 'r1', tenantId: 't1', userId: 'u1' })
  })
})

// ── Dashboards ────────────────────────────────────────────────────────────────

describe('assertDashboardAccess', () => {
  const dash = (ownerId: string, visibility: string, isTeamMember = false) => [{ ownerId, visibility, isTeamMember }]

  const table: Array<{ name: string; row: Record<string, unknown>[]; ctx: GraphQLContext; mode: 'read' | 'write'; expect: string | null }> = [
    { name: 'owner writes',                 row: dash('u1', 'private'),      ctx: ctx(),                   mode: 'write', expect: null },
    { name: 'other user writes',            row: dash('u2', 'all'),          ctx: ctx(),                   mode: 'write', expect: 'FORBIDDEN' },
    { name: 'admin writes any',             row: dash('u2', 'private'),      ctx: ctx({ role: 'admin' }),  mode: 'write', expect: null },
    { name: 'other reads private',          row: dash('u2', 'private'),      ctx: ctx(),                   mode: 'read',  expect: 'FORBIDDEN' },
    { name: 'other reads all',              row: dash('u2', 'all'),          ctx: ctx({ role: 'viewer' }), mode: 'read',  expect: null },
    { name: 'team member reads teams',      row: dash('u2', 'teams', true),  ctx: ctx(),                   mode: 'read',  expect: null },
    { name: 'non-member reads teams',       row: dash('u2', 'teams', false), ctx: ctx(),                   mode: 'read',  expect: 'FORBIDDEN' },
    { name: 'not found',                    row: [],                         ctx: ctx(),                   mode: 'read',  expect: 'NOT_FOUND' },
  ]

  it.each(table)('$name → $expect', async ({ row, ctx: c, mode, expect: exp }) => {
    const session = sessionReturning(row)
    expect(await code(assertDashboardAccess(session as never, 'd1', c, mode))).toBe(exp)
  })
})

describe('widget → dashboard resolution', () => {
  it('resolveDashboardIdForWidget: not found → NOT_FOUND', async () => {
    const session = sessionReturning([])
    expect(await code(resolveDashboardIdForWidget(session as never, 'w1', 'widget', 't1'))).toBe('NOT_FOUND')
  })

  it('assertDashboardOwnerByWidget: resolves the dashboard then enforces owner/admin', async () => {
    const session = sessionReturning([{ dashboardId: 'd9' }], [{ ownerId: 'u2', visibility: 'all', isTeamMember: false }])
    expect(await code(assertDashboardOwnerByWidget(session as never, 'w1', 'customWidget', ctx()))).toBe('FORBIDDEN')
  })

  it('assertDashboardOwnerByWidget: owner passes and returns the dashboard id', async () => {
    const session = sessionReturning([{ dashboardId: 'd9' }], [{ ownerId: 'u1', visibility: 'private', isTeamMember: false }])
    await expect(assertDashboardOwnerByWidget(session as never, 'w1', 'widget', ctx())).resolves.toBe('d9')
  })
})
