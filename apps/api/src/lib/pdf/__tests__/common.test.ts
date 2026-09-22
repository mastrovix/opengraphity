/**
 * Shared pdfkit primitives of the audit dossiers (incident, change, problem).
 *
 * Why these behaviours matter: the dossier is what an auditor reads after the
 * fact. A table that does not break across pages loses rows off the bottom of
 * the sheet; a header without the organisation's brand, or a render error
 * swallowed instead of rejected, produces a document that looks complete and
 * is not. The formatting helpers decide what a missing value looks like (a
 * dash, never "null" or "NaN").
 */
import { describe, it, expect } from 'vitest'
import PDFDocument from 'pdfkit'
import {
  DASH, fmtDate, fmtDuration, fmtBytes, orDash, valueColorInk, VALUE_COLOR_INK, COLOR,
  ensureSpace, bottomLimit, sectionHeading, emptyLine, drawTable, keyValue, badge, docHeader,
  paragraph, createPdfBuffer, type PdfMeta, type Doc,
} from '../common.js'

// A valid 1x1 PNG: pdfkit parses the logo, so it must be a real image.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

const meta = (logoPng: Buffer | null = null): PdfMeta => ({
  generatedAt: '2026-09-22T10:00:00.000Z', generatedBy: 'auditor@acme.com', tenantId: 't1',
  locale: { language: 'en', timeZone: 'UTC' },
  brand: { displayName: 'Acme', logoPng },
})

/** Page count of a rendered PDF, read from its page tree. */
const pageCount = (pdf: Buffer): number => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length

describe('formatting helpers', () => {
  it('fmtDate: a value that is not a date is shown as written, not as "Invalid Date"', () => {
    expect(fmtDate('not a date', { language: 'en', timeZone: 'UTC' })).toBe('not a date')
  })

  it('fmtDate: Italian and any other language are honoured', () => {
    const at = '2026-01-15T12:00:00.000Z'
    expect(fmtDate(at, { language: 'it', timeZone: 'UTC' })).toBe('15/01/2026, 12:00:00')
    expect(fmtDate(at, { language: 'de', timeZone: 'UTC' })).toContain('15.01.2026')
  })

  it('fmtDuration covers every unit and uses the dossier language for days', () => {
    expect(fmtDuration(null)).toBe(DASH)
    expect(fmtDuration(45_000)).toBe('45s')
    expect(fmtDuration(125_000)).toBe('2m 5s')
    expect(fmtDuration(2 * 3600_000 + 5 * 60_000)).toBe('2h 5m')
    expect(fmtDuration(26 * 3600_000, 'g')).toBe('1g 2h')
  })

  it('fmtBytes picks B, KB or MB', () => {
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(2048)).toBe('2.0 KB')
    expect(fmtBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('orDash turns blank values into a dash', () => {
    expect(orDash('  ')).toBe(DASH)
    expect(orDash(null)).toBe(DASH)
    expect(orDash('x')).toBe('x')
  })

  it('a value with no colour in the Dictionary is neutral, as on the web', () => {
    expect(valueColorInk(null)).toBe(COLOR.muted)
    expect(valueColorInk('danger')).toBe(VALUE_COLOR_INK.danger)
  })
})

describe('layout primitives', () => {
  it('ensureSpace adds a page only when the content would cross the bottom margin', () => {
    const doc = new PDFDocument({ size: 'A4', bufferPages: true }) as Doc
    ensureSpace(doc, 10)
    expect(doc.bufferedPageRange().count).toBe(1)
    doc.y = bottomLimit(doc) - 5
    ensureSpace(doc, 10)
    expect(doc.bufferedPageRange().count).toBe(2)
    doc.end()
  })

  it('a long table breaks across pages instead of running off the sheet', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`row ${String(i)}`, ''])
    const pdf = await createPdfBuffer('T', meta(), (doc) => {
      docHeader(doc, 'Audit report', 'INC00000001')
      sectionHeading(doc, 'Timeline')
      drawTable(doc, [{ header: 'Event', width: 200 }, { header: 'Note', width: 200 }], rows)
      emptyLine(doc, 'No attachments')
      keyValue(doc, 'Status', 'closed')
      badge(doc, 50, doc.y, 'HIGH', valueColorInk('danger'))
      paragraph(doc, '')
      paragraph(doc, 'indented', 20)
    })
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pageCount(pdf)).toBeGreaterThan(1)
  })

  it('badge returns its width so badges can be laid out in a row', () => {
    const doc = new PDFDocument({ size: 'A4' }) as Doc
    const short = badge(doc, 0, 0, 'P1', '#000000')
    const long = badge(doc, 0, 0, 'CRITICAL PRIORITY', '#000000')
    expect(long).toBeGreaterThan(short)
    doc.end()
  })
})

describe('docHeader and createPdfBuffer', () => {
  it('draws the organisation logo when it is a PNG', async () => {
    const pdf = await createPdfBuffer('T', meta(PNG_1X1), (doc) => docHeader(doc, 'Audit report', 'CHG1'))
    // The PNG becomes an image XObject in the document.
    expect(pdf.toString('latin1')).toContain('/Subtype /Image')
  })

  it('refuses a header on a document not built by createPdfBuffer: its brand would be unknown', () => {
    const doc = new PDFDocument() as Doc
    expect(() => docHeader(doc, 'Audit report', 'X')).toThrow(/docHeader outside createPdfBuffer/)
    doc.end()
  })

  it('a render error rejects the promise instead of producing a truncated document', async () => {
    await expect(createPdfBuffer('T', meta(), () => { throw new Error('render broke') })).rejects.toThrow('render broke')
    // A non-Error throw is still turned into an Error, so callers can read `.message`.
    await expect(createPdfBuffer('T', meta(), () => { throw 'bad' as unknown as Error })).rejects.toThrow('bad')
  })
})
