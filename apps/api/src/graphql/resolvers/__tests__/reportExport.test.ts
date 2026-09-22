/**
 * PDF / Excel export of a report template, end to end through the resolver.
 *
 * Why these behaviours matter to a user:
 * - the export is a document people attach to audits and monthly reports: a
 *   failed or corrupt section must be printed AS FAILED (in the tenant's
 *   language), never dropped or rendered as an empty page;
 * - files live in REPORT_DIR/<tenantId>/, the only directory the download
 *   route reads for that tenant: a tenant id that could escape it must be
 *   rejected, or one tenant could plant/read files in another's folder;
 * - the read permission on the template is checked BEFORE any file is
 *   produced, and the export is audited;
 * - the periodic cleanup must expire old files (disk) and must not crash the
 *   process when the directory is unreadable.
 *
 * pdfkit is replaced by a recorder so the printed lines can be asserted
 * (the real library compresses its streams); exceljs is the real one and the
 * produced workbook is read back.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import ExcelJSModule from 'exceljs'

const h = vi.hoisted(() => {
  const base = process.env['TMPDIR'] ?? '/tmp'
  const reportDir = `${base.replace(/\/$/, '')}/og-report-export-test-${String(process.pid)}-${String(Date.now())}`
  // Capture the module-level cleanup interval instead of letting it run.
  const cleanup: { fn: (() => void) | null } = { fn: null }
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === 30 * 60 * 1000) { cleanup.fn = fn; return 0 as never }
    return realSetInterval(fn, ms, ...rest)
  }) as typeof setInterval
  return {
    reportDir, cleanup, realSetInterval,
    pdfTexts: [] as string[],
    pdfFail: { error: null as Error | null },
  }
})

const runTemplate = vi.fn<(q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }>>()
const sessionClose = vi.fn(async () => undefined)
const loadTemplateSections = vi.fn()
const executeReportSection = vi.fn()
const assertReportTemplateAccess = vi.fn()
const audit = vi.fn()
const warn = vi.fn()
const loadNotificationLocale = vi.fn(async () => ({ language: 'en', timeZone: 'UTC' }))

vi.mock('../../../lib/config.js', () => ({ config: { reportDir: h.reportDir } }))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: (fn: (tx: unknown) => unknown) => fn({ run: runTemplate }),
    close: sessionClose,
  }),
}))
vi.mock('../../../lib/reportTemplates.js', () => ({ loadTemplateSections: (...a: unknown[]) => loadTemplateSections(...a) }))
vi.mock('../../../lib/reportExecutor.js', () => ({ executeReportSection: (...a: unknown[]) => executeReportSection(...a) }))
vi.mock('../reportAccess.js', () => ({ assertReportTemplateAccess: (...a: unknown[]) => assertReportTemplateAccess(...a) }))
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))
vi.mock('@opengraphity/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opengraphity/notifications')>()),
  loadNotificationLocale: () => loadNotificationLocale(),
}))
vi.mock('pdfkit', () => {
  class FakePDF {
    private out: fs.WriteStream | null = null
    fontSize() { return this }
    fillColor() { return this }
    moveDown() { return this }
    text(t: string) { h.pdfTexts.push(t); return this }
    pipe(s: fs.WriteStream) { this.out = s }
    end() {
      if (h.pdfFail.error) this.out!.destroy(h.pdfFail.error)
      else this.out!.end('%PDF-fake')
    }
  }
  return { default: FakePDF }
})

const mod = await import('../reportExport.js')
globalThis.setInterval = h.realSetInterval
const { reportExportResolvers, tenantReportDir, generateReportFile, loadTemplateForExport, REPORT_DIR } = mod

const ctx = { tenantId: 'c-test', userId: 'u1', userEmail: 'a@b.c', role: 'admin' } as never

function sectionDef(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: id, chartType: 'bar', nodes: [], edges: [], ...extra }
}
function result(title: string, chartType: string, data: unknown, error: string | null = null, errorKey: string | null = null) {
  return { sectionId: title, title, chartType, data: typeof data === 'string' ? data : JSON.stringify(data), total: 0, error, errorKey }
}

function givenTemplate(name: string | null, sections: unknown[], results: unknown[]) {
  runTemplate.mockResolvedValue({ records: name === null ? [] : [{ get: () => name }] })
  loadTemplateSections.mockResolvedValue(sections)
  executeReportSection.mockReset()
  for (const r of results) executeReportSection.mockResolvedValueOnce(r)
}

async function readWorkbook(file: string) {
  const Excel = mod.excelJsFrom(ExcelJSModule as never)
  const wb = new Excel.Workbook()
  await wb.xlsx.readFile(file)
  return wb
}

beforeEach(() => {
  vi.clearAllMocks()
  h.pdfTexts.length = 0
  h.pdfFail.error = null
  loadNotificationLocale.mockResolvedValue({ language: 'en', timeZone: 'UTC' })
})

afterAll(() => { fs.rmSync(h.reportDir, { recursive: true, force: true }) })

describe('report directory', () => {
  it('is created at import when missing', () => {
    expect(REPORT_DIR).toBe(h.reportDir)
    expect(fs.statSync(h.reportDir).isDirectory()).toBe(true)
  })

  it('a tenant id that could escape its own directory is rejected', () => {
    expect(tenantReportDir('c-test')).toBe(path.join(h.reportDir, 'c-test'))
    for (const bad of ['..', '.', '../other', 'a/b', '', 'c test']) {
      expect(() => tenantReportDir(bad)).toThrow(/not a valid report directory segment/)
    }
  })
})

describe('loadTemplateForExport', () => {
  it('reads the template in the caller tenant only, and closes the session', async () => {
    givenTemplate('Monthly', [sectionDef('s1')], [])
    await expect(loadTemplateForExport('tpl-1', 'c-test')).resolves.toEqual({ name: 'Monthly', sections: [sectionDef('s1')] })
    expect(runTemplate.mock.calls[0]![0]).toContain('{id: $id, tenant_id: $tenantId}')
    expect(runTemplate.mock.calls[0]![1]).toEqual({ id: 'tpl-1', tenantId: 'c-test' })
    expect(sessionClose).toHaveBeenCalled()
  })

  it('a missing (or other-tenant) template is null, and the session is still closed', async () => {
    givenTemplate(null, [], [])
    await expect(loadTemplateForExport('tpl-x', 'c-test')).resolves.toBeNull()
    expect(loadTemplateSections).not.toHaveBeenCalled()
    expect(sessionClose).toHaveBeenCalled()
  })
})

describe('exportReportPDF', () => {
  it('prints every kind of section, failed ones as failed, and audits the export', async () => {
    givenTemplate('Ops report', [
      sectionDef('kpi'), sectionDef('bars'), sectionDef('table'), sectionDef('broken'), sectionDef('translated'), sectionDef('corrupt'), sectionDef('badTable'),
    ], [
      result('Open incidents', 'kpi', { value: 42 }),
      result('By status', 'bar', [{ name: 'open', value: 3 }, { name: 'closed', value: 7 }]),
      result('List', 'table', { columns: ['number', 'title'], rows: [['INC1', 'Disk'], ['INC2', null]] }),
      result('Broken', 'bar', '', 'section "s1": internal failure'),
      result('Translated', 'line', '', 'section "s2": groupByGranularity needs date', 'errors.report.granularityNeedsDate'),
      result('Corrupt', 'bar', '{not json'),
      result('Bad table', 'table', { columns: 'x' }),
    ])
    const url = await reportExportResolvers.Mutation.exportReportPDF(null, { templateId: 'tpl-1' }, ctx)

    expect(url).toMatch(/^\/api\/reports\/[0-9a-f-]{36}\.pdf$/)
    const file = path.join(h.reportDir, 'c-test', path.basename(url))
    expect(fs.readFileSync(file, 'utf8')).toBe('%PDF-fake')

    const t = h.pdfTexts
    expect(t[0]).toBe('Ops report')
    expect(t).toContain('42')
    expect(t).toContain('open: 3')
    expect(t).toContain('number | title')
    expect(t).toContain('INC1 | Disk')
    // A null cell prints empty, not "null".
    expect(t).toContain('INC2 | ')
    // An internal failure keeps its technical message (the only useful data).
    expect(t).toContain('ERROR: section "s1": internal failure')
    // A known error reads in the document language, without internal ids.
    expect(t.some((l) => l.startsWith('ERROR: Grouping by period needs a date field'))).toBe(true)
    expect(t.some((l) => l.startsWith('ERROR: Corrupt section data:'))).toBe(true)
    expect(t).toContain('ERROR: Formato dati tabella inatteso')

    // Every section is executed in the tenant, in the document language.
    expect(executeReportSection).toHaveBeenCalledWith(expect.anything(), 'c-test', { language: 'en' })
    expect(assertReportTemplateAccess).toHaveBeenCalledWith(expect.anything(), 'tpl-1', ctx, 'read')
    expect(audit).toHaveBeenCalledWith(ctx, 'report.export_pdf', 'ReportTemplate', 'tpl-1')
  })

  it('a KPI without a value and an empty series print only their titles', async () => {
    givenTemplate('Empty', [sectionDef('a'), sectionDef('b')], [
      result('No value', 'kpi', null),
      result('Not a list', 'pie', { unexpected: true }),
    ])
    await reportExportResolvers.Mutation.exportReportPDF(null, { templateId: 'tpl-1' }, ctx)
    expect(h.pdfTexts.slice(2)).toEqual(['No value', 'Not a list'])
  })

  it('without read access on the template nothing is produced and nothing is audited', async () => {
    assertReportTemplateAccess.mockRejectedValueOnce(new Error('forbidden'))
    await expect(reportExportResolvers.Mutation.exportReportPDF(null, { templateId: 'tpl-1' }, ctx)).rejects.toThrow('forbidden')
    expect(sessionClose).toHaveBeenCalled()
    expect(runTemplate).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('a missing template is a not-found error, not an empty document', async () => {
    givenTemplate(null, [], [])
    await expect(reportExportResolvers.Mutation.exportReportPDF(null, { templateId: 'tpl-x' }, ctx)).rejects.toThrow(/tpl-x/)
    expect(audit).not.toHaveBeenCalled()
  })

  it('a write failure of the PDF stream fails the export', async () => {
    givenTemplate('Ops', [sectionDef('a')], [result('A', 'kpi', { value: 1 })])
    h.pdfFail.error = new Error('disk full')
    await expect(generateReportFile('pdf', 'tpl-1', 'c-test')).rejects.toThrow('disk full')
  })
})

describe('exportReportExcel', () => {
  it('writes one sheet per section, in the tenant language, with the period labels of the chart', async () => {
    loadNotificationLocale.mockResolvedValue({ language: 'it', timeZone: 'Europe/Rome' })
    givenTemplate('Rapporto', [
      sectionDef('kpi'), sectionDef('line', { groupByGranularity: 'year' }), sectionDef('table'), sectionDef('err'),
    ], [
      result('Aperti', 'kpi', { value: 5 }),
      result('Per anno', 'line', [{ date: '2026-01-01', value: 9 }]),
      result('Elenco: tutti/aperti?', 'table', { columns: ['number', 'title'], rows: [['INC1', 'Disco']] }),
      result('Rotta', 'bar', '', 'boom'),
    ])
    const url = await reportExportResolvers.Mutation.exportReportExcel(null, { templateId: 'tpl-2' }, ctx)
    expect(url).toMatch(/\.xlsx$/)
    expect(audit).toHaveBeenCalledWith(ctx, 'report.export_xlsx', 'ReportTemplate', 'tpl-2')
    expect(executeReportSection).toHaveBeenCalledWith(expect.anything(), 'c-test', { language: 'it' })

    const wb = await readWorkbook(path.join(h.reportDir, 'c-test', path.basename(url)))
    const summary = wb.getWorksheet('Summary')!
    expect(summary.getCell('A1').value).toBe('Rapporto')
    expect(summary.getCell('A3').value).toBe('4 sezioni')

    const kpi = wb.getWorksheet('Aperti')!
    expect(kpi.getCell('A2').value).toBe('Valore')
    expect(kpi.getCell('B2').value).toBe(5)

    // A yearly group reads "2026", as on the chart, not "2026-01-01".
    const line = wb.getWorksheet('Per anno')!
    expect(line.getRow(2).values).toEqual([undefined, 'Etichetta', 'Valore'])
    expect(line.getCell('A3').value).toBe('2026')
    expect(line.getCell('B3').value).toBe(9)

    // Sheet names cannot contain : / ? — they are replaced, not rejected.
    const table = wb.getWorksheet('Elenco_ tutti_aperti_')!
    expect(table.getCell('A3').value).toBe('INC1')
    expect(table.getCell('B3').value).toBe('Disco')

    expect(wb.getWorksheet('Rotta')!.getCell('A2').value).toBe('ERRORE: boom')
  })

  it('a single section is counted in the singular; empty rows leave only the title', async () => {
    givenTemplate('One', [sectionDef('a')], [result('Empty table', 'table', { columns: ['a'], rows: [] })])
    const { filePath, templateName } = await generateReportFile('excel', 'tpl-3', 'c-test')
    expect(templateName).toBe('One')
    const wb = await readWorkbook(filePath)
    expect(wb.getWorksheet('Summary')!.getCell('A3').value).toBe('1 section')
    expect(wb.getWorksheet('Empty table')!.getCell('A2').value).toBeNull()
  })

  it('an unknown tenant language falls back to English for the section execution', async () => {
    loadNotificationLocale.mockResolvedValue({ language: 'xx', timeZone: 'UTC' } as never)
    givenTemplate('T', [sectionDef('a')], [result('Broken', 'bar', '', 'raw', 'errors.report.granularityNeedsDate')])
    // The executor must not receive a language it does not know. (The
    // notification texts have no "xx" either, so the document itself fails:
    // that is the loud failure we want, not a half-written file.)
    await expect(generateReportFile('excel', 'tpl-4', 'c-test')).rejects.toThrow()
    expect(executeReportSection).toHaveBeenCalledWith(expect.anything(), 'c-test', { language: undefined })
  })

  it('a series row without any label fails the export instead of writing an empty cell', async () => {
    givenTemplate('T', [sectionDef('a')], [result('Line', 'line', [{ value: 3 }])])
    await expect(generateReportFile('excel', 'tpl-5', 'c-test')).rejects.toThrow(/row 0 of a "line" section has no label/)
  })

  it('an English daily period reads as a full English date', async () => {
    givenTemplate('T', [sectionDef('a', { groupByGranularity: 'day' })], [result('Daily', 'line', [{ date: '2026-09-14', value: 1 }])])
    await generateReportFile('pdf', 'tpl-6', 'c-test')
    expect(h.pdfTexts.some((l) => /^14 Sept? 2026: 1$/.test(l))).toBe(true)
  })

  it('an exceljs module without a Workbook export is a clear error', () => {
    expect(() => mod.excelJsFrom({} as never)).toThrow(/no Workbook export found/)
  })
})

describe('periodic cleanup of exported files', () => {
  it('removes files older than two hours, in tenant folders and in the legacy flat layout', () => {
    const tenantDir = path.join(h.reportDir, 'c-clean')
    fs.mkdirSync(tenantDir, { recursive: true })
    const oldNested = path.join(tenantDir, 'old.pdf')
    const newNested = path.join(tenantDir, 'new.pdf')
    const oldFlat = path.join(h.reportDir, 'legacy.xlsx')
    const newFlat = path.join(h.reportDir, 'recent.xlsx')
    for (const f of [oldNested, newNested, oldFlat, newFlat]) fs.writeFileSync(f, 'x')
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
    fs.utimesSync(oldNested, threeHoursAgo, threeHoursAgo)
    fs.utimesSync(oldFlat, threeHoursAgo, threeHoursAgo)

    expect(h.cleanup.fn).toBeTypeOf('function')
    h.cleanup.fn!()

    expect(fs.existsSync(oldNested)).toBe(false)
    expect(fs.existsSync(oldFlat)).toBe(false)
    expect(fs.existsSync(newNested)).toBe(true)
    expect(fs.existsSync(newFlat)).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('an unreadable report directory is logged, not thrown out of the timer', () => {
    fs.rmSync(h.reportDir, { recursive: true, force: true })
    expect(() => h.cleanup.fn!()).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('cleanup'))
    fs.mkdirSync(h.reportDir, { recursive: true })
  })
})
