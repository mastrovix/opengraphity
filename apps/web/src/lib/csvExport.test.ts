/**
 * CSV EXPORT OF A LIST: the file a person opens in Excel.
 *
 * The columns are the table's (key + label) and the values are read raw from
 * the rows, not from what the cells render. What must not break: a value
 * with a comma, a quote, a line break or a semicolon must stay in its cell
 * (otherwise every column after it shifts), a nested object such as an
 * assignee is written by its name, the file starts with a BOM so Excel reads
 * accented letters right, and the file gets its name with `.csv` once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { exportToCsv } from './csvExport'

interface Download { href: string; download: string; blob: Blob; revoked: string[] }

let downloads: Download[]
let pending: { blob?: Blob; revoked: string[] }

beforeEach(() => {
  downloads = []
  pending = { revoked: [] }
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { pending.blob = blob as Blob; return 'blob:csv-1' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { pending.revoked.push(url) })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    // What had been released at the moment of the click: releasing the link before it would break the download.
    downloads.push({ href: this.href, download: this.download, blob: pending.blob!, revoked: [...pending.revoked] })
  })
})

afterEach(() => { vi.restoreAllMocks() })

/** The file as bytes decoded without dropping the BOM. */
async function content(d: Download): Promise<string> {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(await d.blob.arrayBuffer()))
}

describe('exportToCsv', () => {
  it('writes the labels, then one line per row in column order, with a BOM and Windows line ends', async () => {
    exportToCsv('incidents', [{ key: 'number', label: 'Number' }, { key: 'title', label: 'Title' }], [
      { number: 'INC-1', title: 'Mail down', ignored: 'x' },
      { number: 'INC-2', title: 'VPN slow', ignored: 'y' },
    ])
    expect(downloads).toHaveLength(1)
    expect(await content(downloads[0]!)).toBe('\uFEFFNumber,Title\r\nINC-1,Mail down\r\nINC-2,VPN slow')
    expect(downloads[0]!.blob.type).toBe('text/csv;charset=utf-8')
  })

  it('a value with a comma, a quote, a line break or a semicolon stays in its cell', async () => {
    exportToCsv('x', [{ key: 'v', label: 'Value' }], [
      { v: 'a,b' }, { v: 'say "hi"' }, { v: 'two\nlines' }, { v: 'carriage\rreturn' }, { v: 'semi;colon' }, { v: 'plain' },
    ])
    expect((await content(downloads[0]!)).split('\r\n').slice(1)).toEqual([
      '"a,b"', '"say ""hi"""', '"two\nlines"', '"carriage\rreturn"', '"semi;colon"', 'plain',
    ])
  })

  it('a label is escaped like a value', async () => {
    exportToCsv('x', [{ key: 'v', label: 'Impact, urgency' }], [])
    expect(await content(downloads[0]!)).toBe('\uFEFF"Impact, urgency"')
  })

  it('an object is written by its name, any other object as JSON, and a missing value as an empty cell', async () => {
    exportToCsv('x', [
      { key: 'assignee', label: 'Assignee' }, { key: 'tags', label: 'Tags' }, { key: 'meta', label: 'Meta' },
      { key: 'count', label: 'Count' }, { key: 'open', label: 'Open' }, { key: 'none', label: 'None' }, { key: 'missing', label: 'Missing' },
    ], [
      { assignee: { id: 'u1', name: 'Anna' }, tags: ['vpn', 'mail'], meta: { id: 7 }, count: 3, open: false, none: null, missing: undefined },
    ])
    expect((await content(downloads[0]!)).split('\r\n')[1]).toBe('Anna,"[""vpn"",""mail""]","{""id"":7}",3,false,,')
  })

  it('names the file after the list, adding .csv only when it is not there', () => {
    exportToCsv('teams', [{ key: 'name', label: 'Name' }], [])
    exportToCsv('report.csv', [{ key: 'name', label: 'Name' }], [])
    expect(downloads.map((d) => d.download)).toEqual(['teams.csv', 'report.csv'])
    expect(downloads[0]!.href).toBe('blob:csv-1')
  })

  it('releases the temporary link once the download has started', () => {
    exportToCsv('teams', [{ key: 'name', label: 'Name' }], [])
    expect(downloads[0]!.revoked).toEqual([])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:csv-1')
  })
})
