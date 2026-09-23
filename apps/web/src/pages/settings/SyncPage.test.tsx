/**
 * CMDB SYNC: the page that imports configuration items from external sources.
 *
 * The tabs draw what they are given; this page (and its hook, `useSyncPage`)
 * decides what reaches the server and what the administrator is told. If it
 * regresses, the damage is silent: credentials and configuration sent in the
 * wrong shape, a schedule typed at creation that never arrives (G-7), a delete
 * without confirmation, a failed connection test that reads like a success,
 * or conflicts filtered in the browser instead of by the server — so that 80
 * open conflicts look like 50 (G-21). These tests drive the page as an
 * administrator does and read what goes to the API and what is shown back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { ConnectorInfo, SyncConflict, SyncRun, SyncSource, SyncStats } from './useSyncPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { SyncPage } = await import('./SyncPage')

const STATS: SyncStats = {
  totalSources: 2, enabledSources: 1, lastSyncAt: '2026-09-20T08:00:00Z',
  ciManaged: 1250, openConflicts: 1, totalRuns: 40, successRate: 0.95,
}
const SOURCE: SyncSource = {
  id: 's1', name: 'CMDB prod', connectorType: 'servicenow', enabled: true, scheduleCron: '0 */6 * * *',
  lastSyncAt: '2026-09-20T08:00:00Z', lastSyncStatus: 'completed', lastSyncDurationMs: 2500, createdAt: '2026-09-01T00:00:00Z',
}
const CONNECTOR: ConnectorInfo = {
  type: 'servicenow', displayName: 'ServiceNow', supportedCITypes: ['server'],
  credentialFields: [{ name: 'username', label: 'Username', type: 'text', required: true, placeholder: null, helpText: null, options: null, defaultValue: null }],
  configFields: [{ name: 'table', label: 'Table', type: 'select', required: false, placeholder: null, helpText: null,
    options: [{ value: 'cmdb_ci', label: 'All CIs' }, { value: 'cmdb_ci_server', label: 'Servers' }], defaultValue: 'cmdb_ci_server' }],
}
const RUN: SyncRun = {
  id: 'r1', syncType: 'full', status: 'failed', startedAt: '2026-09-20T08:00:00Z', completedAt: null, durationMs: 900,
  errorMessage: 'Instance unreachable', ciCreated: 0, ciUpdated: 0, ciUnchanged: 0, ciStale: 0, ciConflicts: 0, relationsCreated: 0, relationsRemoved: 0,
}
const CONFLICT: SyncConflict = {
  id: 'c1', externalId: 'SN-00042', ciType: 'server', conflictFields: '["ip_address"]', status: 'open', resolution: null,
  existingCiId: 'ci-9', matchReason: 'hostname', createdAt: '2026-09-20T08:00:00Z', resolvedAt: null,
}

beforeEach(() => {
  apolloFinto.reset()
  for (const f of Object.values(toast)) f.mockReset()
  apolloFinto.risposte['SyncStats'] = { syncStats: STATS }
  apolloFinto.risposte['SyncSources'] = { syncSources: [SOURCE], availableConnectors: [CONNECTOR] }
  apolloFinto.risposte['SyncRuns'] = { syncRuns: { total: 1, items: [RUN] } }
  apolloFinto.risposte['SyncConflicts'] = { syncConflicts: { total: 1, items: [CONFLICT] } }
})

const show = () => renderWithProviders(<SyncPage />)
const tab = (name: string) => screen.getByRole('button', { name })
const dialog = () => within(screen.getByRole('dialog'))

