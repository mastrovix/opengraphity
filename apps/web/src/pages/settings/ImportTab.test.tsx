/**
 * HISTORICAL DATA IMPORT: incidents, problems, changes, service requests and
 * KB articles from a CSV file.
 *
 * The import writes tickets in bulk, so the page forces a dry-run first: the
 * Import button unlocks only after a dry-run of the very inputs on screen,
 * and any change of key, entity or file locks it again. If that regresses, a
 * file is imported without being checked, or the check of one file unlocks
 * the import of another. Also pinned here: what is posted (the file, to the
 * entity's route, with the API key as header), the confirmation when rows
 * will be skipped, the server's refusal shown as the server wrote it, and
 * every problem row read in the language of whoever imports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { apiUrl } from '@/lib/apiBase'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { ImportTab } = await import('./ImportTab')

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> }
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Reply>>()
const answer = (body: unknown, status = 200): Reply => ({ ok: status < 300, status, json: async () => body })
const notJson = (status: number): Reply => ({ ok: false, status, json: async () => { throw new SyntaxError('Unexpected token <') } })

const CLEAN = { totalRows: 12, created: 10, updated: 2, errors: [], warnings: [] }
const WITH_ISSUES = {
  totalRows: 5, created: 2, updated: 0,
  errors: [
    // The server sends a key and its data: the sentence is composed in the importer's language.
    { row: 2, externalId: 'INC-1', message: 'titolo obbligatorio', messageKey: 'titleRequired' },
    { row: 3, externalId: null, message: 'scrittura fallita', messageKey: 'writeFailed', messageParams: { error: 'disk full' } },
  ],
  warnings: [
    { row: 4, externalId: 'INC-4', message: 'team NOC not found' },
    // A key this web does not know yet (a newer API): the server's own sentence is shown.
    { row: 5, externalId: 'INC-5', message: 'assignee kept from the previous row', messageKey: 'brandNewCheck' },
  ],
}

const itilField = (name: string, order: number, isSystem = false) => ({
  id: `f-${name}`, name, label: name, fieldType: 'string', required: false, enumValues: [], order, isSystem,
  enumTypeId: null, enumTypeName: null, visibleToEndUser: false,
})

beforeEach(() => {
  apolloFinto.reset()
  for (const f of Object.values(toast)) f.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [
    { name: 'incident', fields: [itilField('title', 1, true), itilField('vendor_ref', 12), itilField('cost_center', 11)] },
    { name: 'problem', fields: [itilField('title', 1, true)] },
  ] }
})
afterEach(() => { vi.unstubAllGlobals() })

const KEY_PLACEHOLDER = 'Paste an API key with write permissions'
const dryRunButton = () => screen.getByRole('button', { name: 'Dry-run' })
const importButton = () => screen.getByRole('button', { name: 'Import' })
const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!
const csv = (name = 'incidents.csv', body = 'external_id,title,severity\nINC-1,Disk full,high') => new File([body], name, { type: 'text/csv' })

async function ready(user: ReturnType<typeof renderWithProviders>['user'], file = csv()) {
  await user.type(screen.getByPlaceholderText(KEY_PLACEHOLDER), 'k-123')
  await user.upload(fileInput(), file)
}

describe('ImportTab — before running', () => {
  it('nothing runs without a key and a file, and the page says a dry-run comes first', async () => {
    const { user } = renderWithProviders(<ImportTab />)
    expect(screen.getByText('No file selected')).toBeInTheDocument()
    expect(dryRunButton()).toBeDisabled()
    expect(importButton()).toBeDisabled()
    expect(screen.getByText('Run a dry-run first to enable the import')).toBeInTheDocument()
    // Where to get a key: the import is authenticated by key, not by the session.
    expect(screen.getByRole('link', { name: 'Create an API key in Integrations' })).toHaveAttribute('href', '/admin/integrations')
    await user.type(screen.getByPlaceholderText(KEY_PLACEHOLDER), 'k-123')
    expect(screen.getByPlaceholderText(KEY_PLACEHOLDER)).toHaveAttribute('type', 'password')
    expect(dryRunButton()).toBeDisabled()
    await user.upload(fileInput(), csv())
    expect(dryRunButton()).toBeEnabled()
    // A file alone does not unlock the import: only a dry-run does.
    expect(importButton()).toBeDisabled()
  })

  it('the expected columns follow the entity; ticket types add one column per custom field, KB articles none', async () => {
    const { user } = renderWithProviders(<ImportTab />)
    expect(screen.getByText(/^external_id\*, title\*, severity\*/)).toBeInTheDocument()
    // The customer's own fields, in their order, system fields left out.
    expect(screen.getByText('cost_center, vendor_ref')).toBeInTheDocument()
    expect(screen.getByText('Plus one column for each custom field:')).toBeInTheDocument()

    const entity = screen.getByRole('combobox')
    expect(within(entity).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['Incidents', 'Problems', 'Changes', 'Service requests', 'KB articles'])
    await user.selectOptions(entity, 'Problems')
    expect(screen.getByText(/^external_id\*, title\*, priority\*, impact/)).toBeInTheDocument()
    // No custom field on problems: no line promising some.
    expect(screen.queryByText('Plus one column for each custom field:')).toBeNull()
    await user.selectOptions(entity, 'KB articles')
    expect(screen.getByText(/^external_id\*, title\*, body, category/)).toBeInTheDocument()
    expect(screen.queryByText('Plus one column for each custom field:')).toBeNull()
  })

  it('«Choose file» opens the file picker; a chosen file shows name and size, and can be removed', async () => {
    const { user } = renderWithProviders(<ImportTab />)
    const picker = vi.spyOn(fileInput(), 'click')
    await user.click(screen.getByRole('button', { name: 'Choose file' }))
    expect(picker).toHaveBeenCalledTimes(1)
    expect(fileInput()).toHaveAttribute('accept', '.csv,text/csv')

    await user.upload(fileInput(), csv('incidents.csv', 'x'.repeat(1536)))
    expect(screen.getByText('incidents.csv')).toBeInTheDocument()
    expect(screen.getByText('1.5 KB')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByText('No file selected')).toBeInTheDocument()
    expect(fileInput()).toHaveValue('')
  })

  it('a picker cancelled after a file was chosen (the browser then reports no file) drops the file and its dry-run', async () => {
    fetchMock.mockResolvedValue(answer(CLEAN))
    const { user } = renderWithProviders(<ImportTab />)
    await ready(user)
    await user.click(dryRunButton())
    await screen.findByText('Dry-run result')
    fireEvent.change(fileInput(), { target: { files: [] } })
    expect(screen.getByText('No file selected')).toBeInTheDocument()
    expect(screen.queryByText('Dry-run result')).toBeNull()
    expect(dryRunButton()).toBeDisabled()
    expect(importButton()).toBeDisabled()
  })

  it('sizes read in bytes and in megabytes too', async () => {
    const { user } = renderWithProviders(<ImportTab />)
    await user.upload(fileInput(), csv('small.csv', 'a,b'))
    expect(screen.getByText('3 B')).toBeInTheDocument()
    const big = csv('big.csv')
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 })
    await user.upload(fileInput(), big)
    expect(screen.getByText('5.0 MB')).toBeInTheDocument()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the label «API key» was a
  // plain <div> (FieldLabel without htmlFor) and the field had no name of its
  // own, so a screen reader announced a nameless password field.
  it('the API key field is announced by its label', () => {
    renderWithProviders(<ImportTab />)
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password')
  })

  // Found with the one above, fixed the same way: the entity list had no name either.
  it('the entity list is announced by its label', () => {
    renderWithProviders(<ImportTab />)
    expect(screen.getByLabelText('Entity type')).toHaveValue('incidents')
  })
})

