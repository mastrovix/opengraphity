/**
 * L'export Excel del Report Builder produce davvero un file (giro nel browser
 * del 14 set 2026).
 *
 * Dal vivo: «↓ Excel» rispondeva «ExcelJS.Workbook is not a constructor».
 * `exceljs` è CommonJS: in Node ESM `await import('exceljs')` mette la classe
 * sotto `default`. Vitest risolve l'import in un altro modo e il guasto non si
 * vedeva nei test: qui si chiede la forma a Node VERO, e si prova la funzione
 * di caricamento su quella forma.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))

const { generateExcel, excelJsFrom, righeDiSerie, etichettaDelPeriodo, worksheetName } = await import('../reportExport.js')

/**
 * LE DUE FORME DI UNA SERIE (20 set 2026, dal giro nel browser: «esportando in
 * excel la colonna label è vuota»).
 *
 * `reportExecutor` produce `{name, value}` per le barre e `{date, value}` per
 * le linee. L'export leggeva solo `name`: su una sezione a linea la colonna
 * «Label» usciva vuota nel foglio e il PDF stampava «undefined: 5».
 */
describe('l\'etichetta di una riga esportata', () => {
  it('legge sia le barre (name) sia le linee (date)', () => {
    expect(righeDiSerie([{ name: 'production', value: 2 }], 'bar')).toEqual([{ name: 'production', value: 2 }])
    // Una data si scrive come sul grafico anche senza periodo dichiarato
    // (sezioni salvate prima che il periodo esistesse): il giorno per esteso.
    expect(righeDiSerie([{ date: '2026-09-01', value: 5 }], 'line', { lingua: 'it' }))
      .toEqual([{ name: '1 set 2026', value: 5 }])
  })

  it('un periodo si scrive come sul grafico, non come data intera', () => {
    // «In teoria non dovrebbe contenere la data… intera»: la query tronca e
    // restituisce «2026-01-01», che per un raggruppamento annuale dice pure
    // una cosa falsa — «il primo gennaio», non «il 2026».
    expect(etichettaDelPeriodo('2026-01-01', 'year', 'it')).toBe('2026')
    expect(etichettaDelPeriodo('2026-09-01', 'month', 'it')).toBe('set 2026')
    expect(etichettaDelPeriodo('2026-09-01', 'month', 'en')).toMatch(/^Sept? 2026$/)
    expect(etichettaDelPeriodo('2026-09-14', 'day', 'it')).toMatch(/14 set 2026/)
    // Quello che non è una data ISO passa com'è: stato, categoria, team.
    expect(etichettaDelPeriodo('production', null, 'it')).toBe('production')
  })

  it('la serie esportata usa il periodo della sezione', () => {
    expect(righeDiSerie([{ date: '2026-01-01', value: 5 }], 'line', { granularita: 'year', lingua: 'it' }))
      .toEqual([{ name: '2026', value: 5 }])
  })

  it('una riga senza NESSUNA etichetta è un errore, non una cella vuota', () => {
    // Una cella vuota in un foglio consegnato non si distingue da un dato che
    // vale davvero niente.
    expect(() => righeDiSerie([{ value: 5 }], 'line')).toThrow(/has no label/)
  })
})

describe('exceljs in Node', () => {
  it('in Node ESM Workbook sta sotto default (la forma che il codice deve gestire)', () => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      "const m = await import('exceljs'); console.log(typeof m.Workbook + ' ' + typeof m.default?.Workbook)"],
    { cwd: join(import.meta.dirname, '..', '..', '..', '..'), encoding: 'utf8' }).trim()
    expect(out).toBe('undefined function')
  })

  it('excelJsFrom trova Workbook in entrambe le forme', () => {
    class Workbook {}
    expect(excelJsFrom({ default: { Workbook } } as never).Workbook).toBe(Workbook)
    expect(excelJsFrom({ Workbook } as never).Workbook).toBe(Workbook)
    expect(() => excelJsFrom({} as never)).toThrow(/Workbook/)
  })

  it('scrive un file .xlsx con la libreria vera', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'og-xlsx-')), 'report.xlsx')
    await generateExcel('Report giro', [{ title: 'Sezione', chartType: 'bar', rows: [{ name: 'production', value: 2 }], kpiValue: null, tableRows: null, error: null }], file, { language: 'it', timeZone: 'Europe/Rome' })
    expect(statSync(file).size).toBeGreaterThan(1000)
  })

  // Review of 23 Sep 2026: ExcelJS throws on a duplicate, empty or reserved name, and the whole export failed.
  it('two sections with the same title, an empty one and one called «Summary» still make a file, with the real library', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'og-xlsx-')), 'report.xlsx')
    const section = (title: string) => ({ title, chartType: 'bar', rows: [{ name: 'production', value: 2 }], kpiValue: null, tableRows: null, error: null })
    await expect(generateExcel('Report', [section('Incidents'), section('INCIDENTS'), section(''), section('Summary'), section('History')], file, { language: 'it', timeZone: 'Europe/Rome' }))
      .resolves.toBeUndefined()
    expect(statSync(file).size).toBeGreaterThan(1000)
  })

  it('worksheet names: unique ignoring case, never empty, within 31 characters, without the reserved ones', () => {
    const taken = new Set(['summary'])
    expect(worksheetName('Incidents', 0, taken)).toBe('Incidents')
    expect(worksheetName('incidents', 1, taken)).toBe('incidents (2)')
    expect(worksheetName('', 2, taken)).toBe('Section 3')
    expect(worksheetName('Summary', 3, taken)).toBe('Summary (2)')
    expect(worksheetName('History', 4, taken)).toBe('History (1)')
    expect(worksheetName("'quoted'", 5, taken)).toBe('quoted')
    const long = 'x'.repeat(40)
    expect(worksheetName(long, 6, taken)).toBe('x'.repeat(31))
    expect(worksheetName(long, 7, taken)).toBe(`${'x'.repeat(27)} (2)`)
  })
})
