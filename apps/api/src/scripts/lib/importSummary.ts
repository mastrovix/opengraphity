/**
 * Riepilogo a console di un import CSV (import-incidents, import-kb).
 * Prima era duplicato verbatim nei due script.
 */

import type { ImportResult } from '../../services/ticketImportService.js'

const MAX_LISTED = 20

export function printImportSummary(
  label:    string,
  result:   ImportResult,
  isDryRun: boolean,
  out:      (line: string) => void = console.log,
): void {
  out(`\n── Import ${label} ${isDryRun ? '(DRY-RUN — nessuna scrittura)' : ''}`)
  out(`   Righe totali: ${result.totalRows}`)
  out(`   Create:       ${result.created}`)
  out(`   Aggiornate:   ${result.updated}`)
  out(`   Errori:       ${result.errors.length}`)
  out(`   Warning:      ${result.warnings.length}`)

  if (result.warnings.length > 0) {
    out('\n   Warning:')
    for (const w of result.warnings.slice(0, MAX_LISTED)) {
      out(`     riga ${w.row} [${w.externalId ?? '—'}]: ${w.message}`)
    }
    if (result.warnings.length > MAX_LISTED) out(`     ... e altri ${result.warnings.length - MAX_LISTED} warning`)
  }

  if (result.errors.length > 0) {
    out(`\n   Errori (prime ${MAX_LISTED} righe):`)
    for (const e of result.errors.slice(0, MAX_LISTED)) {
      out(`     riga ${e.row} [${e.externalId ?? '—'}]: ${e.message}`)
    }
    if (result.errors.length > MAX_LISTED) out(`     ... e altri ${result.errors.length - MAX_LISTED} errori`)
  }
  out('')
}