describe('ImportTab — dry-run', () => {
  it('posts the file to the chosen entity\'s import with the key as header, and shows a clean report', async () => {
    fetchMock.mockResolvedValue(answer(CLEAN))
    const { user } = renderWithProviders(<ImportTab />)
    const file = csv()
    await ready(user, file)
    await user.selectOptions(screen.getByRole('combobox'), 'Changes')
    await user.click(dryRunButton())

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(apiUrl('/api/v1/import/changes?dryRun=true'))
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'X-API-Key': 'k-123' })
    expect((init.body as FormData).get('file')).toBe(file)

    expect(await screen.findByText('Dry-run result')).toBeInTheDocument()
    expect(screen.getByText('Total rows: 12')).toBeInTheDocument()
    expect(screen.getByText('To create: 10')).toBeInTheDocument()
    expect(screen.getByText('To update: 2')).toBeInTheDocument()
    expect(screen.getByText('Errors: 0')).toBeInTheDocument()
    expect(screen.getByText('No errors or warnings')).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith('Dry-run completed with no errors')
    expect(importButton()).toBeEnabled()
    expect(screen.queryByText('Run a dry-run first to enable the import')).toBeNull()
  })

  it('the problems found are listed row by row, in the importer\'s language', async () => {
    fetchMock.mockResolvedValue(answer(WITH_ISSUES))
    const { user } = renderWithProviders(<ImportTab />)
    await ready(user)
    await user.click(dryRunButton())
    expect(await screen.findByText('Errors: 2')).toBeInTheDocument()
    expect(toast.warning).toHaveBeenCalledWith('Dry-run completed with 2 error rows')

    const [errors, warnings] = screen.getAllByRole('table')
    const rows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1)
      .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))
    expect(within(errors!).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Row', 'External ID', 'Message'])
    expect(rows(errors!)).toEqual([
      ['2', 'INC-1', 'title is required'],
      ['3', '—', 'write failed: disk full'],
    ])
    expect(rows(warnings!)).toEqual([
      ['4', 'INC-4', 'team NOC not found'],
      ['5', 'INC-5', 'assignee kept from the previous row'],
    ])
    expect(screen.queryByText('No errors or warnings')).toBeNull()
  })

  it('warnings alone are listed without an errors table', async () => {
    fetchMock.mockResolvedValue(answer({ ...CLEAN, warnings: WITH_ISSUES.warnings }))
    const { user } = renderWithProviders(<ImportTab />)
    await ready(user)
    await user.click(dryRunButton())
    expect(await screen.findByText('Warnings')).toBeInTheDocument()
    expect(screen.getAllByRole('table')).toHaveLength(1)
    expect(toast.success).toHaveBeenCalledWith('Dry-run completed with no errors')
  })

  it('while a request runs, both buttons wait and say so', async () => {
    let reply!: (r: Reply) => void
    fetchMock.mockReturnValue(new Promise<Reply>((resolve) => { reply = resolve }))
    const { user } = renderWithProviders(<ImportTab />)
    await ready(user)
    await user.click(dryRunButton())
    const running = await screen.findByRole('button', { name: 'Processing…' })
    expect(running).toBeDisabled()
    expect(importButton()).toBeDisabled()
    reply(answer(CLEAN))
    expect(await screen.findByText('Dry-run result')).toBeInTheDocument()
    expect(dryRunButton()).toBeEnabled()
  })

  it('any change of key, entity or file throws the dry-run away and locks the import again', async () => {
    fetchMock.mockResolvedValue(answer(CLEAN))
    const { user } = renderWithProviders(<ImportTab />)
    await ready(user)
    const again = async () => {
      await user.click(dryRunButton())
      await screen.findByText('Dry-run result')
      expect(importButton()).toBeEnabled()
    }
    await again()
    await user.selectOptions(screen.getByRole('combobox'), 'Problems')
    expect(screen.queryByText('Dry-run result')).toBeNull()
    expect(importButton()).toBeDisabled()
    await again()
    await user.type(screen.getByPlaceholderText(KEY_PLACEHOLDER), '4')
    expect(screen.queryByText('Dry-run result')).toBeNull()
    expect(importButton()).toBeDisabled()
    await again()
    await user.upload(fileInput(), csv('other.csv'))
    expect(screen.queryByText('Dry-run result')).toBeNull()
    expect(importButton()).toBeDisabled()
  })
})

