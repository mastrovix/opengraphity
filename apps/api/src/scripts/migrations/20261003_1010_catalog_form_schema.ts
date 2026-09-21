/**
 * Moduli del catalogo servizi, ondata 1: i vincoli del grafo.
 *
 * Due etichette nuove, e per entrambe il vincolo è la sostanza, non una
 * formalità:
 *
 *  - `:FormField` — la libreria dei campi del tenant. Il nome di un campo È il
 *    nome della proprietà sul ticket, quindi due campi con lo stesso nome nello
 *    stesso tenant scriverebbero sullo stesso dato con due tipi diversi. Il
 *    vincolo di unicità (tenant_id, name) rende quel caso impossibile a
 *    livello di database, non solo a livello di resolver.
 *
 *  - `:CatalogFormRevision` — la copia immutabile di ogni pubblicazione. Due
 *    nodi con la stessa (voce, revisione) vorrebbero dire due verità su cosa è
 *    stato chiesto a chi ha compilato: il vincolo (tenant_id, item_id,
 *    revision) lo vieta.
 *
 * I vincoli veri li crea `packages/neo4j/src/init.ts` (sorgente unica dello
 * schema, revisione architetturale): questa migrazione chiama quella, così un
 * database esistente li riceve senza dover rieseguire `neo4j:init` a mano.
 *
 * Non tocca dati: non c'è niente da migrare. Le service request non avevano
 * campi personalizzati su nessun tenant di questo database (verificato prima
 * di scrivere l'ondata: zero `CIFieldDefinition` non di sistema sul tipo
 * `service_request`), quindi nessun modulo esistente da convertire.
 *
 * Idempotente: `CREATE CONSTRAINT ... IF NOT EXISTS`.
 */
import type { Migration } from '@opengraphity/neo4j'

export const catalogFormSchema: Migration = {
  id:          '20261003_1010_catalog_form_schema',
  description: 'Moduli del catalogo: vincoli e indici per FormField e CatalogFormRevision',

  async up(session) {
    // I vincoli sono dichiarati in packages/neo4j/src/init.ts (sorgente unica);
    // qui si creano con la stessa forma, perche `initSchema` apre le sue
    // sessioni e non puo girare dentro la transazione di una migrazione.
    const statements = [
      'CREATE CONSTRAINT form_field_tenant_name_unique IF NOT EXISTS FOR (n:FormField) REQUIRE (n.tenant_id, n.name) IS UNIQUE',
      'CREATE CONSTRAINT catalog_form_revision_unique IF NOT EXISTS FOR (n:CatalogFormRevision) REQUIRE (n.tenant_id, n.item_id, n.revision) IS UNIQUE',
      'CREATE INDEX form_field_tenant IF NOT EXISTS FOR (n:FormField) ON (n.tenant_id)',
      'CREATE INDEX catalog_form_revision_item IF NOT EXISTS FOR (n:CatalogFormRevision) ON (n.tenant_id, n.item_id)',
    ]
    for (const q of statements) await session.run(q)
    console.log(`  ${statements.length} vincoli/indici verificati`)
  },
  // I vincoli non girano nella transazione del marcatore: Neo4j li rifiuta.
  autocommit: true,
}
