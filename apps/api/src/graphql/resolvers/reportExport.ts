import path from 'path'
import fs from 'fs'
import type ExcelJS from 'exceljs'
import { v4 as uuidv4 } from 'uuid'
import type { GraphQLContext } from '../../context.js'
import { NotFoundError } from '../../lib/errors.js'
import { isLingua } from '../../lib/tenantLanguage.js'
import { reportSectionErrorIn } from '../../lib/systemText.js'
import { audit } from '../../lib/audit.js'
import { executeReportSection } from '../../lib/reportExecutor.js'
import type { ReportSectionDef } from '../../lib/reportQueryBuilder.js'
import { loadTemplateSections } from '../../lib/reportTemplates.js'
import { getSession } from '@opengraphity/neo4j'
import { logger } from '../../lib/logger.js'
import { ValidationError } from '../../lib/errors.js'
import { assertReportTemplateAccess } from './reportAccess.js'
import { config } from '../../lib/config.js'
import { loadNotificationLocale, notificationText, formatNotificationDate, type NotificationLocale } from '@opengraphity/notifications'

const REPORT_DIR = config.reportDir

if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true })

/**
 * Exported files live in REPORT_DIR/<tenantId>/<uuid>.<ext>: the download
 * route only ever reads from the caller's own tenant directory, so knowing a
 * filename is not enough to fetch another tenant's report.
 */
export const REPORT_PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/

export function tenantReportDir(tenantId: string): string {
  if (!REPORT_PATH_SEGMENT_RE.test(tenantId) || tenantId === '.' || tenantId === '..') {
    throw new ValidationError(`Tenant id ${JSON.stringify(tenantId)} is not a valid report directory segment`)
  }
  return path.join(REPORT_DIR, tenantId)
}

// Cleanup files older than 2 hours every 30 minutes (per tenant directory).
// `unref()`: the timer runs while the server runs, but it must not keep alive
// a process that only imports this module — a script that calls the report
// mutations never ended (23 Sep 2026, the demo-tenant generator).
setInterval(() => {
  try {
    const threshold = Date.now() - 2 * 60 * 60 * 1000
    for (const entry of fs.readdirSync(REPORT_DIR, { withFileTypes: true })) {
      const entryPath = path.join(REPORT_DIR, entry.name)
      if (!entry.isDirectory()) {
        // Pre-tenant-directory leftovers (flat layout): expire them the same way.
        if (fs.statSync(entryPath).mtimeMs < threshold) fs.unlinkSync(entryPath)
        continue
      }
      for (const file of fs.readdirSync(entryPath)) {
        const fp = path.join(entryPath, file)
        if (fs.statSync(fp).mtimeMs < threshold) fs.unlinkSync(fp)
      }
    }
  } catch (err) {
    // Best-effort cleanup, but disk-filling failures must be visible.
    logger.warn({ err }, '[reportExport] cleanup of old report files failed')
  }
}, 30 * 60 * 1000).unref()

/**
 * Template name + sections WITH nodes/edges via the shared loader. The previous
 * local copy returned `nodes: [], edges: []`, so every exported section failed
 * with "No root node found" (C-04).
 */
