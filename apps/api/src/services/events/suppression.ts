/**
 * Passo 1 della pipeline: soppressione in finestra di change.
 *
 * Una change "in finestra" (passo `deployment`, oppure `scheduled` con una
 * releaseWindow/validationWindow del piano di rilascio che contiene
 * l'istante) collegata al CI dell'evento o a un CI a monte (DEPENDS_ON, fino
 * a `suppress_upstream_hops` salti) silenzia l'evento: status `suppressed`,
 * SUPPRESSED_BY, `event.suppressed`. Niente salute, niente incident.
 */
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import type { MonitoringEventPayload } from '@opengraphity/types'
import { publishEvent } from '../../lib/publishEvent.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { anyDeployWindowContains } from '../../lib/deployWindows.js'
import { eventsSuppressedTotal } from '../../middleware/metrics.js'
import { mapEventPayload, monitoringContext, toNumber, toStr } from './shared.js'
import { historyParams, historyWriteCypher } from './history.js'
import type { EventRecord, PipelineMode } from './types.js'

const log = logger.child({ module: 'event-correlation' })

/**
 * Passi del workflow change (scripts/lib/workflowDefinitions.ts:
 * assessment → approval → scheduled → deployment → review → closed).
 * `deployment` è l'implementazione: silenzia sempre. `scheduled` è la change
 * approvata e pianificata: silenzia solo dentro una finestra del piano.
 */
export const CHANGE_IMPLEMENTATION_STEP = 'deployment'
export const CHANGE_PLANNED_STEPS = ['scheduled'] as const
export const CHANGE_WINDOW_STEPS: readonly string[] = [CHANGE_IMPLEMENTATION_STEP, ...CHANGE_PLANNED_STEPS]

export interface EventSuppressedPayload extends MonitoringEventPayload { change_id: string }

/**
 * Una change è "in finestra" se è in implementazione, oppure pianificata con
 * almeno una finestra (release o validation) del piano che contiene l'istante.
 */
export function changeIsInWindow(step: string, plans: readonly unknown[], atMs: number): boolean {
  if (step === CHANGE_IMPLEMENTATION_STEP) return true
  if ((CHANGE_PLANNED_STEPS as readonly string[]).includes(step)) return anyDeployWindowContains(plans, atMs)
  return false
}

export interface SuppressingChange { changeId: string; code: string; step: string }

/**
 * La change (non eliminata) che silenzia il CI: collegata con AFFECTS_CI al CI
 * stesso o a un CI da cui questo dipende entro `hops` salti (0 = solo diretto),
 * con il workflow in un passo "di finestra" (vedi changeIsInWindow). Preferisce
 * la più vicina, poi quella in implementazione. Lettura: apre una sessione
 * propria (chiamata anche fuori dalla pipeline).
 */
export async function findSuppressingChange(tenantId: string, ciId: string, hops: number, at: string): Promise<SuppressingChange | null> {
  if (!Number.isInteger(hops) || hops < 0) throw new Error(`suppress_upstream_hops must be an integer >= 0, got ${JSON.stringify(hops)}`)
  const atMs = Date.parse(at)
  if (Number.isNaN(atMs)) throw new Error(`findSuppressingChange: "${at}" is not an ISO date`)
  // hops è un intero validato dalla policy: entra nel pattern di lunghezza variabile, non come parametro.
  const upstream = hops > 0
    ? `OPTIONAL MATCH p = (ci)-[:DEPENDS_ON*1..${hops}]->(up:ConfigurationItem {tenant_id: $tenantId})
       WITH ci, collect(DISTINCT {node: up, dist: length(p)}) AS ups`
    : `WITH ci, [] AS ups`
  const session = getSession()
  try {
    const rows = await runQuery<{ changeId: string; code: string | null; step: string; plans: unknown[] }>(session, `
      MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      ${upstream}
      UNWIND [{node: ci, dist: 0}] + ups AS t
      WITH t.node AS target, t.dist AS dist
      WHERE target IS NOT NULL
      MATCH (c:Change {tenant_id: $tenantId})-[:AFFECTS_CI]->(target)
      WHERE coalesce(c.deleted, false) = false
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
      WHERE wi.current_step IN $windowSteps
      OPTIONAL MATCH (c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {tenant_id: $tenantId})
      WITH c, wi, min(dist) AS dist, collect(DISTINCT dp.steps) AS plans
      RETURN c.id AS changeId, c.code AS code, wi.current_step AS step, plans
      ORDER BY dist, CASE WHEN wi.current_step = $implementationStep THEN 0 ELSE 1 END, c.created_at
    `, { ciId, tenantId, windowSteps: CHANGE_WINDOW_STEPS, implementationStep: CHANGE_IMPLEMENTATION_STEP })
    for (const r of rows) {
      if (changeIsInWindow(r.step, r.plans ?? [], atMs)) return { changeId: r.changeId, code: r.code ?? r.changeId, step: r.step }
    }
    return null
  } finally { await session.close() }
}

