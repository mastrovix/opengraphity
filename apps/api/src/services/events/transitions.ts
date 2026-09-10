/**
 * Event Management — stato dell'evento e scrittura dell'ingest.
 *
 * La tabella EVENT_TRANSITIONS è la sorgente unica di `nextEventState`
 * (funzione pura, documenta e testa la semantica) e del CASE Cypher di
 * `ingestMergeCypher` (lo applica atomicamente in UN solo MERGE). Ondata 4:
 * ogni passaggio firing↔resolved viene registrato in `Event.transitions`
 * (ultimi MAX_TRANSITIONS istanti ISO) insieme a `last_payload_status`.
 *
 * Revisione (M11): il MERGE riconosce e aggancia anche il CI (alias
 * external_id → alias per kind → nome, `ciMatchCypher`) quando l'evento non ne
 * ha già uno: scrittura, riconoscimento e RAISED_ON in un solo statement.
 */
import type { EventInputStatus, EventSeverity } from '../../lib/eventVocabularies.js'
import type { NormalizedEvent } from './normalize.js'
import type { Props } from './shared.js'
import { SEVERITY_RANK } from './shared.js'
import { ciNameKey } from '../../lib/ciNameKey.js'

// ── Stato dell'evento (puro) ─────────────────────────────────────────────────

/** Quanti istanti di passaggio firing↔resolved si conservano su `Event.transitions`. */
export const MAX_TRANSITIONS = 50

/**
 * Stato dell'ULTIMO payload ricevuto (firing|resolved): `last_payload_status`
 * se presente; per gli eventi scritti prima dell'ondata 4 si deduce dallo
 * status (resolved → resolved; firing/suppressed/flapping → firing).
 */
export function payloadStatusOf(existing: Props): EventInputStatus {
  const lp = existing['last_payload_status']
  if (lp === 'firing' || lp === 'resolved') return lp
  return existing['status'] === 'resolved' ? 'resolved' : 'firing'
}

/** `Event.transitions` come lista di stringhe ISO (assente → vuota: la migrazione 1040 la scrive, ma un evento appena creato la ha già). */
export function transitionsOf(existing: Props): string[] {
  const t = existing['transitions']
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : []
}

/** Passaggi registrati a partire da `sinceMs` (incluso). */
export function countTransitionsSince(transitions: readonly string[], sinceMs: number): number {
  let n = 0
  for (const t of transitions) if (Date.parse(t) >= sinceMs) n++
  return n
}

export interface EventPatch {
  status: 'firing' | 'resolved' | string
  severity: EventSeverity
  count: number
  first_seen_at: string
  last_seen_at: string
  resolved_at: string | null
  /** Istanti ISO dei passaggi firing↔resolved (gli ultimi MAX_TRANSITIONS), aggiornati con questo payload. */
  transitions: string[]
  last_payload_status: EventInputStatus
  /** Residui da azzerare: `resolved` → suppressed_by_change_id, flapping_since, correlation_due_at; `new_cycle` → flapping_since (e resolved_at, già null). */
  clear: ResidueClear
}

// ── Tabella di transizione (sorgente unica di nextEventState e del CASE Cypher) ──

/**
 * Classe dello stato corrente dell'Event: `resolved`, `flapping`, oppure
 * `open` (firing, suppressed e qualunque altro stato "vivo").
 */
export type PrevClass = 'resolved' | 'open' | 'flapping'
export type ResidueClear = 'none' | 'resolved' | 'new_cycle'

export interface TransitionRule {
  prev:       PrevClass
  payload:    EventInputStatus
  /** `keep` = lo stato non cambia (suppressed resta tale: è la pipeline a toglierlo; flapping lo stabilizza il job periodico). */
  status:     'firing' | 'resolved' | 'keep'
  count:      'reset' | 'increment' | 'keep'
  /** `max` = la più alta fra corrente e payload (mai in discesa finché l'allarme non rientra); `payload` = riparte da quella del payload. */
  severity:   'payload' | 'max' | 'keep'
  firstSeen:  'now' | 'keep'
  resolvedAt: 'now' | 'null' | 'keep'
  clear:      ResidueClear
}

