/**
 * `ConfigurationItem.name_key` — chiave di ricerca per nome, minuscola,
 * indicizzata (`ci_tenant_name_key` in packages/neo4j/src/init.ts).
 *
 * La usa il riconoscimento del CI negli allarmi di monitoraggio
 * (services/eventService.ts#matchCI) al posto di `toLower(ci.name)` a
 * scansione. Va scritta OVUNQUE un CI venga creato o rinominato:
 * graphql/resolvers/ciMutations.ts (create/update), graphql/resolvers/sync.ts
 * (resolveConflict), discovery/reconciliationEngine.ts (create/update).
 * La migrazione 20260909_1050_event_management_indexes fa il backfill dei CI
 * già presenti con `toLower(ci.name)` (Cypher): stessa regola di questa
 * funzione per l'ASCII e per il comune Unicode.
 */
export function ciNameKey(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  return trimmed ? trimmed.toLowerCase() : null
}
