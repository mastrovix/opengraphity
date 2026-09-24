import { GraphQLError } from 'graphql'
import { workflowEngine } from '@opengraphity/workflow'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { loadTransitionRows, mapWorkflowDefinition } from './workflowMapping.js'
import { parseLocalizedLabels } from '@opengraphity/types'
import { requestApprovalWouldBeSkipped } from '../../lib/requestApproval.js'
import { isOwnRequestApproval } from '../../lib/ownApproval.js'
import { transitionsOpenToApproval } from '../../lib/ticketApprovalGate.js'
import { hasPermission } from '../../lib/permissions.js'

// ── WorkflowStep.currentInstances ─────────────────────────────────────────────

/**
 * Conteggi per definizione, vivi solo per il giro corrente dell'event loop:
 * i field resolver degli N step di una definizione partono tutti nello stesso
 * tick, quindi la prima chiamata fa l'unica query e le altre aspettano la sua
 * promessa (niente N+1). `setImmediate` la butta via subito dopo: questo NON è
 * una cache di dati, un `refetch` dopo un'eliminazione deve rileggere il grafo.
 */
const stepInstanceCounts = new Map<string, Promise<Record<string, number>>>()

function loadStepInstanceCounts(tenantId: string, definitionId: string): Promise<Record<string, number>> {
  const key = `${tenantId}::${definitionId}`
  const hit = stepInstanceCounts.get(key)
  if (hit) return hit
  const promise = withSession(async (session) => {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep)
      OPTIONAL MATCH (wi:WorkflowInstance)-[:CURRENT_STEP]->(s)
      RETURN s.name AS name, count(wi) AS n
    `, { definitionId, tenantId }))
    const out: Record<string, number> = {}
    for (const r of res.records) out[r.get('name') as string] = Number(r.get('n') ?? 0)
    return out
  })
  stepInstanceCounts.set(key, promise)
  setImmediate(() => stepInstanceCounts.delete(key))
  return promise
}

/**
 * Quante istanze di workflow stanno ORA su questo step. È il numero che rende
 * l'eliminazione dello step un'operazione distruttiva (B-1): il disegnatore lo
 * usa per spegnere il bottone «Elimina step» e dire perché.
 */
export async function workflowStepCurrentInstances(
  step: { definitionId?: string | null; name: string },
  _: unknown,
  ctx: GraphQLContext,
): Promise<number> {
  if (!step.definitionId) {
    throw new GraphQLError(`Step "${step.name}" has no definition_id: incomplete data, its instances cannot be counted`, { extensions: { code: 'CONFLICT' } })
  }
  const counts = await loadStepInstanceCounts(ctx.tenantId, step.definitionId)
  const n = counts[step.name]
  if (n == null) {
    throw new GraphQLError(
      `Step "${step.name}" not found in definition ${step.definitionId}: the number of instances on it cannot be told`,
      { extensions: { code: 'CONFLICT', i18n: { key: 'errors.workflow.stepNotInDefinition', params: { name: step.name, definition: step.definitionId } } } },
    )
  }
  return n
}

// ── Shared mappers ────────────────────────────────────────────────────────────

export function mapWI(wi: Record<string, unknown>) {
  return {
    id:          wi['id']           as string,
    currentStep: wi['current_step'] as string,
    status:      wi['status']       as string,
    createdAt:   wi['created_at']   as string,
    updatedAt:   wi['updated_at']   as string,
  }
}

export function mapExec(e: Record<string, unknown>) {
  return {
    id:          e['id']           as string,
    stepName:    e['step_name']    as string,
    enteredAt:   e['entered_at']   as string,
    exitedAt:    (e['exited_at']   ?? null) as string | null,
    durationMs:  e['duration_ms'] == null ? null : (typeof e['duration_ms'] === 'object' ? (e['duration_ms'] as { toNumber(): number }).toNumber() : Math.round(Number(e['duration_ms']))),
    triggeredBy: e['triggered_by'] as string,
    triggerType: e['trigger_type'] as string,
    notes:       (e['notes']       ?? null) as string | null,
  }
}

// ── Query resolvers ───────────────────────────────────────────────────────────

export async function incidentWorkflow(
  _: unknown,
  { incidentId }: { incidentId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
              -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi
      `, { incidentId, tenantId: ctx.tenantId }),
    )
    if (!result.records.length) return null
    return mapWI(result.records[0].get('wi').properties as Record<string, unknown>)
  })
}

export async function incidentAvailableTransitions(
  _: unknown,
  { incidentId }: { incidentId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const wiResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
              -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi.id AS instanceId
      `, { incidentId, tenantId: ctx.tenantId }),
    )
    if (!wiResult.records.length) return []
    const instanceId = wiResult.records[0].get('instanceId') as string
    // What the approval holds is not offered (lib/ticketApprovalGate.ts).
    return transitionsOpenToApproval(session, ctx.tenantId, instanceId, await workflowEngine.getAvailableTransitions(session, instanceId), hasPermission(ctx, 'approval.override'))
  })
}

export async function incidentWorkflowHistory(
  _: unknown,
  { incidentId }: { incidentId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
              -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
              -[:STEP_HISTORY]->(exec:WorkflowStepExecution)
        RETURN exec
        ORDER BY exec.entered_at ASC
      `, { incidentId, tenantId: ctx.tenantId }),
    )
    return result.records.map((r) =>
      mapExec(r.get('exec').properties as Record<string, unknown>),
    )
  })
}

