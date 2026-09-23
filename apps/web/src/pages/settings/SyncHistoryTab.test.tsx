/**
 * THE RUN HISTORY OF A SYNC SOURCE.
 *
 * When a CMDB import misbehaves, this is where an administrator looks: which
 * run failed and with what error, how long it took, and what it created,
 * updated, left unchanged, marked stale or could not reconcile. The history
 * is per source, so nothing is listed until a source is chosen — and the
 * choice goes to the page, which is the one that reads the runs.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatDateTime } from '@/lib/datetime'
import { SyncHistoryTab } from './SyncHistoryTab'
import type { SyncRun, SyncSource } from './useSyncPage'

const source = (id: string, name: string): SyncSource => ({
  id, name, connectorType: 'csv', enabled: true, scheduleCron: null, lastSyncAt: null,
  lastSyncStatus: null, lastSyncDurationMs: null, createdAt: '2026-09-01T00:00:00Z',
})
const SOURCES = [source('s1', 'ServiceNow prod'), source('s2', 'Spreadsheet')]

const run = (over: Partial<SyncRun>): SyncRun => ({
  id: 'r1', syncType: 'full', status: 'completed', startedAt: '2026-09-20T08:00:00Z', completedAt: '2026-09-20T08:00:03Z',
  durationMs: 2500, errorMessage: null, ciCreated: 3, ciUpdated: 5, ciUnchanged: 10, ciStale: 2, ciConflicts: 1,
  relationsCreated: 0, relationsRemoved: 0, ...over,
})

function mount(props: Partial<Parameters<typeof SyncHistoryTab>[0]> = {}) {
  const onSelectSource = vi.fn()
  render(<SyncHistoryTab sources={SOURCES} runs={[]} loading={false} selectedSourceId="" onSelectSource={onSelectSource} {...props} />)
  return { onSelectSource }
}

describe('SyncHistoryTab', () => {
  it('asks to pick a source first, and offers every source by name', () => {
    mount()
    expect(screen.getByText('Pick a sync source to see its run history')).toBeInTheDocument()
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Select a source...', 'ServiceNow prod', 'Spreadsheet'])
  })

  // Found in the tour of 23 Sep 2026, fixed: the list had no label and no
  // name of its own, so a screen reader announced a nameless list.
  it('the list of sources is announced by its name', () => {
    mount()
    expect(screen.getByRole('combobox', { name: 'Sync source' })).toHaveValue('')
  })

  it('choosing a source hands it to the page, and says it is loading while the runs arrive', async () => {
    const { onSelectSource } = mount({ loading: true })
    await userEvent.selectOptions(screen.getByRole('combobox'), 's2')
    expect(onSelectSource).toHaveBeenCalledWith('s2')
    expect(screen.getByRole('combobox')).toHaveValue('s2')
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('Pick a sync source to see its run history')).toBeNull()
  })

  it('a source with no run yet says so', () => {
    mount({ selectedSourceId: 's1' })
    expect(screen.getByRole('combobox')).toHaveValue('s1')
    expect(screen.getByText('No run yet')).toBeInTheDocument()
  })

  it('each run shows status, type, start, duration and counts; the error of a failed run is shown in full', () => {
    const failedAt = '2026-09-21T09:30:00Z'
    mount({ selectedSourceId: 's1', runs: [
      run({}),
      run({ id: 'r2', syncType: 'incremental', status: 'failed', startedAt: failedAt, durationMs: null,
        ciCreated: 0, ciUpdated: 0, ciUnchanged: 0, ciStale: 0, ciConflicts: 0, errorMessage: 'Connection refused by host' }),
    ] })
    expect(screen.getByText('completed')).toBeInTheDocument()
    expect(screen.getByText('full')).toBeInTheDocument()
    expect(screen.getByText(formatDateTime('2026-09-20T08:00:00Z'))).toBeInTheDocument()
    expect(screen.getByText('(2.5s)')).toBeInTheDocument()
    expect(screen.getByText('+3')).toBeInTheDocument()
    expect(screen.getByText('~5')).toBeInTheDocument()
    expect(screen.getByText('=10')).toBeInTheDocument()
    // Stale CIs and conflicts are named only when a run has some.
    expect(screen.getAllByText(/^stale:/).map((e) => e.textContent)).toEqual(['stale: 2'])
    expect(screen.getAllByText(/^conflicts:/).map((e) => e.textContent)).toEqual(['conflicts: 1'])

    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.getByText('incremental')).toBeInTheDocument()
    expect(screen.getByText(formatDateTime(failedAt))).toBeInTheDocument()
    expect(screen.getByText('Connection refused by host')).toBeInTheDocument()
    // A run with no duration shows none, rather than «(—)».
    expect(screen.getAllByText(/^\(.*\)$/)).toHaveLength(1)
  })
})
