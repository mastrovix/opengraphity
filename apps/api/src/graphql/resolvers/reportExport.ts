import path from 'path'
import fs from 'fs'
import type ExcelJS from 'exceljs'
import { v4 as uuidv4 } from 'uuid'
import type { GraphQLContext } from '../../context.js'
import { NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { executeReportSection } from '../../lib/reportExecutor.js'
import type { ReportSectionDef } from '../../lib/reportQueryBuilder.js'
import { getSession } from '@opengraphity/neo4j'
import { logger } from '../../lib/logger.js'

const REPORT_DIR = process.env['REPORT_DIR'] ?? path.resolve('./data/reports')

if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true })

// Cleanup files older than 2 hours every 30 minutes
setInterval(() => {
  try {
    const threshold = Date.now() - 2 * 60 * 60 * 1000
    for (const file of fs.readdirSync(REPORT_DIR)) {
      const fp = path.join(REPORT_DIR, file)
      const stat = fs.statSync(fp)
      if (stat.mtimeMs < threshold) fs.unlinkSync(fp)
    }
  } catch (err) {
    // Best-effort cleanup, but disk-filling failures must be visible.
    logger.warn({ err }, '[reportExport] cleanup of old report files failed')
  }
}, 30 * 60 * 1000)

type Props = Record<string, unknown>

function mapSection(p: Props): ReportSectionDef {
  return {
    id:            p['id']               as string,
    order:         Math.round(Number(p['order'] ?? 0)),
    title:         p['title']            as string,
    chartType:     p['chart_type']       as string,
    groupByNodeId: p['group_by_node_id'] as string | null ?? null,
    groupByField:  p['group_by_field']   as string | null ?? null,
    metric:        p['metric']           as string,
    metricField:   p['metric_field']     as string | null ?? null,
    limit:         p['limit_val']        as number | null ?? null,
    sortDir:       p['sort_dir']         as string | null ?? null,
    nodes: [], edges: [],
  }
}

async function loadSectionsForTemplate(templateId: string, tenantId: string): Promise<{ name: string; sections: ReportSectionDef[] } | null> {
  const session = getSession(undefined, 'READ')
  try {
    const tplRes = await session.executeRead(tx =>
      tx.run(`MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId}) RETURN r.name AS name`, { id: templateId, tenantId }),
    )
    if (!tplRes.records.length) return null
    const name = tplRes.records[0].get('name') as string

    const secRes = await session.executeRead(tx =>
      tx.run(`MATCH (r:ReportTemplate {id: $id})-[:HAS_SECTION]->(s:ReportSection) RETURN properties(s) AS props ORDER BY s.order ASC`, { id: templateId }),
    )
    const sections = secRes.records.map(r => mapSection(r.get('props') as Props))
    return { name, sections }
  } finally {
    await session.close()
  }
}

interface TableData { columns: string[]; rows: unknown[][] }
interface SectionData {
  title: string
  chartType: string
  rows: Array<{ name: string; value: number }> | null
  kpiValue: number | null
  tableRows: TableData | null
  /** Execution error — rendered in the document, never silently dropped. */
  error: string | null
}

