/**
 * Le mappe di servizio il cui incident il monitoraggio non riesce a gestire
 * (revisione del 15 set 2026 · SV-4): il motore scrive il motivo sulla mappa
 * (`incident_problem`, services/serviceImpact/incident.ts) e lo toglie alla
 * prima riconciliazione riuscita. Lo usa la diagnostica.
 */
import type { Queryable } from '@opengraphity/neo4j'

export const SERVICE_INCIDENT_PROBLEMS_CYPHER = `
  MATCH (m:ServiceMap {tenant_id: $tenantId})
  WHERE m.incident_problem IS NOT NULL
  RETURN m.id AS id, coalesce(m.name, m.id) AS name
  ORDER BY name, id`

export async function serviceMapsWithIncidentProblem(session: Queryable, tenantId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await session.run(SERVICE_INCIDENT_PROBLEMS_CYPHER, { tenantId })
  return res.records.map((r) => ({ id: String(r.get('id')), name: String(r.get('name')) }))
}
