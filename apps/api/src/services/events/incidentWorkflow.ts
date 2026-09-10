/**
 * Workflow dell'incident per conto del monitoraggio (Event Management):
 * passi della definizione, transizioni eseguite dall'attore `monitoring`,
 * riapertura. Ogni scrittura sull'incident passa da incidentService /
 * workflowEngine (mai Cypher diretto sull'incident) con `userId: 'monitoring'`.
 */
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import { logger } from '../../lib/logger.js'
import { getWorkflowSteps } from '../../lib/workflowHelpers.js'
import { engine, incidents } from './deps.js'
import { MONITORING_ACTOR } from './shared.js'

const log = logger.child({ module: 'event-correlation' })

export interface IncidentStepInfo { resolvedStep: string; terminalSteps: string[] }

export async function incidentStepInfo(session: Session, tenantId: string): Promise<IncidentStepInfo> {
  const steps = await getWorkflowSteps(session, tenantId, 'incident')
  const resolved = steps.find((s) => s.category === 'resolved') ?? steps.find((s) => s.name === 'resolved')
  if (!resolved) throw new Error(`Tenant ${tenantId}: incident workflow has no step with category "resolved"`)
  return { resolvedStep: resolved.name, terminalSteps: steps.filter((s) => s.isTerminal).map((s) => s.name) }
}

export interface OpenIncidentRow { incidentId: string; instanceId: string; step: string }

/** Arco della definizione del workflow (TRANSITIONS_TO) con l'etichetta del passo di arrivo. */
export interface DefinitionTransition {
  fromStep:  string
  toStep:    string
  toLabel:   string | null
  trigger:   string
  condition: string | null
}

/** Incident non terminale a cui l'evento è già correlato (per il commento di sfarfallio). */
export async function findLinkedOpenIncident(session: Session, tenantId: string, eventId: string, info: IncidentStepInfo): Promise<string | null> {
  const row = await runQueryOne<{ incidentId: string }>(session, `
    MATCH (e:Event {id: $eventId, tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})
    MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
    WHERE NOT wi.current_step IN $terminalSteps
    RETURN i.id AS incidentId, i.created_at AS createdAt
    ORDER BY createdAt DESC LIMIT 1
  `, { eventId, tenantId, terminalSteps: info.terminalSteps })
  return row?.incidentId ?? null
}

/** Passo corrente dell'incident (qualunque sia): null se l'incident non esiste. */
export async function incidentStep(session: Session, tenantId: string, incidentId: string): Promise<OpenIncidentRow | null> {
  return runQueryOne<OpenIncidentRow>(session, `
    MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
    RETURN i.id AS incidentId, wi.id AS instanceId, wi.current_step AS step
  `, { incidentId, tenantId })
}

/** Tutti gli archi della definizione a cui appartiene l'istanza (non solo quelli dal passo corrente). */
export async function loadDefinitionTransitions(session: Session, instanceId: string, tenantId: string): Promise<DefinitionTransition[]> {
  return runQuery<DefinitionTransition>(session, `
    MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
    MATCH (wd:WorkflowDefinition {id: wi.definition_id, tenant_id: $tenantId})-[:HAS_STEP]->(from:WorkflowStep)
    MATCH (from)-[tr:TRANSITIONS_TO]->(to:WorkflowStep)
    RETURN from.name AS fromStep, to.name AS toStep, to.label AS toLabel, tr.trigger AS trigger, tr.condition AS condition
  `, { instanceId, tenantId })
}

/**
 * Esegue UNA transizione del workflow dell'incident per conto del monitoraggio
 * replicando i side effect della mutation manuale: transizione via motore,
 * commento in timeline (se `comment`: i passi intermedi della chiusura
 * automatica lasciano un solo commento riassuntivo alla fine), evento
 * `incident.<step>`. Transizione rifiutata dal motore → errore (nessun
 * fallback: il job ritenta e resta visibile). Le enter/exit action del passo
 * (es. orologi SLA) girano come per un utente; un loro errore è già
 * persistito dal motore e viene loggato, non nascosto.
 */
export async function runMonitoringTransition(session: Session, tenantId: string, incidentId: string, instanceId: string, toStep: string, triggerType: 'manual' | 'automatic', notes: string, what: string, comment = true): Promise<void> {
  const res = await (await engine()).transition(
    session,
    { instanceId, toStepName: toStep, triggeredBy: MONITORING_ACTOR, triggerType, notes, tenantId },
    { userId: MONITORING_ACTOR, notes, entityData: {} },
  )
  if (!res.success) throw new Error(`Incident ${incidentId}: ${what} transition to "${toStep}" failed: ${res.error ?? 'unknown error'}`)
  if (res.actionErrors?.length) log.error({ tenantId, incidentId, toStep, actionErrors: res.actionErrors }, `Incident moved to "${toStep}" by monitoring but step actions failed`)
  const ctx = { tenantId, userId: MONITORING_ACTOR }
  const incidentService = await incidents()
  if (comment) await incidentService.addIncidentComment(incidentId, ctx, `Workflow: ${toStep} — ${notes}`)
  await incidentService.publishIncidentTransition(incidentId, toStep, ctx)
}

/**
 * Riapre un incident risolto con la transizione manuale "Riapri" (seed:
 * tr-resolved-inprogress, `inputField: notes`) tramite il motore del workflow,
 * come fa la mutation manuale. Nessuna transizione di riapertura → errore.
 */
export async function reopenIncident(session: Session, tenantId: string, inc: OpenIncidentRow, info: IncidentStepInfo, notes: string): Promise<string> {
  const transitions = await (await engine()).getAvailableTransitions(session, inc.instanceId, tenantId)
  const target = transitions.find((t) => t.toStep === 'in_progress')
    ?? transitions.find((t) => t.toStep !== info.resolvedStep && !info.terminalSteps.includes(t.toStep))
  if (!target) throw new Error(`Incident ${inc.incidentId}: no manual transition out of "${inc.step}" to reopen it`)
  await runMonitoringTransition(session, tenantId, inc.incidentId, inc.instanceId, target.toStep, 'manual', notes, 'reopen')
  return target.toStep
}