describe('ImportTab — import', () => {
  it('after a clean dry-run, Import imports the same file for real and reports it', async () => {
    fetchMock.mockResolvedValueOnce(answer(CLEAN)).mockResolvedValueOnce(answer({ ...CLEAN, created: 9, updated: 3 }))
    const { user } = renderWithProviders(<ImportTab />)
    await ready(user)
    await user.click(dryRunButton())
    await screen.findByText('Dry-run result')
    await user.click(importButton())

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1]![0]).toBe(apiUrl('/api/v1/import/incidents?dryRun=false'))
    expect(await screen.findByText('Import result')).toBeInTheDocument()
    expect(toast.success).toHaveBeenLastCalledWith('Import completed: 9 created, 3 updated')
    // What was imported cannot be imported twice by a second click.
    expect(importButton()).toBeDisabled()
    expect(screen.getByText('Run a dry-run first to enable the import')).toBeInTheDocument()
  })

  it('with rows in error the import asks first; declining imports nothing', async () => {
    fetchMock.mockResolvedValue(answer(WITH_ISSUES))
    const { user } = renderWithProviders(<ImportTab />)
    await ready(user)
    await user.click(dryRunButton())
    await screen.findByText('Errors: 2')
    await user.click(importButton())
    const confirm = await screen.findByRole('dialog')
    expect(within(confirm).getByText('2 rows have errors and will be skipped. Continue with the import?')).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('confirming imports anyway', async () => {
    fetchMock.mockResolvedValueOnce(answer(WITH_ISSUES)).mockResolvedValueOnce(answer({ ...WITH_ISSUES, errors: [WITH_ISSUES.errors[0]] }))
    const { user } = renderWithProviders(<ImportTab />)
    await ready(user)
    await user.click(dryRunButton())
    await screen.findByText('Errors: 2')
    await user.click(importButton())
    const confirm = await screen.findByRole('dialog')
    await user.click(within(confirm).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1]![0]).toBe(apiUrl('/api/v1/import/incidents?dryRun=false'))
    expect(await screen.findByText('Import result')).toBeInTheDocument()
  })
})

