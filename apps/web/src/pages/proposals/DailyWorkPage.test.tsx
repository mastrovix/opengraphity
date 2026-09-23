/**
 * DAILY WORK: the numbers the improvement proposals will be built on.
 *
 * The page proposes nothing: it shows the measures (how long tickets sit in
 * each step, what people do, what they always do back to back, what the AI
 * does) so that a person can look at them before any analyst does. Two
 * promises matter most:
 *  - COVERAGE COMES FIRST. Most tickets may have come in by import, with no
 *    creation entry in the log; the page says how much of the work it sees,
 *    and warns when it is under half — counts without that would lie by
 *    omission;
 *  - EVERY TABLE SHOWS ITS THRESHOLD, so that whoever reads it can say «this
 *    threshold is wrong».
 * The window (7, 30 or 90 days) is chosen by the reader and sent to the API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { DailyWorkPage } from './DailyWorkPage'

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

const aggregates = (over: Record<string, unknown> = {}, coverage: Record<string, unknown> = {}) => ({ dailyWorkAggregates: {
  coverage: { tickets: 1519, withCreationEntry: 93, entries: 400, humanEntries: 300, genericEntries: 12, unreadableActions: 0, windowDays: 30, ...coverage },
  actions: [{ object: 'incident', verb: 'assign', n: 40, distinctActors: 6, distinctObjects: 35 }],
  stepTimes: [{ stepName: 'triage', n: 50, medianHours: 12.5, p90Hours: 40, over48h: 3, discardedZeros: 2 }],
  pairs: [{ first: 'incident.assign', then: 'incident.comment', n: 12, distinctObjects: 9, distinctActors: 4 }],
  aiUsage: [{ feature: 'triage', n: 7, distinctActors: 3 }],
  thresholds: { minWindowDays: 7, minOccurrences: 5, minRunsPerStep: 5, pairMinOccurrences: 10, pairMinDistinctObjects: 5, pairMinDistinctActors: 3, pairMaxMinutes: 15 },
  ...over,
} })

/** A stat tile, found by its label: its number and its line of context. */
const tile = (label: string) => screen.getByText(label).parentElement!.parentElement!.parentElement!
const section = (title: string) => screen.getByRole('region', { name: title })
const rowsOf = (title: string) => within(section(title)).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))

beforeEach(() => {
  apolloFinto.reset()
  held.clear()
  apolloFinto.risposte['GetDailyWorkAggregates'] = aggregates()
})

describe('coverage first', () => {
  it('says how much of the work the log sees, before any other number', () => {
    renderWithProviders(<DailyWorkPage />)
    expect(tile('Tickets')).toHaveTextContent('1519')
    expect(tile('Tickets')).toHaveTextContent('the log sees 6% of them')
    expect(tile('Log entries')).toHaveTextContent('in the last 30 days')
    expect(tile('By people')).toHaveTextContent('75% of the total')
    expect(tile('Generic entries')).toHaveTextContent('they say less than the others')
  })

  it('under half, it warns that everything below speaks of that part only', () => {
    renderWithProviders(<DailyWorkPage />)
    expect(screen.getByText('The log has a creation entry for only 6% of tickets: the rest came in by import. Everything below speaks about that part.')).toBeInTheDocument()
  })

  it('from half up there is no warning', () => {
    apolloFinto.risposte['GetDailyWorkAggregates'] = aggregates({}, { tickets: 100, withCreationEntry: 50 })
    renderWithProviders(<DailyWorkPage />)
    expect(tile('Tickets')).toHaveTextContent('the log sees 50% of them')
    expect(screen.queryByText(/The log has a creation entry for only/)).toBeNull()
  })

  it('with no tickets or no entries, no percentage is made up', () => {
    apolloFinto.risposte['GetDailyWorkAggregates'] = aggregates({}, { tickets: 0, withCreationEntry: 0, entries: 0, humanEntries: 0 })
    renderWithProviders(<DailyWorkPage />)
    expect(tile('Tickets')).not.toHaveTextContent('%')
    expect(tile('By people')).not.toHaveTextContent('%')
    expect(screen.queryByText(/The log has a creation entry for only/)).toBeNull()
  })

  it('entries whose action cannot be read are counted and said, not dropped in silence', () => {
    apolloFinto.risposte['GetDailyWorkAggregates'] = aggregates({}, { unreadableActions: 3 })
    renderWithProviders(<DailyWorkPage />)
    expect(screen.getByText('3 entries have actions I cannot read: they are not in the counts.')).toBeInTheDocument()
  })

  it('when every action can be read, nothing is said about it', () => {
    renderWithProviders(<DailyWorkPage />)
    expect(screen.queryByText(/cannot read/)).toBeNull()
  })
})