export async function workflowDefinition(
  _: unknown,
  { entityType }: { entityType: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const defResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})
        MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        WITH wd, collect(s) AS steps
        // Un tenant puo avere PIU definizioni attive per la stessa entita (su
        // c-test: «Incident Management» e «Incident — Security», una per
        // categoria). Questo LIMIT 1 era senza ORDER BY: quale delle due
        // uscisse lo decideva il piano di esecuzione, quindi poteva cambiare
        // fra due caricamenti. Da quando le etichette dei passi arrivano da
        // qui — pastiglie di stato, timeline, campo «Step workflow» — una
        // scelta non deterministica vorrebbe dire etichette che ballano.
        // Si prende quella SENZA categoria (la generica) e, a pari merito, la
        // versione piu alta: la stessa regola di loadStepFacts.
        ORDER BY (wd.category IS NULL) DESC, wd.version DESC, wd.name
        RETURN wd, steps
        LIMIT 1
      `, { tenantId: ctx.tenantId, entityType }),
    )
    if (!defResult.records.length) return null

    const wd    = defResult.records[0].get('wd').properties    as Record<string, unknown>
    const steps = defResult.records[0].get('steps') as Array<{ properties: Record<string, unknown> }>
    const transitions = await loadTransitionRows(session, wd['id'] as string, ctx.tenantId)
    return mapWorkflowDefinition(wd, steps, transitions)
  })
}

/**
 * LE ETICHETTE DEI PASSI DI TUTTE LE DEFINIZIONI ATTIVE (20 set 2026, dal
 * giro nel browser).
 *
 * `workflowDefinition` ne restituisce UNA sola, e deve: il disegnatore ne
 * modifica una, e la scelta è deterministica apposta. Ma un tenant può averne
 * più d'una attiva per la stessa entità — su c-test le richieste hanno
 * «Service Request Fulfillment» e «Iter portatile con approvazione» — e un
 * ticket fermo su un passo dell'ALTRA si leggeva col nome interno: nella
 * stessa lista «Inviata» e «submitted», che per chi guarda sono due stati.
 *
 * Qui si leggono solo nome ed etichetta, da tutte: leggere uno stato non è
 * percorrere un processo, e non serve sapere da quale definizione viene. Due
 * definizioni con lo stesso nome di passo e un'etichetta diversa: vince la
 * generica (senza categoria) e, a pari merito, la versione più alta — la
 * stessa regola di `workflowDefinition`, così la lista e il dettaglio dicono
 * la stessa parola.
 */
export async function workflowStepLabels(
  _: unknown,
  { entityType }: { entityType: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const r = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})
        MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        RETURN s.name AS name, s.label AS label, s.labels AS labels
        ORDER BY (wd.category IS NULL) DESC, wd.version DESC, wd.name
      `, { tenantId: ctx.tenantId, entityType }),
    )
    const perNome = new Map<string, { name: string; label: string; labels: ReturnType<typeof parseLocalizedLabels> }>()
    for (const rec of r.records) {
      const name = rec.get('name') as string
      if (perNome.has(name)) continue
      perNome.set(name, {
        name,
        label: (rec.get('label') as string | null) ?? name,
        labels: parseLocalizedLabels(rec.get('labels'), `WorkflowStep ${name}`),
      })
    }
    return [...perNome.values()]
  })
}

export async function workflowDefinitionById(
  _: unknown,
  { id }: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const defResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $id, tenant_id: $tenantId})
        MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        RETURN wd, collect(s) AS steps
        LIMIT 1
      `, { id, tenantId: ctx.tenantId }),
    )
    if (!defResult.records.length) return null

    const wd    = defResult.records[0].get('wd').properties    as Record<string, unknown>
    const steps = defResult.records[0].get('steps') as Array<{ properties: Record<string, unknown> }>
    const transitions = await loadTransitionRows(session, id, ctx.tenantId)
    return mapWorkflowDefinition(wd, steps, transitions)
  })
}

/**
 * Le definizioni del tenant. Per difetto SOLO quelle attive — è il
 * comportamento storico e quello che serve a chi deve scegliere un iter da
 * usare.
 *
 * `includeInactive` (moduli del catalogo, ondata 3) serve a un caso preciso: una
 * copia appena duplicata nasce SPENTA di proposito, e senza questo parametro
 * era invisibile a ogni pagina — quindi non c'era modo di finirla e metterla in
 * servizio. Un vicolo cieco scoperto provando la duplicazione nel browser, non
 * dai test.
 */
export async function workflowDefinitions(
  _: unknown,
  { entityType, includeInactive }: { entityType?: string | null; includeInactive?: boolean | null },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const defResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {tenant_id: $tenantId})
        WHERE ($entityType IS NULL OR wd.entity_type = $entityType)
          AND ($includeInactive = true OR wd.active = true)
        MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        RETURN wd, collect(s) AS steps
      `, { tenantId: ctx.tenantId, entityType: entityType ?? null, includeInactive: includeInactive === true }),
    )

    const results = []
    for (const record of defResult.records) {
      const wd    = record.get('wd').properties    as Record<string, unknown>
      const steps = record.get('steps') as Array<{ properties: Record<string, unknown> }>
      const transitions = await loadTransitionRows(session, wd['id'] as string, ctx.tenantId)
      results.push(mapWorkflowDefinition(wd, steps, transitions))
    }
    return results
  })
}