export async function applySuppression(session: Session, tenantId: string, ev: EventRecord, change: SuppressingChange, actorId: string, now: string, mode: PipelineMode, logCtx: Record<string, unknown> = {}): Promise<void> {
  const eventId = toStr(ev.props['id'])
  const alreadyByThisChange = ev.props['status'] === 'suppressed' && ev.props['suppressed_by_change_id'] === change.changeId
  if (alreadyByThisChange) {
    // Già silenziato da questa change: nessun nuovo avviso. `correlation_at`
    // resta "quando è stato silenziato"; `SUPPRESSED_BY.last_seen_at` avanza
    // solo quando lo strumento ha davvero rimandato l'allarme (ingest), non a
    // ogni passata periodica.
    if (mode !== 'ingest') return
    await runQuery(session, `
      MATCH (e:Event {id: $eventId, tenant_id: $tenantId})-[r:SUPPRESSED_BY]->(c:Change {id: $changeId, tenant_id: $tenantId})
      SET r.last_seen_at = $now, e.updated_at = $now
    `, { eventId, tenantId, changeId: change.changeId, now })
    return
  }
  const row = await runQueryOne<{ id: string }>(session, `
    MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    SET e.status = 'suppressed', e.suppressed_by_change_id = $changeId,
        e.correlation = 'suppressed', e.correlation_at = $now, e.correlation_due_at = null, e.updated_at = $now
    MERGE (e)-[r:SUPPRESSED_BY]->(c)
    ON CREATE SET r.created_at = $now
    SET r.last_seen_at = $now
    ${historyWriteCypher()}
    RETURN e.id AS id
  `, { eventId, tenantId, changeId: change.changeId, now, ...historyParams({ kind: 'suppressed', changeId: change.changeId }, now) })
  if (!row) throw new Error(`Event ${eventId} or Change ${change.changeId} vanished while suppressing (tenant ${tenantId})`)

  eventsSuppressedTotal.inc({})
  const payload: EventSuppressedPayload = { ...mapEventPayload({ ...ev.props, status: 'suppressed' }, ev.ciId), change_id: change.changeId }
  await publishEvent('event.suppressed', tenantId, actorId, payload, now)
  void audit(monitoringContext(tenantId), 'event.suppressed', 'Event', eventId, { changeId: change.changeId, changeCode: change.code, changeStep: change.step, ciId: ev.ciId })
  log.info({ ...logCtx, tenantId, eventId, changeId: change.changeId, step: change.step, ciId: ev.ciId }, 'Event suppressed by change window')
}

/**
 * Fine soppressione: torna firing, via il puntatore alla change; SUPPRESSED_BY
 * resta per la storia. `correlation = 'pending'` + `correlation_due_at = now`:
 * se la correlazione che segue fallisce, la passata periodica lo riprende.
 * La voce `unsuppressed` porta la change che silenziava (letta prima di azzerare il puntatore).
 *
 * Revisione 2 · B2-04: la scrittura è GUARDATA da `status = 'suppressed'` e
 * restituisce quante righe ha liberato. Tre attori possono rivalutare lo stesso
 * evento nello stesso istante (job di fine finestra, passata periodica,
 * `deleteChange`): senza guardia ciascuno scriveva la sua voce `unsuppressed`,
 * poi il secondo — che aveva letto `correlation = 'pending'` — si agganciava
 * all'incident appena aperto dal primo e ne riscriveva l'esito (`attached`
 * sopra `opened`, secondo `event.correlated`). `0` = qualcun altro l'ha già
 * liberato e lo sta correlando: chi arriva secondo si ferma.
 */
export async function liftSuppression(session: Session, tenantId: string, eventId: string, now: string): Promise<number> {
  const row = await runQueryOne<{ lifted: unknown }>(session, `
    MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
    WHERE e.status = 'suppressed'
    WITH e, e.suppressed_by_change_id AS changeId
    SET e.status = 'firing', e.suppressed_by_change_id = null,
        e.correlation = 'pending', e.correlation_at = $now, e.correlation_due_at = $now, e.updated_at = $now
    ${historyWriteCypher({ fields: { changeId: 'changeId' } })}
    RETURN count(e) AS lifted
  `, { eventId, tenantId, now, ...historyParams({ kind: 'unsuppressed' }, now) })
  return toNumber(row?.lifted)
}
