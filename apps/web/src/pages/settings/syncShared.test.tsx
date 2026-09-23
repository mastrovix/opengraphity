/**
 * WHAT EVERY CMDB SYNC TAB SHOWS THE SAME WAY: durations, run statuses and
 * the four numbers at the top of the page.
 *
 * An administrator reads these to decide whether a sync source is healthy.
 * If they regress, a two-minute run reads «120000ms», a status stays in the
 * connector's own words in an Italian page, a status nobody translated
 * disappears instead of showing, or a 97% success rate reads «0.97%».
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import i18n from '@/i18n/i18n'
import { formatMs, StatusBadge, StatsBar } from './syncShared'

afterEach(async () => { await i18n.changeLanguage('en') })

describe('formatMs', () => {
  it('no duration is a dash; below a second in ms, below a minute in seconds, then in minutes', () => {
    expect(formatMs(null)).toBe('—')
    expect(formatMs(0)).toBe('0ms')
    expect(formatMs(999)).toBe('999ms')
    expect(formatMs(1000)).toBe('1.0s')
    expect(formatMs(59_900)).toBe('59.9s')
    expect(formatMs(60_000)).toBe('1.0m')
    expect(formatMs(150_000)).toBe('2.5m')
  })
})

describe('StatusBadge', () => {
  it('a known status is read in the language of the interface', async () => {
    await i18n.changeLanguage('it')
    const { rerender } = render(<StatusBadge status="failed" />)
    expect(screen.getByText('fallita')).toBeInTheDocument()
    rerender(<StatusBadge status="running" />)
    expect(screen.getByText('in corso')).toBeInTheDocument()
    rerender(<StatusBadge status="resolved" />)
    expect(screen.getByText('risolto')).toBeInTheDocument()
  })

  it('a status the page does not know is shown as it came, and reported instead of hidden', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<StatusBadge status="partially_synced" />)
    expect(screen.getByText('partially_synced')).toBeInTheDocument()
    expect(logged).toHaveBeenCalledWith('[StatusBadge:cfg] unknown value: "partially_synced"')
  })
})

describe('StatsBar', () => {
  it('shows enabled over total sources, the managed CIs, the open conflicts and the success rate in percent', () => {
    render(<StatsBar stats={{
      totalSources: 3, enabledSources: 2, lastSyncAt: '2026-09-20T08:00:00Z',
      ciManaged: 1250, openConflicts: 4, totalRuns: 30, successRate: 0.966,
    }} />)
    // Each number sits in the same tile as its name.
    const tile = (label: string) => screen.getByText(label).parentElement!
    expect(tile('Sources')).toHaveTextContent('2/3')
    expect(tile('CIs managed')).toHaveTextContent('1250')
    expect(tile('Open conflicts')).toHaveTextContent('4')
    expect(tile('Success rate')).toHaveTextContent('97%')
  })
})
