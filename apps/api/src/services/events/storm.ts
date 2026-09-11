/**
 * Event Management — ondata 4: tempeste di allarmi per sorgente.
 *
 * Contatore al minuto per (tenant, sorgente) su Redis (`getSharedRedis`,
 * chiave `og:events:storm:<tenant>:<sorgente>:<minuto>`, INCR + TTL 120 s):
 * conta gli allarmi che APRONO UN CICLO — nuovi o rientrati e tornati accesi —
 * non le ripetizioni (revisione 2 · B2-03). Quando in un minuto il
 * contatore raggiunge `storm_threshold_per_minute` la sorgente entra in
 * tempesta: `InboundWebhook.storm_since`, `storm_incident_id`,
 * `storm_last_over_at` (ultimo minuto oltre soglia), `event.storm_started`
 * (una volta). Durante la tempesta la pipeline (grouping.ts) NON apre
 * né aggancia incident per CI: ogni evento si aggancia all'UNICO incident di
 * tempesta della sorgente (`correlation = 'storm'`), aperto con il CI del
 * primo evento che ne ha uno (`storm_no_ci` finché nessuno ne ha).
 *
 * La tempesta finisce quando per `storm_cooldown_minutes` consecutivi nessun
 * minuto ha raggiunto la soglia, cioè quando `storm_last_over_at` è più
 * vecchio del raffreddamento: verificato a ogni ingest (`trackSourceStorm`) e
 * dal job periodico (`endCooledStorms`, per le sorgenti che tacciono del
 * tutto). Alla fine: `storm_since = null`, commento sull'incident di tempesta,
 * `event.storm_ended`; gli eventi restano agganciati all'incident di tempesta.
 *
 * Atomicità (il worker `events-ingest` ha concurrency 4 e più job della stessa
 * sorgente superano la soglia nello stesso istante): avvio della tempesta e
 * apertura dell'incident passano da UNA sezione critica per (tenant, sorgente)
 * con doppia barriera — lock Redis `og:events:storm-open:<tenant>:<sorgente>`
 * (lib/redisLock.ts: SET NX EX 30, rilascio guardato dal token del tentativo)
 * attorno a "rileggi la sorgente → avvia se non attiva → apri l'incident se
 * manca → scrivi `storm_incident_id`", e scritture CONDIZIONALI sul grafo
 * (`WHERE w.storm_since IS NULL`, `WHERE w.storm_incident_id IS NULL`,
 * `WHERE w.storm_since = $since` alla fine) come rete di sicurezza. Chi trova
 * il lock occupato attende (fino a STORM_LOCK_WAIT_MS, polling ogni
 * STORM_LOCK_POLL_MS) che l'incident compaia sulla sorgente (e vi si aggancia)
 * o che il lock si liberi; oltre l'attesa → errore, il job ritenta con backoff
 * e al retry l'incident esiste. Mai incident duplicati.
 *
 * La sorgente si legge dalla cache in memoria (sourceCache.ts, TTL 10 s) fuori
 * dal lock; sotto lock e nella rete di sicurezza SEMPRE dal grafo (`fresh`).
 *
 * L'incident di tempesta porta il marcatore `Incident.storm_source_id` (la
 * sorgente): il raggruppamento per CI/impronta (grouping.ts) lo ignora, così
 * finita la tempesta un nuovo allarme su un CI coinvolto apre il SUO incident
 * invece di riagganciarsi a quello di tempesta. Se l'operatore chiude
 * l'incident di tempesta mentre la sorgente è ancora in tempesta, gli allarmi
 * NON si agganciano a un ticket chiuso: `replaceClosedStormIncident` (sotto
 * lo stesso lock) azzera `storm_incident_id` e ne apre uno nuovo.
 *
 * Niente fallback silenziosi: Redis o il grafo irraggiungibili fanno fallire
 * l'ingest (il job ritenta); una sorgente cancellata non è una tempesta.
 */
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { withRedisLock } from '../../lib/redisLock.js'
import { runPagedPass, type PagedPassResult } from '../../lib/pagedPass.js'
import { getSharedRedis } from '../../lib/bullmq.js'
import { publishEvent } from '../../lib/publishEvent.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import type { EventPolicy } from '../../lib/eventPolicy.js'
import { eventStormsActive, incidentsAutoOpenedTotal } from '../../middleware/metrics.js'
import { incidents } from './deps.js'
import { getEventPolicy } from './policy.js'
import { MONITORING_ACTOR, monitoringContext, toNumber, toStr, type Props } from './shared.js'
import { invalidateSourceCache, loadSource } from './sourceCache.js'

