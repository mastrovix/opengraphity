/**
 * The deploy plan of one CI, read-only: the reviewer must see each step in
 * order with its validation and deploy windows, and an explicit "no planned
 * step" instead of an empty dialog when nothing was planned.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PlanModal } from './PlanModal'
import { formatDateTime } from '@/lib/datetime'

const STEPS = [
  { title: 'Stop service', validationWindow: { start: '2026-09-20T08:00:00Z', end: '2026-09-20T09:00:00Z' }, releaseWindow: { start: '2026-09-21T08:00:00Z', end: '2026-09-21T10:00:00Z' } },
  { title: 'Migrate DB', validationWindow: { start: '2026-09-22T08:00:00Z', end: '2026-09-22T09:00:00Z' }, releaseWindow: { start: '2026-09-23T08:00:00Z', end: '2026-09-23T10:00:00Z' } },
]

describe('PlanModal', () => {
  it('lists the steps in order with both windows', () => {
    render(<PlanModal steps={STEPS} ciName="db-01" onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Deploy plan — db-01' })).toBeInTheDocument()
    expect(screen.getByText('Step 1: Stop service')).toBeInTheDocument()
    expect(screen.getByText('Step 2: Migrate DB')).toBeInTheDocument()
    // Windows are shown in the reader's locale, the same formatter as the rest of the app.
    expect(screen.getByText(`Validation: ${formatDateTime(STEPS[0]!.validationWindow.start)} → ${formatDateTime(STEPS[0]!.validationWindow.end)}`)).toBeInTheDocument()
    expect(screen.getByText(`Deploy window: ${formatDateTime(STEPS[1]!.releaseWindow.start)} → ${formatDateTime(STEPS[1]!.releaseWindow.end)}`)).toBeInTheDocument()
    expect(screen.queryByText('No planned step')).not.toBeInTheDocument()
  })

  it('an empty plan says so, and Escape closes', async () => {
    const onClose = vi.fn()
    render(<PlanModal steps={[]} ciName="db-01" onClose={onClose} />)
    expect(screen.getByText('No planned step')).toBeInTheDocument()
    await userEvent.setup().keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})
