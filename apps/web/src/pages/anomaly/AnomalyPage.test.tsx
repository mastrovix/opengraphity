/**
 * The anomaly page is where a CMDB owner learns whether the graph is healthy,
 * and where they close what the scanner found. What must not regress:
 *
 * - An empty table must say WHY it is empty. "Never scanned", "healthy since
 *   the last scan", "nothing matches your filter" and "the query failed" are
 *   four different answers; showing "healthy" for the last two would tell an
 *   owner there is nothing to do when there is.
 * - The scanner is an async job: the page waits until the scan counter moves
 *   past the value read before starting, and says so when it does not
 *   (timeout, broken contract, error) instead of spinning forever.
 * - Resolving an anomaly sends the chosen outcome and note, closes the panel,
 *   and on failure says what did not work inside the panel.
 * - Sort, filter and paging go to the server; the page never stays on a page
 *   that no longer exists after the list shrinks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within, act } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { inFlight, resetInFlight } from '@/test/apolloInFlight'
import type { Anomaly } from '@/types/anomaly'
import { AnomalyPage, AnomalyStatusBadge } from './AnomalyPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloInFlight')).apolloModuleWithInFlight())

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
  Toaster: () => null,
}))

function anomaly(over: Partial<Anomaly> = {}): Anomaly {
  return {
    id: 'a1', ruleKey: 'orphan_ci', title: 'Orphan CI', severity: 'high', status: 'open',
    entityId: 'ci1', entityType: 'CI', entitySubtype: 'server', entityName: 'web-01',
    description: 'The CI has no relation', descriptionParams: [],
    detectedAt: '2026-09-01T10:00:00Z', resolvedAt: null, resolutionStatus: null,
    resolutionNote: null, resolvedBy: null, resolvedByName: null, resolvedReason: null,
    ...over,
  }
}

const stats = { total: 5, open: 3, critical: 1, high: 1, medium: 1, low: 0, falsePositive: 0, acceptedRisk: 0 }

/** The shared `refetch` of the fake answers every refetch; scans read `totalScans` from it. */
function scanCounter(values: number[]) {
  let i = 0
  apolloFinto.refetch.mockImplementation(async () => {
    const totalScans = values[Math.min(i, values.length - 1)]
    i++
    return { data: { anomalyScanStatus: { lastScanAt: null, totalScans } } }
  })
}

type Opts = { items?: Anomaly[]; total?: number; permissions?: string[]; lastScanAt?: string | null }

/** The answers of the four queries the page reads. */
function answer(opts: Opts = {}) {
  const items = opts.items ?? [anomaly()]
  apolloFinto.risposte['GetMe'] = { me: { id: 'u1', permissions: opts.permissions ?? [] } }
  apolloFinto.risposte['GetAnomalyStats'] = { anomalyStats: stats }
  apolloFinto.risposte['GetAnomalyScanStatus'] = { anomalyScanStatus: { lastScanAt: opts.lastScanAt ?? null, totalScans: 3 } }
  apolloFinto.risposte['GetAnomalies'] = { anomalies: { items, total: opts.total ?? items.length } }
}

function setup(opts: Opts = {}) {
  answer(opts)
  return renderWithProviders(<AnomalyPage />)
}

