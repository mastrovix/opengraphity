/**
 * OLA / UC REPORT: how well each contract was kept in the chosen window.
 *
 * A manager reads here whether the internal teams (OLA) and the suppliers
 * (UC) met their resolution targets. What breaks for a user if it regresses:
 * totals that do not add up the contracts' evaluations, an attainment
 * computed on the wrong base, a contract that is switched off counted as
 * active, a percentage coloured against someone else's objective, a scope
 * shown with the factory name instead of the customer's, or a window change
 * that does not reload the numbers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { OLAContract } from '@/pages/admin/OLAContractsPage'

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

const { OLAReportPage } = await import('./OLAReportPage')

// ── Data ─────────────────────────────────────────────────────────────────────

const contract = (over: Partial<OLAContract> = {}): OLAContract => ({
  id: 'c1', type: 'ola', name: 'Network restore', description: null, entityType: 'incident',
  responseMinutes: 30, resolveMinutes: 240, businessHours: false, calendarId: null, calendarName: null, timezone: null,
  complianceTarget: 99, complianceWarning: 95, partyType: 'team', partyName: null, teamId: 't1',
  teamName: 'Network', enabled: true, createdAt: '2026-09-01T00:00:00Z', ...over,
})

interface Row {
  id: string; type: string; name: string; entityType: string; partyType: string | null; partyName: string | null
  resolveMinutes: number; evaluated: number; met: number; breached: number; attainmentPct: number | null
  complianceTarget: number | null; complianceWarning: number | null; inferred: number
}
const row = (over: Partial<Row> = {}): Row => ({
  id: 'c1', type: 'ola', name: 'Network restore', entityType: 'incident', partyType: 'team', partyName: null,
  resolveMinutes: 240, evaluated: 10, met: 9, breached: 1, attainmentPct: 90,
  complianceTarget: 99, complianceWarning: 95, inferred: 0, ...over,
})

const report = (ola: Row[], windowDays = 30) => ({ slaReport: { generatedAt: '2026-09-23T08:00:00Z', windowDays, ola } })

const CONTRACTS = [
  contract(),
  contract({ id: 'c2', type: 'uc', name: 'Hosting UC', entityType: 'any', teamName: null, partyName: 'Acme Hosting', resolveMinutes: 1500 }),
  contract({ id: 'c3', name: 'Legacy desk', enabled: false, teamName: null, partyName: null, resolveMinutes: 45 }),
]

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The number shown in the tile with this label. */
const tile = (label: string) => screen.getByText(label).previousElementSibling as HTMLElement
const contractRow = (name: string) => screen.getByText(name).closest('tr') as HTMLElement
const cells = (tr: HTMLElement) => within(tr).getAllByRole('cell')

beforeEach(() => {
  apolloFinto.reset()
  stillLoading.clear()
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ name: 'incident', label: 'Disruption' }] }
  apolloFinto.risposte['GetOLAContracts'] = { olaContracts: CONTRACTS }
  apolloFinto.risposte['GetOLAReport'] = report([
    row(),
    row({ id: 'c2', type: 'uc', name: 'Hosting UC', evaluated: 4, met: 4, breached: 0, attainmentPct: 99.54, complianceTarget: 99.5, complianceWarning: 98, inferred: 1 }),
  ])
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OLA / UC Report — the window', () => {
  it('reads the last 30 days first, and reloads for the window chosen', async () => {
    const { user } = renderWithProviders(<OLAReportPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'OLA / UC Report' })).toBeInTheDocument()
    expect(apolloFinto.chiamata('GetOLAReport')).toEqual({ windowDays: 30 })
    await user.click(screen.getByRole('button', { name: '7d' }))
    expect(apolloFinto.chiamata('GetOLAReport')).toEqual({ windowDays: 7 })
    expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('who may manage the contracts finds the link to them', () => {
    apolloFinto.risposte['GetMe'] = { me: { id: 'u1', name: 'Ada', email: 'ada@example.com', role: 'admin', roleName: null, permissions: ['config.sla'], slackId: null, emailNotifications: null, language: null, teams: [] } }
    renderWithProviders(<OLAReportPage />)
    expect(screen.getByRole('link', { name: 'Manage contracts →' })).toHaveAttribute('href', '/admin/ola-uc')
  })

  it('while the report loads, a placeholder stands in for the numbers', () => {
    stillLoading.add('GetOLAReport')
    delete apolloFinto.risposte['GetOLAReport']
    renderWithProviders(<OLAReportPage />)
    expect(document.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
    expect(screen.queryByText('Active contracts')).toBeNull()
  })

  it('while a new window loads, the numbers already there stay on screen', () => {
    stillLoading.add('GetOLAReport')
    renderWithProviders(<OLAReportPage />)
    expect(document.querySelector('[data-slot="skeleton"]')).toBeNull()
    expect(tile('Active contracts')).toHaveTextContent(/^2$/)
  })

  it('a failed load says so, and Retry reloads', async () => {
    apolloFinto.erroriQuery['GetOLAReport'] = new Error('The graph did not answer')
    const { user } = renderWithProviders(<OLAReportPage />)
    expect(screen.getByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByText('The graph did not answer')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
    expect(screen.queryByText('Active contracts')).toBeNull()
  })
})