// ── Field resolvers on Incident ───────────────────────────────────────────────

export async function incidentWorkflowInstance(
  incident: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi
      `, { id: incident.id, tenantId: ctx.tenantId }),
    )
    if (!result.records.length) return null
    return mapWI(result.records[0].get('wi').properties as Record<string, unknown>)
  })
}

export async function incidentAvailableTransitionsField(
  incident: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const wiResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi.id AS instanceId
      `, { id: incident.id, tenantId: ctx.tenantId }),
    )
    if (!wiResult.records.length) return []
    const instanceId = wiResult.records[0].get('instanceId') as string
    return transitionsOpenToApproval(session, ctx.tenantId, instanceId, await workflowEngine.getAvailableTransitions(session, instanceId), hasPermission(ctx, 'approval.override'))
  })
}

export async function incidentWorkflowHistoryField(
  incident: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})
              -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
              -[:STEP_HISTORY]->(exec:WorkflowStepExecution)
        RETURN exec
        ORDER BY exec.entered_at ASC
      `, { id: incident.id, tenantId: ctx.tenantId }),
    )
    return result.records.map((r) =>
      mapExec(r.get('exec').properties as Record<string, unknown>),
    )
  })
}

// ── Field resolvers on Change ─────────────────────────────────────────────────

export async function changeWorkflowInstance(
  change: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi
      `, { id: change.id, tenantId: ctx.tenantId }),
    )
    if (!result.records.length) return null
    return mapWI(result.records[0].get('wi').properties as Record<string, unknown>)
  })
}

export async function changeAvailableTransitionsField(
  change: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const wiResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi.id AS instanceId
      `, { id: change.id, tenantId: ctx.tenantId }),
    )
    if (!wiResult.records.length) return []
    const instanceId = wiResult.records[0].get('instanceId') as string
    return workflowEngine.getAvailableTransitions(session, instanceId)
  })
}

export async function changeWorkflowHistoryField(
  change: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (c:Change {id: $id, tenant_id: $tenantId})
              -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
              -[:STEP_HISTORY]->(exec:WorkflowStepExecution)
        RETURN exec
        ORDER BY exec.entered_at ASC
      `, { id: change.id, tenantId: ctx.tenantId }),
    )
    return result.records.map((r) =>
      mapExec(r.get('exec').properties as Record<string, unknown>),
    )
  })
}

// ── Field resolvers on ServiceRequest ─────────────────────────────────────────

export async function serviceRequestWorkflowInstance(
  sr: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi
      `, { id: sr.id, tenantId: ctx.tenantId }),
    )
    if (!result.records.length) return null
    return mapWI(result.records[0].get('wi').properties as Record<string, unknown>)
  })
}

export async function serviceRequestAvailableTransitionsField(
  sr: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const wiResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi.id AS instanceId
      `, { id: sr.id, tenantId: ctx.tenantId }),
    )
    if (!wiResult.records.length) return []
    const instanceId = wiResult.records[0].get('instanceId') as string
    // Una richiesta che richiede approvazione non offre le transizioni che la
    // salterebbero. Revisione del 14 set 2026 · IT-23: questo filtro stava sulla
    // query degli INCIDENT (dove cercava una richiesta e non filtrava mai), e
    // qui — il campo che la pagina della richiesta legge — mancava: il pulsante
    // «Prendi in carico» si vedeva e veniva rifiutato solo al clic.
    const transitions = await workflowEngine.getAvailableTransitions(session, instanceId)
    const allowed = []
    for (const tr of transitions) {
      if (await requestApprovalWouldBeSkipped(session, ctx.tenantId, instanceId, tr.toStep, { byPerson: true })) continue
      // The requester does not see the approval of their own request (24 Sep 2026).
      if (await isOwnRequestApproval(session, ctx.tenantId, instanceId, tr.toStep, ctx.userId)) continue
      allowed.push(tr)
    }
    return transitionsOpenToApproval(session, ctx.tenantId, instanceId, allowed, hasPermission(ctx, 'approval.override'))
  })
}
