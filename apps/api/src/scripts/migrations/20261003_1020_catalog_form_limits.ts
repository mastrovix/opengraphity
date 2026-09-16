/**
 * Moduli del catalogo (ondata 4) — il TETTO sui moduli, sui :Tenant esistenti.
 *
 * Due numeri nuovi sul nodo del tenant:
 *
 *  - `max_form_fields`: quanti campi può avere la LIBRERIA. Ogni campo della
 *    libreria diventa una proprietà sui ticket e una voce nei filtri e nei
 *    report: una libreria senza fondo è una lista di filtri illeggibile e uno
 *    schema che cresce senza che nessuno se ne accorga.
 *  - `max_form_fields_per_form`: quanti campi può citare UN modulo. Un modulo
 *    si compila a mano, da una persona: oltre un certo punto nessuno lo
 *    finisce, e la pagina del portale diventa lentissima.
 *
 * NON è un limite di piano: lo stesso valore per tutti, e l'amministratore lo
 * cambia dalla pagina dei moduli (`setCatalogFormLimits`). È un tetto tecnico,
 * quindi la sua ragione è la stessa per uno starter e per un enterprise —
 * mettere qui una differenza commerciale vorrebbe dire inventarla.
 *
 * Nessun default a runtime: chi legge il tetto e non lo trova ferma con il nome
 * di QUESTA migrazione, come fa `max_service_maps` (20260910_1100). Scrive solo
 * dove manca, quindi un valore già cambiato a mano non viene toccato ed è
 * idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { CATALOG_FORM_LIMIT_DEFAULTS } from '../../lib/catalogFormLimits.js'

export const catalogFormLimits: Migration = {
  id: '20261003_1020_catalog_form_limits',
  description: `Catalog forms: write Tenant.max_form_fields (${CATALOG_FORM_LIMIT_DEFAULTS.maxLibraryFields}) and Tenant.max_form_fields_per_form (${CATALOG_FORM_LIMIT_DEFAULTS.maxFieldsPerForm}) where missing`,
  async up(session) {
    const r = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL AND (t.max_form_fields IS NULL OR t.max_form_fields_per_form IS NULL)
      SET t.max_form_fields = coalesce(t.max_form_fields, toInteger($maxLibraryFields)),
          t.max_form_fields_per_form = coalesce(t.max_form_fields_per_form, toInteger($maxFieldsPerForm))
      RETURN count(t) AS written
    `, {
      maxLibraryFields: CATALOG_FORM_LIMIT_DEFAULTS.maxLibraryFields,
      maxFieldsPerForm: CATALOG_FORM_LIMIT_DEFAULTS.maxFieldsPerForm,
    })
    const written = Number(r.records[0]?.get('written') ?? 0)
    console.log(`[${catalogFormLimits.id}] ${written} tenants: catalog form limits written`)
  },
}