const log = logger.child({ module: 'event-storm' })

export const STORM_COUNTER_TTL_SECONDS = 120
/** Quanti CI vengono elencati nella descrizione dell'incident di tempesta. */
export const STORM_DESCRIPTION_MAX_CIS = 10
/** Lock Redis della sezione critica per (tenant, sorgente): scade da solo se il processo muore a metà. */
export const STORM_LOCK_TTL_SECONDS = 30
/** Attesa massima di chi trova il lock occupato prima di arrendersi (il job ritenta). */
export const STORM_LOCK_WAIT_MS = 3_000
/** Intervallo di polling di chi attende il lock. */
export const STORM_LOCK_POLL_MS = 100

export interface StormState {
  active:     boolean
  since:      string | null
  incidentId: string | null
  sourceName: string
}

export const NO_STORM = (sourceName: string): StormState => ({ active: false, since: null, incidentId: null, sourceName })

/** Payload di `event.storm_started` / `event.storm_ended`. `id`/`entity_*` puntano all'incident di tempesta se esiste, altrimenti alla sorgente. */
export interface EventStormPayload {
  id:              string
  source_id:       string
  source_name:     string
  rate_per_minute: number
  incident_id:     string | null
  since:           string
  /** Solo in storm_ended: eventi nuovi ricevuti dalla sorgente durante la tempesta e durata in minuti. */
  events?:         number
  duration_minutes?: number
  entity_type:     'incident' | 'inbound_webhook'
  entity_id:       string
}

// ── Helper puri ──────────────────────────────────────────────────────────────

export function stormCounterKey(tenantId: string, sourceId: string, atMs: number): string {
  if (!Number.isFinite(atMs)) throw new Error(`stormCounterKey: "${atMs}" is not a timestamp`)
  return `og:events:storm:${tenantId}:${sourceId}:${Math.floor(atMs / 60_000)}`
}

export function stormLockKey(tenantId: string, sourceId: string): string {
  return `og:events:storm-open:${tenantId}:${sourceId}`
}

/** Inizio (ISO) del minuto che contiene `now`: il marcatore `storm_last_over_at` si scrive una volta per minuto. */
export function minuteStartOf(now: string): string {
  const ms = Date.parse(now)
  if (Number.isNaN(ms)) throw new Error(`minuteStartOf: "${now}" is not an ISO date`)
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString()
}

/** True se dall'ultimo minuto oltre soglia sono passati PIÙ di `cooldownMinutes` minuti. */
export function stormCooledDown(lastOverAt: string, now: string, cooldownMinutes: number): boolean {
  const last = Date.parse(lastOverAt)
  const nowMs = Date.parse(now)
  if (Number.isNaN(last)) throw new Error(`stormCooledDown: storm_last_over_at "${lastOverAt}" is not an ISO date`)
  if (Number.isNaN(nowMs)) throw new Error(`stormCooledDown: now "${now}" is not an ISO date`)
  return nowMs - last > cooldownMinutes * 60_000
}

export function stormStateOf(source: Props): StormState {
  const since = source['storm_since']
  const name = toStr(source['name']) || toStr(source['id'])
  if (typeof since !== 'string' || !since) return NO_STORM(name)
  const incidentId = source['storm_incident_id']
  return { active: true, since, incidentId: typeof incidentId === 'string' && incidentId ? incidentId : null, sourceName: name }
}

