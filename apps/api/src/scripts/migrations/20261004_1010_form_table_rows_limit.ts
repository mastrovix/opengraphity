/**
 * Moduli del catalogo (ondata 7) — il tetto sulle RIGHE di una tabella, sui
 * :Tenant esistenti.
 *
 * Un numero nuovo sul nodo del tenant: `max_form_table_rows`. Ogni riga di una
 * tabella è un nodo nel grafo, quindi il tetto non è un capriccio — cento
 * righe per ticket su diecimila ticket è un milione di nodi che nessuno ha
 * chiesto. Come gli altri due (20261003_1020) è TECNICO e configurabile
 * dall'amministratore, non un limite di piano.
 *
 * Nessun default a runtime: chi legge i tetti e non lo trova ferma con il nome
 * di QUESTA migrazione. Scrive solo dove manca, quindi un valore già cambiato a
 * mano non viene toccato ed è idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { CATALOG_FORM_LIMIT_DEFAULTS } from '../../lib/catalogFormLimits.js'

export const formTableRowsLimit: Migration = {
  id: '20261004_1010_form_table_rows_limit',
  description: `Catalog forms: write Tenant.max_form_table_rows (${CATALOG_FORM_LIMIT_DEFAULTS.maxTableRows}) where missing`,
  async up(session) {
    const r = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL AND t.max_form_table_rows IS NULL
      SET t.max_form_table_rows = toInteger($maxTableRows)
      RETURN count(t) AS written
    `, { maxTableRows: CATALOG_FORM_LIMIT_DEFAULTS.maxTableRows })
    const written = Number(r.records[0]?.get('written') ?? 0)
    console.log(`[${formTableRowsLimit.id}] ${written} tenants: max_form_table_rows written`)
  },
}
