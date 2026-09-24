import { randomUUID } from 'crypto'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { businessMinutesBetween, calculateDeadline, type SLATier, type SLAPolicy } from './policy.js'
import { calendarFor, type ServiceCalendar } from './calendar.js'

export interface SLAStatus {
  id: string
  tenant_id: string
  entity_id: string
  entity_type: string
  started_at: string
  response_deadline: string
  resolve_deadline: string
  response_met: boolean
  /** true only if the entity was resolved within `resolve_deadline` (net of pauses). */
  resolve_met: boolean
  /** Set when the resolve deadline elapsed unresolved; NEVER cleared by a later resolution. */
  breached: boolean
  /** QUANDO la violazione è avvenuta (revisione totale · C-8): il digest conta le violazioni del giorno. */
  breached_at?: string
  /** Instant the entity was resolved/completed, when known. */
  resolved_at?: string
  paused_at?: string
  paused_type?: string   // 'resolve' | 'response' | 'both' — which clock is paused
  /**
   * DA QUALE POLICY È NATO questo SLA. Senza, il report non poteva dire quanto
   * è stata rispettata ciascuna policy — solo il totale e la severità. `id` è
   * il riferimento (una policy del cliente, o quella di default del prodotto);
   * `name` è il nome al momento della creazione, per quando la policy viene poi
   * eliminata. Assenti sugli SLA creati prima di questo campo: non si ricostruiscono.
   */
  policy_id?: string
  policy_name?: string
  /**
   * I millisecondi TOTALI di pausa accumulati (revisione totale · E-2),
   * contati con l'orologio dello SLA: su un tier in orario di servizio sono
   * ore di servizio, non di calendario (revisione del 23 set 2026). La
   * ripresa sposta le scadenze di quanto la pausa è durata; questo campo tiene
   * il totale, così un cambio di policy può riportare lo stesso spostamento
   * senza ricalcolare la scadenza «vecchia senza pause» — ricalcolo che usava
   * il fuso e il CALENDARIO della policy NUOVA con i minuti del tier vecchio,
   * e con una policy 24×7 lanciava («business-hours deadline without a service
   * calendar») su una policy che di calendario non ha bisogno.
   */
  paused_total_ms?: number
  /**
   * Quando l'avviso «tempo di presa in carico scaduto» è già stato mandato
   * (revisione totale · E-12). Alla ripresa di una pausa l'orologio della
   * risposta veniva riprogrammato ogni volta che `response_met` era falso,
   * senza sapere se l'avviso era già uscito: un incident non preso in carico
   * che entrava in pausa dopo la scadenza riceveva un secondo avviso
   * identico alla ripresa.
   */
  response_breach_notified_at?: string
  /** When the response was given (G14): later than `response_deadline` is a late response. */
  response_met_at?: string
  tier: SLATier
}

/** Columns returned by every SLAStatus read — one source for the projection. */
/**
 * Le letture dei ticket usano l'UNIONE DI ETICHETTE (revisione totale ·
 * E-27): erano `MATCH (e {id, tenant_id}) WHERE e:Incident OR e:Problem OR
 * e:ServiceRequest`, cioè una scansione di tutti i nodi del database a ogni
 * evento e a ogni job SLA, perché senza etichetta nel pattern nessun indice è
 * utilizzabile. `(e:Incident|Problem|ServiceRequest {...})` dice la stessa
 * cosa e passa dagli indici per etichetta.
 *
 * ATTENZIONE, un difetto pagato caro: riscrivendo `getEntityScope` (che
 * comprende anche `Change`) era rimasto un `OR e:Change` PENZOLANTE dopo il
 * pattern — Cypher non valido. Il motore SLA lanciava a ogni
 * `sla.response.start` e a ogni `ticket.team_assigned`, quindi da quel commit
 * NESSUN ticket riceveva più uno SLA. Niente l'ha visto: i test di `engine`
 * simulano `getEntityScope`, TypeScript non guarda dentro una stringa, e un
 * giro nel browser che si limita ad APRIRE le pagine non esegue il consumer.
 * L'ha trovato il primo giro che ha creato un ticket davvero. Le query di
 * questo file ora hanno il loro test contro un Neo4j vero
 * (`__tests__/statusCypher.test.ts`).
 */