// ── Contatore Redis ──────────────────────────────────────────────────────────

/** Conta un evento NUOVO nel minuto di `now`; restituisce il totale del minuto. */
export async function countNewEvent(tenantId: string, sourceId: string, now: string): Promise<number> {
  const redis = getSharedRedis()
  const key = stormCounterKey(tenantId, sourceId, Date.parse(now))
  const n = await redis.incr(key)
  if (n === 1) await redis.expire(key, STORM_COUNTER_TTL_SECONDS)
  return n
}

/** Tasso corrente della sorgente: massimo fra il minuto corrente e il precedente (0 senza contatori). */
export async function currentRate(tenantId: string, sourceId: string, nowMs: number = Date.now()): Promise<number> {
  const redis = getSharedRedis()
  const values = await redis.mget(stormCounterKey(tenantId, sourceId, nowMs), stormCounterKey(tenantId, sourceId, nowMs - 60_000))
  return Math.max(0, ...values.map((v) => (v == null ? 0 : Number(v))))
}

// ── Sorgente ─────────────────────────────────────────────────────────────────

/** Stato di tempesta della sorgente, in sola lettura (rivalutazioni, job ritardati; dalla cache). Sorgente assente → nessuna tempesta. */
export async function getStormState(tenantId: string, sourceId: string): Promise<StormState> {
  const source = await loadSource(tenantId, sourceId)
  return source ? stormStateOf(source) : NO_STORM(sourceId)
}

async function refreshStormGauge(): Promise<void> {
  const session = getSession()
  try {
    // tenant-ok: metrica di processo su tutte le sorgenti in tempesta
    const row = await runQueryOne<{ n: unknown }>(session, `
      MATCH (w:InboundWebhook)
      WHERE w.storm_since IS NOT NULL
      RETURN count(w) AS n
    `, {})
    eventStormsActive.set({}, toNumber(row?.n))
  } finally { await session.close() }
}

// ── Lock per (tenant, sorgente) ──────────────────────────────────────────────

/**
 * Sezione critica per (tenant, sorgente) su lib/redisLock.ts. `run` riceve la
 * sorgente RILETTA dal grafo sotto lock (null se cancellata). Chi trova il
 * lock occupato a ogni giro rilegge la sorgente (dal grafo) e, se `shortcut`
 * sa già rispondere (l'incident di tempesta è comparso), esce senza lock;
 * oltre STORM_LOCK_WAIT_MS → errore ritentabile.
 */
async function withStormLock<T>(tenantId: string, sourceId: string, shortcut: (source: Props) => T | null, run: (source: Props | null) => Promise<T>): Promise<T> {
  return withRedisLock(
    stormLockKey(tenantId, sourceId),
    { ttlSeconds: STORM_LOCK_TTL_SECONDS, waitMs: STORM_LOCK_WAIT_MS, pollMs: STORM_LOCK_POLL_MS },
    async () => run(await loadSource(tenantId, sourceId, { fresh: true })),
    async () => { const source = await loadSource(tenantId, sourceId, { fresh: true }); return source ? shortcut(source) : null },
    `no storm incident appeared on source ${sourceId} (tenant ${tenantId})`,
  )
}

// ── Incident di tempesta ─────────────────────────────────────────────────────

/**
 * Apre l'incident di tempesta con il CI dato come impattato (createIncident ne
 * richiede almeno uno) e lo scrive sulla sorgente con una SET CONDIZIONALE
 * (`storm_incident_id IS NULL`). Da chiamare SOLO sotto withStormLock dopo
 * aver riletto che l'incident manca. Se la SET non tocca nulla — non dovrebbe
 * mai succedere con il lock — l'incident appena creato è un duplicato: si
 * aggancia comunque il vincitore e lo si dice forte (log.error, audit
 * `event_storm.duplicate_incident`, commento sul duplicato). La descrizione
 * elenca i primi CI coinvolti dagli eventi della sorgente dall'inizio della
 * tempesta.
 */
