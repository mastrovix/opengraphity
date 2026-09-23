/**
 * THE SYNC SOURCES OF THE CMDB: where an administrator adds a connector,
 * schedules it, runs it, tests it and removes it.
 *
 * What breaks if this tab regresses, and nobody notices until the CMDB is
 * wrong: a source created without the configuration its form showed as
 * default (G-7); a schedule typed at creation that never reaches the server,
 * so the source never runs (G-7); a CSV pasted or uploaded that does not
 * travel; a schedule dialog that opens on the wrong preset and overwrites the
 * real schedule on save; a failed save that closes the dialog and throws away
 * what was typed.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatDateTime } from '@/lib/datetime'
import { colors, palette } from '@/lib/tokens'
import { SyncSourcesTab, type SyncSourcesTabProps } from './SyncSourcesTab'
import type { ConnectorField, ConnectorInfo, SyncSource } from './useSyncPage'

const field = (over: Partial<ConnectorField> & Pick<ConnectorField, 'name' | 'label'>): ConnectorField => ({
  type: 'text', required: false, placeholder: null, helpText: null, options: null, defaultValue: null, ...over,
})

const SERVICENOW: ConnectorInfo = {
  type: 'servicenow', displayName: 'ServiceNow', supportedCITypes: ['server'],
  credentialFields: [
    field({ name: 'username', label: 'Username', required: true, placeholder: 'integration.user' }),
    field({ name: 'password', label: 'Password', type: 'password', required: true, helpText: 'Stored encrypted' }),
  ],
  configFields: [
    field({ name: 'instance', label: 'Instance URL', required: true, helpText: 'https://<name>.service-now.com' }),
    field({ name: 'table', label: 'Table', type: 'select', defaultValue: 'cmdb_ci_server',
      options: [{ value: 'cmdb_ci', label: 'All CIs' }, { value: 'cmdb_ci_server', label: 'Servers' }] }),
    field({ name: 'batch_size', label: 'Batch size', defaultValue: '500' }),
  ],
}
const CSV: ConnectorInfo = {
  type: 'csv', displayName: 'CSV file', supportedCITypes: [], credentialFields: [],
  configFields: [field({ name: 'csv_content', label: 'CSV content', type: 'textarea', required: true })],
}
const JSON_FEED: ConnectorInfo = {
  type: 'json', displayName: 'JSON feed', supportedCITypes: [], credentialFields: [],
  configFields: [
    field({ name: 'json_content', label: 'JSON content', type: 'textarea' }),
    field({ name: 'mapping', label: 'Mapping', type: 'textarea' }),
  ],
}

const source = (over: Partial<SyncSource> = {}): SyncSource => ({
  id: 's1', name: 'CMDB prod', connectorType: 'servicenow', enabled: true, scheduleCron: '0 */6 * * *',
  lastSyncAt: '2026-09-20T08:00:00Z', lastSyncStatus: 'completed', lastSyncDurationMs: 2500,
  createdAt: '2026-09-01T00:00:00Z', ...over,
})

function mount(props: Partial<SyncSourcesTabProps> = {}) {
  const handlers = {
    onCreateSource: vi.fn<SyncSourcesTabProps['onCreateSource']>(async () => {}),
    onDeleteSource: vi.fn<SyncSourcesTabProps['onDeleteSource']>(async () => {}),
    onTriggerSync: vi.fn<SyncSourcesTabProps['onTriggerSync']>(async () => {}),
    onTestConnection: vi.fn<SyncSourcesTabProps['onTestConnection']>(async () => {}),
    onSaveSchedule: vi.fn<SyncSourcesTabProps['onSaveSchedule']>(async () => {}),
  }
  const user = userEvent.setup()
  render(<SyncSourcesTab sources={[source()]} connectors={[SERVICENOW, CSV, JSON_FEED]} loading={false} {...handlers} {...props} />)
  return { ...handlers, user }
}

type User = ReturnType<typeof userEvent.setup>
const dialog = () => screen.getByRole('dialog')
const inDialog = () => within(dialog())

/** Opens «Add source» and picks a connector: the connector decides the fields. */
async function openCreate(user: User, connector = 'ServiceNow') {
  await user.click(screen.getByRole('button', { name: 'Add source' }))
  expect(inDialog().getByText('Add a sync source')).toBeInTheDocument()
  await user.selectOptions(inDialog().getByLabelText('Connector type'), connector)
}

