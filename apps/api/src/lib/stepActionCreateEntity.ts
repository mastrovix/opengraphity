/**
 * L'azione di passo `create_entity` — revisione del 14 set 2026 · WA-2.
 *
 * Prima l'azione scriveva il nodo con una CREATE sua: niente numero, niente
 * istanza di workflow, niente evento di creazione (quindi niente SLA,
 * notifiche, automazioni). Adesso il ticket nasce dal servizio del suo tipo,
 * come da qualunque altra porta. I CI impattati si ereditano dal ticket di
 * origine: un incident e una change senza CI non nascono, e un problem senza
 * CI non servirebbe a nessuno.
 */
import type { Session } from 'neo4j-driver'
import { ValidationError } from './errors.js'
import { matchById } from './cypherLookups.js'
import { TICKET_CI_RELATIONSHIPS_PATTERN } from '@opengraphity/types'

const LABELS: Readonly<Record<string, string>> = { incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'ServiceRequest' }

type Ctx = { tenantId: string; userId: string }

export async function createEntityFromStepAction(
  session: Session, ctx: Ctx, type: string, data: Record<string, unknown>, current: { id?: string; type: string },
): Promise<string> {
  const { parent_id, parent_type, title, ...copied } = data
  const label = LABELS[type]
  if (!label) throw new ValidationError(`Unknown entity type: ${type}`)
  const sourceId   = (parent_id as string | undefined) ?? current.id
  const sourceType = (parent_type as string | undefined) ?? current.type
  const cis = sourceId
    ? await session.executeRead((tx) => tx.run(`
        ${matchById('e', { id: '$id' })}
        MATCH (e)-[:${TICKET_CI_RELATIONSHIPS_PATTERN}]->(ci)
        RETURN collect(DISTINCT ci.id) AS ids
      `, { id: sourceId, tenantId: ctx.tenantId })).then((r) => (r.records[0]?.get('ids') ?? []) as string[])
    : []
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
  let id: string
  if (type === 'incident') {
    const { createIncident } = await import('../services/incidentService.js')
    id = (await createIncident({ title: String(title), description: text(copied['description']), severity: text(copied['severity']) ?? text(copied['priority']), category: text(copied['category']), affectedCIIds: cis }, ctx)).id as string
  } else if (type === 'problem') {
    const { createProblem } = await import('../services/problemService.js')
    id = (await createProblem({ title: String(title), description: text(copied['description']), priority: text(copied['priority']) ?? text(copied['severity']), category: text(copied['category']), affectedCIs: cis, relatedIncidents: sourceType === 'incident' && sourceId ? [sourceId] : [] }, ctx)).id as string
  } else if (type === 'change') {
    const { createChangeRFC } = await import('../services/changeCreationService.js')
    id = (await createChangeRFC({ title: String(title), why: text(copied['description']) ?? String(title), what: String(title), affectedCIIds: cis, changeType: text(copied['change_type']) }, ctx)).id
  } else {
    throw new ValidationError(`Step actions cannot create a ${type}`)
  }

  // Il collegamento al ticket di origine quando l'azione lo chiede (problem ←
  // incident: CAUSED_BY lo scrive già il servizio).
  const parentLabel = parent_type ? LABELS[parent_type as string] : undefined
  if (parent_id && parentLabel && !(type === 'problem' && parent_type === 'incident')) {
    await session.executeWrite((tx) => tx.run(
      `MATCH (child:${label} {id: $childId, tenant_id: $tenantId})
       MATCH (parent:${parentLabel} {id: $parentId, tenant_id: $tenantId})
       MERGE (child)-[:RELATED_TO]->(parent)`,
      { childId: id, parentId: parent_id, tenantId: ctx.tenantId },
    ))
  }
  return id
}
