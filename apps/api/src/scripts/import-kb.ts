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
import { parseCsv, importKBArticles } from '../services/ticketImportService.js'
import { printImportSummary } from './lib/importSummary.js'

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