async function openStormIncident(tenantId: string, sourceId: string, sourceName: string, ciId: string, rate: number, since: string, now: string): Promise<string> {
  const session = getSession(undefined, 'WRITE')
  let ciNames: string[]
  try {
    const rows = await runQuery<{ name: string }>(session, `
      MATCH (e:Event {tenant_id: $tenantId, source_id: $sourceId})-[:RAISED_ON]->(ci:ConfigurationItem {tenant_id: $tenantId})
      WHERE e.first_seen_at >= $since
      RETURN DISTINCT ci.name AS name ORDER BY name LIMIT ${STORM_DESCRIPTION_MAX_CIS}
    `, { tenantId, sourceId, since })
    ciNames = rows.map((r) => r.name).filter(Boolean)
  } finally { await session.close() }

  const description = [
    `Tempesta di allarmi dalla sorgente "${sourceName}": ${rate} allarmi nuovi al minuto (soglia della policy raggiunta alle ${since}).`,
    'Gli allarmi ricevuti durante la tempesta vengono agganciati a questo incident invece di aprire un incident per ogni CI.',
    ciNames.length ? `Primi CI coinvolti: ${ciNames.join(', ')}` : 'Nessun CI riconosciuto finora tra gli allarmi della tempesta.',
  ].join('\n')

  const incidentService = await incidents()
  const incident = await incidentService.createIncident({
    title:         `Tempesta di allarmi da ${sourceName}: ${rate} allarmi al minuto`,
    description,
    severity:      'critical',
    affectedCIIds: [ciId],
  }, { tenantId, userId: MONITORING_ACTOR })

  const s = getSession(undefined, 'WRITE')
  let claimed: { id: string } | null
  try {
    // Marcatore (non stato del workflow): l'incident di tempesta è escluso dal
    // raggruppamento per CI/impronta. Vale anche per un eventuale duplicato.
    const marked = await runQueryOne<{ id: string }>(s, `
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
      SET i.storm_source_id = $sourceId
      RETURN i.id AS id
    `, { incidentId: incident.id, tenantId, sourceId })
    if (!marked) throw new Error(`Storm incident ${incident.id} vanished right after creation (tenant ${tenantId})`)
    claimed = await runQueryOne<{ id: string }>(s, `
      MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})
      WHERE w.storm_incident_id IS NULL
      SET w.storm_incident_id = $incidentId, w.updated_at = $now
      RETURN w.id AS id
    `, { sourceId, tenantId, incidentId: incident.id, now })
  } finally { await s.close() }
  invalidateSourceCache(tenantId, sourceId)

  if (!claimed) {
    // Rete di sicurezza: qualcun altro ha scritto l'incident nel frattempo (o la sorgente è sparita).
    const fresh = await loadSource(tenantId, sourceId, { fresh: true })
    const winnerId = fresh ? stormStateOf(fresh).incidentId : null
    if (!winnerId) throw new Error(`Storm incident ${incident.id} created but InboundWebhook ${sourceId} has no storm_incident_id to attach to (tenant ${tenantId})`)
    log.error({ tenantId, sourceId, duplicateIncidentId: incident.id, incidentId: winnerId }, 'Duplicate storm incident: a concurrent job won the source; attaching to the winner')
    void audit(monitoringContext(tenantId), 'event_storm.duplicate_incident', 'InboundWebhook', sourceId, { duplicateIncidentId: incident.id, incidentId: winnerId, sourceName })
    await incidentService.addIncidentComment(incident.id, { tenantId, userId: MONITORING_ACTOR }, `Incident duplicato: la tempesta della sorgente "${sourceName}" è già tracciata dall'incident ${winnerId}; gli allarmi vengono agganciati a quello`)
    return winnerId
  }
  incidentsAutoOpenedTotal.inc({})
  log.info({ tenantId, sourceId, incidentId: incident.id, rate, ciId }, 'Storm incident opened')
  return incident.id
}

// ── Inizio / fine ────────────────────────────────────────────────────────────