beforeEach(() => {
  apolloFinto.reset()
  resetInFlight()
  apolloFinto.refetch.mockImplementation(async () => ({ data: {} }))
  toastSuccess.mockClear()
  toastError.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AnomalyPage — what the list says', () => {
  it('shows the count, the stats tiles and the rows with the metamodel type label', async () => {
    const long = 'x'.repeat(80)
    setup({ items: [anomaly(), anomaly({ id: 'a2', ruleKey: 'custom_rule', title: 'Custom title', description: long, descriptionParams: null, entitySubtype: '', entityType: 'Thing', status: 'resolved' })] })
    expect(screen.getByText('2 anomalies')).toBeInTheDocument()
    expect(screen.getByText('Orphan CI')).toBeInTheDocument()
    // The type label comes from the metamodel, not the internal name.
    expect(screen.getByText('Server')).toBeInTheDocument()
    // An empty subtype falls back to the entity type instead of a blank line.
    expect(screen.getByText('Thing')).toBeInTheDocument()
    // Long descriptions are cut in the table so rows keep one height.
    expect(screen.getByText('x'.repeat(61) + '…')).toBeInTheDocument()
    expect(screen.getByText('Custom title')).toBeInTheDocument()
    expect(screen.getAllByText('Resolved').length).toBeGreaterThan(0)
    // No false-positive/accepted-risk line when both are zero.
    expect(screen.queryByText(/false positive/)).not.toBeInTheDocument()
  })

  it('describes each row in the viewer language from the params, old forbidden-relation rows included', () => {
    setup({ items: [
      anomaly({ id: 'n', ruleKey: 'unauthorized_relation', descriptionParams: [{ key: 'relation', value: 'RUNS_ON' }, { key: 'target', value: 'db' }] }),
      // Before wave 5 the parameter was `application` and there was no `target`.
      anomaly({ id: 'o', ruleKey: 'unauthorized_relation', descriptionParams: [{ key: 'application', value: 'CRM' }] }),
    ] })
    expect(screen.getByText('Forbidden relation RUNS_ON towards db')).toBeInTheDocument()
    expect(screen.getByText('Reversed DEPENDS_ON: Server → Application (CRM)')).toBeInTheDocument()
  })

  it('adds the false-positive and accepted-risk summary only for non-zero counts', () => {
    answer()
    apolloFinto.risposte['GetAnomalyStats'] = { anomalyStats: { ...stats, falsePositive: 2, acceptedRisk: 1 } }
    const { unmount } = renderWithProviders(<AnomalyPage />)
    expect(screen.getByText('2 false positives · 1 accepted risk')).toBeInTheDocument()
    unmount()
    apolloFinto.risposte['GetAnomalyStats'] = { anomalyStats: { ...stats, falsePositive: 0, acceptedRisk: 4 } }
    renderWithProviders(<AnomalyPage />)
    expect(screen.getByText('4 accepted risks')).toBeInTheDocument()
  })

  it('never-scanned CMDB says so, rather than claiming it is healthy', () => {
    setup({ items: [], lastScanAt: null })
    expect(screen.getByText('Scanner not yet run')).toBeInTheDocument()
    expect(screen.queryByText('No anomalies detected')).not.toBeInTheDocument()
  })

  it('a scanned CMDB with no anomalies is healthy, with the date of the last scan', () => {
    setup({ items: [], lastScanAt: '2026-09-01T10:00:00Z' })
    expect(screen.getByText('No anomalies detected')).toBeInTheDocument()
    expect(screen.getByText(/The CMDB graph is healthy\. Last scan:/)).toBeInTheDocument()
  })

  it('a failed query shows the error with a retry, not a healthy CMDB', async () => {
    answer()
    apolloFinto.erroriQuery['GetAnomalies'] = new Error('boom')
    const { user } = renderWithProviders(<AnomalyPage />)
    expect(screen.getAllByText(/boom/).length).toBeGreaterThan(0)
    expect(screen.queryByText('No anomalies detected')).not.toBeInTheDocument()
    apolloFinto.refetch.mockClear()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('offers "Configure rules" only to who may configure monitoring', () => {
    const { unmount } = setup({ permissions: [] })
    expect(screen.queryByRole('link', { name: /Configure rules/ })).not.toBeInTheDocument()
    unmount()
    setup({ permissions: ['config.monitoring'] })
    expect(screen.getByRole('link', { name: /Configure rules/ })).toHaveAttribute('href', '/settings/anomaly-rules')
  })

  it('an out-of-vocabulary status is shown loudly, not as a plausible grey', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderWithProviders(<AnomalyStatusBadge value="weird" />)
    expect(screen.getByText('?weird')).toBeInTheDocument()
    expect(err).toHaveBeenCalled()
  })
})

describe('AnomalyPage — server-side sort, filter and paging', () => {
  it('sorting asks the server for that field and direction', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: /^Severity/ }))
    await waitFor(() => expect(apolloFinto.chiamata('GetAnomalies')).toMatchObject({ sortField: 'severity', offset: 0 }))
  })

  it('an applied filter goes to the server, and an empty result blames the filter', async () => {
    const { user } = setup()
    apolloFinto.risposte['GetAnomalies'] = (v?: Record<string, unknown>) =>
      v?.['filters'] ? { anomalies: { items: [], total: 0 } } : { anomalies: { items: [anomaly()], total: 1 } }
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), 'title')
    await user.type(screen.getByPlaceholderText('Value…'), 'web')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(await screen.findByText('No anomaly matches the filters')).toBeInTheDocument()
    const filters = JSON.parse(String(apolloFinto.chiamata('GetAnomalies')?.['filters'])) as { rules: Array<{ field: string }> }
    expect(filters.rules[0]?.field).toBe('title')
    // Not the "never scanned" message: the emptiness belongs to the filter.
    expect(screen.queryByText('Scanner not yet run')).not.toBeInTheDocument()
  })

  it('pages forward and back with the right offset', async () => {
    const { user } = setup({ total: 25 })
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await waitFor(() => expect(apolloFinto.chiamata('GetAnomalies')).toMatchObject({ offset: 10, limit: 10 }))
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    await waitFor(() => expect(apolloFinto.chiamata('GetAnomalies')).toMatchObject({ offset: 0 }))
  })

  /*
   * Owner, 24 Sep 2026: «la paginazione non sembra funzionare». While page 2
   * loaded there was no data for it, the total read 0, and the clamp below
   * took «page 2 of 1» for a list that had shrunk: back to page 1 at once.
   * The fake answers at once, so the earlier test never saw the wait.
   */
  it('Next moves even while the next page is still loading: the pager keeps the last total', async () => {
    const { user } = setup({ total: 77 })
    apolloFinto.precedenti['GetAnomalies'] = { anomalies: { items: [anomaly()], total: 77 } }
    inFlight.add('GetAnomalies')
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(screen.getByText('2 / 8')).toBeInTheDocument()
    expect(apolloFinto.chiamata('GetAnomalies')).toMatchObject({ offset: 10 })
    inFlight.delete('GetAnomalies')
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await waitFor(() => expect(apolloFinto.chiamata('GetAnomalies')).toMatchObject({ offset: 20 }))
    expect(screen.getByText('3 / 8')).toBeInTheDocument()
  })

  it('when the list shrinks under the current page, it moves back to the last page that exists', async () => {
    let total = 25
    apolloFinto.risposte['GetMe'] = { me: { id: 'u1', permissions: [] } }
    apolloFinto.risposte['GetAnomalyStats'] = { anomalyStats: stats }
    apolloFinto.risposte['GetAnomalyScanStatus'] = { anomalyScanStatus: { lastScanAt: null, totalScans: 0 } }
    apolloFinto.risposte['GetAnomalies'] = () => ({ anomalies: { items: [anomaly()], total } })
    const { user } = renderWithProviders(<AnomalyPage />)
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await waitFor(() => expect(apolloFinto.chiamata('GetAnomalies')).toMatchObject({ offset: 20 }))
    total = 15
    // Opening a row re-renders without touching the page (sorting would reset
    // it to the first): only the clamp can move it from 3 to 2.
    await user.click(screen.getByText('web-01'))
    await waitFor(() => expect(screen.getByText('2 / 2')).toBeInTheDocument())
    expect(apolloFinto.chiamata('GetAnomalies')).toMatchObject({ offset: 10 })
  })
})

