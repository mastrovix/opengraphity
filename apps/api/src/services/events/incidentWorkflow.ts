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

export interface IncidentStepInfo {
  resolvedStep: string
  terminalSteps: string[]
  /**
   * I passi in cui un incident riaperto torna «in lavorazione»: categoria
   * `active` o `escalated` e non il passo iniziale, in ordine di `step_order`
   * (ondata 4 · A4-3). Prima `reopenIncident` cercava il NOME `in_progress` con
   * un ripiego «primo passo non terminale», che in un workflow rinominato
   * poteva riaprire l'incident in un passo qualsiasi.
   */
  reopenSteps: string[]
}

/**
 * I passi TERMINALI del workflow degli incident, e solo quelli (revisione delle
 * otto ondate · A·3.4).
 *
 * ## Il vicolo cieco che questa funzione apre
 * Chi deve sapere soltanto «quali incident sono ancora aperti» chiedeva
 * `incidentStepInfo`, che **lancia** se il workflow non ha un passo di
 * categoria `resolved`. Ma quel passo serve a un'altra cosa (risolvere un
 * incident dal monitoraggio), e pretenderlo qui chiudeva una porta che non
 * c'entrava niente:
 *
 *   cancellare un CI → annotare gli incident che perdono la loro unica causa
 *   → «Tenant c-two: incident workflow has no step with category "resolved"»
 *
 * E siccome un tipo CI non si cancella finché ha dei CI, il cliente restava
 * chiuso fuori dal proprio metamodello: il tipo non si cancella perché ha dei
 * CI, i CI non si cancellano perché hanno degli incident, gli incident non si
 * chiudono perché manca il passo. Incontrato dal vivo su `c-two` mentre si
 * ripuliva una prova dell'ondata 4.
 *
 * Il fail-loud di `incidentStepInfo` resta dov'è giusto — chi deve **portare**
 * un incident nel passo risolto non può indovinarlo. Qui serve una lista, e una
 * lista vuota è una risposta legittima: un tenant senza workflow non ha
 * nemmeno istanze, quindi nessun incident da escludere.
 */
export async function incidentTerminalSteps(session: Session, tenantId: string): Promise<string[]> {
  const steps = await getWorkflowSteps(session, tenantId, 'incident')
  return steps.filter((s) => s.isTerminal).map((s) => s.name)
}

export async function incidentStepInfo(session: Session, tenantId: string): Promise<IncidentStepInfo> {
  const steps = await getWorkflowSteps(session, tenantId, 'incident')
  const resolved = steps.find((s) => s.category === 'resolved') ?? steps.find((s) => s.name === 'resolved')
  if (!resolved) throw new Error(`Tenant ${tenantId}: incident workflow has no step with category "resolved"`)
  const reopenSteps = steps
    .filter((s) => !s.isInitial && !s.isTerminal && (s.category === 'active' || s.category === 'escalated'))
    .sort((a, b) => (a.stepOrder ?? Number.MAX_SAFE_INTEGER) - (b.stepOrder ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name))
    .map((s) => s.name)
  return { resolvedStep: resolved.name, terminalSteps: steps.filter((s) => s.isTerminal).map((s) => s.name), reopenSteps }
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
 * come fa la mutation manuale.
 *
 * Il bersaglio si scelge per CATEGORIA (`info.reopenSteps`: `active` /
 * `escalated`, non iniziale), coerente con `incidentStepInfo` che è la parte
 * già fatta bene di questo file — non per il nome `in_progress` e senza più il
 * ripiego «primo passo non terminale», che era un fallback silenzioso: in un
 * workflow rinominato poteva riaprire l'incident in un passo che non c'entrava
 * niente (ondata 4 · A4-3, rinegoziazione dichiarata nel rapporto).
 * Nessuna transizione manuale verso un passo di lavorazione → errore.
 */
export async function reopenIncident(session: Session, tenantId: string, inc: OpenIncidentRow, info: IncidentStepInfo, notes: string): Promise<string> {
  const transitions = await (await engine()).getAvailableTransitions(session, inc.instanceId, tenantId)
  const toStep = info.reopenSteps.find((name) => transitions.some((t) => t.toStep === name))
  if (!toStep) {
    throw new Error(
      `Incident ${inc.incidentId}: no manual transition out of "${inc.step}" leads to a step with category ` +
      `"active"/"escalated" to reopen it (candidates: ${info.reopenSteps.join(', ') || 'none'}; ` +
      `available: ${transitions.map((t) => t.toStep).join(', ') || 'none'})`,
    )
  }
  await runMonitoringTransition(session, tenantId, inc.incidentId, inc.instanceId, toStep, 'manual', notes, 'reopen')
  return toStep
}