/** Se la sorgente ha già l'incident di tempesta chi attende il lock si aggancia a quello senza entrare. */
const stormWithIncident = (source: Props): StormState | null => {
  const state = stormStateOf(source)
  return state.active && state.incidentId ? state : null
}

/**
 * Sotto lock: avvia la tempesta se la sorgente non è già in tempesta (solo con
 * `mayStart`; SET condizionale su `storm_since IS NULL`: chi l'ha avviata
 * pubblica `event.storm_started` una volta sola) e apre l'incident di tempesta
 * se manca e l'evento ha un CI. Restituisce lo stato dopo la sezione critica.
 */
async function ensureStorm(tenantId: string, sourceId: string, rate: number, ciId: string | null, actorId: string, now: string, mayStart: boolean): Promise<StormState> {
  return withStormLock(tenantId, sourceId, stormWithIncident, async (source) => {
    if (!source) throw new Error(`InboundWebhook ${sourceId} vanished while entering a storm (tenant ${tenantId})`)
    let state = stormStateOf(source)
    let started = false
    if (!state.active) {
      // Chiamata solo per aprire l'incident e la tempesta è finita nel frattempo: niente da fare.
      if (!mayStart) return state
      const session = getSession(undefined, 'WRITE')
      try {
        const row = await runQueryOne<{ id: string }>(session, `
          MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})
          WHERE w.storm_since IS NULL
          SET w.storm_since = $now, w.storm_last_over_at = $now, w.storm_incident_id = null,
              w.storm_started_rate = toInteger($rate), w.storm_count = coalesce(w.storm_count, 0) + 1, w.updated_at = $now
          RETURN w.id AS id
        `, { sourceId, tenantId, now, rate })
        if (!row) throw new Error(`InboundWebhook ${sourceId} changed under the storm lock while starting a storm (tenant ${tenantId})`)
      } finally { await session.close(); invalidateSourceCache(tenantId, sourceId) }
      state = { active: true, since: now, incidentId: null, sourceName: state.sourceName }
      started = true
    }
    if (!state.incidentId && ciId) {
      state = { ...state, incidentId: await openStormIncident(tenantId, sourceId, state.sourceName, ciId, rate, state.since ?? now, now) }
    }
    if (started) {
      const { incidentId, sourceName } = state
      const payload: EventStormPayload = {
        id: incidentId ?? sourceId, source_id: sourceId, source_name: sourceName, rate_per_minute: rate, incident_id: incidentId, since: now,
        entity_type: incidentId ? 'incident' : 'inbound_webhook', entity_id: incidentId ?? sourceId,
      }
      await publishEvent('event.storm_started', tenantId, actorId, payload, now)
      void audit(monitoringContext(tenantId), 'event.storm_started', 'InboundWebhook', sourceId, { rate, incidentId, sourceName })
      await refreshStormGauge()
      log.warn({ tenantId, sourceId, sourceName, rate, incidentId }, 'Alert storm started')
    }
    return state
  })
}

/**
 * L'incident di tempesta `closedIncidentId` è in un passo terminale (chiuso a
 * mano o dal timer) mentre la sorgente è ancora in tempesta: sotto lock,
 * se la sorgente punta ancora a quell'incident, si azzera `storm_incident_id`
 * (SET condizionale) e — se l'evento ha un CI — si apre un nuovo incident di
 * tempesta con `ensureStorm` (mayStart = false: la tempesta esiste già). Un
 * commento sull'incident chiuso rimanda al nuovo. Chi arriva dopo trova già
 * il nuovo `storm_incident_id` (shortcut del lock) e vi si aggancia.
 * Tempesta finita nel frattempo → stato "nessuna tempesta".
 */
