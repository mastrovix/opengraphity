import { describe, it, expect } from 'vitest'
import { printImportSummary } from '../lib/importSummary.js'
import type { ImportResult } from '../../services/ticketImportService.js'

function capture(result: ImportResult, dryRun = false): string[] {
  const lines: string[] = []
  printImportSummary('incidents', result, dryRun, l => lines.push(l))
  return lines
}

describe('printImportSummary', () => {
  it('prints counters and the dry-run marker', () => {
    const lines = capture({ totalRows: 3, created: 2, updated: 1, errors: [], warnings: [] }, true)
    expect(lines[0]).toContain('Import incidents (DRY-RUN — nessuna scrittura)')
    expect(lines).toContain('   Righe totali: 3')
    expect(lines).toContain('   Create:       2')
    expect(lines).toContain('   Aggiornate:   1')
    expect(lines.some(l => l.includes('Warning:') && !l.includes('0'))).toBe(false)
  })

  it('lists at most 20 warnings/errors and summarizes the rest', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ row: i + 1, externalId: i % 2 ? `x${i}` : null, message: `m${i}` }))
    const lines = capture({ totalRows: 25, created: 0, updated: 0, errors: many, warnings: many })
    expect(lines.filter(l => l.startsWith('     riga '))).toHaveLength(40)
    expect(lines).toContain('     ... e altri 5 warning')
    expect(lines).toContain('     ... e altri 5 errori')
    expect(lines).toContain('     riga 1 [—]: m0')
    expect(lines).toContain('     riga 2 [x1]: m1')
  })
})
