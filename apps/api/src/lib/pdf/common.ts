/**
 * Shared pdfkit primitives for audit-report PDF exports (incident, change,
 * problem). Pure layout/formatting helpers — no domain knowledge here.
 */
import PDFDocument from 'pdfkit'

export interface PdfMeta {
  generatedAt: string   // ISO
  generatedBy: string   // user email
  tenantId:    string
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export const DASH = '—' // —

export function fmtDate(v: string | null | undefined): string {
  if (!v) return DASH
  const d = new Date(v)
  if (isNaN(d.getTime())) return String(v)
  return d.toLocaleString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Europe/Rome',
  })
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return DASH
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  if (min < 60) return `${min}m ${totalSec % 60}s`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${min % 60}m`
  const d = Math.floor(h / 24)
  return `${d}g ${h % 24}h`
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function orDash(v: string | null | undefined): string {
  return v != null && String(v).trim() !== '' ? String(v) : DASH
}

// ── PDF layout constants ──────────────────────────────────────────────────────

export const PAGE_MARGIN = { top: 50, bottom: 70, left: 50, right: 50 }
export const COLOR = {
  brand:  '#2563eb',
  dark:   '#1a2332',
  text:   '#334155',
  muted:  '#94a3b8',
  border: '#e2e8f0',
  headBg: '#f1f5f9',
}

export type Doc = InstanceType<typeof PDFDocument>

export function contentWidth(doc: Doc): number {
  return doc.page.width - PAGE_MARGIN.left - PAGE_MARGIN.right
}

export function bottomLimit(doc: Doc): number {
  return doc.page.height - PAGE_MARGIN.bottom
}

export function ensureSpace(doc: Doc, needed: number): void {
  if (doc.y + needed > bottomLimit(doc)) doc.addPage()
}

export function sectionHeading(doc: Doc, title: string): void {
  ensureSpace(doc, 40)
  doc.moveDown(0.8)
  doc.fontSize(13).font('Helvetica-Bold').fillColor(COLOR.dark)
    .text(title, PAGE_MARGIN.left, doc.y)
  const y = doc.y + 2
  doc.moveTo(PAGE_MARGIN.left, y).lineTo(doc.page.width - PAGE_MARGIN.right, y)
    .lineWidth(0.8).strokeColor(COLOR.border).stroke()
  doc.moveDown(0.4)
  doc.font('Helvetica').fontSize(9).fillColor(COLOR.text)
}

export function emptyLine(doc: Doc, label: string): void {
  ensureSpace(doc, 16)
  doc.fontSize(9).font('Helvetica-Oblique').fillColor(COLOR.muted)
    .text(label, PAGE_MARGIN.left, doc.y)
  doc.font('Helvetica').fillColor(COLOR.text)
}

export interface TableCol { header: string; width: number }

/** Simple bordered table with wrapping cells and page-break handling. */
export function drawTable(doc: Doc, cols: TableCol[], rows: string[][]): void {
  const startX = PAGE_MARGIN.left
  const padX = 4
  const padY = 3

  const cellHeight = (text: string, width: number): number =>
    doc.heightOfString(text || ' ', { width: width - padX * 2 }) + padY * 2

  const drawRow = (cells: string[], bold: boolean): void => {
    doc.fontSize(8).font(bold ? 'Helvetica-Bold' : 'Helvetica')
    const h = Math.max(...cells.map((c, idx) => cellHeight(c, cols[idx]!.width)), 14)
    if (doc.y + h > bottomLimit(doc)) {
      doc.addPage()
      if (!bold) drawRow(cols.map((c) => c.header), true) // repeat header on new page
      doc.fontSize(8).font(bold ? 'Helvetica-Bold' : 'Helvetica')
    }
    const y = doc.y
    if (bold) {
      const totalW = cols.reduce((acc, c) => acc + c.width, 0)
      doc.rect(startX, y, totalW, h).fillColor(COLOR.headBg).fill()
    }
    let x = startX
    doc.fillColor(bold ? COLOR.dark : COLOR.text)
    cells.forEach((cell, idx) => {
      doc.text(cell || DASH, x + padX, y + padY, { width: cols[idx]!.width - padX * 2 })
      x += cols[idx]!.width
    })
    const totalW = cols.reduce((acc, c) => acc + c.width, 0)
    doc.moveTo(startX, y + h).lineTo(startX + totalW, y + h)
      .lineWidth(0.5).strokeColor(COLOR.border).stroke()
    doc.x = startX
    doc.y = y + h
  }

  drawRow(cols.map((c) => c.header), true)
  for (const row of rows) drawRow(row, false)
  doc.moveDown(0.5)
  doc.font('Helvetica').fontSize(9).fillColor(COLOR.text)
}

export function keyValue(doc: Doc, label: string, value: string): void {
  ensureSpace(doc, 18)
  const labelW = 110
  const y = doc.y
  doc.fontSize(9).font('Helvetica-Bold').fillColor(COLOR.muted)
    .text(label, PAGE_MARGIN.left, y, { width: labelW })
  doc.font('Helvetica').fillColor(COLOR.text)
    .text(value, PAGE_MARGIN.left + labelW, y, { width: contentWidth(doc) - labelW })
  doc.x = PAGE_MARGIN.left
  doc.moveDown(0.25)
}

export function badge(doc: Doc, x: number, y: number, label: string, color: string): number {
  doc.fontSize(8).font('Helvetica-Bold')
  const w = doc.widthOfString(label) + 14
  const h = 15
  doc.roundedRect(x, y, w, h, 4).fillColor(color).fill()
  doc.fillColor('#ffffff').text(label, x + 7, y + 4, { lineBreak: false })
  return w
}

/**
 * Document header: brand name on the left, report title on the right, then a
 * large entity title. Leaves the cursor below the title, ready for badges.
 */
export function docHeader(doc: Doc, reportTitle: string, entityTitle: string): void {
  doc.fontSize(16).font('Helvetica-Bold').fillColor(COLOR.brand)
    .text('OpenGrafo', PAGE_MARGIN.left, PAGE_MARGIN.top, { lineBreak: false })
  doc.fontSize(9).font('Helvetica').fillColor(COLOR.muted)
    .text(reportTitle, PAGE_MARGIN.left, PAGE_MARGIN.top + 2,
      { width: contentWidth(doc), align: 'right' })
  doc.y = PAGE_MARGIN.top + 28

  doc.fontSize(17).font('Helvetica-Bold').fillColor(COLOR.dark)
    .text(entityTitle, PAGE_MARGIN.left, doc.y, { width: contentWidth(doc) })
  doc.moveDown(0.4)
}

/** Multi-line paragraph block (used for comments and long text). */
export function paragraph(doc: Doc, text: string, indent = 0): void {
  doc.fontSize(9).font('Helvetica').fillColor(COLOR.text)
    .text(text || DASH, PAGE_MARGIN.left + indent, doc.y,
      { width: contentWidth(doc) - indent, lineGap: 2.5 })
  doc.x = PAGE_MARGIN.left
}

/** Footer with generation metadata + "Pagina x/y" on every buffered page. */
export function renderFooters(doc: Doc, meta: PdfMeta): void {
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    const prevBottom = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    const y = doc.page.height - 45
    doc.moveTo(PAGE_MARGIN.left, y - 5).lineTo(doc.page.width - PAGE_MARGIN.right, y - 5)
      .lineWidth(0.5).strokeColor(COLOR.border).stroke()
    doc.fontSize(7.5).font('Helvetica').fillColor(COLOR.muted)
    doc.text(
      `Generato il ${meta.generatedAt} da ${meta.generatedBy} ${DASH} tenant ${meta.tenantId}`,
      PAGE_MARGIN.left, y,
      { width: contentWidth(doc) - 80, lineBreak: false },
    )
    doc.text(
      `Pagina ${i - range.start + 1}/${range.count}`,
      PAGE_MARGIN.left, y,
      { width: contentWidth(doc), align: 'right', lineBreak: false },
    )
    doc.page.margins.bottom = prevBottom
  }
}

/**
 * Creates an A4 buffered-pages document, runs `render`, applies footers and
 * resolves with the concatenated PDF buffer.
 */
export function createPdfBuffer(
  title: string,
  meta: PdfMeta,
  render: (doc: Doc) => void,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: PAGE_MARGIN,
      bufferPages: true,
      info: { Title: title, Author: 'OpenGrafo', Creator: 'OpenGrafo' },
    })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    try {
      render(doc)
      renderFooters(doc, meta)
      doc.end()
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
