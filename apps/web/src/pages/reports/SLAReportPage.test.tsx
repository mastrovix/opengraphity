/**
 * SLA REPORT: how well the SLAs were kept in the chosen window.
 *
 * A manager reads the totals (met, breached, paused, breach rate, average
 * resolution), then which POLICY each SLA came from and how well each was
 * kept against its own objective, then the same by priority. What breaks for
 * a user if it regresses: an SLA set by a rule, or one whose origin was never
 * recorded, shown as if it had a policy (or not at all); a compliance
 * computed on SLAs still running; a percentage coloured against a fixed
 * threshold instead of the policy's objective; a scope with the factory name
 * instead of the customer's; or a window change that does not reload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

/** Operations reported as still loading: the shared fake never is, and the page shows a placeholder then. */
const stillLoading = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const base = moduloApollo()
  return {
    ...base,
    useQuery: (...args: Parameters<typeof base.useQuery>) => {
      const result = base.useQuery(...args)
      return stillLoading.has(nomeOperazione(args[0])) ? { ...result, loading: true } : result
    },
  }
})

const { SLAReportPage } = await import('./SLAReportPage')

// ── Data ─────────────────────────────────────────────────────────────────────

interface PolicyRow {
  policyId: string | null; policyName: string | null; setByRule: string | null
  entityType: string | null; responseMinutes: number | null; resolveMinutes: number | null
  complianceTarget: number | null; complianceWarning: number | null
  total: number; met: number; breached: number; paused: number
}
const policy = (over: Partial<PolicyRow> = {}): PolicyRow => ({
  policyId: 'p1', policyName: 'P1 incidents', setByRule: null, entityType: 'incident',
  responseMinutes: 15, resolveMinutes: 240, complianceTarget: 95, complianceWarning: 90,
  total: 50, met: 45, breached: 5, paused: 1, ...over,
})

const sla = (over: Record<string, unknown> = {}) => ({
  total: 120, met: 100, breached: 12, paused: 3, openOnTrack: 5, breachRate: 10.714, avgResolutionMinutes: 150,
  byPriority: [
    { priority: 'critical', total: 10, met: 9, breached: 1 },
    { priority: 'low', total: 4, met: 0, breached: 0 },
  ],
  byPolicy: [
    policy(),
    policy({ policyId: null, policyName: null, setByRule: 'VIP customers', entityType: null, responseMinutes: null, resolveMinutes: null, complianceTarget: null, complianceWarning: null, total: 6, met: 0, breached: 0, paused: 0 }),
    policy({ policyId: null, policyName: null, setByRule: null, entityType: 'any', responseMinutes: 60, resolveMinutes: null, complianceTarget: null, complianceWarning: null, total: 3, met: 2, breached: 1, paused: 0 }),
    policy({ policyId: null, policyName: null, setByRule: null, entityType: 'change', responseMinutes: null, resolveMinutes: 30, complianceTarget: null, complianceWarning: null, total: 1, met: 1, breached: 0, paused: 0 }),
  ],
  ...over,
})

const report = (over: Record<string, unknown> = {}, windowDays = 30) => ({
  slaReport: { generatedAt: '2026-09-23T08:00:00Z', windowDays, sla: sla(over) },
})

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The number shown in the tile with this label (the table headers carry some of the same words). */
const tile = (label: string) => screen.getAllByText(label).find((e) => e.tagName === 'DIV')!.previousElementSibling as HTMLElement
const tableRows = (name: string) => within(screen.getByRole('table', { name })).getAllByRole('row').slice(1)
const texts = (tr: HTMLElement) => within(tr).getAllByRole('cell').map((c) => c.textContent)

