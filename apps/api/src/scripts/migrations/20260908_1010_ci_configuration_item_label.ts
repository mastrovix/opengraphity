/**
 * B-08 — every CI node created through the typed GraphQL resolvers carries
 * only its type label (Server, Application, …), never :ConfigurationItem,
 * so the generic CI queries/constraints/indexes (ci_id_unique, ci_tenant_id,
 * discovery key) did not see them. Adds :ConfigurationItem to every node whose
 * label is a registered CI type (CITypeDefinition.neo4j_label) and that has a
 * tenant_id.
 *
 * `CALL { … } IN TRANSACTIONS` commits every 5000 rows on its own: it cannot
 * run inside an explicit transaction, hence `autocommit: true`. Idempotent
 * (the NOT n:ConfigurationItem filter), so an interrupted run is simply
 * resumed by running it again.
 */
import type { Migration } from '@opengraphity/neo4j'

export const ciConfigurationItemLabel: Migration = {
  id: '20260908_1010_ci_configuration_item_label',
  description: 'Add :ConfigurationItem to typed CI nodes (labels registered in CITypeDefinition.neo4j_label)',
  autocommit: true,
  async up(session) {
    const res = await session.run(`
      MATCH (t:CITypeDefinition) WHERE t.neo4j_label IS NOT NULL AND t.neo4j_label <> '' AND t.scope <> 'itil' // i tipi ITIL (Incident, Problem, …) sono ticket, non CI
      WITH collect(DISTINCT t.neo4j_label) AS ciLabels
      CALL {
        WITH ciLabels
        MATCH (n)
        WHERE n.tenant_id IS NOT NULL
          AND NOT n:ConfigurationItem
          AND any(l IN labels(n) WHERE l IN ciLabels)
        SET n:ConfigurationItem
        RETURN count(n) AS labelled
      } IN TRANSACTIONS OF 5000 ROWS
      RETURN sum(labelled) AS total_labelled
    `)
    console.log(`[${ciConfigurationItemLabel.id}] labelled ${String(res.records[0]?.get('total_labelled') ?? 0)} nodes`)
  },
}