describe('AnomalyPage — resolving from the detail panel', () => {
  async function openAndFill(user: ReturnType<typeof setup>['user']) {
    await user.click(screen.getByText('web-01'))
    const panel = screen.getByRole('dialog')
    await user.click(within(panel).getByRole('button', { name: 'Resolve anomaly' }))
    await user.selectOptions(within(panel).getByRole('combobox'), 'false_positive')
    await user.type(within(panel).getByRole('textbox'), 'Decommissioned host')
    await user.click(within(panel).getByRole('button', { name: 'Confirm resolution' }))
  }

  it('sends outcome and note, refreshes and closes the panel', async () => {
    const { user } = setup()
    apolloFinto.esiti['ResolveAnomaly'] = { data: { resolveAnomaly: { id: 'a1' } } }
    await openAndFill(user)
    expect(apolloFinto.chiamata('ResolveAnomaly')).toEqual({ id: 'a1', resolutionStatus: 'false_positive', note: 'Decommissioned host' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a failed resolution keeps the panel open and says what did not work', async () => {
    const { user } = setup()
    apolloFinto.esiti['ResolveAnomaly'] = { error: new Error('forbidden') }
    await openAndFill(user)
    expect(await screen.findByText('Error during resolution. Please retry.')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // Closing the panel clears the error, so the next anomaly does not inherit it.
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByText('web-01'))
    expect(screen.queryByText('Error during resolution. Please retry.')).not.toBeInTheDocument()
  })

  it('an anomaly no longer in the list is shown as stale, without a Resolve button', async () => {
    let items = [anomaly()]
    apolloFinto.risposte['GetMe'] = { me: { id: 'u1', permissions: [] } }
    apolloFinto.risposte['GetAnomalyStats'] = { anomalyStats: stats }
    apolloFinto.risposte['GetAnomalyScanStatus'] = { anomalyScanStatus: { lastScanAt: null, totalScans: 0 } }
    apolloFinto.risposte['GetAnomalies'] = () => ({ anomalies: { items, total: 1 } })
    const { user } = renderWithProviders(<AnomalyPage />)
    await user.click(screen.getByText('web-01'))
    items = [anomaly({ id: 'other', entityName: 'db-02' })]
    // Re-render through a sort so the page reads the new answer.
    await user.click(screen.getByRole('button', { name: /^Status/ }))
    expect(await screen.findByText(/no longer in the list/)).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Resolve anomaly' })).not.toBeInTheDocument()
  })
})

describe('AnomalyPage — running the scanner', () => {
  it('waits for the scan counter to move, then refreshes and says the scan completed', async () => {
    const { user } = setup()
    scanCounter([3, 3, 4])
    apolloFinto.esiti['RunAnomalyScanner'] = { data: { runAnomalyScanner: true } }
    const button = screen.getByRole('button', { name: 'Run Scanner' })
    await user.click(button)
    // While waiting the button cannot start a second scan.
    await waitFor(() => expect(button).toBeDisabled())
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Scan completed'), { timeout: 8000 })
    expect(button).toBeEnabled()
  })

  it('says the scan did not finish in time instead of waiting forever', async () => {
    const { user } = setup()
    scanCounter([3])
    apolloFinto.esiti['RunAnomalyScanner'] = { data: { runAnomalyScanner: true } }
    await user.click(screen.getByRole('button', { name: 'Run Scanner' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run Scanner' })).toBeDisabled())
    // Move the clock past the timeout; the next poll must give up and say so.
    const realNow = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 200_000)
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Scan not completed within 120s')), { timeout: 8000 })
    expect(screen.getByRole('button', { name: 'Run Scanner' })).toBeEnabled()
  })

  it('a poll that fails stops waiting and shows the error', async () => {
    const { user } = setup()
    let calls = 0
    apolloFinto.refetch.mockImplementation(async () => {
      calls++
      if (calls > 1) throw new Error('scan status down')
      return { data: { anomalyScanStatus: { lastScanAt: null, totalScans: 3 } } }
    })
    apolloFinto.esiti['RunAnomalyScanner'] = { data: { runAnomalyScanner: true } }
    await user.click(screen.getByRole('button', { name: 'Run Scanner' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('scan status down'), { timeout: 8000 })
    expect(screen.getByRole('button', { name: 'Run Scanner' })).toBeEnabled()
  })

  it('a poll answering after the page is gone does nothing', async () => {
    const { user, unmount } = setup()
    let release: (v: unknown) => void = () => {}
    let calls = 0
    apolloFinto.refetch.mockImplementation(async () => {
      calls++
      if (calls === 1) return { data: { anomalyScanStatus: { lastScanAt: null, totalScans: 3 } } }
      return new Promise<{ data: object }>((r) => { release = (v) => r(v as { data: object }) })
    })
    apolloFinto.esiti['RunAnomalyScanner'] = { data: { runAnomalyScanner: true } }
    await user.click(screen.getByRole('button', { name: 'Run Scanner' }))
    await waitFor(() => expect(calls).toBe(2), { timeout: 8000 })
    unmount()
    await act(async () => { release({ data: { anomalyScanStatus: { lastScanAt: null, totalScans: 9 } } }) })
    // No "completed" toast for a page nobody is looking at.
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('a failing poll after the page is gone is not shown either', async () => {
    const { user, unmount } = setup()
    let fail: (e: Error) => void = () => {}
    let calls = 0
    apolloFinto.refetch.mockImplementation(async () => {
      calls++
      if (calls === 1) return { data: { anomalyScanStatus: { lastScanAt: null, totalScans: 3 } } }
      return new Promise((_r, rej) => { fail = rej })
    })
    apolloFinto.esiti['RunAnomalyScanner'] = { data: { runAnomalyScanner: true } }
    await user.click(screen.getByRole('button', { name: 'Run Scanner' }))
    await waitFor(() => expect(calls).toBe(2), { timeout: 8000 })
    unmount()
    await act(async () => { fail(new Error('late failure')) })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('an answer without data is a broken contract, and is said, not waited on', async () => {
    const { user } = setup()
    scanCounter([3])
    apolloFinto.esiti['RunAnomalyScanner'] = { data: {} }
    await user.click(screen.getByRole('button', { name: 'Run Scanner' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Unable to start the scan: job queue unavailable.'))
    expect(screen.getByRole('button', { name: 'Run Scanner' })).toBeEnabled()
  })

  it('an enqueue error is shown', async () => {
    const { user } = setup()
    scanCounter([3])
    apolloFinto.esiti['RunAnomalyScanner'] = { error: new Error('redis down') }
    await user.click(screen.getByRole('button', { name: 'Run Scanner' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('redis down'))
  })
})
