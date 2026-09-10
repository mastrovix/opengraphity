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
 * external_id → alias per kind → nome → nome corto da policy, `ciMatchCypher`)
 * quando l'evento non ne ha già uno: scrittura, riconoscimento e RAISED_ON in
 * un solo statement. Revisione (A2/M2): l'alias external_id si confronta con
 * l'id della RISORSA, un nome ambiguo non aggancia (`match_reason`).
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
  /** Severità CORRENTE = quella dell'ultimo payload (M9): la salute del CI e la priorità seguono la sorgente. */
  severity: EventSeverity
  /** Severità più alta vista nel ciclo corrente (storia/reporting, M9): riparte con il ciclo. */
  max_severity: EventSeverity
  count: number
  first_seen_at: string
  last_seen_at: string
  resolved_at: string | null
  /** Istanti ISO dei passaggi firing↔resolved (gli ultimi MAX_TRANSITIONS), aggiornati con questo payload. */
  transitions: string[]
  last_payload_status: EventInputStatus
  /** Esito di correlazione dopo il payload: `none` all'apertura di un nuovo ciclo (M10), altrimenti invariato (lo scrive la pipeline). */
  correlation: string
  /** Residui da azzerare: `resolved` → suppressed_by_change_id, flapping_since, correlation_due_at; `new_cycle` → flapping_since, correlation (→ none), correlation_at, correlation_due_at (e resolved_at, già null). */
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
  /** `payload` = la severità dell'ultimo payload (M9: la sorgente può abbassarla: Zabbix, Datadog Warn dopo Triggered); `max` = la più alta fra corrente e payload; `keep` = invariata. */
  severity:   'payload' | 'max' | 'keep'
  /** `max_severity` (storia del ciclo): `payload` = riparte, `max` = la più alta fra memorizzata e payload, `keep` = invariata. */
  maxSeverity: 'payload' | 'max' | 'keep'
  firstSeen:  'now' | 'keep'
  resolvedAt: 'now' | 'null' | 'keep'
  clear:      ResidueClear
}

/**
 * Tabella di transizione (stato corrente × stato del payload). L'evento nuovo
 * (ON CREATE) non è qui: count 1, severità e status del payload, first_seen =
 * ora, resolved_at = ora se il payload è resolved.
 *
 * | corrente  | payload  | status   | count | severità | max_severity | first_seen | resolved_at | azzera                 |
 * |-----------|----------|----------|-------|----------|--------------|------------|-------------|------------------------|
 * | resolved  | firing   | firing   | 1     | payload  | payload      | ora        | null        | flapping_since, correlation → none, correlation_at, correlation_due_at (nuovo ciclo) |
 * | resolved  | resolved | invariato| inv.  | inv.     | inv.         | inv.       | inv.        | —                      |
 * | open      | firing   | invariato| +1    | payload  | max          | inv.       | inv.        | —                      |
 * | open      | resolved | resolved | inv.  | inv.     | inv.         | inv.       | ora         | suppressed_by_change_id, flapping_since, correlation_due_at |
 * | flapping  | firing   | invariato| +1    | payload  | max          | inv.       | null        | —                      |
 * | flapping  | resolved | invariato| inv.  | inv.     | inv.         | inv.       | ora         | —                      |
 *
 * In ogni riga: last_seen_at = ora, last_payload_status = payload, e un
 * passaggio (payload diverso dall'ultimo ricevuto) viene appeso a
 * `transitions` (ultimi MAX_TRANSITIONS). M9: `severity` è quella dell'ultimo
 * payload (la sorgente che passa da critical a warning abbassa la salute del
 * CI); la storia del ciclo resta in `max_severity`.
 */
