import { v4 as uuidv4 } from 'uuid'
import { customFieldDefs, resolveCustomFieldWrites, type CustomFieldInput } from '../lib/ticketCustomFields.js'
import { withTicketProps } from '../lib/ticketProps.js'
import { nextSequenceValue } from '../lib/sequence.js'
import { runQuery } from '@opengraphity/neo4j'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import type { ServiceCtx } from './incidentService.js'
import { publishEvent } from '../lib/publishEvent.js'
import { getInitialStepName } from '../lib/workflowHelpers.js'
import { workflowEngine } from '@opengraphity/workflow'

type Props = Record<string, unknown>

/** Unico mapper ServiceRequest (il resolver ne aveva una copia che perdeva catalogItemId/requiresApproval). */
export function mapRequest(props: Props) {
  return withTicketProps({
    id:          props['id']           as string,
    number:      (props['number'] ?? '') as string,
    tenantId:    props['tenant_id']    as string,
    title:       props['title']        as string,
    description: props['description']  as string | undefined,
    status:      props['status']       as string,
    priority:    props['priority']     as string,
    dueDate:     props['due_date']     as string | undefined,
    completedAt: props['completed_at'] as string | undefined,
    catalogItemId: (props['catalog_item_id'] ?? null) as string | null,
    requiresApproval: (props['requires_approval'] ?? false) as boolean,
    createdAt:   props['created_at']   as string,
    updatedAt:   props['updated_at']   as string,
    requestedBy: null,
    assignee:    null,
  }, props)
}

export async function createRequest(
  input: { title: string; description?: string; priority: string; category?: string | null; dueDate?: string; catalogItemId?: string; requiresApproval?: boolean; acknowledgeNoSla?: boolean | null; customFields?: CustomFieldInput[] | null },
  ctx: ServiceCtx,
  channel: 'agent' | 'portal' = 'agent',
) {
  // Campi personalizzati (ondata 4): solo dai canali che li mandano (vedi createIncident).
  const customProps = input.customFields == null ? {} : await withSession(async (session) =>
    resolveCustomFieldWrites(ctx.tenantId, 'service_request', await customFieldDefs(session, ctx.tenantId, 'service_request'), input.customFields, { current: null, endUser: channel === 'portal' }))
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const seq = await nextSequenceValue(session, ctx.tenantId, 'service_request')
    const number = 'REQ' + String(seq).padStart(8, '0')

    // Real lifecycle: start at the workflow's initial step, not a phantom 'open'.
    const initialStatus = await getInitialStepName(session, ctx.tenantId, 'service_request')

    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (r:ServiceRequest {
        id:                $id,
        tenant_id:         $tenantId,
        number:            $number,
        title:             $title,
        description:       $description,
        status:            $status,
        priority:          $priority,
        category:          $category,
        due_date:          $dueDate,
        catalog_item_id:   $catalogItemId,
        requires_approval: $requiresApproval,
        created_at:        $now,
        updated_at:        $now,
        // Chi l'ha creata ha visto l'avviso «nessuna policy SLA la copre» e
        // l'ha accettato: la diagnostica non la conta fra i ticket senza SLA.
        sla_absence_acknowledged_at: $ackAt,
        sla_absence_acknowledged_by: $ackBy
      })
      SET r += $customProps
      RETURN properties(r) as props
    `, {
      id, tenantId: ctx.tenantId, number, status: initialStatus,
      title: input.title, description: input.description ?? null,
      priority: input.priority, dueDate: input.dueDate ?? null,
      // La categoria arriva dalla voce del catalogo (verifica «Cosa resta cablato», ondata 2): serve alle policy SLA per categoria.
      category: input.category ?? null,
      catalogItemId: input.catalogItemId ?? null,
      requiresApproval: input.requiresApproval ?? false,
      now,
      ackAt: input.acknowledgeNoSla === true ? now : null,
      ackBy: input.acknowledgeNoSla === true ? ctx.userId : null,
      customProps,
    })
    if (!rows[0]) throw new Error('Failed to create service request')

    await runQuery(session, `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NOT NULL THEN [1] ELSE [] END |
        MERGE (r)-[:REQUESTED_BY]->(u)
        // Chi apre la richiesta la segue, come per gli incident.
        MERGE (u)-[w:WATCHES]->(r)
          ON CREATE SET w.watched_at = $now
      )
    `, { id, tenantId: ctx.tenantId, userId: ctx.userId, now })

    await workflowEngine.createInstance(session, ctx.tenantId, id, 'service_request')

    return mapRequest(rows[0].props)
  }, true)

  await publishEvent('request.created', ctx.tenantId, ctx.userId, { id, title: input.title, priority: input.priority }, now)
  return created
}

/*
 * `completeRequest` non esiste più (revisione del 14 set 2026 · F2). Portava la
 * richiesta al passo per NOME `fulfilled` — aperto, categoria `active` nel
 * workflow di fabbrica — e scriveva a mano `completed_at`: la richiesta
 * risultava conclusa per OLA, report e diagnostica mentre il suo SLA restava
 * aperto. Nessuna pagina la chiamava. Una richiesta si conclude con le
 * transizioni del suo workflow, e il motore scrive `completed_at` entrando in un
 * passo terminale (packages/workflow/src/engine.ts).
 */