describe('SyncPage — the page', () => {
  it('opens on the sources, under the four numbers of the sync', () => {
    show()
    expect(screen.getByRole('heading', { name: 'CMDB Sync' })).toBeInTheDocument()
    expect(screen.getByText('Import and sync configuration items from external sources')).toBeInTheDocument()
    // Each number sits in the tile of its name.
    expect(screen.getByText('1/2').parentElement).toHaveTextContent('Sources')
    expect(screen.getByText('1250').parentElement).toHaveTextContent('CIs managed')
    expect(screen.getByText('95%').parentElement).toHaveTextContent('Success rate')
    expect(tab('Sources')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('CMDB prod')).toBeInTheDocument()
  })

  it('with no stats from the server, no number is drawn rather than zeros', () => {
    delete apolloFinto.risposte['SyncStats']
    apolloFinto.risposte['SyncSources'] = undefined
    show()
    expect(screen.queryByText('CIs managed')).toBeNull()
    // No answer yet for the sources either: the list is empty, not broken.
    expect(screen.getByText('No sync source configured. Add one to start importing CIs.')).toBeInTheDocument()
  })

  it('each tab shows its own content, and the pressed tab is the one shown', async () => {
    const { user } = show()
    await user.click(tab('History'))
    expect(tab('History')).toHaveAttribute('aria-pressed', 'true')
    expect(tab('Sources')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Pick a sync source to see its run history')).toBeInTheDocument()
    await user.click(tab('Conflicts'))
    expect(screen.getByText('SN-00042')).toBeInTheDocument()
    await user.click(tab('Import'))
    expect(screen.getByText('Historical data import')).toBeInTheDocument()
    expect(screen.queryByText('SN-00042')).toBeNull()
  })
})

describe('SyncPage — sources', () => {
  it('a new source travels with credentials and configuration as JSON, enabled, with its schedule', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Add source' }))
    await user.selectOptions(dialog().getByLabelText('Connector type'), 'ServiceNow')
    await user.type(dialog().getByLabelText('Name'), 'CMDB test')
    await user.type(dialog().getByLabelText(/^Username/), 'svc.sync')
    await user.type(dialog().getByLabelText('Schedule (cron, optional)'), '0 * * * *')
    await user.click(dialog().getByRole('button', { name: 'Create source' }))
    expect(apolloFinto.chiamata('CreateSyncSource')).toEqual({ input: {
      name: 'CMDB test', connectorType: 'servicenow',
      credentials: JSON.stringify({ username: 'svc.sync' }), config: JSON.stringify({ table: 'cmdb_ci_server' }),
      scheduleCron: '0 * * * *', enabled: true,
    } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Sync source created'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('without a schedule, the input carries none', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Add source' }))
    await user.selectOptions(dialog().getByLabelText('Connector type'), 'ServiceNow')
    await user.type(dialog().getByLabelText('Name'), 'CMDB test')
    await user.type(dialog().getByLabelText(/^Username/), 'svc.sync')
    await user.click(dialog().getByRole('button', { name: 'Create source' }))
    await waitFor(() => expect(apolloFinto.chiamata('CreateSyncSource')).toBeDefined())
    expect(apolloFinto.chiamata('CreateSyncSource')!['input']).not.toHaveProperty('scheduleCron')
  })

  it('a refused creation says why and keeps the dialog open with what was typed', async () => {
    apolloFinto.esiti['CreateSyncSource'] = { error: new Error('A source with this name exists') }
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Add source' }))
    await user.selectOptions(dialog().getByLabelText('Connector type'), 'ServiceNow')
    await user.type(dialog().getByLabelText('Name'), 'CMDB prod')
    await user.type(dialog().getByLabelText(/^Username/), 'svc.sync')
    await user.click(dialog().getByRole('button', { name: 'Create source' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A source with this name exists'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(dialog().getByLabelText('Name')).toHaveValue('CMDB prod')
  })

  it('deleting asks first; confirming deletes that source and says so', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Delete source CMDB prod' }))
    expect(await screen.findByText('Delete this sync source?')).toBeInTheDocument()
    expect(apolloFinto.chiamata('DeleteSyncSource')).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteSyncSource')).toEqual({ id: 's1' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Source deleted'))
  })

  it('declining the confirmation deletes nothing', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Delete source CMDB prod' }))
    await screen.findByText('Delete this sync source?')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Delete this sync source?')).toBeNull())
    expect(apolloFinto.chiamata('DeleteSyncSource')).toBeUndefined()
  })

  it('a refused delete says why', async () => {
    apolloFinto.esiti['DeleteSyncSource'] = { error: new Error('Source is running') }
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Delete source CMDB prod' }))
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Source is running'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('«Sync now» starts a run of that source and says so; a refusal says why', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(apolloFinto.chiamata('TriggerSync')).toEqual({ sourceId: 's1' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Sync triggered'))
    apolloFinto.esiti['TriggerSync'] = { error: new Error('Already running') }
    await user.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Already running'))
  })

  it('a connection test that passes says what the connector answered', async () => {
    apolloFinto.esiti['TestSyncConnection'] = { data: { testSyncConnection: { ok: true, message: 'Reached acme.service-now.com', details: null } } }
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Test' }))
    expect(apolloFinto.chiamata('TestSyncConnection')).toEqual({ sourceId: 's1' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Reached acme.service-now.com'))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a connection test that fails is an error, with the connector\'s reason or a generic one', async () => {
    apolloFinto.esiti['TestSyncConnection'] = { data: { testSyncConnection: { ok: false, message: 'HTTP 401 from the instance', details: null } } }
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('HTTP 401 from the instance'))
    // No answer at all is not a success either.
    apolloFinto.esiti['TestSyncConnection'] = { data: {} }
    await user.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Connection failed'))
    apolloFinto.esiti['TestSyncConnection'] = { error: new Error('Network down') }
    await user.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Network down'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a new schedule is saved on that source, and the dialog closes', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    await user.selectOptions(dialog().getByLabelText('Cron preset'), 'Daily at midnight')
    await user.click(dialog().getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('UpdateSyncSource')).toEqual({ id: 's1', input: { scheduleCron: '0 0 * * *' } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Schedule saved'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a refused schedule says why and keeps the dialog open', async () => {
    apolloFinto.esiti['UpdateSyncSource'] = { error: new Error('Invalid cron expression') }
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    await user.click(dialog().getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Invalid cron expression'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('SyncPage — history', () => {
  it('no run is read until a source is chosen; then its last 50 runs are', async () => {
    const { user } = show()
    await user.click(tab('History'))
    expect(apolloFinto.chiamate['SyncRuns']).toBeUndefined()
    await user.selectOptions(screen.getByRole('combobox'), 'CMDB prod')
    expect(apolloFinto.chiamata('SyncRuns')).toEqual({ sourceId: 's1', limit: 50 })
    expect(screen.getByText('Instance unreachable')).toBeInTheDocument()
  })

  it('a source whose runs have not arrived shows no run', async () => {
    apolloFinto.risposte['SyncRuns'] = undefined
    const { user } = show()
    await user.click(tab('History'))
    await user.selectOptions(screen.getByRole('combobox'), 'CMDB prod')
    expect(screen.getByText('No run yet')).toBeInTheDocument()
  })
})

describe('SyncPage — conflicts', () => {
  it('the server filters the conflicts, 50 at a time: open by default, then resolved, then all', async () => {
    const { user } = show()
    await user.click(tab('Conflicts'))
    expect(apolloFinto.chiamata('SyncConflicts')).toEqual({ limit: 50, status: 'open' })
    await user.click(screen.getByRole('button', { name: 'Resolved' }))
    expect(apolloFinto.chiamata('SyncConflicts')).toEqual({ limit: 50, status: 'resolved' })
    // «All» is no filter at all, not a status called "all".
    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(apolloFinto.chiamata('SyncConflicts')).toEqual({ limit: 50, status: null })
  })

  it('the total comes from the server, and says when there are more than shown', async () => {
    apolloFinto.risposte['SyncConflicts'] = { syncConflicts: { total: 80, items: [CONFLICT] } }
    const { user } = show()
    await user.click(tab('Conflicts'))
    expect(screen.getByText('Showing 1 of 80 conflicts: resolve these, and the rest appears.')).toBeInTheDocument()
  })

  it('with no answer yet, there is no conflict and no count', async () => {
    apolloFinto.risposte['SyncConflicts'] = undefined
    const { user } = show()
    await user.click(tab('Conflicts'))
    expect(screen.getByText('No open conflicts')).toBeInTheDocument()
    expect(screen.queryByText(/^Showing/)).toBeNull()
  })

  it('resolving a conflict sends the choice and says so; a refusal says why', async () => {
    const { user } = show()
    await user.click(tab('Conflicts'))
    await user.click(screen.getByRole('button', { name: 'Link' }))
    expect(apolloFinto.chiamata('ResolveConflict')).toEqual({ conflictId: 'c1', resolution: 'linked' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Conflict resolved'))
    apolloFinto.esiti['ResolveConflict'] = { error: new Error('Conflict already resolved') }
    await user.click(screen.getByRole('button', { name: 'Merge' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Conflict already resolved'))
  })
})