export async function loadTemplateForExport(templateId: string, tenantId: string): Promise<{ name: string; sections: ReportSectionDef[] } | null> {
  const session = getSession(undefined, 'READ')
  try {
    const tplRes = await session.executeRead(tx =>
      tx.run(`MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId}) RETURN r.name AS name`, { id: templateId, tenantId }),
    )
    if (!tplRes.records.length) return null
    const name = tplRes.records[0].get('name') as string
    const sections = await loadTemplateSections(session, templateId, tenantId)
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

async function fetchSectionData(sections: ReportSectionDef[], tenantId: string, lingua: string, permissions?: ReadonlySet<string>): Promise<SectionData[]> {
  const sezioni = sections
  // La lingua serve anche QUI, non solo a schermo: le intestazioni delle
  // colonne le compone il server, e senza lingua il PDF e l'Excel uscivano in
  // inglese («TITLE», «NUMBER») mentre il costruttore diceva «Titolo».
  const results = await Promise.all(sections.map(s => executeReportSection(s, tenantId, { language: isLingua(lingua) ? lingua : undefined, permissions })))
  return results.map((r, i) => {
    // A failed section must appear AS FAILED in the exported document — an
    // empty page in a delivered audit PDF is a lie.
    if (r.error) {
      /*
       * L'errore si legge nella LINGUA DEL DOCUMENTO (20 set 2026,
       * segnalato dal proprietario: «il pdf dà errore»). Qui finiva il
       * messaggio tecnico — «section "942cc018-…": groupByGranularity
       * "month" needs a date field to group by» — in inglese e con l'id
       * interno della sezione, stampato in rosso dentro un PDF che
       * qualcuno allega. `reportSectionErrorIn` traduce quello che ha una
       * frase per chi legge; per un difetto nostro resta il tecnico, che
       * in quel caso è l'unica cosa utile.
       */
      const leggibile = reportSectionErrorIn(isLingua(lingua) ? lingua : 'en', r.errorKey)
      return { title: r.title, chartType: r.chartType, rows: null, kpiValue: null, tableRows: null, error: leggibile ?? r.error }
    }
    let parsed: unknown
    try { parsed = JSON.parse(r.data) }
    catch (e) {
      return { title: r.title, chartType: r.chartType, rows: null, kpiValue: null, tableRows: null, error: `Corrupt section data: ${e instanceof Error ? e.message : String(e)}` }
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
    // A row without a label fails ITS section, not the whole export: until
    // 23 Sep 2026 the throw escaped this map and one bad section (a group
    // whose team was deleted) took the other sections of the document with it.
    let rows: Array<{ name: string; value: number }> | null
    try {
      rows = Array.isArray(parsed)
        ? righeDiSerie(parsed as unknown[], r.chartType, { granularita: sezioni[i]?.groupByGranularity, lingua })
        : null
    } catch (e) {
      return { title: r.title, chartType: r.chartType, rows: null, kpiValue: null, tableRows: null, error: e instanceof Error ? e.message : String(e) }
    }
    return { title: r.title, chartType: r.chartType, rows, kpiValue: null, tableRows: null, error: null }
  })
}

/**
 * IL PERIODO SI SCRIVE COME SUL GRAFICO (20 set 2026, dal giro nel browser:
 * «in teoria non dovrebbe contenere la data… intera»).
 *
 * La query tronca al periodo e restituisce una data ISO: un raggruppamento
 * PER ANNO esce «2026-01-01», per mese «2026-09-01». Sul grafico il browser
 * le rende «2026» e «set 2026»; nel foglio e nel PDF finiva la data intera,
 * che per un raggruppamento annuale dice pure una cosa falsa — «il primo
 * gennaio», non «il 2026». Lo stesso report deve leggersi allo stesso modo a
 * schermo e nel file che si allega.
 *
 * Una riga per cella: il foglio non ha l'asse a due righe del grafico, quindi
 * l'anno c'è sempre.
 */
export function etichettaDelPeriodo(raw: string, granularita: string | null | undefined, lingua: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!m) return raw
  const [, anno, mese, giorno] = m
  if (granularita === 'year') return anno!
  const locale = lingua === 'it' ? 'it-IT' : 'en-GB'
  // Mezzogiorno UTC: a mezzanotte un «1 gennaio» scivolerebbe a dicembre nei
  // fusi a ovest.
  const d = new Date(Date.UTC(Number(anno), Number(mese) - 1, Number(giorno), 12))
  return granularita === 'month'
    ? `${d.toLocaleDateString(locale, { month: 'short', timeZone: 'UTC' })} ${anno!}`
    : d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/**
 * LE DUE FORME DI UNA SERIE (20 set 2026, dal giro nel browser: «esportando in
 * excel la colonna label è vuota»).
 *
 * `reportExecutor` produce `{name, value}` per barre, torte e classifiche e
 * `{date, value}` per linee e aree — due contratti, perché i grafici del
 * browser leggono l'uno o l'altro. L'esportazione ne conosceva UNO SOLO:
 * `row.name`. Su una sezione a linea la colonna «Label» del foglio usciva
 * vuota e il PDF stampava «undefined: 5» — il documento che si allega a un
 * rapporto mensile.
 *
 * Qui le due forme si uniscono in una, e una riga che non porta NESSUNA
 * etichetta è un errore dichiarato: una cella vuota in un foglio consegnato
 * non si distingue da un dato che vale davvero niente.
 */
export function righeDiSerie(
  parsed: readonly unknown[], chartType: string,
  periodo: { granularita?: string | null; lingua: string } = { lingua: 'en' },
): Array<{ name: string; value: number }> {
  return parsed.map((raw, i) => {
    const r = (raw ?? {}) as { name?: unknown; date?: unknown; value?: unknown }
    const etichetta = r.name ?? r.date
    if (etichetta === undefined || etichetta === null || String(etichetta) === '') {
      throw new Error(`[report-export] row ${String(i)} of a "${chartType}" section has no label (neither "name" nor "date")`)
    }
    return {
      name: etichettaDelPeriodo(String(etichetta), periodo.granularita, periodo.lingua),
      value: Number(r.value ?? 0),
    }
  })
}

type PdfDoc = PDFKit.PDFDocument

function writePdfContent(doc: PdfDoc, templateName: string, data: SectionData[], locale: NotificationLocale): void {
  // Title
  doc.fontSize(20).fillColor('#1a2332').text(templateName, { align: 'center' })
  doc.moveDown(0.5)
  doc.fontSize(10).fillColor('#94a3b8').text(formatNotificationDate(locale), { align: 'center' })
  doc.moveDown(1.5)

  for (const sec of data) {
    doc.fontSize(14).fillColor('#334155').text(sec.title, { underline: true })
    doc.moveDown(0.5)

    if (sec.error) {
      doc.fontSize(10).fillColor('#dc2626').text(`${notificationText(locale, 'exportSectionError')}: ${sec.error}`)
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
}

/**
 * The file is opened only once the content is built: pdfkit keeps the
 * document in memory until it is piped. Until 23 Sep 2026 the file was
 * opened first, so a failure while building (a language with no texts, say)
 * left a half-written file behind with its descriptor open, and the partial
 * file could be served as the report.
 */
async function generatePDF(templateName: string, data: SectionData[], filePath: string, locale: NotificationLocale): Promise<void> {
  const PDFDocument = (await import('pdfkit')).default
  const doc = new PDFDocument({ margin: 50, size: 'A4' })
  writePdfContent(doc, templateName, data, locale)
  const stream = fs.createWriteStream(filePath)
  doc.pipe(stream)
  doc.end()
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve)
    stream.on('error', reject)
  })
}

/**
 * `exceljs` è CommonJS: in Node ESM `await import('exceljs')` mette la classe
 * sotto `default` («ExcelJS.Workbook is not a constructor», giro nel browser del
 * 14 set 2026). Vitest invece la espone anche in cima, per questo i test non
 * lo vedevano: si gestiscono le due forme, e una terza è un errore.
 */
export function excelJsFrom(mod: { default?: typeof ExcelJS } & Partial<typeof ExcelJS>): typeof ExcelJS {
  if (typeof mod.default?.Workbook === 'function') return mod.default
  if (typeof mod.Workbook === 'function') return mod as typeof ExcelJS
  throw new Error('exceljs: no Workbook export found (neither default.Workbook nor Workbook)')
}

export async function generateExcel(templateName: string, data: SectionData[], filePath: string, locale: NotificationLocale): Promise<void> {
  const Excel = excelJsFrom(await import('exceljs') as never)
  const workbook = new Excel.Workbook()
  workbook.creator = 'OpenGraphity'
  workbook.created = new Date()

  const summary = workbook.addWorksheet('Summary')
  summary.getCell('A1').value = templateName
  summary.getCell('A1').font = { bold: true, size: 14 }
  summary.getCell('A2').value = formatNotificationDate(locale)
  summary.getCell('A2').font = { color: { argb: 'FF94A3B8' } }
  summary.getCell('A3').value = data.length === 1
    ? notificationText(locale, 'exportSectionsOne')
    : notificationText(locale, 'exportSectionsMany', { count: String(data.length) })
  summary.columns = [{ width: 40 }]

  for (const sec of data) {
    const safeName = sec.title.replace(/[\\/*?:[\]]/g, '_').slice(0, 31)
    const sheet = workbook.addWorksheet(safeName)

    sheet.getCell('A1').value = sec.title
    sheet.getCell('A1').font = { bold: true, size: 12 }
    sheet.getRow(1).height = 24

    if (sec.error) {
      sheet.getCell('A2').value = `${notificationText(locale, 'exportSectionError')}: ${sec.error}`
      sheet.getCell('A2').font = { color: { argb: 'FFDC2626' }, bold: true }
    } else if (sec.chartType === 'kpi' && sec.kpiValue !== null) {
      sheet.getCell('A2').value = notificationText(locale, 'exportValue')
      sheet.getCell('B2').value = sec.kpiValue
      sheet.getCell('B2').font = { bold: true, size: 16 }
    } else if (sec.rows && sec.rows.length > 0) {
      sheet.getRow(2).values = [notificationText(locale, 'exportLabel'), notificationText(locale, 'exportValue')]
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

/**
 * IL FILE, SENZA CHI LO CHIEDE (ondata 11).
 *
 * Era dentro il resolver, quindi esisteva solo per chi premeva «Esporta»: il
 * report SCHEDULATO raccoglieva destinatari e formato dall'interfaccia e non
 * produceva niente — «i generatori PDF/Excel vivono dentro i resolver e non
 * sono riusabili qui», diceva il commento dello scheduler. Ora la produzione
 * del file è una funzione sola, e la usano tutti e due.
 *
 * Il controllo dei permessi NON sta qui: lo fa chi chiama. Il resolver
 * verifica che l'utente possa leggere il template; lo scheduler esegue un
 * report che un amministratore ha già programmato. `permissions` (review of
 * 23 Sep 2026): those of the person exporting, so a section on data their
 * role cannot read comes out as a refused section, not as the data.
 */
export async function generateReportFile(
  format: 'pdf' | 'excel', templateId: string, tenantId: string, permissions?: ReadonlySet<string>,
): Promise<{ filename: string; filePath: string; templateName: string }> {
  const tpl = await loadTemplateForExport(templateId, tenantId)
  if (!tpl) throw new NotFoundError('ReportTemplate', templateId)

  /*
   * LINGUA E FUSO DEL CLIENTE (20 set 2026). Il documento che si allega esce
   * dal prodotto come un'e-mail: si legge nella lingua dell'organizzazione e
   * le sue date sono nel suo fuso. Prima l'intestazione portava
   * `new Date().toLocaleString()` — cioè il formato e l'ora del PROCESSO, che
   * in un container è en-US su UTC: «9/19/2026, 12:42:48 PM» in un foglio
   * italiano.
   */
  const locale = await loadNotificationLocale(tenantId)
  const data = await fetchSectionData(tpl.sections, tenantId, locale.language, permissions)
  const ext  = format === 'pdf' ? 'pdf' : 'xlsx'
  const filename = `${uuidv4()}.${ext}`
  const dir      = tenantReportDir(tenantId)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, filename)

  if (format === 'pdf') {
    await generatePDF(tpl.name, data, filePath, locale)
  } else {
    await generateExcel(tpl.name, data, filePath, locale)
  }

  logger.info({ filename, templateId }, `[report-export] ${ext} generated`)
  return { filename, filePath, templateName: tpl.name }
}

async function exportReport(format: 'pdf' | 'excel', args: { templateId: string }, ctx: GraphQLContext): Promise<string> {
  const accessSession = getSession(undefined, 'READ')
  try {
    await assertReportTemplateAccess(accessSession, args.templateId, ctx, 'read')
  } finally {
    await accessSession.close()
  }

  const { filename } = await generateReportFile(format, args.templateId, ctx.tenantId, ctx.permissions)
  void audit(ctx, `report.export_${format === 'pdf' ? 'pdf' : 'xlsx'}`, 'ReportTemplate', args.templateId)
  return `/api/reports/${filename}`
}

export const reportExportResolvers = {
  Mutation: {
    exportReportPDF:   (_: unknown, args: { templateId: string }, ctx: GraphQLContext) => exportReport('pdf',   args, ctx),
    exportReportExcel: (_: unknown, args: { templateId: string }, ctx: GraphQLContext) => exportReport('excel', args, ctx),
  },
}

export { REPORT_DIR }
