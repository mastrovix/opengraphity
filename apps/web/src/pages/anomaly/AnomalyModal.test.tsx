/**
 * Closing an anomaly is an audit decision: the form must demand an action and
 * a real note (at least 10 characters, not just spaces) before it lets the
 * user confirm, must send the note trimmed, and must not allow a second click
 * while the save runs. If these regressed, anomalies could be closed with no
 * justification or resolved twice.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/utils'
import type { Anomaly } from '@/types/anomaly'
import { ResolutionForm } from './AnomalyModal'

const anomaly = (ruleKey: string) => ({ id: 'a1', ruleKey } as Anomaly)

describe('ResolutionForm', () => {
  it('shows the rule suggestion for a known rule, none for an unknown one', () => {
    const { unmount } = renderWithProviders(<ResolutionForm anomaly={anomaly('spof')} onConfirm={vi.fn()} onCancel={vi.fn()} loading={false} />)
    const withSuggestion = document.querySelectorAll('svg').length
    unmount()
    renderWithProviders(<ResolutionForm anomaly={anomaly('custom_rule')} onConfirm={vi.fn()} onCancel={vi.fn()} loading={false} />)
    // The lightbulb box is the only icon in the form: it disappears without a suggestion.
    expect(withSuggestion).toBe(1)
    expect(document.querySelectorAll('svg').length).toBe(0)
  })

  it('confirms only with an action and a note of at least 10 real characters, sending the note trimmed', async () => {
    const onConfirm = vi.fn()
    renderWithProviders(<ResolutionForm anomaly={anomaly('spof')} onConfirm={onConfirm} onCancel={vi.fn()} loading={false} />)
    const confirm = screen.getByRole('button', { name: 'Confirm resolution' })
    expect(confirm).toBeDisabled()

    await userEvent.selectOptions(screen.getByLabelText('Action *'), 'false_positive')
    await userEvent.type(screen.getByLabelText('Note *'), '  short   ')
    // Spaces do not count towards the minimum.
    expect(confirm).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Note *'), 'but now long enough')
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith('false_positive', 'short   but now long enough')
  })

  it('while saving, both buttons are disabled and the confirm says it is saving; the error is shown', () => {
    renderWithProviders(<ResolutionForm anomaly={anomaly('spof')} onConfirm={vi.fn()} onCancel={vi.fn()} loading error="Server said no" />)
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByText('Server said no')).toBeInTheDocument()
  })

  it('cancel calls back', async () => {
    const onCancel = vi.fn()
    renderWithProviders(<ResolutionForm anomaly={anomaly('spof')} onConfirm={vi.fn()} onCancel={onCancel} loading={false} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