/** The details of a source, next to its name. */
const detailsOf = (name: string) => screen.getByText(name).parentElement!.parentElement!

/**
 * Reading a file is asynchronous in a browser (and in jsdom, three tasks
 * later). The tests wait for the reader to be DONE before they submit,
 * instead of guessing how long it takes.
 */
function watchFileReads() {
  const reads = vi.spyOn(FileReader.prototype, 'readAsText')
  return async () => {
    await waitFor(() => expect((reads.mock.contexts.at(-1) as FileReader | undefined)?.readyState).toBe(FileReader.DONE))
  }
}

const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!

describe('SyncSourcesTab — the list of sources', () => {
  it('while the sources load, only the loading line is shown', () => {
    mount({ loading: true })
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add source' })).toBeNull()
  })

  it('with no source yet, the tab says how to start', () => {
    mount({ sources: [] })
    expect(screen.getByText('No sync source configured. Add one to start importing CIs.')).toBeInTheDocument()
  })

  it('each source shows its connector, state, last sync with outcome and duration, and its schedule', () => {
    mount({ sources: [
      source(),
      source({ id: 's2', name: 'Spreadsheet', connectorType: 'csv', enabled: false, scheduleCron: null,
        lastSyncAt: null, lastSyncStatus: null, lastSyncDurationMs: null }),
    ] })
    const prod = detailsOf('CMDB prod')
    expect(prod).toHaveTextContent('servicenow')
    expect(prod).toHaveTextContent('enabled')
    expect(prod).toHaveTextContent(`Last sync: ${formatDateTime('2026-09-20T08:00:00Z')}`)
    expect(prod).toHaveTextContent('completed')
    expect(prod).toHaveTextContent('2.5s')
    expect(prod).toHaveTextContent('schedule: 0 */6 * * *')

    // A source never run says so, and does not invent an outcome, a duration or a schedule.
    const sheet = detailsOf('Spreadsheet')
    expect(sheet).toHaveTextContent('disabled')
    expect(sheet).toHaveTextContent('Last sync: —')
    expect(sheet).not.toHaveTextContent('completed')
    expect(sheet).not.toHaveTextContent('schedule')
    expect(sheet).not.toHaveTextContent('·')
  })

  it('the row buttons test the connection, run a sync and delete — each on its own source', async () => {
    const { user, onTestConnection, onTriggerSync, onDeleteSource } = mount({ sources: [source(), source({ id: 's2', name: 'Spreadsheet' })] })
    await user.click(screen.getAllByRole('button', { name: 'Test' })[1]!)
    expect(onTestConnection).toHaveBeenCalledWith('s2')
    await user.click(screen.getAllByRole('button', { name: 'Sync now' })[0]!)
    expect(onTriggerSync).toHaveBeenCalledWith('s1')
    // The bin is only an icon: its name says which source it deletes (G-22).
    await user.click(screen.getByRole('button', { name: 'Delete source Spreadsheet' }))
    expect(onDeleteSource).toHaveBeenCalledWith('s2')
  })
})