export async function replaceClosedStormIncident(tenantId: string, sourceId: string, closedIncidentId: string, ciId: string | null, actorId: string, now: string): Promise<StormState> {
  const replaced = (source: Props): StormState | null => {
    const state = stormStateOf(source)
    if (!state.active) return state
    return state.incidentId && state.incidentId !== closedIncidentId ? state : null
  }
  return withStormLock(tenantId, sourceId, replaced, async (source) => {
    if (!source) throw new Error(`InboundWebhook ${sourceId} vanished while replacing its closed storm incident (tenant ${tenantId})`)
    const state = stormStateOf(source)
    const already = replaced(source)
    if (already) return already
    const session = getSession(undefined, 'WRITE')
    try {
      await runQuery(session, `
        MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})
        WHERE w.storm_incident_id = $closedIncidentId
        SET w.storm_incident_id = null, w.updated_at = $now
      `, { sourceId, tenantId, closedIncidentId, now })
    } finally { await session.close(); invalidateSourceCache(tenantId, sourceId) }
    log.warn({ tenantId, sourceId, closedIncidentId, ciId }, 'Storm incident was closed while the source is still storming: detached from the source')
    void audit(monitoringContext(tenantId), 'event_storm.incident_closed_during_storm', 'InboundWebhook', sourceId, { closedIncidentId, sourceName: state.sourceName })
    if (!ciId) return { ...state, incidentId: null }
    const rate = Math.max(await currentRate(tenantId, sourceId, Date.parse(now)), 1)
    const next = { ...state, incidentId: await openStormIncident(tenantId, sourceId, state.sourceName, ciId, rate, state.since ?? now, now) }
    await (await incidents()).addIncidentComment(closedIncidentId, { tenantId, userId: MONITORING_ACTOR },
      `La tempesta della sorgente "${state.sourceName}" continua dopo la chiusura di questo incident: i nuovi allarmi vengono agganciati all'incident ${next.incidentId}`)
    return next
  })
}

/**
 * Fine della tempesta. La SET è condizionale su `storm_since = $since` (lo
 * stato letto): se un'altra replica (o un job concorrente) l'ha già chiusa —
 * o ne è già iniziata una nuova — non si tocca nulla e non si ripubblica
 * `event.storm_ended`. Restituisce true se è stata chiusa qui.
 */
async function endStorm(tenantId: string, source: Props, actorId: string, now: string): Promise<boolean> {
  const sourceId = toStr(source['id'])
  const state = stormStateOf(source)
  if (!state.active || !state.since) throw new Error(`endStorm: source ${sourceId} is not in a storm`)
  const session = getSession(undefined, 'WRITE')
  let events: number
  let ended: { id: string } | null
  try {
    const counted = await runQueryOne<{ n: unknown }>(session, `
      MATCH (e:Event {tenant_id: $tenantId, source_id: $sourceId})
      WHERE e.first_seen_at >= $since
      RETURN count(e) AS n
    `, { tenantId, sourceId, since: state.since })
    events = toNumber(counted?.n)
    ended = await runQueryOne<{ id: string }>(session, `
      MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})
      WHERE w.storm_since = $since
      SET w.storm_since = null, w.storm_incident_id = null, w.storm_last_over_at = null,
          w.last_storm_started_at = $since, w.last_storm_ended_at = $now, w.last_storm_incident_id = $incidentId, w.last_storm_events = toInteger($events),
          w.updated_at = $now
      RETURN w.id AS id
    `, { sourceId, tenantId, since: state.since, now, incidentId: state.incidentId, events })
  } finally { await session.close(); invalidateSourceCache(tenantId, sourceId) }
  if (!ended) {
    log.info({ tenantId, sourceId, since: state.since }, 'Alert storm already ended (or restarted) by another process: nothing to do')
    return false
  }

  const durationMinutes = Math.max(1, Math.round((Date.parse(now) - Date.parse(state.since)) / 60_000))
  if (state.incidentId) {
    await (await incidents()).addIncidentComment(state.incidentId, { tenantId, userId: MONITORING_ACTOR }, `Tempesta terminata: ${events} eventi in ${durationMinutes} minuti`)
  }
  const payload: EventStormPayload = {
    id: state.incidentId ?? sourceId, source_id: sourceId, source_name: state.sourceName, rate_per_minute: 0, incident_id: state.incidentId, since: state.since,
    events, duration_minutes: durationMinutes,
    entity_type: state.incidentId ? 'incident' : 'inbound_webhook', entity_id: state.incidentId ?? sourceId,
  }
  await publishEvent('event.storm_ended', tenantId, actorId, payload, now)
  void audit(monitoringContext(tenantId), 'event.storm_ended', 'InboundWebhook', sourceId, { events, durationMinutes, incidentId: state.incidentId })
  await refreshStormGauge()
  log.info({ tenantId, sourceId, events, durationMinutes, incidentId: state.incidentId }, 'Alert storm ended')
  return true
}

