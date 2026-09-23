/**
 * THE «EXPORT CSV» BUTTON of the lists.
 *
 * The export fetches ALL the filtered rows, not just the page on screen, so it
 * can take a while: the button must show it is working and refuse a second
 * click (two clicks = two downloads of the same file), and it must come back
 * usable whatever happens. A failed export must tell the user why — a button
 * that silently goes back to idle reads as «the file is somewhere».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { ExportCsvButton } = await import('./ExportCsvButton')

beforeEach(() => { toast.error.mockReset() })

/** A promise the test settles by hand, to look at the button while it waits. */
function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const button = () => screen.getByRole('button', { name: 'Export CSV' })

describe('ExportCsvButton', () => {
  it('says what it does: the label and a tooltip that promises all the filtered rows', () => {
    render(<ExportCsvButton onExport={vi.fn(async () => {})} />)
    expect(button()).toHaveAttribute('title', 'Download all filtered rows as CSV')
    expect(button()).toBeEnabled()
  })

  it('while the export runs the button spins and cannot be clicked again; it comes back when done', async () => {
    const user = userEvent.setup()
    const run = deferred()
    const onExport = vi.fn(() => run.promise)
    render(<ExportCsvButton onExport={onExport} />)
    await user.click(button())
    expect(button()).toBeDisabled()
    expect(button().querySelector('.animate-spin')).not.toBeNull()
    await user.click(button())
    expect(onExport).toHaveBeenCalledTimes(1)
    run.resolve()
    await waitFor(() => expect(button()).toBeEnabled())
    expect(button().querySelector('.animate-spin')).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a failed export shows the reason and the button is usable again', async () => {
    const user = userEvent.setup()
    render(<ExportCsvButton onExport={vi.fn(async () => { throw new Error('Too many rows: narrow the filter') })} />)
    await user.click(button())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Too many rows: narrow the filter'))
    await waitFor(() => expect(button()).toBeEnabled())
  })

  it('a failure without a message says that the export failed, not nothing', async () => {
    const user = userEvent.setup()
    render(<ExportCsvButton onExport={() => Promise.reject('network down')} />)
    await user.click(button())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Export failed'))
    await waitFor(() => expect(button()).toBeEnabled())
  })
})