beforeEach(() => {
  apolloFinto.reset()
  stillLoading.clear()
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ name: 'incident', label: 'Disruption' }, { name: 'change', label: 'Change' }] }
  apolloFinto.risposte['GetSLAReport'] = report()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SLA Report — the window', () => {
  it('reads the last 30 days first, and reloads for the window chosen', async () => {
    const { user } = renderWithProviders(<SLAReportPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'SLA Report' })).toBeInTheDocument()
    expect(apolloFinto.chiamata('GetSLAReport')).toEqual({ windowDays: 30 })
    await user.click(screen.getByRole('button', { name: '90d' }))
    expect(apolloFinto.chiamata('GetSLAReport')).toEqual({ windowDays: 90 })
  })

  it('who may manage the policies finds the link to them', () => {
    apolloFinto.risposte['GetMe'] = { me: { id: 'u1', name: 'Ada', email: 'ada@example.com', role: 'admin', roleName: null, permissions: ['config.sla'], slackId: null, emailNotifications: null, language: null, teams: [] } }
    renderWithProviders(<SLAReportPage />)
    expect(screen.getByRole('link', { name: 'Manage policies →' })).toHaveAttribute('href', '/admin/sla-policies')
  })

  it('while the report loads, a placeholder stands in for the numbers', () => {
    stillLoading.add('GetSLAReport')
    delete apolloFinto.risposte['GetSLAReport']
    renderWithProviders(<SLAReportPage />)
    expect(document.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
    expect(screen.queryByText('Breach rate')).toBeNull()
  })

  it('while a new window loads, the numbers already there stay on screen', () => {
    stillLoading.add('GetSLAReport')
    renderWithProviders(<SLAReportPage />)
    expect(document.querySelector('[data-slot="skeleton"]')).toBeNull()
    expect(tile('Breach rate')).toHaveTextContent(/^10\.7%$/)
  })

  it('a failed load says so, and Retry reloads', async () => {
    apolloFinto.erroriQuery['GetSLAReport'] = new Error('The graph did not answer')
    const { user } = renderWithProviders(<SLAReportPage />)
    expect(screen.getByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByText('The graph did not answer')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('SLA Report — the totals', () => {
  it('show the SLAs of the window: met, breached, paused, breach rate and average resolution', () => {
    renderWithProviders(<SLAReportPage />)
    expect(tile('SLA in the window (30d)')).toHaveTextContent(/^120$/)
    expect(tile('Met')).toHaveTextContent(/^100$/)
    expect(tile('Breached')).toHaveTextContent(/^12$/)
    expect(tile('SLA paused')).toHaveTextContent(/^3$/)
    expect(tile('Breach rate')).toHaveTextContent(/^10\.7%$/)
    expect(tile('Average resolution time')).toHaveTextContent(/^2h 30min$/)
    expect(screen.getByText('Generated on 23 Sept 2026, 10:00.')).toBeInTheDocument()
  })

  it('without a resolved SLA there is no average: a dash, not zero', () => {
    apolloFinto.risposte['GetSLAReport'] = report({ avgResolutionMinutes: null }, 7)
    renderWithProviders(<SLAReportPage />)
    expect(tile('Average resolution time')).toHaveTextContent(/^—$/)
    expect(tile('SLA in the window (7d)')).toHaveTextContent(/^120$/)
  })
})

describe('SLA Report — by policy', () => {
  it('each row names where its SLAs came from: a policy, a rule, or no recorded origin', () => {
    renderWithProviders(<SLAReportPage />)
    const [fromPolicy, fromRule, unknownAny, unknownChange] = tableRows('By policy')
    expect(texts(fromPolicy!)).toEqual(['P1 incidents', 'Disruption', '15min / 4h', '50', '45', '5', '1', '95%', '90%'])
    expect(texts(fromRule!)).toEqual(['Set by the rule «VIP customers»', '—', '—', '6', '0', '0', '0', '—', '—'])
    // The reason sits in the hint: in the cell it took six lines.
    expect(within(unknownAny!).getByText('No policy recorded')).toHaveAttribute('title', 'These SLAs were created before the policy that produced them was recorded: their origin is not reconstructed.')
    expect(texts(unknownAny!)).toEqual(['No policy recorded', 'All', '1h / —', '3', '2', '1', '0', '—', '67%'])
    expect(texts(unknownChange!)).toEqual(['No policy recorded', 'Change', '— / 30min', '1', '1', '0', '0', '—', '100%'])
  })

  it('compliance counts only the concluded SLAs and is coloured against the policy\'s own objective', () => {
    renderWithProviders(<SLAReportPage />)
    const [fromPolicy, , unknownAny] = tableRows('By policy')
    // 45 met of 50 concluded (the paused one is not concluded): 90%, against 95/90.
    expect(within(fromPolicy!).getByText('90%')).toHaveAttribute('title', 'Green from 95%, yellow from 90%, red below')
    // Without an objective there is no colour, and the hint says why.
    expect(within(unknownAny!).getByText('67%')).toHaveAttribute('title', 'No compliance target: no colour')
  })

  it('with no SLA in the window, says so instead of an empty table', () => {
    apolloFinto.risposte['GetSLAReport'] = report({ byPolicy: [], byPriority: [] })
    renderWithProviders(<SLAReportPage />)
    expect(screen.getAllByText('No SLA data in this period.')).toHaveLength(2)
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('SLA Report — by priority', () => {
  it('each priority shows its SLAs and its compliance; a priority with nothing concluded shows a dash', () => {
    renderWithProviders(<SLAReportPage />)
    const [critical, low] = tableRows('By priority')
    expect(texts(critical!)).toEqual(['critical', '10', '9', '1', '90%'])
    expect(texts(low!)).toEqual(['low', '4', '0', '0', '—'])
    // Priorities mix policies with different objectives: no objective, no colour.
    expect(within(critical!).getByText('90%')).toHaveAttribute('title', 'No compliance target: no colour')
  })
})
