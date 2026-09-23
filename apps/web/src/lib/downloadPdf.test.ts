/**
 * DOWNLOADING A FILE FROM THE API (ticket PDFs, report exports).
 *
 * An `/api/…` path opened with a plain link carries no token, so files are
 * fetched with the bearer header and handed to the browser as a download.
 * The file name is the one the server gives in Content-Disposition — plain,
 * quoted, or RFC 5987 encoded for accented names — and only without one the
 * caller's fallback. A refused request must fail with its status instead of
 * saving an error page as «report.pdf».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { downloadFile, filenameFromDisposition } from './downloadPdf'

describe('filenameFromDisposition', () => {
  it('reads a quoted, a bare and an RFC 5987 encoded name', () => {
    expect(filenameFromDisposition('attachment; filename="INC00000042.pdf"')).toBe('INC00000042.pdf')
    expect(filenameFromDisposition('attachment; filename=sla-report.xlsx')).toBe('sla-report.xlsx')
    expect(filenameFromDisposition("attachment; filename*=UTF-8''Rapporto%20SLA%20%E2%80%93%20settembre.pdf")).toBe('Rapporto SLA – settembre.pdf')
  })

  it('no header, or a header without a name, gives no name', () => {
    expect(filenameFromDisposition(null)).toBeNull()
    expect(filenameFromDisposition('')).toBeNull()
    expect(filenameFromDisposition('inline')).toBeNull()
  })
})

describe('downloadFile', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let clicked: Array<{ href: string; download: string }>

  beforeEach(() => {
    clicked = []
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:file-1')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download })
    })
  })

  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const answer = (status: number, statusText: string, disposition: string | null) => ({
    ok: status >= 200 && status < 300, status, statusText,
    headers: new Headers(disposition ? { 'Content-Disposition': disposition } : {}),
    blob: async () => new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
  })

  it('fetches with the bearer token and saves the file under the server\'s name', async () => {
    fetchMock.mockResolvedValue(answer(200, 'OK', 'attachment; filename="INC00000042.pdf"'))
    await downloadFile('/api/incidents/inc-42/pdf', 'incident.pdf')
    const [url, init] = fetchMock.mock.calls[0]! as [string, { headers: Record<string, string> }]
    expect(url).toBe('/api/incidents/inc-42/pdf')
    const headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]))
    expect(headers).toEqual({ authorization: 'Bearer test-token' })
    expect(clicked).toEqual([{ href: 'blob:file-1', download: 'INC00000042.pdf' }])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:file-1')
  })

  it('without a name from the server it uses the one it was given', async () => {
    fetchMock.mockResolvedValue(answer(200, 'OK', null))
    await downloadFile('/api/reports/sla.xlsx', 'sla-report.xlsx')
    expect(clicked).toEqual([{ href: 'blob:file-1', download: 'sla-report.xlsx' }])
  })

  it('a refused request fails with its status, and nothing is saved', async () => {
    fetchMock.mockResolvedValue(answer(403, 'Forbidden', null))
    await expect(downloadFile('/api/reports/sla.xlsx', 'sla-report.xlsx')).rejects.toThrow('403 Forbidden')
    expect(clicked).toEqual([])
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
