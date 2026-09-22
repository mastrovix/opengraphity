/**
 * The side panel of a CMDB anomaly: what was found, where, and how to close it.
 *
 * What a regression costs the reader:
 * - the panel is a dialog (G-ANO-13): it must take the focus and close with
 *   Escape, or a keyboard user is trapped behind it;
 * - an anomaly the scanner has already closed (`stale`) must NOT offer
 *   "Resolve": a manual resolution would overwrite the automatic closure;
 * - a resolved anomaly shows WHO closed it by name and WHY (rule switched off),
 *   and never an empty "Resolved by" row;
 * - the resolution form must send the anomaly id with the chosen outcome, or
 *   the wrong anomaly gets closed.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import type { Anomaly } from '@/types/anomaly'
import { DetailPanel, Field } from './AnomalyDetail'

const ANOMALY: Anomaly = {
  id: 'an-1', ruleKey: 'orphan_ci', title: 'raw title', severity: 'high', status: 'open',
  entityId: 'ci-1', entityType: 'ci', entitySubtype: 'server', entityName: 'web-01',
  description: 'raw description', descriptionParams: [], detectedAt: '2026-09-14T10:00:00Z',
  resolvedAt: null, resolutionStatus: null, resolutionNote: null, resolvedBy: null, resolvedByName: null, resolvedReason: null,
}

const mount = (over: Partial<Anomaly> = {}, props: Partial<Parameters<typeof DetailPanel>[0]> = {}) => {
  const onClose = vi.fn()
  const onResolve = vi.fn()
  const r = renderWithProviders(
    <DetailPanel anomaly={{ ...ANOMALY, ...over }} onClose={onClose} onResolve={onResolve} loading={false} resolveError={null} {...props} />,
  )
  return { ...r, onClose, onResolve }
}

describe('AnomalyDetail — DetailPanel', () => {
  it('is an announced dialog that takes the focus, and reads rule, entity and description in words', () => {
    mount()
    const dialog = screen.getByRole('dialog', { name: 'Orphan CI' })
    expect(dialog).toHaveFocus()
    expect(screen.getByText('web-01 (Server)')).toBeInTheDocument()
    expect(screen.getByText('The CI has no relation with other nodes of the CMDB graph')).toBeInTheDocument()
    // Nothing was resolved: no empty resolution rows.
    expect(screen.queryByText('Resolved by')).toBeNull()
    expect(screen.queryByText('Resolved at')).toBeNull()
  })

  it('a rule the web does not know is shown by its key and its stored title, not hidden', () => {
    mount({ ruleKey: 'custom_rule', title: 'Custom finding' })
    expect(screen.getByText('custom_rule')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Custom finding' })).toBeInTheDocument()
  })

  it('Escape and the close button both close it; other keys do not', async () => {
    const { user, onClose } = mount()
    await user.keyboard('{Enter}')
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('a resolved anomaly shows when, why, the note and who resolved it by name — and no "Resolve"', () => {
    mount({
      status: 'resolved', resolvedAt: '2026-09-15T08:00:00Z', resolutionNote: 'Owner assigned by hand',
      resolvedBy: 'u-uuid', resolvedByName: 'Grace Hopper', resolvedReason: 'rule_disabled',
    })
    expect(screen.getByText('The rule was switched off')).toBeInTheDocument()
    expect(screen.getByText('Resolved at')).toBeInTheDocument()
    expect(screen.getByText('Owner assigned by hand')).toBeInTheDocument()
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument()
    // G-ANO-8: the UUID is never shown.
    expect(screen.queryByText('u-uuid')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resolve anomaly' })).toBeNull()
  })

  it('a stale anomaly says it is the last reading and offers no "Resolve" (G-ANO-10)', () => {
    mount({}, { stale: true })
    expect(screen.getByRole('status')).toHaveTextContent('This anomaly is no longer in the list')
    expect(screen.queryByRole('button', { name: 'Resolve anomaly' })).toBeNull()
  })

  it('"Resolve" opens the form; cancel brings the button back; confirm sends the anomaly id with outcome and note', async () => {
    const { user, onResolve } = mount()
    await user.click(screen.getByRole('button', { name: 'Resolve anomaly' }))
    expect(screen.getByText('Resolution')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Resolve anomaly' }))

    await user.selectOptions(screen.getByLabelText('Action *'), 'false_positive')
    await user.type(screen.getByLabelText('Note *'), 'Decommissioned last week')
    await user.click(screen.getByRole('button', { name: 'Confirm resolution' }))
    expect(onResolve).toHaveBeenCalledWith('an-1', 'false_positive', 'Decommissioned last week')
  })

  it('the resolve error is shown inside the form', async () => {
    const { user } = mount({}, { resolveError: 'Not allowed' })
    await user.click(screen.getByRole('button', { name: 'Resolve anomaly' }))
    expect(screen.getByText(/Not allowed/)).toBeInTheDocument()
  })
})

describe('AnomalyDetail — Field', () => {
  it('shows a label and its value', () => {
    renderWithProviders(<Field label="Entity" value="web-01" />)
    expect(screen.getByText('Entity')).toBeInTheDocument()
    expect(screen.getByText('web-01')).toBeInTheDocument()
  })
})