describe('ImportTab — failures', () => {
  it.each([
    ['a plain error', answer({ error: 'API key lacks write permission' }, 403), 'API key lacks write permission'],
    ['an error object', answer({ error: { message: 'File larger than 10 MB' } }, 413), 'File larger than 10 MB'],
    ['a body without an error', answer({ detail: 'nope' }, 400), 'Import request failed (HTTP 400)'],
    ['a body that is not JSON', notJson(502), 'Import request failed (HTTP 502)'],
  ])('a refusal with %s is shown as the server wrote it, or with its HTTP status', async (_case, reply, shown) => {
    fetchMock.mockResolvedValue(reply)
    const { user } = renderWithProviders(<ImportTab />)
    await ready(user)
    await user.click(dryRunButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(shown))
    expect(screen.queryByText('Dry-run result')).toBeNull()
    expect(importButton()).toBeDisabled()
    expect(dryRunButton()).toBeEnabled()
  })

  it('a request that cannot reach the server says so, and the page can retry', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(answer(CLEAN))
    const { user } = renderWithProviders(<ImportTab />)
    await ready(user)
    await user.click(dryRunButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Import request failed: Failed to fetch'))
    await user.click(dryRunButton())
    expect(await screen.findByText('Dry-run result')).toBeInTheDocument()
  })
})