async function fetchSectionData(sections: ReportSectionDef[], tenantId: string): Promise<SectionData[]> {
  const results = await Promise.all(sections.map(s => executeReportSection(s, tenantId)))
  return results.map(r => {
    // A failed section must appear AS FAILED in the exported document — an
    // empty page in a delivered audit PDF is a lie.
    if (r.error) {
      return { title: r.title, chartType: r.chartType, rows: null, kpiValue: null, tableRows: null, error: r.error }
    }
    let parsed: unknown
    try { parsed = JSON.parse(r.data) }
    catch (e) {
      return { title: r.title, chartType: r.chartType, rows: null, kpiValue: null, tableRows: null, error: `Dati sezione corrotti: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (r.chartType === 'kpi') {
      return { title: r.title, chartType: r.chartType, rows: null, kpiValue: (parsed as { value: number } | null)?.value ?? null, tableRows: null, error: null }
    }
    if (r.chartType === 'table') {
      // executeReportSection produces { columns, rows } for tables
      const t = parsed as TableData | null
      const tableRows = t && Array.isArray(t.columns) && Array.isArray(t.rows) ? t : null
      return {
        title: r.title, chartType: r.chartType, rows: null, kpiValue: null, tableRows,
        error: tableRows ? null : 'Formato dati tabella inatteso',
      }
    }
    return { title: r.title, chartType: r.chartType, rows: Array.isArray(parsed) ? parsed as Array<{ name: string; value: number }> : null, kpiValue: null, tableRows: null, error: null }
  })
}

async function generatePDF(templateName: string, data: SectionData[], filePath: string): Promise<void> {
  const PDFDocument = (await import('pdfkit')).default
  const doc = new PDFDocument({ margin: 50, size: 'A4' })
  const stream = fs.createWriteStream(filePath)
  doc.pipe(stream)

  // Title
  doc.fontSize(20).fillColor('#1a2332').text(templateName, { align: 'center' })
  doc.moveDown(0.5)
  doc.fontSize(10).fillColor('#94a3b8').text(new Date().toLocaleString(), { align: 'center' })
  doc.moveDown(1.5)

  for (const sec of data) {
    doc.fontSize(14).fillColor('#334155').text(sec.title, { underline: true })
    doc.moveDown(0.5)

    if (sec.error) {
      doc.fontSize(10).fillColor('#dc2626').text(`ERRORE: ${sec.error}`)
    } else if (sec.chartType === 'kpi' && sec.kpiValue !== null) {
      doc.fontSize(28).fillColor('#0f172a').text(String(sec.kpiValue), { align: 'center' })
    } else if (sec.rows) {
      for (const row of sec.rows.slice(0, 50)) {
        doc.fontSize(10).fillColor('#334155').text(`${row.name}: ${row.value}`)
      }
    } else if (sec.tableRows) {
      const cols = sec.tableRows.columns.slice(0, 6)
      const colIdx = cols.map(c => sec.tableRows!.columns.indexOf(c))
      doc.fontSize(9).fillColor('#475569').text(cols.join(' | '))
      doc.moveDown(0.2)
      for (const row of sec.tableRows.rows.slice(0, 30)) {
        doc.fontSize(9).fillColor('#334155').text(colIdx.map(i => String((row as unknown[])[i] ?? '')).join(' | '))
      }
    }
    doc.moveDown(1)
  }

  doc.end()
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve)
    stream.on('error', reject)
  })
}

async function generateExcel(templateName: string, data: SectionData[], filePath: string): Promise<void> {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'OpenGraphity'
  workbook.created = new Date()

  const summary = workbook.addWorksheet('Summary')
  summary.getCell('A1').value = templateName
  summary.getCell('A1').font = { bold: true, size: 14 }
  summary.getCell('A2').value = new Date().toLocaleString()
  summary.getCell('A2').font = { color: { argb: 'FF94A3B8' } }
  summary.getCell('A3').value = `${data.length} sezione/i`
  summary.columns = [{ width: 40 }]

  for (const sec of data) {
    const safeName = sec.title.replace(/[\\/*?:[\]]/g, '_').slice(0, 31)
    const sheet = workbook.addWorksheet(safeName)

    sheet.getCell('A1').value = sec.title
    sheet.getCell('A1').font = { bold: true, size: 12 }
    sheet.getRow(1).height = 24

    if (sec.error) {
      sheet.getCell('A2').value = `ERRORE: ${sec.error}`
      sheet.getCell('A2').font = { color: { argb: 'FFDC2626' }, bold: true }
    } else if (sec.chartType === 'kpi' && sec.kpiValue !== null) {
      sheet.getCell('A2').value = 'Valore'
      sheet.getCell('B2').value = sec.kpiValue
      sheet.getCell('B2').font = { bold: true, size: 16 }
    } else if (sec.rows && sec.rows.length > 0) {
      sheet.getRow(2).values = ['Label', 'Valore']
      sheet.getRow(2).font = { bold: true }
      sheet.columns = [{ key: 'name', width: 30 }, { key: 'value', width: 15 }]
      sec.rows.forEach((row, i) => { sheet.getRow(i + 3).values = [row.name, row.value] })
    } else if (sec.tableRows && sec.tableRows.rows.length > 0) {
      const cols = sec.tableRows.columns.slice(0, 10)
      const colIdx = cols.map(c => sec.tableRows!.columns.indexOf(c))
      sheet.getRow(2).values = cols
      sheet.getRow(2).font = { bold: true }
      sheet.columns = cols.map(c => ({ key: c, header: c, width: 20 }))
      sec.tableRows.rows.forEach((row, i) => {
        const vals = colIdx.map(idx => (row as unknown[])[idx])
        sheet.getRow(i + 3).values = vals as ExcelJS.CellValue[]
      })
    }
  }

  await workbook.xlsx.writeFile(filePath)
}

async function exportReport(format: 'pdf' | 'excel', args: { templateId: string }, ctx: GraphQLContext): Promise<string> {
  const tpl = await loadSectionsForTemplate(args.templateId, ctx.tenantId)
  if (!tpl) throw new NotFoundError('ReportTemplate', args.templateId)

  const data = await fetchSectionData(tpl.sections, ctx.tenantId)
  const ext  = format === 'pdf' ? 'pdf' : 'xlsx'
  const filename = `${uuidv4()}.${ext}`
  const filePath = path.join(REPORT_DIR, filename)

  if (format === 'pdf') {
    await generatePDF(tpl.name, data, filePath)
  } else {
    await generateExcel(tpl.name, data, filePath)
  }

  logger.info({ filename, templateId: args.templateId }, `[report-export] ${ext} generated`)
  void audit(ctx, `report.export_${ext}`, 'ReportTemplate', args.templateId)
  return `/api/reports/${filename}`
}

export const reportExportResolvers = {
  Mutation: {
    exportReportPDF:   (_: unknown, args: { templateId: string }, ctx: GraphQLContext) => exportReport('pdf',   args, ctx),
    exportReportExcel: (_: unknown, args: { templateId: string }, ctx: GraphQLContext) => exportReport('excel', args, ctx),
  },
}

export { REPORT_DIR }