/**
 * Tabella di transizione (stato corrente × stato del payload). L'evento nuovo
 * (ON CREATE) non è qui: count 1, severità e status del payload, first_seen =
 * ora, resolved_at = ora se il payload è resolved.
 *
 * | corrente  | payload  | status   | count | severità | first_seen | resolved_at | azzera                 |
 * |-----------|----------|----------|-------|----------|------------|-------------|------------------------|
 * | resolved  | firing   | firing   | 1     | payload  | ora        | null        | flapping_since (nuovo ciclo) |
 * | resolved  | resolved | invariato| inv.  | inv.     | inv.       | inv.        | —                      |
 * | open      | firing   | invariato| +1    | max      | inv.       | inv.        | —                      |
 * | open      | resolved | resolved | inv.  | inv.     | inv.       | ora         | suppressed_by_change_id, flapping_since, correlation_due_at |
 * | flapping  | firing   | invariato| +1    | max      | inv.       | null        | —                      |
 * | flapping  | resolved | invariato| inv.  | inv.     | inv.       | ora         | —                      |
 *
 * In ogni riga: last_seen_at = ora, last_payload_status = payload, e un
 * passaggio (payload diverso dall'ultimo ricevuto) viene appeso a
 * `transitions` (ultimi MAX_TRANSITIONS).
 */
export const EVENT_TRANSITIONS: readonly TransitionRule[] = [
  { prev: 'resolved', payload: 'firing',   status: 'firing',   count: 'reset',     severity: 'payload', firstSeen: 'now',  resolvedAt: 'null', clear: 'new_cycle' },
  { prev: 'resolved', payload: 'resolved', status: 'keep',     count: 'keep',      severity: 'keep',    firstSeen: 'keep', resolvedAt: 'keep', clear: 'none' },
  { prev: 'open',     payload: 'firing',   status: 'keep',     count: 'increment', severity: 'max',     firstSeen: 'keep', resolvedAt: 'keep', clear: 'none' },
  { prev: 'open',     payload: 'resolved', status: 'resolved', count: 'keep',      severity: 'keep',    firstSeen: 'keep', resolvedAt: 'now',  clear: 'resolved' },
  { prev: 'flapping', payload: 'firing',   status: 'keep',     count: 'increment', severity: 'max',     firstSeen: 'keep', resolvedAt: 'null', clear: 'none' },
  { prev: 'flapping', payload: 'resolved', status: 'keep',     count: 'keep',      severity: 'keep',    firstSeen: 'keep', resolvedAt: 'now',  clear: 'none' },
]

export function prevClassOf(status: unknown): PrevClass {
  if (status === 'resolved') return 'resolved'
  if (status === 'flapping') return 'flapping'
  return 'open'
}

export function transitionRuleFor(prev: PrevClass, payload: EventInputStatus): TransitionRule {
  const rule = EVENT_TRANSITIONS.find((r) => r.prev === prev && r.payload === payload)
  if (!rule) throw new Error(`No event transition rule for ${prev} × ${payload}`)
  return rule
}

/**
 * Stato successivo di un Event esistente all'arrivo di un nuovo payload:
 * applicazione in memoria della tabella EVENT_TRANSITIONS. La scrittura reale
 * la fa il CASE Cypher generato dalla stessa tabella (`ingestMergeCypher`);
 * questa funzione documenta e testa la semantica.
 */