// ── All'ingest ───────────────────────────────────────────────────────────────

export interface TrackStormInput {
  tenantId: string
  sourceId: string
  /**
   * true se il payload APRE UN CICLO: Event creato, oppure allarme rientrato
   * che torna acceso (`resolved → firing`, nuovo ciclo con `first_seen_at` =
   * istante del payload). Revisione 2 · B2-03: contare i soli Event creati
   * rendeva impossibile la tempesta al SECONDO guasto identico — dopo il primo
   * gli Event esistono già (conservati 90 giorni) e nessuno incrementava più
   * il contatore. NON aprono un ciclo: la ripetizione dello stesso allarme
   * ancora acceso (`repeat_interval`) e il retry `duplicate` dello stesso
   * payload (che ripete un ciclo già contato).
   */
  opensCycle: boolean
  policy:   EventPolicy
  now:      string
  actorId:  string
  /** CI dell'evento appena ingerito: apre l'incident di tempesta se ancora manca. */
  ciId:     string | null
}

/**
 * Aggiorna il contatore e lo stato di tempesta della sorgente all'ingest di
 * un evento. Restituisce lo stato DOPO la valutazione: la pipeline aggancia
 * l'evento all'incident di tempesta se `active`. La sorgente viene letta
 * dalla cache: le decisioni che contano sono riprese sotto lock.
 */
export async function trackSourceStorm(input: TrackStormInput): Promise<StormState> {
  const { tenantId, sourceId, policy, now, actorId } = input
  const source = await loadSource(tenantId, sourceId)
  if (!source) return NO_STORM(sourceId)
  const state = stormStateOf(source)
  const threshold = policy.storm_threshold_per_minute
  let lastOverAt = typeof source['storm_last_over_at'] === 'string' ? source['storm_last_over_at'] : state.since

  if (input.opensCycle && threshold > 0) {
    const rate = await countNewEvent(tenantId, sourceId, now)
    if (rate >= threshold) {
      if (!state.active) {
        // Sotto lock: se un job concorrente l'ha già avviata, ci si aggancia alla sua.
        return ensureStorm(tenantId, sourceId, rate, input.ciId, actorId, now, true)
      }
      // Minuto oltre soglia: ogni job oltre soglia lo segna (non solo il
      // 50°, che potrebbe fallire prima della SET), ma la SET condizionale
      // scrive UNA volta per minuto.
      const s = getSession(undefined, 'WRITE')
      try {
        await runQuery(s, `
          MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})
          WHERE w.storm_last_over_at IS NULL OR w.storm_last_over_at < $minuteStart
          SET w.storm_last_over_at = $now
        `, { sourceId, tenantId, now, minuteStart: minuteStartOf(now) })
      } finally { await s.close(); invalidateSourceCache(tenantId, sourceId) }
      lastOverAt = now
    }
  }
  if (!state.active) return state

  if (lastOverAt && stormCooledDown(lastOverAt, now, policy.storm_cooldown_minutes)) {
    await endStorm(tenantId, source, actorId, now)
    return NO_STORM(state.sourceName)
  }
  // Tempesta iniziata da eventi orfani: il primo evento con un CI apre l'incident (sotto lock: uno solo).
  if (!state.incidentId && input.ciId) {
    const rate = await currentRate(tenantId, sourceId, Date.parse(now))
    return ensureStorm(tenantId, sourceId, Math.max(rate, threshold), input.ciId, actorId, now, false)
  }
  return state
}