export const EVENT_TRANSITIONS: readonly TransitionRule[] = [
  { prev: 'resolved', payload: 'firing',   status: 'firing',   count: 'reset',     severity: 'payload', maxSeverity: 'payload', firstSeen: 'now',  resolvedAt: 'null', clear: 'new_cycle' },
  { prev: 'resolved', payload: 'resolved', status: 'keep',     count: 'keep',      severity: 'keep',    maxSeverity: 'keep',    firstSeen: 'keep', resolvedAt: 'keep', clear: 'none' },
  { prev: 'open',     payload: 'firing',   status: 'keep',     count: 'increment', severity: 'payload', maxSeverity: 'max',     firstSeen: 'keep', resolvedAt: 'keep', clear: 'none' },
  { prev: 'open',     payload: 'resolved', status: 'resolved', count: 'keep',      severity: 'keep',    maxSeverity: 'keep',    firstSeen: 'keep', resolvedAt: 'now',  clear: 'resolved' },
  { prev: 'flapping', payload: 'firing',   status: 'keep',     count: 'increment', severity: 'payload', maxSeverity: 'max',     firstSeen: 'keep', resolvedAt: 'null', clear: 'none' },
  { prev: 'flapping', payload: 'resolved', status: 'keep',     count: 'keep',      severity: 'keep',    maxSeverity: 'keep',    firstSeen: 'keep', resolvedAt: 'now',  clear: 'none' },
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
  // Eventi scritti prima di max_severity: la storia nota coincide con la corrente.
  const prevMax      = String(existing['max_severity'] ?? prevSeverity) as EventSeverity
  const prevCount    = Number(existing['count'] ?? 0)
  const previous     = transitionsOf(existing)
  const transitions  = ev.status !== payloadStatusOf(existing) ? [...previous, now].slice(-MAX_TRANSITIONS) : previous
  const higher = (a: EventSeverity, b: EventSeverity): EventSeverity => ((SEVERITY_RANK[a] ?? -1) > (SEVERITY_RANK[b] ?? -1) ? a : b)

  return {
    status:        rule.status === 'keep' ? prevStatus : rule.status,
    count:         rule.count === 'reset' ? 1 : rule.count === 'increment' ? prevCount + 1 : prevCount,
    severity:      rule.severity === 'payload' ? ev.severity : rule.severity === 'max' ? higher(ev.severity, prevSeverity) : prevSeverity,
    max_severity:  rule.maxSeverity === 'payload' ? ev.severity : rule.maxSeverity === 'max' ? higher(ev.severity, prevMax) : prevMax,
    first_seen_at: rule.firstSeen === 'now' ? now : String(existing['first_seen_at'] ?? now),
    resolved_at:   rule.resolvedAt === 'now' ? now : rule.resolvedAt === 'null' ? null : ((existing['resolved_at'] as string | null) ?? null),
    last_seen_at:  now,
    transitions,
    last_payload_status: ev.status,
    correlation:   rule.clear === 'new_cycle' ? 'none' : String(existing['correlation'] ?? 'none'),
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
/** Come SEVERITY_MAX_CYPHER ma su `max_severity` (assente sugli eventi scritti prima di M9: vale la corrente). */
export const MAX_SEVERITY_MAX_CYPHER = 'CASE WHEN coalesce($severityRank[$severity], -1) > coalesce($severityRank[coalesce(e.max_severity, e.severity)], -1) THEN $severity ELSE coalesce(e.max_severity, e.severity) END'

/** Espressioni Cypher per ogni azione della tabella (tutte leggono SOLO i valori pre-scrittura di `e` e i parametri). */
export const TRANSITION_ACTION_CYPHER = {
  status:      { firing: "'firing'", resolved: "'resolved'", keep: 'e.status' },
  count:       { reset: '1', increment: 'coalesce(e.count, 0) + 1', keep: 'e.count' },
  severity:    { payload: '$severity', max: SEVERITY_MAX_CYPHER, keep: 'e.severity' },
  maxSeverity: { payload: '$severity', max: MAX_SEVERITY_MAX_CYPHER, keep: 'coalesce(e.max_severity, e.severity)' },
  firstSeen:   { now: '$now', keep: 'coalesce(e.first_seen_at, $now)' },
  resolvedAt:  { now: '$now', null: 'null', keep: 'e.resolved_at' },
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
    // max_severity PRIMA di severity: legge e.severity pre-scrittura (eventi senza max_severity, scritti prima di M9).
    `e.max_severity = ${transitionCaseCypher((r) => a.maxSeverity[r.maxSeverity])}`,
    `e.severity = ${transitionCaseCypher((r) => a.severity[r.severity])}`,
    `e.first_seen_at = ${transitionCaseCypher((r) => a.firstSeen[r.firstSeen])}`,
    `e.resolved_at = ${transitionCaseCypher((r) => a.resolvedAt[r.resolvedAt])}`,
    `e.suppressed_by_change_id = ${residueClearCypher('suppressed_by_change_id', ['resolved'])}`,
    `e.correlation_due_at = ${residueClearCypher('correlation_due_at', ['resolved', 'new_cycle'])}`,
    `e.flapping_since = ${residueClearCypher('flapping_since', ['resolved', 'new_cycle'])}`,
    // M10: un nuovo ciclo riparte senza esito di correlazione (la pipeline lo
    // riscrive subito dopo); l'esito del ciclo precedente non deve restare
    // visibile né far tacere l'avviso di correlazione del nuovo ciclo.
    `e.correlation = ${transitionCaseCypher((r) => (r.clear === 'new_cycle' ? "'none'" : 'e.correlation'))}`,
    `e.correlation_at = ${residueClearCypher('correlation_at', ['new_cycle'])}`,
    `e.transitions = CASE WHEN $status <> coalesce(e.last_payload_status, CASE WHEN e.status = 'resolved' THEN 'resolved' ELSE 'firing' END) THEN (coalesce(e.transitions, []) + $now)[-${MAX_TRANSITIONS}..] ELSE coalesce(e.transitions, []) END`,
    `e.last_payload_status = $status`,
    `e.status = ${transitionCaseCypher((r) => a.status[r.status])}`,
    'e.last_seen_at = $now',
    'e.last_received_at = $receivedAt',
    'e.title = $title',
    'e.description = $description',
    'e.labels = $labels',
    // M2: l'id della risorsa presso la sorgente può comparire dopo (es. Zabbix con host_id aggiunto ai parametri): mai azzerato da un payload che non lo porta.
    'e.resource_external_id = coalesce($resourceExternalId, e.resource_external_id)',
    'e.starts_at = coalesce($startsAt, e.starts_at)',
    'e.ends_at = $endsAt',
    'e.updated_at = $now',
  ].join(',\n        ')
}

/** Esito della scrittura dell'evento (vedi ingestMergeCypher). */
export type IngestWriteOutcome = 'created' | 'applied' | 'duplicate' | 'stale'
export const INGEST_WRITE_OUTCOMES: readonly IngestWriteOutcome[] = ['created', 'applied', 'duplicate', 'stale']

// ── Riconoscimento del CI ────────────────────────────────────────────────────

/** Quanti candidati di un riconoscimento ambiguo tornano al chiamante (payload di event.orphan, log). */
export const MATCH_CANDIDATES_MAX = 5

/** Un CI candidato di un riconoscimento ambiguo. */
export interface CIMatchCandidate { id: string; name: string }

/** Opzioni del riconoscimento che vengono dalla policy del tenant (lib/eventPolicy.ts). */
export interface CIMatchOptions {
  /** `match_short_hostname`: confronta anche nome corto ↔ FQDN (vedi shortHostnameKeys). */
  matchShortHostname: boolean
}

/**
 * Ordine di precedenza del riconoscimento (A2/M2 della revisione), in UN solo
 * frammento Cypher (`ciMatchCypher`), tutto indicizzato:
 *
 *   1. `alias_external_id` — alias `external_id` del CI = id della RISORSA
 *      presso la sorgente (`$resourceExternalId`: entity Dynatrace, host_id
 *      Zabbix, field resourceExternalId del generic). MAI l'id dell'allarme
 *      (`externalId`, che è il fingerprint/event_id: M2).
 *   2. `alias` — alias del tipo della risorsa (`$kind` = resourceKind
 *      hostname|ip|fqdn|external_id, valore minuscolo salvo external_id).
 *      Un alias è univoco per costruzione (vincolo CIAlias tenant+kind+value).
 *   3. `name` — `ConfigurationItem.name_key` = risorsa minuscola (indice
 *      ci_tenant_name_key). Più CI con lo stesso nome → `ambiguous`: nessun
 *      aggancio, i candidati tornano al chiamante (prima il `LIMIT 1` sceglieva
 *      in silenzio il più vecchio).
 *   4. `name_short` — solo con la policy `match_short_hostname` e solo se il
 *      nome esatto non ha trovato nulla: risorsa con un punto → name_key =
 *      prima etichetta (`db-01.example.local` → `db-01`); risorsa senza punto
 *      → name_key che inizia con `risorsa + '.'` (STARTS WITH sull'indice).
 *      Anche qui >1 candidato → `ambiguous`.
 *   5. `none` — orfano.
 *
 * `guard` spegne tutta la ricerca (es. "il CI è già agganciato, il payload è
 * stale"); `carry` sono le variabili del chiamante da portare attraverso le
 * aggregazioni (collect). Il frammento espone `matched` (il CI, o null),
 * `matchReason` (MATCH_REASONS) e `candidates` (lista di {id, name}, al
 * massimo MATCH_CANDIDATES_MAX, non vuota solo se `ambiguous`). Parametri:
 * $tenantId, $resourceExternalId, $kind, $kindValue, $nameKey,
 * $matchShortHostname, $shortNameKey, $fqdnPrefix (vedi ciMatchParams).
 */
export function ciMatchCypher(opts: { guard?: string; carry?: readonly string[] } = {}): string {
  const where = opts.guard ? ` WHERE ${opts.guard}` : ''
  const guardAnd = opts.guard ? `${opts.guard} AND ` : ''
  const carry = (opts.carry ?? []).map((v) => `${v}, `).join('')
  const byShortWhere = `${guardAnd}$matchShortHostname AND size(byNames) = 0`
  return [
    `OPTIONAL MATCH (:CIAlias {tenant_id: $tenantId, kind: 'external_id', value: $resourceExternalId})-[:ALIAS_OF]->(byExt:ConfigurationItem {tenant_id: $tenantId})${where}`,
    `OPTIONAL MATCH (:CIAlias {tenant_id: $tenantId, kind: $kind, value: $kindValue})-[:ALIAS_OF]->(byKind:ConfigurationItem {tenant_id: $tenantId})${where}`,
    `OPTIONAL MATCH (byName:ConfigurationItem {tenant_id: $tenantId, name_key: $nameKey})${where}`,
    // candidati in ordine di creazione (stabile per i log e per il payload)
    `WITH ${carry}byExt, byKind, byName ORDER BY byName.created_at`,
    `WITH ${carry}byExt, byKind, collect(byName) AS byNames`,
    // nome corto ↔ FQDN (policy): solo se il nome esatto non ha trovato nulla; $shortNameKey e $fqdnPrefix sono mutuamente esclusivi (uno dei due è null)
    `OPTIONAL MATCH (byShort:ConfigurationItem {tenant_id: $tenantId, name_key: $shortNameKey}) WHERE ${byShortWhere}`,
    `OPTIONAL MATCH (byPrefix:ConfigurationItem {tenant_id: $tenantId}) WHERE ${byShortWhere} AND byPrefix.name_key STARTS WITH $fqdnPrefix`,
    `WITH ${carry}byExt, byKind, byNames, coalesce(byShort, byPrefix) AS byShortOrPrefix ORDER BY byShortOrPrefix.created_at`,
    `WITH ${carry}byExt, byKind, byNames, collect(byShortOrPrefix) AS byShorts`,
    `WITH ${carry}byExt, byKind, byNames, byShorts, CASE`,
    `  WHEN byExt IS NOT NULL THEN 'alias_external_id'`,
    `  WHEN byKind IS NOT NULL THEN 'alias'`,
    `  WHEN size(byNames) = 1 THEN 'name'`,
    `  WHEN size(byNames) > 1 THEN 'ambiguous'`,
    `  WHEN size(byShorts) = 1 THEN 'name_short'`,
    `  WHEN size(byShorts) > 1 THEN 'ambiguous'`,
    `  ELSE 'none' END AS matchReason`,
    `WITH ${carry}matchReason,`,
    `  CASE matchReason WHEN 'alias_external_id' THEN byExt WHEN 'alias' THEN byKind WHEN 'name' THEN byNames[0] WHEN 'name_short' THEN byShorts[0] ELSE null END AS matched,`,
    `  CASE WHEN matchReason = 'ambiguous' THEN [c IN (CASE WHEN size(byNames) > 1 THEN byNames ELSE byShorts END)[..${MATCH_CANDIDATES_MAX}] | {id: c.id, name: c.name}] ELSE [] END AS candidates`,
  ].join('\n      ')
}

/** Tipi di risorsa a cui ha senso applicare la regola nome corto ↔ FQDN (un ip o un id esterno non hanno etichette DNS). */
const SHORT_HOSTNAME_KINDS: ReadonlySet<string> = new Set(['hostname', 'fqdn', 'name'])

/**
 * Chiavi della regola nome corto ↔ FQDN a partire dalla `name_key` della
 * risorsa: con un punto → `shortNameKey` = prima etichetta (e nessun prefisso);
 * senza → `fqdnPrefix` = `nameKey + '.'` (e nessun nome corto). Entrambe null
 * per ip/external_id, per un indirizzo IPv4/IPv6 (la "prima etichetta" di
 * `10.0.0.7` sarebbe `10`) e per una prima etichetta vuota (`.example`).
 */
export function shortHostnameKeys(nameKey: string | null, resourceKind: string): { shortNameKey: string | null; fqdnPrefix: string | null } {
  const none = { shortNameKey: null, fqdnPrefix: null }
  if (!nameKey || !SHORT_HOSTNAME_KINDS.has(resourceKind)) return none
  if (nameKey.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(nameKey)) return none
  const dot = nameKey.indexOf('.')
  if (dot < 0) return { shortNameKey: null, fqdnPrefix: `${nameKey}.` }
  const first = nameKey.slice(0, dot)
  return first ? { shortNameKey: first, fqdnPrefix: null } : none
}

export function ciMatchParams(tenantId: string, ev: Pick<NormalizedEvent, 'resourceExternalId' | 'resource' | 'resourceKind'>, opts: CIMatchOptions): Record<string, unknown> {
  const nameKey = ciNameKey(ev.resource)
  // Con la policy spenta le chiavi restano null: nessun seek in più, comportamento identico a prima.
  const short = opts.matchShortHostname ? shortHostnameKeys(nameKey, ev.resourceKind) : { shortNameKey: null, fqdnPrefix: null }
  return {
    tenantId,
    resourceExternalId: ev.resourceExternalId ?? null,
    kind:       ev.resourceKind === 'name' ? null : ev.resourceKind,
    kindValue:  ev.resourceKind === 'name' ? null : ev.resourceKind === 'external_id' ? ev.resource : ev.resource.toLowerCase(),
    nameKey,
    matchShortHostname: opts.matchShortHostname,
    shortNameKey: short.shortNameKey,
    fqdnPrefix:   short.fqdnPrefix,
  }
}

/** Quando il riconoscimento gira dentro l'ingest: evento senza CI agganciato e payload non stantio. */
export const CI_MATCH_GUARD = "linked IS NULL AND outcome <> 'stale'"

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
 * il riconoscimento (`ciMatchCypher`, precedenza alias external_id → alias →
 * nome → nome corto) gira nello stesso statement e, se trova UN solo CI e il
 * payload non è `stale`, scrive RAISED_ON. `ciId` è il CI agganciato alla fine
 * (null = orfano). Ogni volta che il riconoscimento gira scrive
 * `e.match_reason` (A2: `ambiguous` = più CI con lo stesso nome, nessun
 * aggancio); `matchReason`/`candidates` tornano al chiamante solo in quel caso
 * (null/[] = riconoscimento non eseguito: CI già agganciato o payload stale).
 * L'esito torna in `outcome`; il chiamante decide se proseguire con la pipeline.
 *
 * `$firstSeenAt` (B5): di norma `$now`; per un `resolved` di un allarme mai
 * visto è `starts_at` della sorgente (l'allarme era acceso prima che la
 * sorgente fosse collegata), calcolato da ingest.ts. `$resourceExternalId`
 * (M2) è l'id della risorsa presso la sorgente; `max_severity` (M9) parte
 * dalla severità del payload.
 */
export function ingestMergeCypher(): string {
  return `
      MERGE (e:Event {tenant_id: $tenantId, fingerprint: $fingerprint})
      ON CREATE SET
        e.id = $id, e.external_id = $externalId, e.resource_external_id = $resourceExternalId,
        e.status = $status, e.severity = $severity, e.max_severity = $severity, e.title = $title, e.description = $description,
        e.resource = $resource, e.resource_kind = $resourceKind, e.labels = $labels,
        e.count = 1, e.first_seen_at = $firstSeenAt, e.last_seen_at = $now, e.last_received_at = $receivedAt,
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
      ${ciMatchCypher({ guard: CI_MATCH_GUARD, carry: ['e', 'outcome', 'w', 'linked'] })}
      WITH e, outcome, w, linked, matched, matchReason, candidates, coalesce(linked, matched) AS ci
      FOREACH (_ IN CASE WHEN ${CI_MATCH_GUARD} THEN [1] ELSE [] END | SET e.match_reason = matchReason)
      FOREACH (_ IN CASE WHEN linked IS NULL AND matched IS NOT NULL THEN [1] ELSE [] END | MERGE (e)-[:RAISED_ON]->(matched))
      RETURN properties(e) AS props, outcome, ci.id AS ciId,
             CASE WHEN ${CI_MATCH_GUARD} THEN matchReason ELSE null END AS matchReason,
             CASE WHEN ${CI_MATCH_GUARD} THEN candidates ELSE [] END AS candidates,
             w.connector_kind AS connectorKind, w.last_error IS NOT NULL AS sourceHasError
    `
}
