/**
 * Import historical tickets from a CSV file (migration from other ITSM tools).
 *
 * Usage:
 *   pnpm --filter @opengraphity/api import:incidents -- \
 *     --file ./samples/import/incidents-sample.csv \
 *     --tenant-id c-one \
 *     [--type incident|problem|change|service_request] \
 *     [--dry-run]
 *
 * `--type` (default incident, ondata 5 di «Nulla cablato»): the columns of each
 * type are listed in services/ticketImportService.ts (TICKET_IMPORT_SPECS).
 *
 * Required env vars: NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD (default: localhost)
 *
 * CSV columns:
 *   external_id (required, idempotency key), title (required), description,
 *   severity, status, number, created_at, updated_at, resolved_at,
 *   assignee_email, team_name, comments (JSON array [{author_email, text, created_at}])
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { closeDriver } from '@opengraphity/neo4j'
import { parseCsv, importTickets, TICKET_IMPORT_SPECS, type TicketImportKind } from '../services/ticketImportService.js'
import { printImportSummary } from './lib/importSummary.js'

const { values: args } = parseArgs({
  options: {
    'file':      { type: 'string' },
    'tenant-id': { type: 'string' },
    'dry-run':   { type: 'boolean', default: false },
    'type':      { type: 'string', default: 'incident' },
  },
})

const file     = args['file']
const tenantId = args['tenant-id']
const dryRun   = args['dry-run'] ?? false
const kind     = args['type'] ?? 'incident'
if (!(kind in TICKET_IMPORT_SPECS)) {
  console.error(`Errore: --type deve essere uno fra ${Object.keys(TICKET_IMPORT_SPECS).join(', ')}.`)
  process.exit(1)
}

if (!file || !tenantId) {
  console.error('Errore: argomenti mancanti.')
  console.error('Uso: --file <path.csv> --tenant-id <id> [--dry-run]')
  process.exit(1)
}

async function main() {
  const text = readFileSync(file!, 'utf-8')
  const rows = parseCsv(text)
  console.log(`File: ${file} — ${rows.length} righe dati`)

  const result = await importTickets(kind as TicketImportKind, rows, { tenantId: tenantId!, userId: 'import-cli' }, { dryRun })
  printImportSummary(kind, result, dryRun)
}

main()
  .catch((err: unknown) => {
    console.error('\n✖ Import fallito:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => closeDriver().catch(() => { /* ignore */ }))
