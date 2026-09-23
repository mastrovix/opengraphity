/**
 * CONFLICTS BETWEEN WHAT A SYNC SOURCE SENT AND WHAT THE CMDB ALREADY HOLDS.
 *
 * A conflict is an imported CI that matched an existing one ambiguously, or
 * that touches fields somebody locked. The administrator decides here: merge
 * it into the existing CI, keep the two distinct, or link them. The filter is
 * applied by the SERVER (G-21), so this tab must say when it holds fewer
 * conflicts than the total — otherwise 80 open conflicts look like 50, and
 * «resolved» shows only those that happened to be among the latest 50.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatDateTime } from '@/lib/datetime'
import { SyncConflictsTab } from './SyncConflictsTab'
import type { SyncConflict } from './useSyncPage'

const conflict = (over: Partial<SyncConflict>): SyncConflict => ({
  id: 'c1', externalId: 'SN-00042', ciType: 'server', conflictFields: '["ip_address","os"]', status: 'open',
  resolution: null, existingCiId: 'ci-9', matchReason: 'hostname', createdAt: '2026-09-20T08:00:00Z', resolvedAt: null, ...over,
})

function mount(props: Partial<Parameters<typeof SyncConflictsTab>[0]> = {}) {
  const onStatusChange = vi.fn()
  const onResolveConflict = vi.fn(async () => {})
  const { unmount } = render(<SyncConflictsTab conflicts={[]} loading={false} total={0} status="open"
    onStatusChange={onStatusChange} onResolveConflict={onResolveConflict} {...props} />)
  return { onStatusChange, onResolveConflict, unmount }
}

describe('SyncConflictsTab — the filter', () => {
  it('the three filters say which one is active and hand the choice to the page', async () => {
    const { onStatusChange } = mount({ status: 'resolved' })
    expect(screen.getByRole('button', { name: 'Resolved' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(onStatusChange).toHaveBeenCalledWith('all')
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onStatusChange).toHaveBeenLastCalledWith('open')
  })

  it('while loading, only the loading line is under the filters', () => {
    mount({ loading: true, total: 80 })
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('No open conflicts')).toBeNull()
    expect(screen.queryByText(/^Showing/)).toBeNull()
  })

  it('an empty list says there is no OPEN conflict under «Open», and none at all under the others', () => {
    const underOpen = mount()
    expect(screen.getByText('No open conflicts')).toBeInTheDocument()
    underOpen.unmount()
    mount({ status: 'all' })
    expect(screen.getByText('No conflicts found')).toBeInTheDocument()
    expect(screen.queryByText('No open conflicts')).toBeNull()
  })

  it('when the server holds more than the page shows, the tab says how many there are in all', () => {
    mount({ conflicts: [conflict({}), conflict({ id: 'c2', externalId: 'SN-00043' })], total: 80 })
    expect(screen.getByText('Showing 2 of 80 conflicts: resolve these, and the rest appears.')).toBeInTheDocument()
  })

  it('when the page shows all of them, it does not claim there are more', () => {
    mount({ conflicts: [conflict({})], total: 1 })
    expect(screen.queryByText(/^Showing/)).toBeNull()
  })
})

describe('SyncConflictsTab — a conflict', () => {
  it('an open conflict shows the CI, its type, status, locked fields and date, and offers the three resolutions', async () => {
    const { onResolveConflict } = mount({ conflicts: [conflict({})], total: 1 })
    expect(screen.getByText('SN-00042')).toBeInTheDocument()
    expect(screen.getByText('server')).toBeInTheDocument()
    expect(screen.getByText('open')).toBeInTheDocument()
    expect(screen.getByText(`Locked fields: ip_address, os · ${formatDateTime('2026-09-20T08:00:00Z')}`)).toBeInTheDocument()

    // Each button carries what it will do: the three words alone are not enough to choose.
    const merge = screen.getByRole('button', { name: 'Merge' })
    expect(merge).toHaveAttribute('title', 'Update the existing CI with the imported data')
    expect(screen.getByRole('button', { name: 'They are different' })).toHaveAttribute('title', 'Create a new CI, separate from the imported data')
    expect(screen.getByRole('button', { name: 'Link' })).toHaveAttribute('title', 'Create a new CI and link both with RELATED_TO')

    await userEvent.click(merge)
    expect(onResolveConflict).toHaveBeenLastCalledWith('c1', 'merged')
    await userEvent.click(screen.getByRole('button', { name: 'They are different' }))
    expect(onResolveConflict).toHaveBeenLastCalledWith('c1', 'distinct')
    await userEvent.click(screen.getByRole('button', { name: 'Link' }))
    expect(onResolveConflict).toHaveBeenLastCalledWith('c1', 'linked')
  })

  it('a resolved conflict says how it was resolved and cannot be resolved again', () => {
    mount({ status: 'resolved', total: 1, conflicts: [conflict({ status: 'resolved', resolution: 'merged', conflictFields: '' })] })
    expect(screen.getByText('Resolution: merged')).toBeInTheDocument()
    // No locked field is a dash, not an empty «Locked fields: ».
    expect(screen.getByText(/^Locked fields: — ·/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull()
  })
})
