/**
 * Event Management — l'ingest: dall'evento normalizzato al grafo e alla
 * pipeline. Orchestratore chiamato dal worker `events-ingest`
 * (jobs/eventIngestWorker.ts); importa pipeline.ts, mai il contrario.
 *
 * UN solo statement Neo4j per evento prima della pipeline (M11):
 * `ingestMergeCypher` scrive l'Event (MERGE per impronta con la transizione
 * di stato in Cypher e la guardia d'ordine `last_received_at`), lo collega
 * alla sorgente, riconosce il CI (alias external_id → alias → nome → nome
 * corto da policy; nome ambiguo = orfano con `match_reason`) e scrive
 * RAISED_ON. Il record appena scritto viene passato alla pipeline, che non lo
 * rilegge. La policy del tenant arriva dalla cache (policy.ts).
 */
import { v4 as uuidv4 } from 'uuid'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import type { MonitoringEventPayload } from '@opengraphity/types'
import { ValidationError } from '../../lib/errors.js'
import { publishEvent } from '../../lib/publishEvent.js'
import { logger } from '../../lib/logger.js'
import { MATCH_REASONS, type CIMatchReason } from '../../lib/eventVocabularies.js'
import { eventsAmbiguousTotal, eventsDeduplicatedTotal, eventsOrphanTotal, eventsOutOfOrderTotal, eventsReceivedTotal, eventsResolvedUnknownTotal } from '../../middleware/metrics.js'
import { fingerprintOf, quoteValue, type NormalizedEvent } from './normalize.js'
import { INGEST_WRITE_OUTCOMES, ciMatchCypher, ciMatchParams, ingestMergeCypher, type CIMatchCandidate, type CIMatchOptions, type IngestWriteOutcome } from './transitions.js'
import { SEVERITY_RANK, mapEventPayload, type Props } from './shared.js'
import { getEventPolicy } from './policy.js'
import { runEventPipeline } from './pipeline.js'

const log = logger.child({ module: 'event-service' })

// ── Riconoscimento del CI (fuori dall'ingest: diagnosi, test) ────────────────

/** Esito del riconoscimento del CI (vedi ciMatchCypher per la precedenza). */
export interface CIMatchResult {
  /** CI riconosciuto; null = orfano (`matchReason` dice perché: `ambiguous` o `none`). */
  ciId: string | null
  matchReason: CIMatchReason
  /** CI candidati quando `ambiguous` (al massimo MATCH_CANDIDATES_MAX), altrimenti vuota. */
  candidates: CIMatchCandidate[]
}

/**
 * CI riconosciuto per l'evento (vedi ciMatchCypher): una sola query.
 * L'ingest non la chiama: il riconoscimento gira dentro il MERGE.
 */
export async function matchCI(tenantId: string, ev: Pick<NormalizedEvent, 'resourceExternalId' | 'resource' | 'resourceKind'>, opts: CIMatchOptions): Promise<CIMatchResult> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ ciId: string | null; matchReason: unknown; candidates: CIMatchCandidate[] }>(session, `
      ${ciMatchCypher()}
      RETURN matched.id AS ciId, matchReason, candidates
    `, ciMatchParams(tenantId, ev, opts))
    if (!row) throw new Error(`CI match for ${quoteValue(ev.resource)} returned no row for tenant ${tenantId}`)
    return { ciId: row.ciId ?? null, matchReason: assertMatchReason(row.matchReason), candidates: row.candidates ?? [] }
  } finally {
    await session.close()
  }
}

/** `match_reason` fuori vocabolario dal grafo = frammento Cypher e lista TS non allineati: errore, mai un valore inventato. */
function assertMatchReason(value: unknown): CIMatchReason {
  if (typeof value !== 'string' || !(MATCH_REASONS as readonly string[]).includes(value)) {
    throw new Error(`CI match returned an unexpected match_reason ${JSON.stringify(value)} (expected one of: ${MATCH_REASONS.join(', ')})`)
  }
  return value as CIMatchReason
}

/** Payload di `event.orphan` (A2): il motivo e, se ambiguo, i CI candidati. */
export interface EventOrphanPayload extends MonitoringEventPayload {
  /** Null quando il riconoscimento non è girato per questo payload (retry `duplicate` di un evento già orfano, evento orfano scritto prima del campo). */
  match_reason: CIMatchReason | null
  candidates: CIMatchCandidate[]
}