describe('the tables, each with its threshold', () => {
  it('how long tickets sit in each step: median and p90 in hours, and the ones over 48 hours', () => {
    renderWithProviders(<DailyWorkPage />)
    expect(within(section('How long tickets sit')).getByText(/Only steps with at least 5 completed runs/)).toBeInTheDocument()
    expect(rowsOf('How long tickets sit')).toEqual([['triage', '50', '12.5 h', '40 h', '3']])
  })

  it('a step with tickets over 48 hours is marked in red; one without is not', () => {
    apolloFinto.risposte['GetDailyWorkAggregates'] = aggregates({ stepTimes: [
      { stepName: 'triage', n: 50, medianHours: 12.5, p90Hours: 40, over48h: 3, discardedZeros: 0 },
      { stepName: 'closing', n: 20, medianHours: 1, p90Hours: 2, over48h: 0, discardedZeros: 0 },
    ] })
    renderWithProviders(<DailyWorkPage />)
    const over48 = (step: string) => within(within(section('How long tickets sit')).getByRole('row', { name: new RegExp(step) })).getAllByRole('cell')[4]!
    expect(over48('triage').style.color).toBe('var(--color-trigger-sla-breach)')
    expect(over48('closing').style.color).toBe('')
  })

  it('what people do: the first twenty-five actions', () => {
    const actions = Array.from({ length: 30 }, (_, i) => ({ object: 'incident', verb: `verb-${i}`, n: 30 - i, distinctActors: 2, distinctObjects: 3 }))
    apolloFinto.risposte['GetDailyWorkAggregates'] = aggregates({ actions })
    renderWithProviders(<DailyWorkPage />)
    expect(within(section('What people do')).getByText(/Human actions only/)).toBeInTheDocument()
    const rows = rowsOf('What people do')
    expect(rows).toHaveLength(25)
    expect(rows[0]).toEqual(['incident', 'verb-0', '30', '2', '3'])
  })

  it('what is done back to back, with the four thresholds of the criterion', () => {
    renderWithProviders(<DailyWorkPage />)
    expect(within(section('Things always done back to back')).getByText(
      'Two actions on the same object, by the same person, within 15 minutes. At least 10 times, across 5 distinct objects, by 3 people.',
    )).toBeInTheDocument()
    expect(rowsOf('Things always done back to back')).toEqual([['incident.assign', 'incident.comment', '12', '9', '4']])
  })

  it('what the AI does, with the warning that the log only sees mutations', () => {
    renderWithProviders(<DailyWorkPage />)
    expect(within(section('AI actions the audit log can see')).getByText(/this is NOT AI feature adoption/)).toBeInTheDocument()
    expect(rowsOf('AI actions the audit log can see')).toEqual([['triage', '7', '3']])
  })

  it('an empty table is a dash; with no actions and no step times the page says there is nothing to measure yet', () => {
    apolloFinto.risposte['GetDailyWorkAggregates'] = aggregates({ actions: [], stepTimes: [], pairs: [], aiUsage: [] })
    renderWithProviders(<DailyWorkPage />)
    for (const title of ['How long tickets sit', 'What people do', 'Things always done back to back', 'AI actions the audit log can see']) {
      expect(within(section(title)).queryByRole('table')).toBeNull()
      expect(within(section(title)).getByText('—')).toBeInTheDocument()
    }
    expect(screen.getByText('Nothing to measure yet')).toBeInTheDocument()
    expect(screen.getByText('In the last 30 days the log has no human work to aggregate.')).toBeInTheDocument()
  })

  it('with actions but no step times there is still something to read', () => {
    apolloFinto.risposte['GetDailyWorkAggregates'] = aggregates({ stepTimes: [] })
    renderWithProviders(<DailyWorkPage />)
    expect(screen.queryByText('Nothing to measure yet')).toBeNull()
  })
})

describe('the window', () => {
  it('is thirty days at first, and the reader\'s choice is what the API receives', async () => {
    const { user } = renderWithProviders(<DailyWorkPage />)
    const group = screen.getByRole('radiogroup', { name: 'Window' })
    expect(within(group).getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'true')
    expect(apolloFinto.chiamata('GetDailyWorkAggregates')).toEqual({ windowDays: 30 })
    await user.click(within(group).getByRole('radio', { name: '7 days' }))
    expect(within(group).getByRole('radio', { name: '7 days' })).toHaveAttribute('aria-checked', 'true')
    expect(within(group).getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'false')
    expect(apolloFinto.chiamata('GetDailyWorkAggregates')).toEqual({ windowDays: 7 })
    await user.click(within(group).getByRole('radio', { name: '90 days' }))
    expect(apolloFinto.chiamata('GetDailyWorkAggregates')).toEqual({ windowDays: 90 })
  })
})

describe('loading and errors', () => {
  it('while the numbers load it says so', () => {
    held.add('GetDailyWorkAggregates')
    renderWithProviders(<DailyWorkPage />)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('numbers that cannot be loaded show the error, and Retry reloads them', async () => {
    apolloFinto.erroriQuery['GetDailyWorkAggregates'] = new Error('aggregates unavailable')
    const { user } = renderWithProviders(<DailyWorkPage />)
    expect(screen.getByText('aggregates unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Loading...')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })
})
