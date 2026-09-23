/**
 * THE LOGS PAGE: the application log, newest first, for whoever audits it.
 *
 * Each line shows its time, level, module and message, plus a one-line summary
 * of its `data` so that a hundred «HTTP request» lines can be told apart; a
 * line with data opens to show it in full. Filters, sorting and paging happen
 * on the server, fifty lines at a time, and «Auto-refresh» reloads every ten
 * seconds.
 *
 * What must not regress: `data` is free text from the API, so a value that is
 * not JSON must be shown raw with a badge, never break the page (E-07); a
 * filter the server refuses must show its error instead of an empty page
 * (F-11); the list is a window on the most recent lines and must say so when
 * the archive goes further back; and auto-refresh must stop when turned off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, within, act } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { formatDateTime } from '@/lib/datetime'
import { LogsPage } from './LogsPage'

// The shared fake answers at once: a query named in `held` stays in flight.
const held = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { nomeOperazione, moduloApollo } = await import('@/test/apolloFinto')
  const m = moduloApollo()
  type Doc = Parameters<typeof m.useQuery>[0]
  type Opts = Parameters<typeof m.useQuery>[1]
  return {
    ...m,
    useQuery: (doc: Doc, opts?: Opts) => {
      const r = m.useQuery(doc, opts)
      return held.has(nomeOperazione(doc)) ? { ...r, data: undefined, loading: true } : r
    },
  }
})

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'l1', timestamp: '2026-09-22T14:05:00Z', level: 'info', module: 'http', message: 'HTTP request',
  data: '{"method":"POST","url":"/graphql","status":200}', ...over,
})

const logs = (entries: unknown[], over: Record<string, unknown> = {}) =>
  ({ logs: { entries, total: entries.length, truncated: false, windowSize: 5000, ...over } })

const rowOf = (text: string) => screen.getByText(text).closest('tr') as HTMLTableRowElement

beforeEach(() => {
  apolloFinto.reset()
  held.clear()
  apolloFinto.risposte['GetLogs'] = logs([entry()])
})

afterEach(() => { vi.useRealTimers() })

describe('the lines', () => {
  it('each line shows time, level, module and message, with a summary of its data', () => {
    apolloFinto.risposte['GetLogs'] = logs([
      entry(),
      entry({ id: 'l2', level: 'warn', module: null, message: 'Slow query', data: null }),
    ])
    renderWithProviders(<LogsPage />)
    expect(screen.getByText('2 logs')).toBeInTheDocument()
    const first = within(rowOf('HTTP request')).getAllByRole('cell').map((c) => c.textContent)
    expect(first).toEqual([
      formatDateTime('2026-09-22T14:05:00Z'), 'INFO', 'http', 'HTTP requestmethod=POST · url=/graphql · status=200',
    ])
    const second = within(rowOf('Slow query')).getAllByRole('cell').map((c) => c.textContent)
    // No module: a dash. No data: no summary.
    expect(second.slice(1)).toEqual(['WARN', '—', 'Slow query'])
  })

  it('the summary takes the first three plain values, cut at forty characters, and skips nested ones', () => {
    apolloFinto.risposte['GetLogs'] = logs([entry({
      data: JSON.stringify({ user: { id: 7 }, method: 'GET', path: `/api/${'x'.repeat(60)}`, ok: true, extra: 'not shown' }),
    })])
    renderWithProviders(<LogsPage />)
    expect(screen.getByText(`method=GET · path=/api/${'x'.repeat(35)} · ok=true`)).toBeInTheDocument()
  })

  it('data that is not an object with plain values gets no summary', () => {
    apolloFinto.risposte['GetLogs'] = logs([
      entry({ id: 'a', message: 'An array', data: '[1,2,3]' }),
      entry({ id: 'b', message: 'A null', data: 'null' }),
      entry({ id: 'c', message: 'Not JSON', data: 'plain text payload' }),
      entry({ id: 'd', message: 'Only nested', data: '{"user":{"id":1}}' }),
    ])
    renderWithProviders(<LogsPage />)
    for (const message of ['An array', 'A null', 'Not JSON', 'Only nested']) {
      expect(within(rowOf(message)).getAllByRole('cell')[3]).toHaveTextContent(new RegExp(`^${message}$`))
    }
  })

  it('every level has its badge; an unknown level is shown anyway, and reported', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    apolloFinto.risposte['GetLogs'] = logs(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'notice']
      .map((level, i) => entry({ id: `l${i}`, level, message: `line ${level}` })))
    renderWithProviders(<LogsPage />)
    for (const level of ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'NOTICE']) {
      expect(screen.getByText(level)).toBeInTheDocument()
    }
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith('[LEVEL_STYLES] unknown value: "notice"')
  })

  it('a line with data opens to show it in full, and closes on a second click', async () => {
    const { user } = renderWithProviders(<LogsPage />)
    await user.click(screen.getByText('HTTP request'))
    const pre = document.querySelector('pre')!
    expect(pre.textContent).toBe(JSON.stringify({ method: 'POST', url: '/graphql', status: 200 }, null, 2))
    await user.click(screen.getByText('HTTP request'))
    expect(document.querySelector('pre')).toBeNull()
  })

  it('data that is not JSON is shown raw with a badge instead of breaking the page (E-07)', async () => {
    apolloFinto.risposte['GetLogs'] = logs([entry({ data: 'upstream said <html>502</html>' })])
    const { user } = renderWithProviders(<LogsPage />)
    await user.click(screen.getByText('HTTP request'))
    expect(screen.getByText('Not JSON — raw value')).toBeInTheDocument()
    expect(document.querySelector('pre')!.textContent).toBe('upstream said <html>502</html>')
  })

  it('a line without data, or with an empty object, does not open', async () => {
    apolloFinto.risposte['GetLogs'] = logs([
      entry({ id: 'a', message: 'No data', data: null }),
      entry({ id: 'b', message: 'Empty data', data: '{}' }),
    ])
    const { user } = renderWithProviders(<LogsPage />)
    await user.click(screen.getByText('No data'))
    await user.click(screen.getByText('Empty data'))
    expect(document.querySelector('pre')).toBeNull()
  })
})

describe('what is asked of the server', () => {
  it('the first fifty lines, newest first, with no filter', () => {
    renderWithProviders(<LogsPage />)
    expect(apolloFinto.chiamata('GetLogs')).toEqual({ limit: 50, offset: 0, filters: null, sortField: 'timestamp', sortDirection: 'desc' })
  })

  it('pages through fifty lines at a time', async () => {
    apolloFinto.risposte['GetLogs'] = logs([entry()], { total: 120 })
    const { user } = renderWithProviders(<LogsPage />)
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(apolloFinto.chiamata('GetLogs')).toMatchObject({ offset: 50 })
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    expect(apolloFinto.chiamata('GetLogs')).toMatchObject({ offset: 0 })
  })

  it('sorting by a column asks again from the first page', async () => {
    apolloFinto.risposte['GetLogs'] = logs([entry()], { total: 120 })
    const { user } = renderWithProviders(<LogsPage />)
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.click(within(screen.getByRole('columnheader', { name: /Level/ })).getByRole('button'))
    expect(apolloFinto.chiamata('GetLogs')).toMatchObject({ offset: 0, sortField: 'level', sortDirection: 'asc' })
  })

  it('a filter goes to the server and restarts from the first page; levels are offered as the logger writes them', async () => {
    apolloFinto.risposte['GetLogs'] = logs([entry()], { total: 120 })
    const { user } = renderWithProviders(<LogsPage />)
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    const fieldSelect = screen.getByRole('combobox', { name: 'Field of condition 1' })
    expect(within(fieldSelect).getAllByRole('option').map((o) => o.textContent)).toEqual(['Select field...', 'Message', 'Level', 'Module', 'Date'])
    await user.selectOptions(fieldSelect, 'module')
    expect(within(screen.getByRole('combobox', { name: 'Value of condition 1' })).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['Select', 'HTTP', 'GraphQL', 'Auth', 'Workflow', 'Notification', 'Frontend'])
    await user.selectOptions(fieldSelect, 'level')
    expect(within(screen.getByRole('combobox', { name: 'Value of condition 1' })).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['Select', 'Trace', 'Debug', 'Info', 'Warn', 'Error', 'Fatal'])
    await user.selectOptions(screen.getByRole('combobox', { name: 'Value of condition 1' }), 'error')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    const vars = apolloFinto.chiamata('GetLogs') as { offset: number; filters: string }
    expect(vars.offset).toBe(0)
    expect(JSON.parse(vars.filters).rules).toEqual([expect.objectContaining({ field: 'level', operator: 'equals', value: 'error' })])
  })

  it('a filter the server refuses shows its error, with a retry (F-11)', async () => {
    apolloFinto.erroriQuery['GetLogs'] = new Error('invalid filter: timestamp')
    const { user } = renderWithProviders(<LogsPage />)
    expect(screen.getByText('invalid filter: timestamp')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })
})

describe('the header and the controls', () => {
  it('no lines: says there are no results', () => {
    apolloFinto.risposte['GetLogs'] = logs([])
    renderWithProviders(<LogsPage />)
    expect(screen.getAllByText('No results').length).toBeGreaterThan(0)
  })

  it('while loading the count is a dash, and the window notice waits', () => {
    held.add('GetLogs')
    renderWithProviders(<LogsPage />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText(/Showing the most recent/)).toBeNull()
  })

  it('when the archive goes further back than the window, it says the filters only see the window', () => {
    apolloFinto.risposte['GetLogs'] = logs([entry()], { truncated: true, windowSize: 5000 })
    renderWithProviders(<LogsPage />)
    expect(screen.getByText('Showing the most recent 5000 lines: the archive goes further back, and the filters do not reach there.')).toBeInTheDocument()
  })

  it('Refresh reloads the lines', async () => {
    const { user } = renderWithProviders(<LogsPage />)
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })

  it('auto-refresh reloads every ten seconds, and stops when turned off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { user } = renderWithProviders(<LogsPage />)
    const toggle = screen.getByRole('checkbox', { name: 'Auto-refresh 10s' })
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
    await user.click(toggle)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(3)
    await user.click(toggle)
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(3)
  })
})
