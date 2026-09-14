/**
 * Lo SLA impostato da una regola (azione `set_sla` di trigger e Business Rule)
 * — revisione del 14 set 2026 · AU-4.
 *
 * Prima l'azione scriveva il nodo `SLAStatus` da sé: cancellava quello
 * esistente senza annullarne i job (che poi scattavano su un nodo che non
 * c'era più), ne creava uno nuovo senza programmare avviso, breach e risposta
 * — quindi nessun avviso e nessuna violazione, mai — e calcolava le scadenze
 * nel fuso `Europe/Rome` per ogni cliente. Qui la stessa strada del motore: il
 * fuso del tenant, lo stato sostituito, i tre controlli programmati.
 */
import { randomUUID } from 'crypto'
import { DEFAULT_SLA_WARNING_MINUTES } from '@opengraphity/types'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { calculateDeadline } from './policy.js'
import { mapToSLAStatus, SLA_STATUS_PROJECTION, type SLAStatus } from './status.js'
import { cancelSLAJobs, scheduleBreachCheck, scheduleResponseCheck, scheduleWarning } from './scheduler.js'
import { getTenantTimezone } from './olaBreach.js'

export interface RuleSLAInput {
  tenantId:        string
  entityType:      string
  entityId:        string
  responseMinutes: number
  resolveMinutes:  number
  /** Il nome della regola: il report lo mostra al posto della policy. */
  ruleName:        string
  /** Minuti di preavviso; senza, il valore di fabbrica dichiarato. */
  warningMinutes?: number
  /** Da quando parte l'orologio. Default: adesso (la regola si applica quando scatta). */
  startedAt?:      Date
}

export function assertRuleSLAMinutes(responseMinutes: unknown, resolveMinutes: unknown): { response: number; resolve: number } {
  const response = Number(responseMinutes)
  const resolve  = Number(resolveMinutes)
  if (!Number.isInteger(response) || response <= 0 || !Number.isInteger(resolve) || resolve <= 0) {
    throw new Error(`set_sla: response_minutes and resolve_minutes must be positive whole numbers (got ${JSON.stringify(responseMinutes)}, ${JSON.stringify(resolveMinutes)})`)
  }
  if (response > resolve) {
    throw new Error(`set_sla: the response target (${response} min) cannot be later than the resolution target (${resolve} min)`)
  }
  return { response, resolve }
}

export async function applyRuleSLA(input: RuleSLAInput): Promise<SLAStatus> {
  const { response, resolve } = assertRuleSLAMinutes(input.responseMinutes, input.resolveMinutes)
  const timezone  = await getTenantTimezone(input.tenantId)
  const startedAt = input.startedAt ?? new Date()
  const responseDeadline = calculateDeadline(startedAt, response, false, timezone, null)
  const resolveDeadline  = calculateDeadline(startedAt, resolve,  false, timezone, null)

  // I job del vecchio stato non devono scattare su uno stato che non c'è più.
  await cancelSLAJobs(input.entityId, 'both')

  const session = getSession(undefined, 'WRITE')
  let status: SLAStatus
  try {
    const rows = await runQuery<Record<string, unknown>>(session, `
      MATCH (e {id: $entityId, tenant_id: $tenantId})
      WHERE e:Incident OR e:Problem OR e:ServiceRequest
      OPTIONAL MATCH (e)-[:HAS_SLA]->(old:SLAStatus)
      DETACH DELETE old
      WITH DISTINCT e
      CREATE (e)-[:HAS_SLA]->(s:SLAStatus {
        id:                    $id,
        tenant_id:             $tenantId,
        entity_id:             $entityId,
        entity_type:           $entityType,
        started_at:            $startedAt,
        response_deadline:     $responseDeadline,
        resolve_deadline:      $resolveDeadline,
        response_met:          false,
        resolve_met:           false,
        breached:              false,
        tier_severity:         'custom',
        tier_response_minutes: $response,
        tier_resolve_minutes:  $resolve,
        tier_business_hours:   false,
        tier_warning_minutes:  $warning,
        set_by_rule:           $ruleName
      })
      RETURN ${SLA_STATUS_PROJECTION}
    `, {
      id: randomUUID(), tenantId: input.tenantId, entityId: input.entityId, entityType: input.entityType,
      startedAt: startedAt.toISOString(), responseDeadline: responseDeadline.toISOString(), resolveDeadline: resolveDeadline.toISOString(),
      response, resolve, ruleName: input.ruleName, warning: input.warningMinutes ?? DEFAULT_SLA_WARNING_MINUTES,
    })
    const row = rows[0]
    if (!row) throw new Error(`set_sla: ${input.entityType} ${input.entityId} not found, or it is not a ticket with an SLA`)
    status = mapToSLAStatus(row)
  } finally {
    await session.close()
  }

  await Promise.all([scheduleWarning(status), scheduleBreachCheck(status), scheduleResponseCheck(status)])
  return status
}