describe('OLA / UC Report — the totals', () => {
  it('count the active contracts and add up every contract\'s evaluations; attainment is met over evaluated', () => {
    renderWithProviders(<OLAReportPage />)
    // The switched-off contract is listed but not active.
    expect(tile('Active contracts')).toHaveTextContent(/^2$/)
    expect(tile('Evaluations (30d)')).toHaveTextContent(/^14$/)
    expect(tile('Met')).toHaveTextContent(/^13$/)
    expect(tile('Breached')).toHaveTextContent(/^1$/)
    expect(tile('Attainment')).toHaveTextContent(/^92\.9%$/)
  })

  it('the window in the labels is the one the report was computed on', () => {
    apolloFinto.risposte['GetOLAReport'] = report([row()], 90)
    renderWithProviders(<OLAReportPage />)
    expect(tile('Evaluations (90d)')).toHaveTextContent(/^10$/)
    expect(screen.getByRole('columnheader', { name: 'Attainment (90d)' })).toBeInTheDocument()
  })

  it('with no evaluation in the window, attainment is a dash, not 0%', () => {
    apolloFinto.risposte['GetOLAReport'] = report([row({ evaluated: 0, met: 0, breached: 0, attainmentPct: null })])
    renderWithProviders(<OLAReportPage />)
    expect(tile('Evaluations (30d)')).toHaveTextContent(/^0$/)
    expect(tile('Attainment')).toHaveTextContent(/^—$/)
  })

  it('says when it was generated, and how many evaluations were counted from the ticket\'s opening', () => {
    renderWithProviders(<OLAReportPage />)
    expect(screen.getByText(/^Generated on 23 Sept 2026, 10:00\. Each OLA\/UC contract measures/)).toBeInTheDocument()
    expect(screen.getByText('1 evaluation is counted from when the ticket was opened: the ticket is older than the assignment history.')).toBeInTheDocument()
  })

  it('names the reconstructed evaluations in the plural, and not at all when there are none', () => {
    apolloFinto.risposte['GetOLAReport'] = report([row({ inferred: 2 }), row({ id: 'c2', inferred: 1 })])
    const { unmount } = renderWithProviders(<OLAReportPage />)
    expect(screen.getByText('3 evaluations are counted from when the ticket was opened: those tickets are older than the assignment history.')).toBeInTheDocument()
    unmount()
    apolloFinto.risposte['GetOLAReport'] = report([row({ inferred: 0 })])
    renderWithProviders(<OLAReportPage />)
    expect(screen.queryByText(/counted from when the ticket was opened/)).toBeNull()
  })
})

describe('OLA / UC Report — by contract', () => {
  it('each contract shows its type, the scope as the customer names it, who answers for it and its target', () => {
    renderWithProviders(<OLAReportPage />)
    expect(screen.getByRole('table', { name: 'By contract' })).toBeInTheDocument()
    expect(cells(contractRow('Network restore')).slice(0, 5).map((c) => c.textContent)).toEqual(['OLA', 'Network restore', 'Disruption', 'Network', '4h'])
    // «any» is every ITIL type; a supplier without a team is named as the contract says.
    expect(cells(contractRow('Hosting UC')).slice(0, 5).map((c) => c.textContent)).toEqual(['UC', 'Hosting UC', 'All', 'Acme Hosting', '1d 1h'])
    expect(cells(contractRow('Legacy desk')).slice(0, 5).map((c) => c.textContent)).toEqual(['OLA', 'Legacy desk', 'Disruption', '—', '45min'])
  })

  it('attainment is coloured against the contract\'s own objective and says met out of evaluated', () => {
    renderWithProviders(<OLAReportPage />)
    const network = cells(contractRow('Network restore'))[5]!
    expect(network).toHaveTextContent('90%(9/10)')
    expect(within(network).getByText('90%')).toHaveAttribute('title', 'Green from 99%, yellow from 95%, red below')
    const hosting = cells(contractRow('Hosting UC'))[5]!
    expect(within(hosting).getByText('99.5%')).toHaveAttribute('title', 'Green from 99.5%, yellow from 98%, red below')
    expect(hosting).toHaveTextContent('(4/4)')
  })

  it('a contract without a compliance objective shows its attainment without a colour, and says why', () => {
    apolloFinto.risposte['GetOLAReport'] = report([row({ complianceTarget: null, complianceWarning: null })])
    renderWithProviders(<OLAReportPage />)
    const network = cells(contractRow('Network restore'))[5]!
    expect(within(network).getByText('90%')).toHaveAttribute('title', 'No compliance target: no colour')
    expect(within(network).getByText('90%')).toHaveStyle({ color: 'var(--color-slate)' })
  })

  it('a contract with nothing evaluated in the window says there is no data, without a 0/0', () => {
    apolloFinto.risposte['GetOLAReport'] = report([row({ evaluated: 0, met: 0, breached: 0, attainmentPct: null })])
    renderWithProviders(<OLAReportPage />)
    expect(cells(contractRow('Network restore'))[5]).toHaveTextContent(/^No data$/)
    // A contract the report does not mention at all (switched off, never measured) too.
    expect(cells(contractRow('Legacy desk'))[5]).toHaveTextContent(/^No data$/)
  })

  it('a switched-off contract is listed dimmed', () => {
    renderWithProviders(<OLAReportPage />)
    expect(within(contractRow('Legacy desk')).getByText('Legacy desk')).toHaveStyle({ opacity: '0.55' })
    expect(within(contractRow('Network restore')).getByText('Network restore')).toHaveStyle({ opacity: '1' })
  })

  it.each([
    ['no contract is defined', { olaContracts: [] }],
    ['the contracts are still loading', undefined],
  ])('when %s, it says what an OLA and a UC are instead of an empty table', (_case, answer) => {
    apolloFinto.risposte['GetOLAContracts'] = answer
    renderWithProviders(<OLAReportPage />)
    expect(screen.getByText('No OLA/UC defined. An OLA sets a target between internal teams; a UC ties it to an external supplier.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(tile('Active contracts')).toHaveTextContent(/^0$/)
  })
})