describe('SyncSourcesTab — the schedule of a source', () => {
  it('a source on a preset opens on that preset; saving sends the preset chosen and closes', async () => {
    const { user, onSaveSchedule } = mount()
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    expect(inDialog().getByText('Schedule — CMDB prod')).toBeInTheDocument()
    const preset = inDialog().getByLabelText('Cron preset')
    expect(preset).toHaveValue('0 */6 * * *')
    expect(within(preset).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['Every hour', 'Every 6 hours', 'Every 12 hours', 'Daily at midnight', 'Custom…'])
    expect(inDialog().queryByLabelText('Custom cron expression')).toBeNull()
    await user.selectOptions(preset, 'Every hour')
    await user.click(inDialog().getByRole('button', { name: 'Save' }))
    expect(onSaveSchedule).toHaveBeenCalledWith('s1', '0 * * * *')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a schedule that is no preset opens as custom with its expression, and is sent trimmed', async () => {
    const { user, onSaveSchedule } = mount({ sources: [source({ scheduleCron: '15 3 * * 1' })] })
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    expect(inDialog().getByLabelText('Cron preset')).toHaveValue('__custom__')
    const custom = inDialog().getByLabelText('Custom cron expression')
    expect(custom).toHaveValue('15 3 * * 1')
    expect(custom).toHaveAttribute('placeholder', 'e.g. 0 */4 * * *')
    await user.clear(custom)
    await user.type(custom, '  0 4 * * *  ')
    await user.click(inDialog().getByRole('button', { name: 'Save' }))
    expect(onSaveSchedule).toHaveBeenCalledWith('s1', '0 4 * * *')
  })

  it('a source with no schedule opens on an empty expression; saving it empty removes the schedule', async () => {
    const { user, onSaveSchedule } = mount({ sources: [source({ scheduleCron: null })] })
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    expect(inDialog().getByLabelText('Custom cron expression')).toHaveValue('')
    await user.click(inDialog().getByRole('button', { name: 'Save' }))
    expect(onSaveSchedule).toHaveBeenCalledWith('s1', null)
  })

  it('a refused save keeps the dialog open; Cancel closes it without saving again', async () => {
    const { user, onSaveSchedule } = mount()
    onSaveSchedule.mockRejectedValueOnce(new Error('invalid cron'))
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    await user.click(inDialog().getByRole('button', { name: 'Save' }))
    expect(onSaveSchedule).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.click(inDialog().getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onSaveSchedule).toHaveBeenCalledTimes(1)
  })

  it('the close button of the dialog closes it too', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Schedule' }))
    await user.click(inDialog().getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('SyncSourcesTab — adding a source', () => {
  it('the connector decides the fields: credentials with secrets hidden, configuration with defaults and help', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Add source' }))
    const connector = inDialog().getByLabelText('Connector type')
    expect(within(connector).getAllByRole('option').map((o) => o.textContent)).toEqual(['Select a connector...', 'ServiceNow', 'CSV file', 'JSON feed'])
    // Nothing to fill before a connector is chosen.
    expect(inDialog().queryByText('Credentials')).toBeNull()
    await user.selectOptions(connector, 'ServiceNow')

    expect(inDialog().getByText('Credentials')).toBeInTheDocument()
    expect(inDialog().getByLabelText(/^Username/)).toHaveAttribute('placeholder', 'integration.user')
    expect(inDialog().getByLabelText(/^Username/)).toBeRequired()
    expect(inDialog().getByLabelText(/^Password/)).toHaveAttribute('type', 'password')
    expect(inDialog().getByText('Stored encrypted')).toBeInTheDocument()
    expect(inDialog().getByText('Configuration')).toBeInTheDocument()
    expect(inDialog().getByText('https://<name>.service-now.com')).toBeInTheDocument()
    expect(inDialog().getByLabelText('Table')).toHaveValue('cmdb_ci_server')
    expect(inDialog().getByLabelText('Batch size')).toHaveValue('500')
    expect(inDialog().getByLabelText('Schedule (cron, optional)')).toHaveAttribute('placeholder', '0 */6 * * * (every 6h)')
  })

  it('creates the source with its credentials, its configuration — defaults included — and the schedule typed', async () => {
    const { user, onCreateSource } = mount()
    await openCreate(user)
    await user.type(inDialog().getByLabelText('Name'), 'CMDB prod')
    await user.type(inDialog().getByLabelText(/^Username/), 'svc.sync')
    await user.type(inDialog().getByLabelText(/^Password/), 's3cret')
    await user.type(inDialog().getByLabelText(/^Instance URL/), 'https://acme.service-now.com')
    await user.type(inDialog().getByLabelText('Schedule (cron, optional)'), '  0 * * * *  ')
    await user.click(inDialog().getByRole('button', { name: 'Create source' }))

    expect(onCreateSource).toHaveBeenCalledWith({
      name: 'CMDB prod', connectorType: 'servicenow',
      credentials: { username: 'svc.sync', password: 's3cret' },
      // The two values the form showed by default are the ones configured (G-7).
      config: { instance: 'https://acme.service-now.com', table: 'cmdb_ci_server', batch_size: '500' },
      scheduleCron: '0 * * * *',
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // Opened again, the dialog starts from scratch.
    await user.click(screen.getByRole('button', { name: 'Add source' }))
    expect(inDialog().getByLabelText('Name')).toHaveValue('')
    expect(inDialog().getByLabelText('Connector type')).toHaveValue('')
  })

  it('a choice made in a list is sent; a default emptied on purpose is not; no schedule means no schedule', async () => {
    const { user, onCreateSource } = mount()
    await openCreate(user)
    await user.type(inDialog().getByLabelText('Name'), 'All CIs')
    await user.type(inDialog().getByLabelText(/^Username/), 'u')
    await user.type(inDialog().getByLabelText(/^Password/), 'p')
    await user.type(inDialog().getByLabelText(/^Instance URL/), 'https://acme')
    await user.selectOptions(inDialog().getByLabelText('Table'), 'All CIs')
    await user.clear(inDialog().getByLabelText('Batch size'))
    await user.click(inDialog().getByRole('button', { name: 'Create source' }))
    const sent = onCreateSource.mock.calls[0]![0]
    expect(sent.config).toEqual({ instance: 'https://acme', table: 'cmdb_ci' })
    expect(sent).not.toHaveProperty('scheduleCron')
  })

  it('switching connector starts its fields from scratch', async () => {
    const { user } = mount()
    await openCreate(user)
    await user.type(inDialog().getByLabelText(/^Username/), 'svc.sync')
    await user.selectOptions(inDialog().getByLabelText('Connector type'), 'CSV file')
    expect(inDialog().queryByText('Credentials')).toBeNull()
    await user.selectOptions(inDialog().getByLabelText('Connector type'), 'ServiceNow')
    expect(inDialog().getByLabelText(/^Username/)).toHaveValue('')
  })

  it('a refused creation keeps the dialog open with what was typed', async () => {
    const { user, onCreateSource } = mount()
    onCreateSource.mockRejectedValueOnce(new Error('name taken'))
    await openCreate(user, 'JSON feed')
    await user.type(inDialog().getByLabelText('Name'), 'Feed')
    await user.click(inDialog().getByRole('button', { name: 'Create source' }))
    expect(onCreateSource).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(inDialog().getByLabelText('Name')).toHaveValue('Feed')
  })

  it('Cancel closes the dialog without creating anything', async () => {
    const { user, onCreateSource } = mount()
    await openCreate(user)
    await user.click(inDialog().getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onCreateSource).not.toHaveBeenCalled()
  })

  it('Escape closes the dialog too, without creating anything', async () => {
    const { user, onCreateSource } = mount()
    await openCreate(user)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onCreateSource).not.toHaveBeenCalled()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: a list field with no
  // default showed its first option as chosen — a <select> always shows one —
  // but sent nothing until the administrator changed it, so the source was
  // created without that setting while the dialog showed «Europe».
  it('a list field with no default sends the option it shows', async () => {
    const REGIONAL: ConnectorInfo = {
      type: 'regional', displayName: 'Regional API', supportedCITypes: [], credentialFields: [],
      configFields: [field({ name: 'region', label: 'Region', type: 'select',
        options: [{ value: 'eu', label: 'Europe' }, { value: 'us', label: 'United States' }] })],
    }
    const { user, onCreateSource } = mount({ connectors: [REGIONAL] })
    await openCreate(user, 'Regional API')
    await user.type(inDialog().getByLabelText('Name'), 'Regional')
    expect(inDialog().getByLabelText('Region')).toHaveValue('eu')
    await user.click(inDialog().getByRole('button', { name: 'Create source' }))
    expect(onCreateSource).toHaveBeenCalledWith(expect.objectContaining({ config: { region: 'eu' } }))
  })

  // Found by this test (tour of 23 Sep 2026), fixed: choosing the connector
  // reset the whole form, the source NAME included — typed first, above the
  // connector list, it was lost and had to be typed again.
  it('the name typed before choosing the connector is kept', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Add source' }))
    await user.type(inDialog().getByLabelText('Name'), 'CMDB prod')
    await user.selectOptions(inDialog().getByLabelText('Connector type'), 'ServiceNow')
    expect(inDialog().getByLabelText('Name')).toHaveValue('CMDB prod')
  })
})

describe('SyncSourcesTab — a content field (CSV, JSON)', () => {
  it('content pasted in the field travels as its value', async () => {
    const { user, onCreateSource } = mount()
    await openCreate(user, 'CSV file')
    await user.type(inDialog().getByLabelText('Name'), 'Inventory')
    await user.click(inDialog().getByLabelText(/^CSV content/))
    await user.paste('hostname,ip\nweb01,10.0.0.1')
    await user.click(inDialog().getByRole('button', { name: 'Create source' }))
    expect(onCreateSource).toHaveBeenCalledWith(expect.objectContaining({
      connectorType: 'csv', credentials: {}, config: { csv_content: 'hostname,ip\nweb01,10.0.0.1' },
    }))
  })

  it('a required content left empty blocks the creation', async () => {
    const { user, onCreateSource } = mount()
    await openCreate(user, 'CSV file')
    await user.type(inDialog().getByLabelText('Name'), 'Inventory')
    await user.click(inDialog().getByRole('button', { name: 'Create source' }))
    expect(onCreateSource).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('a chosen file shows its name and size, and its content travels', async () => {
    const readDone = watchFileReads()
    const { user, onCreateSource } = mount()
    await openCreate(user, 'CSV file')
    await user.type(inDialog().getByLabelText('Name'), 'Inventory')
    await user.click(inDialog().getByRole('button', { name: 'Upload file' }))
    // The zone says which files it takes.
    expect(inDialog().getByText('.csv,.tsv')).toBeInTheDocument()
    expect(fileInput()).toHaveAttribute('accept', '.csv,.tsv')
    await user.upload(fileInput(), new File(['hostname,ip\nweb01,10.0.0.1'], 'inventory.csv', { type: 'text/csv' }))
    expect(inDialog().getByText('inventory.csv')).toBeInTheDocument()
    expect(inDialog().getByText('26 B')).toBeInTheDocument()
    await readDone()
    await user.click(inDialog().getByRole('button', { name: 'Create source' }))
    expect(onCreateSource).toHaveBeenCalledWith(expect.objectContaining({ config: { csv_content: 'hostname,ip\nweb01,10.0.0.1' } }))
  })

  it('removing the file empties the field and offers the drop zone again', async () => {
    const readDone = watchFileReads()
    const { user, onCreateSource } = mount()
    await openCreate(user, 'JSON feed')
    await user.type(inDialog().getByLabelText('Name'), 'Feed')
    await user.click(inDialog().getAllByRole('button', { name: 'Upload file' })[0]!)
    await user.upload(fileInput(), new File(['[{"host":"web01"}]'], 'feed.json', { type: 'application/json' }))
    await readDone()
    await user.click(inDialog().getByRole('button', { name: /Remove/ }))
    expect(inDialog().queryByText('feed.json')).toBeNull()
    expect(inDialog().getAllByRole('button', { name: 'Browse' })).toHaveLength(1)
    await user.click(inDialog().getByRole('button', { name: 'Create source' }))
    expect(onCreateSource).toHaveBeenCalledWith(expect.objectContaining({ config: {} }))
  })

  it('a file dropped on the zone is taken like a chosen one; dragging over the zone is accepted and highlighted', async () => {
    const readDone = watchFileReads()
    const { user, onCreateSource } = mount()
    await openCreate(user, 'CSV file')
    await user.type(inDialog().getByLabelText('Name'), 'Inventory')
    await user.click(inDialog().getByRole('button', { name: 'Upload file' }))
    const zone = inDialog().getByRole('button', { name: 'Browse' })
    // `false` = the page called preventDefault: the browser will not open the file itself.
    expect(fireEvent.dragOver(zone)).toBe(false)
    expect(zone.style.borderColor).toBe(colors.brand)
    // Leaving puts back the colour of the dashed border at rest.
    fireEvent.dragLeave(zone)
    expect(zone.style.borderColor).toBe(palette.neutral.borderStrong)
    expect(fireEvent.drop(zone, { dataTransfer: { files: [new File(['a,b'], 'dropped.csv', { type: 'text/csv' })] } })).toBe(false)
    expect(inDialog().getByText('dropped.csv')).toBeInTheDocument()
    await readDone()
    await user.click(inDialog().getByRole('button', { name: 'Create source' }))
    expect(onCreateSource).toHaveBeenCalledWith(expect.objectContaining({ config: { csv_content: 'a,b' } }))
  })

  it('a drop with no file changes nothing', async () => {
    const { user } = mount()
    await openCreate(user, 'CSV file')
    await user.click(inDialog().getByRole('button', { name: 'Upload file' }))
    fireEvent.drop(inDialog().getByRole('button', { name: 'Browse' }), { dataTransfer: { files: [] } })
    expect(inDialog().getByRole('button', { name: 'Browse' })).toBeInTheDocument()
  })

  it('the zone opens the file picker, with the mouse and with the keyboard', async () => {
    const { user } = mount()
    await openCreate(user, 'CSV file')
    await user.click(inDialog().getByRole('button', { name: 'Upload file' }))
    const picker = vi.spyOn(fileInput(), 'click')
    await user.click(inDialog().getByRole('button', { name: 'Browse' }))
    expect(picker).toHaveBeenCalledTimes(1)
    inDialog().getByRole('button', { name: 'Browse' }).focus()
    await user.keyboard('{Enter}')
    expect(picker).toHaveBeenCalledTimes(2)
  })

  it('a picker closed without choosing changes nothing', async () => {
    const { user } = mount()
    await openCreate(user, 'CSV file')
    await user.click(inDialog().getByRole('button', { name: 'Upload file' }))
    fireEvent.change(fileInput(), { target: { files: [] } })
    expect(inDialog().getByRole('button', { name: 'Browse' })).toBeInTheDocument()
  })

  it('sizes read in B, KB and MB', async () => {
    const { user } = mount()
    await openCreate(user, 'JSON feed')
    const [first, second] = inDialog().getAllByRole('button', { name: 'Upload file' })
    await user.click(first!)
    await user.click(second!)
    const [a, b] = document.querySelectorAll<HTMLInputElement>('input[type="file"]')
    const big = new File(['{}'], 'big.json', { type: 'application/json' })
    Object.defineProperty(big, 'size', { value: 3 * 1024 * 1024 })
    await user.upload(a!, new File(['x'.repeat(2048)], 'medium.json', { type: 'application/json' }))
    fireEvent.change(b!, { target: { files: [big] } })
    expect(inDialog().getByText('2.0 KB')).toBeInTheDocument()
    expect(inDialog().getByText('3.00 MB')).toBeInTheDocument()
  })

  it('each content field takes its own kind of file: JSON for JSON, anything otherwise', async () => {
    const { user } = mount()
    await openCreate(user, 'JSON feed')
    for (const b of inDialog().getAllByRole('button', { name: 'Upload file' })) await user.click(b)
    expect(inDialog().getByText('.json')).toBeInTheDocument()
    expect(inDialog().getByText('*')).toBeInTheDocument()
    expect([...document.querySelectorAll('input[type="file"]')].map((i) => i.getAttribute('accept'))).toEqual(['.json', '*'])
  })

  it('switching between pasting and uploading starts the field empty', async () => {
    const { user, onCreateSource } = mount()
    await openCreate(user, 'JSON feed')
    await user.type(inDialog().getByLabelText('Name'), 'Feed')
    await user.click(inDialog().getByLabelText('JSON content'))
    await user.paste('[]')
    await user.click(inDialog().getAllByRole('button', { name: 'Upload file' })[0]!)
    await user.click(inDialog().getAllByRole('button', { name: 'Inline' })[0]!)
    expect(inDialog().getByLabelText('JSON content')).toHaveValue('')
    await user.click(inDialog().getByRole('button', { name: 'Create source' }))
    expect(onCreateSource).toHaveBeenCalledWith(expect.objectContaining({ config: {} }))
  })

  // Found by this test (tour of 23 Sep 2026), fixed: in «Upload file» mode a
  // required content was guarded by a hidden `required readOnly` input, and a
  // read-only input is barred from validation, so the source was created with
  // no content at all, where the inline mode refuses it.
  it('a required content with no file chosen blocks the creation too', async () => {
    const { user, onCreateSource } = mount()
    await openCreate(user, 'CSV file')
    await user.type(inDialog().getByLabelText('Name'), 'Inventory')
    await user.click(inDialog().getByRole('button', { name: 'Upload file' }))
    await user.click(inDialog().getByRole('button', { name: 'Create source' }))
    expect(onCreateSource).not.toHaveBeenCalled()
  })
})