export function nextEventState(existing: Props, ev: NormalizedEvent, now: string): EventPatch {
  const rule = transitionRuleFor(prevClassOf(existing['status']), ev.status)
  const prevStatus   = String(existing['status'])
  const prevSeverity = String(existing['severity']) as EventSeverity
  const prevCount    = Number(existing['count'] ?? 0)
  const previous     = transitionsOf(existing)
  const transitions  = ev.status !== payloadStatusOf(existing) ? [...previous, now].slice(-MAX_TRANSITIONS) : previous
  const higher = (SEVERITY_RANK[ev.severity] ?? -1) > (SEVERITY_RANK[prevSeverity] ?? -1) ? ev.severity : prevSeverity

  return {
    status:        rule.status === 'keep' ? prevStatus : rule.status,
    count:         rule.count === 'reset' ? 1 : rule.count === 'increment' ? prevCount + 1 : prevCount,
    severity:      rule.severity === 'payload' ? ev.severity : rule.severity === 'max' ? higher : prevSeverity,
    first_seen_at: rule.firstSeen === 'now' ? now : String(existing['first_seen_at'] ?? now),
    resolved_at:   rule.resolvedAt === 'now' ? now : rule.resolvedAt === 'null' ? null : ((existing['resolved_at'] as string | null) ?? null),
    last_seen_at:  now,
    transitions,
    last_payload_status: ev.status,
    clear: rule.clear,
  }
}

/** Condizione Cypher sulla classe dello stato corrente (`e` è l'Event prima della scrittura). */
export const PREV_CLASS_CYPHER: Record<PrevClass, string> = {
  resolved: "e.status = 'resolved'",
  flapping: "e.status = 'flapping'",
  open:     "NOT e.status IN ['resolved', 'flapping']",
}

/** Espressione Cypher della severità più alta fra corrente e payload (`$severityRank` = SEVERITY_RANK). */
export const SEVERITY_MAX_CYPHER = 'CASE WHEN coalesce($severityRank[$severity], -1) > coalesce($severityRank[e.severity], -1) THEN $severity ELSE e.severity END'

/** Espressioni Cypher per ogni azione della tabella (tutte leggono SOLO i valori pre-scrittura di `e` e i parametri). */
export const TRANSITION_ACTION_CYPHER = {
  status:     { firing: "'firing'", resolved: "'resolved'", keep: 'e.status' },
  count:      { reset: '1', increment: 'coalesce(e.count, 0) + 1', keep: 'e.count' },
  severity:   { payload: '$severity', max: SEVERITY_MAX_CYPHER, keep: 'e.severity' },
  firstSeen:  { now: '$now', keep: 'coalesce(e.first_seen_at, $now)' },
  resolvedAt: { now: '$now', null: 'null', keep: 'e.resolved_at' },
} as const

/**
 * CASE Cypher esaustivo (3 classi × 2 stati del payload) che sceglie il valore
 * di un campo dalla tabella; nessun ELSE: `$status` è validato (firing|resolved)
 * prima della scrittura, un valore fuori vocabolario non deve produrre null.
 */
export function transitionCaseCypher(valueOf: (rule: TransitionRule) => string): string {
  const whens = EVENT_TRANSITIONS.map((r) => `WHEN ${PREV_CLASS_CYPHER[r.prev]} AND $status = '${r.payload}' THEN ${valueOf(r)}`)
  return `CASE ${whens.join(' ')} END`
}

/** CASE che azzera (null) un residuo nelle righe della tabella con `clear` fra quelli dati, altrimenti lo conserva. */
export function residueClearCypher(field: string, when: readonly ResidueClear[]): string {
  return transitionCaseCypher((r) => (when.includes(r.clear) ? 'null' : `e.${field}`))
}

/**
 * Assegnazioni `ON MATCH` (dentro il FOREACH condizionale di ingestMergeCypher).
 * Ordine deliberato: ogni espressione legge `e.status`, `e.count`,
 * `e.last_payload_status`… PRIMA della scrittura, quindi `status` e
 * `last_payload_status` sono gli ultimi ad essere assegnati — il risultato è
 * lo stesso sia che Cypher valuti tutte le espressioni prima di scrivere sia
 * che le applichi in sequenza.
 */