// ── Ingest ───────────────────────────────────────────────────────────────────

export interface IngestInput {
  tenantId: string
  sourceId: string
  ev: NormalizedEvent
  /** ISO; default ora. Usato come last_seen_at (e first_seen_at se nuovo). */
  receivedAt?: string
  /** actor_id degli eventi di dominio; default 'monitoring'. */
  actorId?: string
  /** Id del job BullMQ: solo per i log (ritrova l'allarme in coda). */
  jobId?: string
}

/** Esiti della pipeline per cui l'ingest NON pubblica event.received/resolved/orphan (l'avviso lo ha già dato la pipeline). */
export const QUIET_OUTCOMES: ReadonlySet<string> = new Set(['suppressed', 'flapping', 'storm', 'storm_no_ci'])

export interface IngestResult {
  props: Props
  ciId: string | null
  /** Esito del riconoscimento eseguito da QUESTO ingest; null = non eseguito (CI già agganciato). */
  matchReason: CIMatchReason | null
  /** CI candidati di un riconoscimento `ambiguous` (al massimo MATCH_CANDIDATES_MAX). */
  candidates: CIMatchCandidate[]
  created: boolean
  /** Esito della scrittura (ingestMergeCypher). */
  outcome: IngestWriteOutcome
  /** true se la sorgente (InboundWebhook) porta un `last_error`: il worker lo azzera dopo un job riuscito. */
  sourceHasError: boolean
}

/**
 * Deduplica per impronta con UN solo MERGE (transizione di stato in Cypher,
 * guardia d'ordine su `last_received_at`, riconoscimento e aggancio del CI),
 * esegue la pipeline di correlazione (soppressione → salute del CI →
 * incident), pubblica gli eventi di dominio. Restituisce le proprietà
 * dell'Event (stato finale), il CI agganciato e l'esito della scrittura.
 *
 * - `out_of_order` (payload più vecchio dell'ultimo applicato ma con uno stato
 *   diverso): applicato come gli altri, con un warn e la metrica
 *   events_out_of_order_total{connector} (revisione 2 · B2-06); uno più vecchio
 *   con lo STESSO stato è innocuo e torna `duplicate`.
 * - `duplicate` (retry dello stesso job, stessa receivedAt): nessuna modifica
 *   al nodo (count non raddoppia), ma la pipeline VIENE rieseguita — il retry
 *   esiste proprio perché un passo successivo alla scrittura può essere
 *   fallito. Gli eventi di dominio possono quindi ripetersi (at-least-once).
 *
 * Dieta di rumore (3.3): `event.received` solo quando il payload apre un
 * ciclo — evento nuovo, o `resolved → firing` (`first_seen_at` = istante di
 * questo payload) — e `event.resolved` solo quando lo chiude (`resolved_at` =
 * istante di questo payload); le ripetizioni (Alertmanager `repeat_interval`,
 * Zabbix) non notificano nulla. La regola legge le proprietà post-scrittura
 * con l'istante del payload, quindi vale anche per il retry `duplicate`
 * (stessa receivedAt). `event.orphan` segue la stessa regola.
 *
 * `resolved` di un allarme mai visto (B5): tipico all'attivazione di una
 * sorgente (Alertmanager manda i resolved degli allarmi rientrati prima del
 * collegamento). L'Event nasce già risolto con `first_seen_at` = `startsAt`
 * della sorgente (se è un istante valido, altrimenti l'istante di ricezione),
 * senza `event.resolved` né `event.orphan` — non ha mai "fiammato" qui —
 * e conta in `events_resolved_unknown_total{connector}`.
 *
 * Riconoscimento del CI (A2): la policy del tenant (`match_short_hostname`,
 * letta dalla cache) entra nei parametri del MERGE; un nome che combacia con
 * più CI NON aggancia (`match_reason = ambiguous`, metrica
 * events_ambiguous_total, log warn con i candidati) e `event.orphan` porta
 * motivo e candidati, così l'amministratore sa quale CI collegare a mano.
 */
