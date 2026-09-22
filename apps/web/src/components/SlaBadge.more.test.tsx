/**
 * The SLA pill is how an agent decides which ticket to pick up next in a list.
 * If the state order regressed (a met SLA shown as overdue, a paused one still
 * counting down, a breached one shown as "on track") the agent works the wrong
 * queue; if the countdown stopped refreshing, the pill would lie after a few
 * minutes on screen. These tests pin each state and the live refresh.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, act } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { SlaBadge, type SlaStatusInfo } from './SlaBadge'

const base = (over: Partial<SlaStatusInfo> = {}): SlaStatusInfo => {
  const now = Date.now()
  return {
    startedAt: new Date(now - 3_600_000).toISOString(),
    responseDeadline: new Date(now + 45 * 60_000 + 20_000).toISOString(),
    resolveDeadline: new Date(now + 10 * 3_600_000).toISOString(),
    responseMet: false, resolveMet: false, breached: false, pausedAt: null, warningMinutes: 5,
    ...over,
  }
}

afterEach(() => { vi.useRealTimers() })

describe('SlaBadge — states', () => {
  it('no SLA: nothing in a detail page, a dash in a compact list cell', () => {
    const { unmount } = renderWithProviders(<SlaBadge sla={null} />)
    expect(screen.queryByText('—')).toBeNull()
    expect(screen.queryByText(/SLA|left|Overdue/)).toBeNull()
    unmount()
    renderWithProviders(<SlaBadge sla={undefined} compact />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('resolution met wins over everything else, even a breached flag', () => {
    renderWithProviders(<SlaBadge sla={base({ resolveMet: true, breached: true, pausedAt: '2026-01-01T00:00:00Z' })} />)
    expect(screen.getByText('SLA met')).toBeInTheDocument()
  })

  it('a paused SLA shows paused, not a countdown or a breach', () => {
    renderWithProviders(<SlaBadge sla={base({ pausedAt: '2026-01-01T00:00:00Z', breached: true })} />)
    expect(screen.getByText('SLA paused')).toBeInTheDocument()
  })

  it('a breach marked by the scheduler is shown as breached', () => {
    renderWithProviders(<SlaBadge sla={base({ breached: true })} compact />)
    expect(screen.getByText('SLA breached')).toBeInTheDocument()
  })

  it('before the response, the countdown targets the response deadline (minutes)', () => {
    renderWithProviders(<SlaBadge sla={base()} />)
    // 45 minutes to the response, not the 10 hours to the resolution.
    expect(screen.getByText(/45 min left/)).toBeInTheDocument()
  })

  it('past the deadline without a scheduler breach: overdue, with the elapsed time', () => {
    const now = Date.now()
    renderWithProviders(<SlaBadge sla={base({ responseDeadline: new Date(now - 2 * 3_600_000 - 5 * 60_000 - 10_000).toISOString() })} />)
    expect(screen.getByText(/Overdue by 2 h 5 min/)).toBeInTheDocument()
  })

  it('the tooltip carries both deadlines', () => {
    renderWithProviders(<SlaBadge sla={base()} />)
    const title = screen.getByText(/left/).getAttribute('title') ?? ''
    expect(title).toMatch(/Response: .* · Resolution: /)
  })
})

describe('SlaBadge — live countdown', () => {
  it('refreshes every 30 seconds so the pill turns overdue without a reload', () => {
    vi.useFakeTimers()
    const now = Date.now()
    renderWithProviders(<SlaBadge sla={base({ responseDeadline: new Date(now + 20_000).toISOString() })} />)
    expect(screen.getByText(/0 min left/)).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(screen.getByText(/Overdue by 0 min/)).toBeInTheDocument()
  })
})