// ── Job periodico ────────────────────────────────────────────────────────────

/**
 * Chiude le tempeste raffreddate delle sorgenti che non ricevono più nulla
 * (l'ingest non passa, quindi nessuno le rivaluta). Paginata per id della
 * sorgente (lib/pagedPass.ts); un errore su una sorgente non ferma le altre
 * ma fa fallire il job. Riallinea il gauge.
 */
export async function endCooledStorms(now: string = new Date().toISOString()): Promise<PagedPassResult & { active: number; ended: number }> {
  let ended = 0
  const policies = new Map<string, EventPolicy>()
  const result = await runPagedPass<Props>({
    fetchPage: async (cursor, limit) => {
      const session = getSession()
      try {
        // tenant-ok: job di manutenzione su tutti i tenant; ogni sorgente è poi trattata nel suo tenant
        const rows = await runQuery<{ props: Props }>(session, `
          MATCH (w:InboundWebhook)
          WHERE w.storm_since IS NOT NULL AND w.id > $cursor
          RETURN properties(w) AS props
          ORDER BY w.id LIMIT toInteger($limit)
        `, { cursor, limit })
        return rows.map((r) => r.props)
      } finally { await session.close() }
    },
    keyOf: (source) => toStr(source['id']),
    handle: async (source) => {
      const tenantId = toStr(source['tenant_id'])
      let policy = policies.get(tenantId)
      if (!policy) { policy = await getEventPolicy(tenantId); policies.set(tenantId, policy) }
      const lastOverAt = typeof source['storm_last_over_at'] === 'string' ? source['storm_last_over_at'] : toStr(source['storm_since'])
      if (stormCooledDown(lastOverAt, now, policy.storm_cooldown_minutes)) {
        if (await endStorm(tenantId, source, MONITORING_ACTOR, now)) ended++
      }
    },
    onError: (source, err) => log.error({ err, tenantId: toStr(source['tenant_id']), sourceId: toStr(source['id']) }, 'Storm cooldown check failed'),
  })
  await refreshStormGauge()
  if (result.truncated) log.warn({ evaluated: result.evaluated }, 'endCooledStorms: page cap reached, remaining storming sources are checked on the next pass')
  if (result.failed > 0) throw new Error(`endCooledStorms: ${result.failed}/${result.evaluated} storming sources failed the cooldown check (see logs)`)
  return { ...result, active: result.evaluated - ended, ended }
}

// ── Console ──────────────────────────────────────────────────────────────────

export interface StormSourceRow {
  sourceId:       string
  sourceName:     string
  ratePerMinute:  number
  since:          string
  incidentId:     string | null
  incidentNumber: string | null
}

/** Sorgenti del tenant in tempesta, con il tasso corrente letto da Redis (eventStats.stormSources). */
export async function listStormSources(tenantId: string, nowMs: number = Date.now()): Promise<StormSourceRow[]> {
  const session = getSession()
  let rows: Array<{ sourceId: string; sourceName: string | null; since: string; incidentId: string | null; incidentNumber: string | null }>
  try {
    rows = await runQuery(session, `
      MATCH (w:InboundWebhook {tenant_id: $tenantId, entity_type: 'event'})
      WHERE w.storm_since IS NOT NULL
      OPTIONAL MATCH (i:Incident {id: w.storm_incident_id, tenant_id: $tenantId})
      RETURN w.id AS sourceId, w.name AS sourceName, w.storm_since AS since, i.id AS incidentId, i.number AS incidentNumber
      ORDER BY w.storm_since
    `, { tenantId })
  } finally { await session.close() }
  const out: StormSourceRow[] = []
  for (const r of rows) {
    out.push({
      sourceId: r.sourceId, sourceName: r.sourceName ?? r.sourceId, since: toStr(r.since),
      ratePerMinute: await currentRate(tenantId, r.sourceId, nowMs),
      incidentId: r.incidentId ?? null, incidentNumber: r.incidentNumber ?? null,
    })
  }
  return out
}