export const SLA_STATUS_PROJECTION = `
      s.id as id, s.tenant_id as tenant_id, s.entity_id as entity_id,
      s.entity_type as entity_type, s.started_at as started_at,
      s.response_deadline as response_deadline, s.resolve_deadline as resolve_deadline,
      s.response_met as response_met, s.resolve_met as resolve_met,
      s.breached as breached, s.resolved_at as resolved_at,
      s.paused_at as paused_at, s.paused_type as paused_type,
      s.tier_severity as tier_severity,
      s.tier_response_minutes as tier_response_minutes,
      s.tier_resolve_minutes as tier_resolve_minutes,
      s.tier_business_hours as tier_business_hours,
      s.tier_warning_minutes as tier_warning_minutes,
      s.policy_id as policy_id, s.policy_name as policy_name,
      s.response_breach_notified_at as response_breach_notified_at,
      s.response_met_at as response_met_at,
      s.paused_total_ms as paused_total_ms,
      s.breached_at as breached_at
`

export type SLAPauseType = 'resolve' | 'response' | 'both'

// ── Session helpers ──────────────────────────────────────────────────────────
// getSession() (not getDriver().session()): the wrapped session feeds the
// slow-query/metrics tracker and converts Neo4j Integers (D-22).

function readSession() {
  return getSession(undefined, 'READ')
}

function writeSession() {
  return getSession(undefined, 'WRITE')
}

// ── Node → SLAStatus mapping ─────────────────────────────────────────────────