export function transitionSetCypher(): string {
  const a = TRANSITION_ACTION_CYPHER
  return [
    `e.count = ${transitionCaseCypher((r) => a.count[r.count])}`,
    `e.severity = ${transitionCaseCypher((r) => a.severity[r.severity])}`,
    `e.first_seen_at = ${transitionCaseCypher((r) => a.firstSeen[r.firstSeen])}`,
    `e.resolved_at = ${transitionCaseCypher((r) => a.resolvedAt[r.resolvedAt])}`,
    `e.suppressed_by_change_id = ${residueClearCypher('suppressed_by_change_id', ['resolved'])}`,
    `e.correlation_due_at = ${residueClearCypher('correlation_due_at', ['resolved'])}`,
    `e.flapping_since = ${residueClearCypher('flapping_since', ['resolved', 'new_cycle'])}`,
    `e.transitions = CASE WHEN $status <> coalesce(e.last_payload_status, CASE WHEN e.status = 'resolved' THEN 'resolved' ELSE 'firing' END) THEN (coalesce(e.transitions, []) + $now)[-${MAX_TRANSITIONS}..] ELSE coalesce(e.transitions, []) END`,
    `e.last_payload_status = $status`,
    `e.status = ${transitionCaseCypher((r) => a.status[r.status])}`,
    'e.last_seen_at = $now',
    'e.last_received_at = $receivedAt',
    'e.title = $title',
    'e.description = $description',
    'e.labels = $labels',
    'e.starts_at = coalesce($startsAt, e.starts_at)',
    'e.ends_at = $endsAt',
    'e.updated_at = $now',
  ].join(',\n        ')
}

/** Esito della scrittura dell'evento (vedi ingestMergeCypher). */
export type IngestWriteOutcome = 'created' | 'applied' | 'duplicate' | 'stale'
export const INGEST_WRITE_OUTCOMES: readonly IngestWriteOutcome[] = ['created', 'applied', 'duplicate', 'stale']

/**
 * Riconoscimento del CI, nell'ordine: alias (external_id) → alias (kind =
 * resourceKind, valore minuscolo) → CI con lo stesso nome
 * (`ConfigurationItem.name_key` = nome minuscolo, indicizzato: lib/ciNameKey.ts).
 * Tre OPTIONAL MATCH ordinati per priorità: `coalesce(byExt, byKind, byName)`
 * sceglie il primo; a parità di nome vince il CI più vecchio (chi usa il
 * frammento aggiunge `ORDER BY byName.created_at LIMIT 1`). Un alias
 * external_id si cerca solo se l'evento ha un externalId; l'alias per kind
 * solo se resourceKind non è `name` (i parametri a null non combaciano con
 * nulla). `guard` (opzionale) è una condizione che spegne la ricerca (es.
 * "il CI è già agganciato"). Parametri: $tenantId, $externalId, $kind,
 * $kindValue, $nameKey (vedi ciMatchParams).
 */
export function ciMatchCypher(guard?: string): string {
  const where = guard ? ` WHERE ${guard}` : ''
  return [
    `OPTIONAL MATCH (:CIAlias {tenant_id: $tenantId, kind: 'external_id', value: $externalId})-[:ALIAS_OF]->(byExt:ConfigurationItem {tenant_id: $tenantId})${where}`,
    `OPTIONAL MATCH (:CIAlias {tenant_id: $tenantId, kind: $kind, value: $kindValue})-[:ALIAS_OF]->(byKind:ConfigurationItem {tenant_id: $tenantId})${where}`,
    `OPTIONAL MATCH (byName:ConfigurationItem {tenant_id: $tenantId, name_key: $nameKey})${where}`,
  ].join('\n      ')
}

export function ciMatchParams(tenantId: string, ev: Pick<NormalizedEvent, 'externalId' | 'resource' | 'resourceKind'>): Record<string, unknown> {
  return {
    tenantId,
    externalId: ev.externalId ?? null,
    kind:       ev.resourceKind === 'name' ? null : ev.resourceKind,
    kindValue:  ev.resourceKind === 'name' ? null : ev.resourceKind === 'external_id' ? ev.resource : ev.resource.toLowerCase(),
    nameKey:    ciNameKey(ev.resource),
  }
}

