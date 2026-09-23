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
import { DEFAULT_SLA_WARNING_MINUTES, matchById } from '@opengraphity/types'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { calculateDeadline } from './policy.js'
import { mapToSLAStatus, getSLAStatus, SLA_STATUS_PROJECTION, type SLAStatus } from './status.js'
import { cancelSLAJobs, scheduleBreachCheck, scheduleResponseCheck, scheduleWarning } from './scheduler.js'

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

/**
 * LA PRECEDENZA FRA REGOLA E POLICY, dichiarata (revisione totale · E-9).
 *
 * La regola VINCE: è una scelta esplicita dell'amministratore per quel caso, e
 * `handleTeamAssigned` non ricambia un SLA «fissato da una regola». Prima però
 * l'inverso non era protetto: `applyRuleSLA` cancellava QUALUNQUE SLA — anche
 * uno di policy, in corso e già parzialmente consumato — senza dire niente, e
 * se la regola scattava di nuovo (per esempio `on_update`) l'orologio
 * ripartiva da «adesso», azzerando il tempo già passato.
 *
 * Ora: l'istante di partenza e i fatti già avvenuti (violazione, presa in
 * carico) si CONSERVANO dallo stato precedente, e la sostituzione di uno SLA
 * di policy viene scritta nel log con il nome della policy che perde.
 */
export async function applyRuleSLA(input: RuleSLAInput): Promise<SLAStatus> {
  const { response, resolve } = assertRuleSLAMinutes(input.responseMinutes, input.resolveMinutes)
  const previous  = await getSLAStatus(input.tenantId, input.entityId)
  if (previous && previous.policy_id) {
    console.log(`[sla:rule] ${input.entityType} ${input.entityId}: the rule "${input.ruleName}" replaces the SLA of policy "${previous.policy_name ?? previous.policy_id}" (the rule wins, as declared)`)
  }
  // Il tempo già consumato non si azzera: se uno SLA c'era, la partenza resta
  // la sua. `input.startedAt` (la creazione del ticket) vale solo al primo giro.
  const startedAt = previous
    ? new Date(previous.started_at)
    : (input.startedAt ?? new Date())
  /**
   * Uno SLA da regola è sempre 24×7 (`tier_business_hours: false`), quindi il
   * fuso dell'organizzazione NON entra nel conto: `calculateDeadline` lo
   * ignora quando l'orario di servizio è spento. Prima lo si chiedeva comunque
   * con `getTenantTimezone`, che LANCIA se il tenant non ne ha uno: l'azione
   * `set_sla` falliva «cannot compute business-hours deadlines» per uno SLA
   * che non usa l'orario di servizio (revisione totale · E-23).
   */
  const TWENTY_FOUR_SEVEN = { businessHours: false, timezone: 'UTC', calendar: null } as const
  const responseDeadline = calculateDeadline(startedAt, response, TWENTY_FOUR_SEVEN.businessHours, TWENTY_FOUR_SEVEN.timezone, TWENTY_FOUR_SEVEN.calendar)
  const resolveDeadline  = calculateDeadline(startedAt, resolve,  TWENTY_FOUR_SEVEN.businessHours, TWENTY_FOUR_SEVEN.timezone, TWENTY_FOUR_SEVEN.calendar)

  // I job del vecchio stato non devono scattare su uno stato che non c'è più.
  await cancelSLAJobs(input.entityId, 'both')

  const session = getSession(undefined, 'WRITE')
  let status: SLAStatus
  try {
    const rows = await runQuery<Record<string, unknown>>(session, `
      ${matchById('e', { labels: ['Incident', 'Problem', 'ServiceRequest'], id: '$entityId' })}
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
        // I fatti già avvenuti restano: una violazione non si cancella perché
        // una regola ha cambiato l'obiettivo, e una presa in carico già fatta
        // non torna da fare (E-9).
        response_met:          $responseMet,
        resolve_met:           false,
        breached:              $breached,
        breached_at:           $breachedAt,
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
      responseMet: previous?.response_met === true,
      breached:    previous?.breached === true,
      breachedAt:  previous?.breached === true ? (previous.breached_at ?? null) : null,
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
