/**
 * Import historical KB articles from a CSV file (migration from other ITSM tools).
 *
 * Usage:
 *   pnpm --filter @opengraphity/api import:kb -- \
 *     --file ./samples/import/kb-articles-sample.csv \
 *     --tenant-id c-one \
 *     [--dry-run]
 *
 * Required env vars: NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD (default: localhost)
 *
 * CSV columns:
 *   external_id (required, idempotency key), title (required), body (markdown),
 *   category, tags (separated by ;), status (published/draft, default draft),
 *   author_name, created_at, published_at
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { closeDriver } from '@opengraphity/neo4j'
import { parseCsv, importKBArticles, type ImportResult } from '../services/ticketImportService.js'

const { values: args } = parseArgs({
  options: {
    'file':      { type: 'string' },
    'tenant-id': { type: 'string' },
    'dry-run':   { type: 'boolean', default: false },
  },
})

const file     = args['file']
const tenantId = args['tenant-id']
const dryRun   = args['dry-run'] ?? false

if (!file || !tenantId) {
  console.error('Errore: argomenti mancanti.')
  console.error('Uso: --file <path.csv> --tenant-id <id> [--dry-run]')
  process.exit(1)
}

function printImportSummary(label: string, result: ImportResult, isDryRun: boolean): void {
  console.log(`\n── Import ${label} ${isDryRun ? '(DRY-RUN — nessuna scrittura)' : ''}`)
  console.log(`   Righe totali: ${result.totalRows}`)
  console.log(`   Create:       ${result.created}`)
  console.log(`   Aggiornate:   ${result.updated}`)
  console.log(`   Errori:       ${result.errors.length}`)
  console.log(`   Warning:      ${result.warnings.length}`)

  if (result.warnings.length > 0) {
    console.log('\n   Warning:')
    for (const w of result.warnings.slice(0, 20)) {
      console.log(`     riga ${w.row} [${w.externalId ?? '—'}]: ${w.message}`)
    }
    if (result.warnings.length > 20) console.log(`     ... e altri ${result.warnings.length - 20} warning`)
  }

  if (result.errors.length > 0) {
    console.log('\n   Errori (prime 20 righe):')
    for (const e of result.errors.slice(0, 20)) {
      console.log(`     riga ${e.row} [${e.externalId ?? '—'}]: ${e.message}`)
    }
    if (result.errors.length > 20) console.log(`     ... e altri ${result.errors.length - 20} errori`)
  }
  console.log('')
}

async function main() {
  const text = readFileSync(file!, 'utf-8')
  const rows = parseCsv(text)
  console.log(`File: ${file} — ${rows.length} righe dati`)

  const result = await importKBArticles(rows, { tenantId: tenantId!, userId: 'import-cli' }, { dryRun })
  printImportSummary('kb-articles', result, dryRun)
}

main()
  .catch((err: unknown) => {
    console.error('\n✖ Import fallito:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => closeDriver().catch(() => { /* ignore */ }))