/**
 * UN solo statement per la scrittura dell'evento (C1/M1 della revisione):
 * MERGE per (tenant_id, fingerprint) — il vincolo unico rende impossibile il
 * doppione — con la transizione di stato calcolata in Cypher dalla tabella
 * EVENT_TRANSITIONS. Niente "leggi poi scrivi": due job della stessa impronta
 * non possono perdersi un incremento.
 *
 * Guardia d'ordine (`last_received_at`, istante di ricezione del payload):
 * - `created`   → nodo nuovo;
 * - `applied`   → payload più recente dell'ultimo applicato (o evento senza
 *                 last_received_at, scritto prima di questa ondata): transizione applicata;
 * - `duplicate` → stesso istante dell'ultimo applicato: è il retry dello
 *                 stesso job (jobId = tenant+impronta+receivedAt), già scritto → nessuna modifica;
 * - `stale`     → payload più vecchio dell'ultimo applicato (retry tardivo di
 *                 un firing dopo il resolved): NON si tocca nulla.
 *
 * CI (M11): quello già agganciato (anche a mano) vince (`linked`); altrimenti
 * il riconoscimento (`ciMatchCypher`) gira nello stesso statement e, se trova
 * un CI e il payload non è `stale`, scrive RAISED_ON. `ciId` è il CI
 * agganciato alla fine (null = orfano).
 * L'esito torna in `outcome`; il chiamante decide se proseguire con la pipeline.
 */
export function ingestMergeCypher(): string {
  return `
      MERGE (e:Event {tenant_id: $tenantId, fingerprint: $fingerprint})
      ON CREATE SET
        e.id = $id, e.external_id = $externalId,
        e.status = $status, e.severity = $severity, e.title = $title, e.description = $description,
        e.resource = $resource, e.resource_kind = $resourceKind, e.labels = $labels,
        e.count = 1, e.first_seen_at = $now, e.last_seen_at = $now, e.last_received_at = $receivedAt,
        e.resolved_at = CASE WHEN $status = 'resolved' THEN $now ELSE null END,
        e.starts_at = $startsAt, e.ends_at = $endsAt,
        e.correlation = 'none', e.correlation_at = null, e.correlation_due_at = null, e.suppressed_by_change_id = null,
        e.transitions = [], e.last_payload_status = $status, e.flapping_since = null,
        e.source_id = $sourceId, e.created_at = $now, e.updated_at = $now
      WITH e, CASE
        WHEN e.id = $id THEN 'created'
        WHEN e.last_received_at IS NULL OR datetime(e.last_received_at) < datetime($receivedAt) THEN 'applied'
        WHEN e.last_received_at = $receivedAt THEN 'duplicate'
        ELSE 'stale' END AS outcome
      FOREACH (_ IN CASE WHEN outcome = 'applied' THEN [1] ELSE [] END |
        SET ${transitionSetCypher()}
      )
      WITH e, outcome
      OPTIONAL MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN outcome = 'created' AND w IS NOT NULL THEN [1] ELSE [] END | MERGE (e)-[:FROM_SOURCE]->(w))
      WITH e, outcome, w
      OPTIONAL MATCH (e)-[:RAISED_ON]->(linked:ConfigurationItem {tenant_id: $tenantId})
      WITH e, outcome, w, linked
      ${ciMatchCypher("linked IS NULL AND outcome <> 'stale'")}
      WITH e, outcome, w, linked, byExt, byKind, byName ORDER BY byName.created_at LIMIT 1
      WITH e, outcome, w, linked, coalesce(linked, byExt, byKind, byName) AS ci
      FOREACH (_ IN CASE WHEN linked IS NULL AND ci IS NOT NULL THEN [1] ELSE [] END | MERGE (e)-[:RAISED_ON]->(ci))
      RETURN properties(e) AS props, outcome, ci.id AS ciId, w.connector_kind AS connectorKind, w.last_error IS NOT NULL AS sourceHasError
    `
}