export async function ingestEvent(input: IngestInput): Promise<IngestResult> {
  const { tenantId, sourceId, ev, jobId } = input
  if (ev.status !== 'firing' && ev.status !== 'resolved') {
    throw new ValidationError(`Event status must be firing or resolved. Got: ${quoteValue(ev.status)}`)
  }
  // `now` è l'istante di ricezione del payload (last_seen_at, first_seen_at se
  // nuovo, e la guardia d'ordine last_received_at): stesso valore per tutti i
  // job della stessa richiesta, quindi confrontabile fra retry.
  const now = input.receivedAt ?? new Date().toISOString()
  const actorId = input.actorId ?? 'monitoring'
  const fingerprint = fingerprintOf(sourceId, ev)
  const labels = JSON.stringify(ev.labels)
  const firstSeenAt = ev.status === 'resolved' ? firstSeenOfResolvedUnknown(ev.startsAt, now) : now
  // Policy dalla cache (una lettura per tenant ogni 30 s, M11): tenant senza policy → errore, il job ritenta (mai un default silenzioso).
  const policy = await getEventPolicy(tenantId)

  const session = getSession(undefined, 'WRITE')
  let row: { props: Props; outcome: IngestWriteOutcome; ciId: string | null; ciStatus: string | null; matchReason: unknown; candidates: CIMatchCandidate[] | null; connectorKind: string | null; sourceHasError: boolean | null } | null
  try {
    row = await runQueryOne(session, ingestMergeCypher(), {
      ...ciMatchParams(tenantId, ev, { matchShortHostname: policy.match_short_hostname }),
      id: uuidv4(), fingerprint, externalId: ev.externalId ?? null,
      status: ev.status, severity: ev.severity, severityRank: SEVERITY_RANK,
      title: ev.title, description: ev.description ?? null,
      resource: ev.resource, resourceKind: ev.resourceKind, labels,
      startsAt: ev.startsAt ?? null, endsAt: ev.endsAt ?? null, sourceId, now, receivedAt: now, firstSeenAt,
      // Cronologia (history.ts): l'id della voce che il MERGE scrive nello stesso statement quando il payload apre/chiude un ciclo o cambia severità.
      historyId: uuidv4(),
    })
  } finally {
    await session.close()
  }
  if (!row) throw new Error(`Event ${fingerprint} not written for tenant ${tenantId}`)
  if (!INGEST_WRITE_OUTCOMES.includes(row.outcome)) throw new Error(`Event ${fingerprint}: unexpected ingest outcome ${JSON.stringify(row.outcome)}`)
  const { props, outcome } = row
  const created = outcome === 'created'
  const ciId = row.ciId
  // null = riconoscimento non eseguito (CI già agganciato); altrimenti deve stare nel vocabolario.
  const matchReason = row.matchReason == null ? null : assertMatchReason(row.matchReason)
  const candidates = row.candidates ?? []
  const sourceHasError = row.sourceHasError === true
  // connector_kind della sorgente (etichetta della metrica events_received_total;
  // assente = webhook precedente all'Event Management → generic, come sourceConfigOf).
  const connectorKind = row.connectorKind ?? 'generic'
  const logCtx = { tenantId, sourceId, eventId: props['id'], fingerprint, jobId }

  if (outcome === 'out_of_order') {
    // B2-06: applicato, non scartato — ma è un'anomalia da vedere (orologi
    // delle repliche API divergenti, salto NTP, riordino della coda).
    eventsOutOfOrderTotal.inc({ connector: connectorKind })
    log.warn({ ...logCtx, receivedAt: now, lastReceivedAt: props['last_received_at'], payloadStatus: ev.status, status: props['status'] },
      'Out-of-order event payload applied (older than the last applied one but with a different status)')
  }
  if (outcome === 'duplicate') {
    log.info({ ...logCtx, receivedAt: now }, 'Event payload already applied (job retry, or older payload with the same status): state untouched, pipeline re-run')
  } else {
    eventsReceivedTotal.inc({ connector: connectorKind })
    if (!created) eventsDeduplicatedTotal.inc({})
  }
  if (!ciId) eventsOrphanTotal.inc({})
  // A2: più CI con lo stesso nome → nessun aggancio. Contato e loggato a ogni
  // payload (non solo al primo): l'ambiguità persiste finché qualcuno non
  // collega l'evento a mano o non rinomina/aliasa i CI.
  if (matchReason === 'ambiguous') {
    eventsAmbiguousTotal.inc({})
    log.warn({ ...logCtx, resource: ev.resource, resourceKind: ev.resourceKind, candidates }, 'Event left orphan: more than one CI matches the resource name (link it manually or add an alias)')
  }
  // B5: allarme mai visto che arriva già rientrato. Creato (con first_seen_at
  // dalla sorgente) ma mai annunciato: nessun ciclo si è aperto qui.
  const resolvedUnknown = created && ev.status === 'resolved'
  if (resolvedUnknown) {
    eventsResolvedUnknownTotal.inc({ connector: connectorKind })
    log.info({ ...logCtx, startsAt: ev.startsAt ?? null, firstSeenAt }, 'Resolved payload for an alert never seen before: Event created already resolved, no notification')
  }

  // «Apre un ciclo»: evento nuovo, oppure allarme rientrato che torna acceso
  // (`resolved → firing`: il MERGE ha riscritto `first_seen_at` con l'istante
  // di questo payload). Una ripetizione dello stesso allarme ancora acceso no.
  const opensCycle = created || props['first_seen_at'] === now
  // Pipeline (services/events/pipeline.ts): soppressione in finestra di change
  // → salute del CI → correlazione in incident / chiusura automatica. La
  // soppressione blocca anche la salute, per questo il ricalcolo vive lì.
  // `opensCycle` alimenta il contatore di tempesta della sorgente (revisione 2
  // · B2-03: contare i soli Event creati rendeva impossibile la tempesta al
  // secondo guasto identico); il retry `duplicate` ripete un payload già
  // applicato — `first_seen_at` è quello del ciclo aperto allora — e non deve
  // contare due volte. Il record appena scritto viaggia con la chiamata: la
  // pipeline non lo rilegge.
  const pipeline = await runEventPipeline({
    tenantId, eventId: String(props['id']), actorId, now, mode: 'ingest',
    opensCycle: opensCycle && outcome !== 'duplicate', record: { props, ciId, ciStatus: row.ciStatus ?? null }, jobId,
  })
  props['status'] = pipeline.status

  // Nessun avviso "ricevuto"/"rientrato" quando l'avviso lo dà già la pipeline:
  // silenziato (event.suppressed), sfarfallio (event.flapping, una volta per
  // episodio) o tempesta (event.storm_started: un solo avviso per sorgente,
  // non uno per ciascuno delle centinaia di allarmi al minuto). E nessun
  // avviso per una ripetizione: solo il payload che apre o chiude il ciclo.
  const resolved = props['status'] === 'resolved'
  const closesCycle = props['resolved_at'] === now && !resolvedUnknown
  const notify = resolved ? closesCycle : opensCycle
  if (!QUIET_OUTCOMES.has(pipeline.outcome) && notify) {
    const payload = mapEventPayload(props, ciId)
    await publishEvent(resolved ? 'event.resolved' : 'event.received', tenantId, actorId, payload, now)
    if (!ciId) {
      const orphan: EventOrphanPayload = { ...payload, match_reason: matchReason, candidates }
      await publishEvent('event.orphan', tenantId, actorId, orphan, now)
    }
  }

  log.info({ ...logCtx, outcome, created, ciId, matchReason, status: props['status'], count: props['count'], correlation: pipeline.outcome, notified: notify }, 'Event ingested')
  return { props, ciId, matchReason, candidates, created, outcome, sourceHasError }
}

/**
 * `first_seen_at` di un Event creato da un payload `resolved` (B5): l'istante
 * di inizio dichiarato dalla sorgente se è una data valida (riportato in ISO),
 * altrimenti l'istante di ricezione — documentato, non un istante inventato
 * (una stringa non parsabile non può ordinare la console né nutrire gli SLA).
 * Per un allarme già noto il MERGE non legge questo valore (solo ON CREATE).
 */
export function firstSeenOfResolvedUnknown(startsAt: string | undefined, receivedAt: string): string {
  if (!startsAt) return receivedAt
  const ms = Date.parse(startsAt)
  return Number.isNaN(ms) ? receivedAt : new Date(ms).toISOString()
}