export function mapToSLAStatus(props: Record<string, unknown>): SLAStatus {
  return {
    id:                props['id']                as string,
    tenant_id:         props['tenant_id']         as string,
    entity_id:         props['entity_id']         as string,
    entity_type:       props['entity_type']       as string,
    started_at:        props['started_at']        as string,
    response_deadline: props['response_deadline'] as string,
    resolve_deadline:  props['resolve_deadline']  as string,
    response_met:      props['response_met']      as boolean,
    resolve_met:       props['resolve_met']       as boolean,
    breached:          props['breached']          as boolean,
    breached_at:       (props['breached_at'] ?? undefined) as string | undefined,
    resolved_at:       (props['resolved_at'] ?? undefined) as string | undefined,
    paused_at:         props['paused_at']         as string | undefined,
    paused_type:       props['paused_type']       as string | undefined,
    policy_id:         (props['policy_id']   ?? undefined) as string | undefined,
    policy_name:       (props['policy_name'] ?? undefined) as string | undefined,
    // E-2 e E-12: lo spostamento accumulato dalle pause e l'avviso della presa
    // in carico già mandato. `toNumber` non serve: la sessione del pacchetto
    // converte gli Integer di Neo4j.
    paused_total_ms:   props['paused_total_ms'] == null ? undefined : Number(props['paused_total_ms']),
    response_breach_notified_at: (props['response_breach_notified_at'] ?? undefined) as string | undefined,
    response_met_at:   (props['response_met_at'] ?? undefined) as string | undefined,
    tier: {
      severity:         props['tier_severity']         as string,
      response_minutes: props['tier_response_minutes'] as number,
      resolve_minutes:  props['tier_resolve_minutes']  as number,
      business_hours:   props['tier_business_hours']   as boolean,
      warning_minutes:  props['tier_warning_minutes']  as number,
    },
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * `created_at` of the SLA-bearing entity (Incident/Problem/ServiceRequest).
 * The SLA clock starts when the entity was created, not when the consumer
 * happened to process the event (retries/backoff would otherwise push every
 * deadline forward — D-29). Throws if the entity or its created_at is missing:
 * an SLA anchored to an unknown instant is worse than a failed, retried job.
 */
export async function getEntityCreatedAt(tenantId: string, entityId: string): Promise<Date> {
  const cypher = `
    MATCH (e:Incident|Problem|ServiceRequest {id: $entityId, tenant_id: $tenantId})
    RETURN e.created_at AS created_at
  `
  const session = readSession()
  try {
    const row = await runQueryOne<{ created_at: unknown }>(session, cypher, { tenantId, entityId })
    if (!row) throw new Error(`[sla:status] Entity ${entityId} not found for tenant ${tenantId}`)
    return parseInstant(row.created_at, `created_at of entity ${entityId}`)
  } finally {
    await session.close()
  }
}

/**
 * La CATEGORIA e il TEAM dell'entità, per scegliere la policy SLA.
 *
 * Il difetto che questo chiude (terza revisione, provato dal browser): la
 * pagina «Policy SLA» offre quattro ambiti — priorità, categoria, team, e le
 * loro combinazioni — e il selettore riceveva `null` per categoria e team,
 * SEMPRE. Delle cinque specificità che sa distinguere restavano raggiungibili
 * solo due: «priorità sola» e «tutto». Una policy con una categoria o un team
 * non si applicava mai, e la pagina la mostrava con la sua riga «Si applica a:
 * Incident con categoria network» — una promessa che il motore non manteneva,
 * senza un log, senza un avviso.
 *
 * Entità senza categoria o senza team: `null`, che è il valore giusto — una
 * policy che chiede una categoria non deve applicarsi a un ticket che non ne
 * ha.
 */
export async function getEntityScope(
  tenantId: string, entityId: string,
): Promise<{ category: string | null; teamId: string | null }> {
  const cypher = `
    MATCH (e:Incident|Problem|ServiceRequest|Change {id: $entityId, tenant_id: $tenantId})
    OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(t:Team)
    RETURN e.category AS category, t.id AS teamId
  `
  const session = readSession()
  try {
    const row = await runQueryOne<{ category: unknown; teamId: unknown }>(session, cypher, { tenantId, entityId })
    if (!row) throw new Error(`[sla:status] Entity ${entityId} not found for tenant ${tenantId}`)
    return {
      category: typeof row.category === 'string' && row.category !== '' ? row.category : null,
      teamId:   typeof row.teamId   === 'string' && row.teamId   !== '' ? row.teamId   : null,
    }
  } finally {
    await session.close()
  }
}

/**
 * La priorità del ticket con cui si sceglie la policy: l'incident la tiene in
 * `severity`, problem e richieste in `priority`. Serve a chi avvia uno SLA
 * dopo la creazione (azione di passo «avvia SLA»).
 */
export async function getEntityPriority(tenantId: string, entityType: 'incident' | 'problem' | 'service_request', entityId: string): Promise<unknown> {
  const label = entityType === 'incident' ? 'Incident' : entityType === 'problem' ? 'Problem' : 'ServiceRequest'
  const prop  = entityType === 'incident' ? 'severity' : 'priority'
  const session = readSession()
  try {
    const row = await runQueryOne<{ priority: unknown }>(session, `MATCH (e:${label} {id: $entityId, tenant_id: $tenantId}) RETURN e.${prop} AS priority`, { tenantId, entityId })
    if (!row) throw new Error(`[sla:status] ${entityType} ${entityId} not found for tenant ${tenantId}`)
    return row.priority
  } finally {
    await session.close()
  }
}

/** ISO string → Date, loud on anything unparseable. */
function parseInstant(value: unknown, what: string): Date {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`[sla:status] ${what} is missing or not an ISO string (got ${JSON.stringify(value)})`)
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error(`[sla:status] ${what} is not a valid instant: "${value}"`)
  return d
}

export async function createSLAStatus(params: {
  tenantId: string
  entityId: string
  entityType: string
  severity: string
  policy: SLAPolicy
  /** Instant the SLA clock starts (the entity's created_at). Defaults to now. */
  startedAt?: Date
}): Promise<SLAStatus> {
  const { tenantId, entityId, entityType, severity, policy } = params

  const tier = policy.tiers.find((t) => t.severity === severity)
  if (!tier) {
    throw new Error(
      `[sla:status] No tier found for severity "${severity}" in policy "${policy.id}"`,
    )
  }

  const now              = params.startedAt ?? new Date()
  const responseDeadline = calculateDeadline(now, tier.response_minutes, tier.business_hours, policy.timezone, policy.calendar)
  const resolveDeadline  = calculateDeadline(now, tier.resolve_minutes,  tier.business_hours, policy.timezone, policy.calendar)

  const id = randomUUID()

  const cypher = `
    MATCH (e:Incident|Problem|ServiceRequest {id: $entityId, tenant_id: $tenantId})
    // MERGE (not CREATE): an at-least-once redelivery of entity.created must not
    // create a second SLAStatus for the same entity. ON CREATE sets the fields
    // once; a redelivery returns the existing status unchanged.
    MERGE (e)-[:HAS_SLA]->(s:SLAStatus { tenant_id: $tenantId, entity_id: $entityId })
    ON CREATE SET
      s.id                    = $id,
      s.entity_type           = $entityType,
      s.started_at            = $startedAt,
      s.response_deadline     = $responseDeadline,
      s.resolve_deadline      = $resolveDeadline,
      s.response_met          = false,
      s.resolve_met           = false,
      s.breached              = false,
      s.tier_severity         = $tierSeverity,
      s.tier_response_minutes = $tierResponseMinutes,
      s.tier_resolve_minutes  = $tierResolveMinutes,
      s.tier_business_hours   = $tierBusinessHours,
      s.tier_warning_minutes  = $tierWarningMinutes,
      s.policy_id             = $policyId,
      s.policy_name           = $policyName
    RETURN ${SLA_STATUS_PROJECTION}
  `

  const session = writeSession()
  try {
    const results = await runQuery<Record<string, unknown>>(session, cypher, {
      id,
      tenantId,
      entityId,
      entityType,
      startedAt:            now.toISOString(),
      responseDeadline:     responseDeadline.toISOString(),
      resolveDeadline:      resolveDeadline.toISOString(),
      tierSeverity:         tier.severity,
      tierResponseMinutes:  tier.response_minutes,
      tierResolveMinutes:   tier.resolve_minutes,
      tierBusinessHours:    tier.business_hours,
      tierWarningMinutes:   tier.warning_minutes,
      policyId:             policy.id,
      policyName:           policy.name,
    })

    const row = results[0]
    if (!row) throw new Error(`[sla:status] Failed to create SLAStatus for entity ${entityId}`)
    return mapToSLAStatus(row)
  } finally {
    await session.close()
  }
}

export async function getSLAStatus(
  tenantId: string,
  entityId: string,
): Promise<SLAStatus | null> {
  const cypher = `
    MATCH (e:Incident|Problem|ServiceRequest {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    RETURN ${SLA_STATUS_PROJECTION}
  `

  const session = readSession()
  try {
    const row = await runQueryOne<Record<string, unknown>>(session, cypher, { tenantId, entityId })
    return row ? mapToSLAStatus(row) : null
  } finally {
    await session.close()
  }
}

/**
 * Numero e titolo del ticket che porta lo SLA, per le notifiche. Giro nel
 * browser del 14 set 2026 (#18): «SLA about to be breached» arrivava col
 * corpo «29» — i minuti e basta, senza dire di quale ticket.
 */
/** Come il ticket compare nelle notifiche SLA: numero, titolo e i suoi valori veri. */
export interface TicketReference {
  number:   string
  title:    string
  severity: string | null
  status:   string | null
}

export async function ticketReference(tenantId: string, entityId: string): Promise<TicketReference | null> {
  const session = readSession()
  try {
    const row = await runQueryOne<{ number: string | null; title: string | null; severity: string | null; status: string | null }>(session, `
      MATCH (e:Incident|Problem|ServiceRequest {id: $entityId, tenant_id: $tenantId})
      RETURN coalesce(e.number, e.code) AS number, e.title AS title,
             coalesce(e.severity, e.priority) AS severity, e.status AS status
    `, { tenantId, entityId })
    if (!row) return null
    if (!row.number || !row.title) throw new Error(`[sla:status] ticket ${entityId} has no number or title: the SLA notification would not say which ticket`)
    // `severity` e `status` viaggiano con l'evento perché la card Slack/Teams
    // della violazione li scriveva CABLATI («Severity: HIGH · Status: open»)
    // per qualunque ticket, anche un critical in escalation (revisione totale
    // · E-8). Sono facoltativi: un ticket senza priorità resta possibile.
    return { number: row.number, title: row.title, severity: row.severity ?? null, status: row.status ?? null }
  } finally {
    await session.close()
  }
}

/**
 * Registra che l'avviso di scadenza della presa in carico è stato mandato
 * (E-12): alla ripresa di una pausa non se ne manda un secondo.
 */
export async function markResponseBreachNotified(tenantId: string, entityId: string, at: string = new Date().toISOString()): Promise<void> {
  const session = writeSession()
  try {
    await runQuery(session, `
      MATCH (e:Incident|Problem|ServiceRequest {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
      SET s.response_breach_notified_at = coalesce(s.response_breach_notified_at, $at)
    `, { tenantId, entityId, at })
  } finally {
    await session.close()
  }
}

/**
 * Records that the resolve-deadline warning went out, FOR WHICH deadline
 * (review of 23 Sep 2026). The SLA sweep reads it: a warning already sent for
 * this deadline is not sent again, while a new deadline (a policy or a rule
 * changed it) gets its own warning.
 */
export async function markWarningSent(tenantId: string, entityId: string, resolveDeadline: string): Promise<void> {
  const session = writeSession()
  try {
    await runQuery(session, `
      MATCH (e:Incident|Problem|ServiceRequest {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
      SET s.warning_sent_for = $resolveDeadline
    `, { tenantId, entityId, resolveDeadline })
  } finally {
    await session.close()
  }
}

/**
 * The response is given, and WHEN (tour of 24 Sep 2026, G14): the badge said
 * «Overdue by 37 min» and, once someone took the ticket, «1 d 7 h left» — the
 * late response left no trace. The instant stays the first one: a second
 * response (a reassignment) does not move it.
 */
export async function markResponseMet(tenantId: string, entityId: string, at: Date = new Date()): Promise<void> {
  const cypher = `
    MATCH (e:Incident|Problem|ServiceRequest {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    SET s.response_met = true, s.response_met_at = coalesce(s.response_met_at, $at)
  `
  const session = writeSession()
  try {
    await runQuery(session, cypher, { tenantId, entityId, at: at.toISOString() })
  } finally {
    await session.close()
  }
}

/**
 * THE CLOCK AN SLA COUNTS ON (review of 23 Sep 2026).
 *
 * A pause, and the time a ticket stays resolved before it is reopened, move
 * the deadlines forward by the time the clock did not count. The shift was
 * wall-clock milliseconds on every SLA: on a tier in service hours a pause
 * from Friday 17:00 to Monday 09:00 moved the deadline by 64 hours — six and
 * a half business days — where the clock had missed two business hours.
 * The shift is now measured on the SLA's own clock: 24×7, or the service
 * calendar and time zone of the policy it came from.
 */
interface SLAClock { businessHours: boolean; timezone: string; calendar: ServiceCalendar | null }

const TWENTY_FOUR_SEVEN: SLAClock = { businessHours: false, timezone: 'UTC', calendar: null }

async function clockOf(status: SLAStatus): Promise<SLAClock> {
  if (!status.tier.business_hours) return TWENTY_FOUR_SEVEN
  if (!status.policy_id) {
    throw new Error(`[sla:status] SLAStatus ${status.id} counts service hours but names no policy: its service calendar cannot be found`)
  }
  const session = readSession()
  let row: { name: string | null; timezone: string | null; tenantTimezone: string | null; calendarId: string | null } | null
  try {
    row = await runQueryOne(session, `
      MATCH (p:SLAPolicyNode {id: $policyId, tenant_id: $tenantId})
      OPTIONAL MATCH (t:Tenant {id: $tenantId})
      RETURN p.name AS name, p.timezone AS timezone, t.timezone AS tenantTimezone, p.calendar_id AS calendarId
    `, { policyId: status.policy_id, tenantId: status.tenant_id })
  } finally {
    await session.close()
  }
  if (!row) {
    throw new Error(`[sla:status] SLAStatus ${status.id} counts service hours on policy ${status.policy_id}, which no longer exists: its service calendar cannot be found`)
  }
  // The same time zone rule as the selector: the policy's own, else the tenant's.
  const timezone = row.timezone || row.tenantTimezone
  if (!timezone) throw new Error(`[sla:status] SLA policy "${String(row.name)}" has no time zone and neither has tenant ${status.tenant_id}`)
  const calendar = await calendarFor(status.tenant_id, { name: row.name ?? status.policy_id, businessHours: true, calendarId: row.calendarId })
  return { businessHours: true, timezone, calendar }
}

/** The time between `from` and `to` that the clock counts, in milliseconds. */
function countedMs(from: Date, to: Date, clock: SLAClock): number {
  if (to.getTime() <= from.getTime()) return 0
  if (!clock.businessHours) return to.getTime() - from.getTime()
  return businessMinutesBetween(from, to, true, clock.timezone, clock.calendar) * 60_000
}

/** `deadline` moved forward by `ms` of the clock's time. */
function extendDeadline(deadline: Date, ms: number, clock: SLAClock): Date {
  if (ms <= 0) return deadline
  if (!clock.businessHours) return new Date(deadline.getTime() + ms)
  return calculateDeadline(deadline, ms / 60_000, true, clock.timezone, clock.calendar)
}

/**
 * Records the resolution of the entity at `resolvedAt` and decides the SLA
 * outcome (D-02):
 *   - `resolve_met = true`  only if `resolvedAt <= resolve_deadline` (the
 *     deadline is extended by the still-open pause, if the SLA was paused when
 *     the entity got resolved);
 *   - otherwise `resolve_met = false` and `breached = true`.
 * `breached` is never cleared: a breach that later got resolved stays a breach
 * in the compliance history. Also stores `resolved_at` and closes any pause.
 * Returns the updated status, or null if the entity has no SLAStatus.
 */
export async function markResolveMet(
  tenantId: string,
  entityId: string,
  resolvedAt: Date = new Date(),
): Promise<SLAStatus | null> {
  const current = await getSLAStatus(tenantId, entityId)
  if (!current) return null
  if (Number.isNaN(resolvedAt.getTime())) {
    throw new Error(`[sla:status] markResolveMet(${entityId}): resolvedAt is not a valid instant`)
  }

  const deadline = parseInstant(current.resolve_deadline, `resolve_deadline of SLAStatus ${current.id}`)
  // A pause still open at resolution time extends the deadline by its duration
  // on the SLA's clock, exactly as resumeSLA would have done.
  const pausedResolve = current.paused_at && (current.paused_type ?? 'both') !== 'response'
  const clock = pausedResolve ? await clockOf(current) : TWENTY_FOUR_SEVEN
  const pauseShiftMs = pausedResolve
    ? countedMs(parseInstant(current.paused_at, `paused_at of SLAStatus ${current.id}`), resolvedAt, clock)
    : 0
  const effectiveDeadlineMs = extendDeadline(deadline, pauseShiftMs, clock).getTime()
  const met = resolvedAt.getTime() <= effectiveDeadlineMs

  /**
   * La pausa ancora aperta alla risoluzione si SCRIVE nella scadenza, come
   * farebbe `resumeSLA` (revisione totale · E-21). Prima serviva solo a
   * decidere l'esito e poi si perdeva: un ticket stato due giorni in attesa e
   * risolto da un passo «in attesa → risolto» ripartiva, se riaperto, da una
   * scadenza che non teneva conto di quei due giorni — e violava quasi
   * subito. Il totale delle pause segue la scadenza, così anche il cambio di
   * policy lo ritrova.
   */
  const cypher = `
    MATCH (e:Incident|Problem|ServiceRequest {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    SET s.resolve_met       = $met,
        s.breached          = CASE WHEN $met THEN coalesce(s.breached, false) ELSE true END,
        s.resolved_at       = $resolvedAt,
        s.resolve_deadline  = $effectiveDeadline,
        s.paused_total_ms   = coalesce(s.paused_total_ms, 0) + $pauseShiftMs,
        s.paused_at         = null,
        s.paused_type       = null
    RETURN ${SLA_STATUS_PROJECTION}
  `
  const session = writeSession()
  try {
    const row = await runQueryOne<Record<string, unknown>>(session, cypher, {
      tenantId, entityId, met, resolvedAt: resolvedAt.toISOString(),
      effectiveDeadline: new Date(effectiveDeadlineMs).toISOString(), pauseShiftMs,
    })
    if (!row) throw new Error(`[sla:status] markResolveMet(${entityId}): SLAStatus vanished during update`)
    return mapToSLAStatus(row)
  } finally {
    await session.close()
  }
}

/**
 * Stops the SLA clock for the given target(s). Sets `paused_at`/`paused_type`,
 * unless the SLA is already paused or already resolved (nothing to pause).
 * `slaType` picks which clock stops: 'resolve' (warning+breach timers),
 * 'response' (response timer), or 'both'. Returns the updated status (carrying
 * `paused_type`), or null if there was nothing to pause. The caller cancels the
 * corresponding jobs — a paused clock must not fire timers.
 */
export async function pauseSLA(
  tenantId: string,
  entityId: string,
  slaType: SLAPauseType = 'both',
  /** L'istante dell'evento che mette in pausa (SL-8): non quello in cui il consumatore lo elabora. */
  pausedAt: Date = new Date(),
): Promise<SLAStatus | null> {
  const current = await getSLAStatus(tenantId, entityId)
  if (!current || current.paused_at || current.resolve_met || current.resolved_at) return null

  const now = pausedAt.toISOString()
  const cypher = `
    MATCH (e:Incident|Problem|ServiceRequest {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    SET s.paused_at = $now, s.paused_type = $slaType
  `
  const session = writeSession()
  try {
    await runQuery(session, cypher, { tenantId, entityId, now, slaType })
  } finally {
    await session.close()
  }
  return { ...current, paused_at: now, paused_type: slaType }
}

/**
 * Restarts the SLA clock. Extends the paused deadline(s) by the elapsed pause
 * duration so the remaining time is preserved, clears `paused_at`/`paused_type`,
 * and returns the updated status. Which deadline shifts depends on the
 * `paused_type` recorded at pause time. Returns null if the SLA was not paused.
 * The caller re-schedules the timers against the new deadlines.
 */
export async function resumeSLA(
  tenantId: string,
  entityId: string,
  /**
   * L'istante dell'evento che fa ripartire l'orologio — revisione del 14 set
   * 2026 · SL-8: la pausa si misurava con l'ora del consumatore, quindi una
   * coda in ritardo allungava la pausa (e la scadenza) di quanto era in ritardo.
   */
  resumedAt: Date = new Date(),
): Promise<SLAStatus | null> {
  const current = await getSLAStatus(tenantId, entityId)
  if (!current || !current.paused_at) return null

  const pausedType = (current.paused_type ?? 'both') as SLAPauseType
  const clock = await clockOf(current)
  // A corrupt/future paused_at counts nothing: no negative shift.
  const shiftMs = countedMs(parseInstant(current.paused_at, `paused_at of SLAStatus ${current.id}`), resumedAt, clock)
  const shiftResponse = pausedType === 'response' || pausedType === 'both'
  const shiftResolve  = pausedType === 'resolve'  || pausedType === 'both'
  const newResponse = shiftResponse
    ? extendDeadline(parseInstant(current.response_deadline, `response_deadline of SLAStatus ${current.id}`), shiftMs, clock).toISOString()
    : current.response_deadline
  const newResolve = shiftResolve
    ? extendDeadline(parseInstant(current.resolve_deadline, `resolve_deadline of SLAStatus ${current.id}`), shiftMs, clock).toISOString()
    : current.resolve_deadline

  const cypher = `
    MATCH (e:Incident|Problem|ServiceRequest {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    SET s.response_deadline = $newResponse,
        s.resolve_deadline  = $newResolve,
        s.paused_at         = null,
        s.paused_type       = null,
        // E-2: il totale delle pause, che il cambio di policy riporta.
        s.paused_total_ms   = coalesce(s.paused_total_ms, 0) + $shiftMs
  `
  const session = writeSession()
  try {
    await runQuery(session, cypher, { tenantId, entityId, newResponse, newResolve, shiftMs })
  } finally {
    await session.close()
  }
  return {
    ...current,
    response_deadline: newResponse,
    resolve_deadline:  newResolve,
    paused_at:         undefined,
    paused_type:       pausedType,   // report which clock resumed so the caller reschedules
  }
}

/**
 * Il ticket riaperto riapre il suo SLA — revisione del 14 set 2026 · SL-3.
 *
 * Alla risoluzione lo SLA si chiude (`resolved_at`, `resolve_met`) e i job si
 * annullano; prima una transizione da risolto a un passo aperto non lo
 * riapriva, e il ticket tornava in lavorazione senza scadenza. La regola:
 * il tempo passato da risolto non conta, come una pausa — la scadenza di
 * risoluzione si sposta in avanti di quanto il ticket è rimasto risolto.
 * `breached` resta com'era (una violazione non si cancella). `null` se non
 * c'è uno SLA chiuso da riaprire.
 */
export async function reopenSLA(tenantId: string, entityId: string, reopenedAt: Date): Promise<SLAStatus | null> {
  const current = await getSLAStatus(tenantId, entityId)
  if (!current || !current.resolved_at) return null
  const resolvedAt = parseInstant(current.resolved_at, `resolved_at of SLAStatus ${current.id}`)
  const clock = await clockOf(current)
  const shiftMs = countedMs(resolvedAt, reopenedAt, clock)
  const newResolve = extendDeadline(parseInstant(current.resolve_deadline, `resolve_deadline of SLAStatus ${current.id}`), shiftMs, clock).toISOString()
  // The time spent resolved is not counted, like a pause: it joins the pause
  // total, so a later change of policy carries it too.
  const cypher = `
    MATCH (e:Incident|Problem|ServiceRequest {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    SET s.resolve_deadline = $newResolve,
        s.paused_total_ms  = coalesce(s.paused_total_ms, 0) + $shiftMs,
        s.resolved_at      = null,
        s.resolve_met      = false,
        s.reopened_at      = $reopenedAt
    RETURN ${SLA_STATUS_PROJECTION}
  `
  const session = writeSession()
  try {
    const row = await runQueryOne<Record<string, unknown>>(session, cypher, { tenantId, entityId, newResolve, shiftMs, reopenedAt: reopenedAt.toISOString() })
    if (!row) throw new Error(`[sla:status] reopenSLA(${entityId}): SLAStatus vanished during update`)
    return mapToSLAStatus(row)
  } finally {
    await session.close()
  }
}

/**
 * Sostituisce la policy di uno SLA in corso — SL-10. Le scadenze si ricalcolano
 * da `started_at` con i minuti della policy nuova, e lo spostamento già
 * accumulato dalle pause resta (differenza fra la scadenza corrente e quella
 * che la policy vecchia avrebbe dato senza pause). `null` se lo SLA è chiuso,
 * fissato da una regola, o già di quella policy.
 */
export async function repolicySLA(tenantId: string, entityId: string, policy: SLAPolicy, severity: string): Promise<SLAStatus | null> {
  const current = await getSLAStatus(tenantId, entityId)
  // The same policy with another tier is a change too: the priority moved (24 Sep 2026).
  if (!current || current.resolved_at || !current.policy_id || (current.policy_id === policy.id && current.tier.severity === severity)) return null
  const tier = policy.tiers.find((t) => t.severity === severity)
  if (!tier) throw new Error(`[sla:status] repolicySLA(${entityId}): policy "${policy.name}" has no tier for severity "${severity}"`)
  const started = parseInstant(current.started_at, `started_at of SLAStatus ${current.id}`)
  /**
   * Lo spostamento già accumulato dalle pause è un DATO (`paused_total_ms`),
   * non una differenza da ricalcolare (revisione totale · E-2). Prima si
   * ricostruiva la scadenza «vecchia senza pause» con i minuti del tier
   * vecchio ma il fuso e il CALENDARIO della policy NUOVA: se il tier vecchio
   * era in orario di servizio e la policy nuova è 24×7 (nessun calendario),
   * `calculateDeadline` lanciava, l'evento `ticket.team_assigned` falliva
   * quattro volte e lo SLA restava sulla policy vecchia; con calendari
   * diversi lo spostamento era comunque sbagliato.
   *
   * Gli SLA aperti PRIMA di questo campo non l'hanno: per loro lo
   * spostamento è zero e le scadenze nuove partono pulite dalla policy nuova.
   * È una perdita dichiarata (il tempo di pausa già scontato), non un errore
   * silenzioso: ricostruirla richiederebbe il calendario della policy vecchia,
   * che lo stato non ha mai conservato.
   */
  const pausedShift = Math.max(0, current.paused_total_ms ?? 0)
  // The pause total is time the clock did not count: on a tier in service
  // hours it is added as service time, not as wall-clock time (review of
  // 23 Sep 2026). A total measured on a different clock (the old policy's)
  // is carried as it is — the same declared approximation as above.
  const clock: SLAClock = { businessHours: tier.business_hours, timezone: policy.timezone, calendar: policy.calendar }
  const newResponse = extendDeadline(calculateDeadline(started, tier.response_minutes, tier.business_hours, policy.timezone, policy.calendar), pausedShift, clock).toISOString()
  const newResolve  = extendDeadline(calculateDeadline(started, tier.resolve_minutes,  tier.business_hours, policy.timezone, policy.calendar), pausedShift, clock).toISOString()
  const cypher = `
    MATCH (e:Incident|Problem|ServiceRequest {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    SET s.response_deadline     = $newResponse,
        s.resolve_deadline      = $newResolve,
        s.tier_response_minutes = $response,
        s.tier_resolve_minutes  = $resolve,
        s.tier_business_hours   = $bh,
        s.tier_warning_minutes  = $warning,
        s.tier_severity         = $tierSeverity,
        s.policy_id             = $policyId,
        s.policy_name           = $policyName
    RETURN ${SLA_STATUS_PROJECTION}
  `
  const session = writeSession()
  try {
    const row = await runQueryOne<Record<string, unknown>>(session, cypher, {
      tenantId, entityId, newResponse, newResolve, response: tier.response_minutes, resolve: tier.resolve_minutes,
      bh: tier.business_hours, warning: tier.warning_minutes, tierSeverity: tier.severity, policyId: policy.id, policyName: policy.name,
    })
    if (!row) throw new Error(`[sla:status] repolicySLA(${entityId}): SLAStatus vanished during update`)
    return mapToSLAStatus(row)
  } finally {
    await session.close()
  }
}

/**
 * Marca la violazione e QUANDO è avvenuta (revisione totale · C-8): senza
 * `breached_at` il riquadro «SLA violati» del digest contava gli SLA
 * *iniziati* nelle ultime 24 ore che risultano violati — un numero sbagliato
 * in entrambe le direzioni (uno violato stanotte ma partito tre giorni fa non
 * c'era; uno partito ieri e che violerà fra una settimana veniva contato solo
 * se violava entro le 24 ore). L'istante non si sposta se la funzione viene
 * ripetuta: la violazione è avvenuta una volta sola.
 */
export async function markBreached(tenantId: string, entityId: string, at: string = new Date().toISOString()): Promise<void> {
  const cypher = `
    MATCH (e:Incident|Problem|ServiceRequest {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    SET s.breached = true, s.breached_at = coalesce(s.breached_at, $at)
  `
  const session = writeSession()
  try {
    await runQuery(session, cypher, { tenantId, entityId, at })
  } finally {
    await session.close()
  }
}
