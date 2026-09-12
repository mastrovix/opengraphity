/**
 * Servizi monitorati — incident del servizio (ondata 3).
 *
 * Il motore (engine.ts) chiama `reconcileServiceIncident` DOPO aver scritto la
 * salute, e solo quando la valutazione ha prodotto un cambiamento rilevante
 * (salute cambiata, oppure insieme delle cause cambiato). Qui non si valuta
 * nulla: si confronta la salute appena scritta con la soglia della mappa
 * (`rules.open_incident_from`) e si porta l'incident del servizio nello stato
 * coerente — aperto, aggiornato, riaperto o risolto.
 *
 * La meccanica è quella degli allarmi (services/events/): stesso lock Redis
 * (lib/redisLock.ts, TTL 30 s e attesa 5 s come il raggruppamento), stesso
 * `incidentStepInfo` / `runMonitoringTransition` / `reopenIncident`
 * (services/events/incidentWorkflow.ts), stesso `findAutoResolvePath`
 * (services/events/autoResolve.ts) per arrivare a `resolved` da un passo che
 * non ci arriva in un colpo, stesso `incidentService` (mai Cypher diretto
 * sull'incident) con l'attore `monitoring`.
 *
 * Regole del contratto (ondata 3):
 *  - UN solo incident non chiuso per mappa: "trova → apri / aggiorna / riapri /
 *    risolvi" gira tutto sotto il lock `og:services:incident:<tenant>:<mapId>`,
 *    perché il worker `services-impact` ha concurrency 2 e la stessa mappa può
 *    essere valutata da un job e da una mutation nello stesso istante.
 *  - Una mappa `draft` (bozza) o `paused` non APRE incident: il motore ne
 *    calcola comunque la salute. Aggiornamento, riapertura e chiusura restano
 *    possibili: un incident già aperto deve poter essere chiuso anche se nel
 *    frattempo la mappa è stata messa in bozza o in pausa.
 *  - Salute `maintenance` non apre e non chiude nulla; se un incident è aperto
 *    riceve UN commento (una volta sola: `maintenance_noted_at` sulla
 *    relazione), rimosso quando il servizio esce dalla manutenzione.
 *  - **Si chiude solo con `health = 'operational'`** (revisione 2 · I1). Negli
 *    altri casi in cui la soglia non è più raggiunta — degradato sotto soglia,
 *    `unknown`, regola passata a `never` — l'incident RESTA aperto con UN
 *    commento onesto (`kept_open_noted_at`, azzerato quando si torna sopra
 *    soglia), e la causa di risoluzione si costruisce dalla salute vera: mai
 *    «tornato operativo» su un servizio che operativo non è.
 *  - **Apertura idempotente** (revisione 2 · I2): marcatore Redis
 *    `og:services:incident:opened:<tenant>:<mapId>` scritto subito dopo
 *    `createIncident`; se la relazione fallisce, al retry si ricollega
 *    quell'incident invece di crearne un secondo. `cause_ids` si scrive PRIMA
 *    del commento «Causa aggiornata», per lo stesso motivo.
 *  - Il commento «Causa aggiornata» si scrive solo quando l'insieme delle cause
 *    cambia DAVVERO rispetto a quello riportato l'ultima volta sull'incident
 *    (`cause_ids` sulla relazione, confronto per id e non per ordine): mai un
 *    commento per valutazione.
 *  - Nessun fallback silenzioso: soglia fuori vocabolario, salute senza urgenza,
 *    cause vuote sopra soglia, transizione rifiutata → errore (il job ritenta e
 *    resta visibile), mai un incident aperto «a metà».
 *
 * Ondata 4 (additiva, nessun cambio di comportamento): un allarme critico su un
 * CI incluso in una mappa apre DUE incident — quello del CI (Event Management)
 * e quello del servizio — e continua a farlo: non si sopprime nulla. All'
 * apertura, però, la descrizione dell'incident di servizio elenca gli incident
 * tecnici già aperti sui CI delle cause (`findTechnicalIncidents`, una query
 * sola), così chi legge il ticket del servizio vede subito su cosa si sta già
 * lavorando. Contatori `service_incidents_opened_total` (la riapertura conta
 * come apertura) e `service_incidents_resolved_total` (solo la chiusura vera).
 */
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import type { ServiceIncidentOpenedPayload } from '@opengraphity/types'
import { publishEvent } from '../../lib/publishEvent.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { ValidationError } from '../../lib/errors.js'
import { withRedisLock, type RedisLockOptions } from '../../lib/redisLock.js'
import { getSharedRedis } from '../../lib/bullmq.js'
import { derivePriority } from '../../lib/priority.js'
import { assertDomainValue, domainVocabulary, loadDomainMatrix } from '../../lib/domainMatrix.js'
import { resolveDomainValue } from '../../lib/domainValue.js'
import { serviceIncidentsOpenedTotal, serviceIncidentsResolvedTotal } from '../../middleware/metrics.js'
import { SERVICE_MAX_CAUSES, type ServiceHealth, type ServiceImpactRules, type ServiceMapStatus, type ServiceOpenIncidentFrom } from '../../lib/serviceVocabularies.js'
import { MONITORING_ACTOR, monitoringContext, toStr } from '../events/shared.js'
import { GROUP_LOCK_OPTS } from '../events/grouping.js'
import { engine, incidents } from '../events/deps.js'
import { incidentStepInfo, loadDefinitionTransitions, reopenIncident, runMonitoringTransition, type IncidentStepInfo, type OpenIncidentRow } from '../events/incidentWorkflow.js'
import { findAutoResolvePath } from '../events/autoResolve.js'
import { causeIdsOf, sameCauseIds, type StoredCause } from './history.js'

const log = logger.child({ module: 'service-impact' })

/** Lock del riconciliatore per (tenant, mappa): stesse opzioni del raggruppamento degli allarmi (TTL 30 s, attesa 5 s). */
export const SERVICE_INCIDENT_LOCK_OPTS: RedisLockOptions = GROUP_LOCK_OPTS

export function serviceIncidentLockKey(tenantId: string, mapId: string): string {
  return `og:services:incident:${tenantId}:${mapId}`
}

// ── Vocabolari espliciti ─────────────────────────────────────────────────────

/** Salute del servizio in italiano, per titoli e commenti (nessuna stringa inventata a runtime). */
export const SERVICE_HEALTH_LABEL_IT: Readonly<Record<ServiceHealth, string>> = {
  down:        'non disponibile',
  degraded:    'degradato',
  maintenance: 'in manutenzione',
  operational: 'operativo',
  unknown:     'sconosciuto',
}

/** Gravità delle sole salute che aprono un incident: la soglia `open_incident_from` si confronta qui. */
const OPEN_HEALTH_RANK: Readonly<Record<'degraded' | 'down', number>> = { degraded: 1, down: 2 }

/** True se la salute raggiunge la soglia della mappa (`never` → mai; maintenance/unknown/operational non aprono mai). */
export function meetsServiceOpenThreshold(health: ServiceHealth, openFrom: ServiceOpenIncidentFrom): boolean {
  if (openFrom === 'never') return false
  if (health !== 'down' && health !== 'degraded') return false
  return OPEN_HEALTH_RANK[health] >= OPEN_HEALTH_RANK[openFrom]
}

/**
 * Impatto dell'incident dalla criticità del servizio
 * (`BusinessApplication.criticality`), dalla matrice `service_impact` **del
 * cliente** (ondata 7 · C-7).
 *
 * ## Com'era, e perché era il difetto più silenzioso dell'area
 * `IMPACT_BY_CRITICALITY` aveva quattro chiavi scritte qui e
 * `serviceImpactOf` ripiegava su `DEFAULT_SERVICE_IMPACT = 'medium'` con un
 * `log.warn` che nessun utente vede. Il vocabolario della criticità è però
 * **del cliente**: aggiungere `tier_0`, o rinominare `mission_critical` in
 * `critica`, faceva nascere l'incident del servizio a impatto medio — quindi
 * P3 invece di P1/P2 — e sbagliava di conseguenza la SLA selezionata per
 * severità. Il vecchio commento lo giustificava come «dato incompleto, non un
 * errore di programmazione»: con il Dizionario aperto alle rinomine quella
 * lettura non regge più, perché il valore nuovo è una configurazione
 * legittima, non un campo mai compilato.
 *
 * ## Com'è adesso
 * Due casi, distinti e nessuno silenzioso:
 *  - criticità **assente** (CI importato da una discovery, campo mai
 *    compilato): è un dato incompleto, e resta un errore dell'apertura con un
 *    messaggio che dice quale servizio e cosa compilare — perché aprire un
 *    incident con un impatto inventato è peggio che non aprirlo e ritentare;
 *  - criticità **presente**: validata contro il vocabolario
 *    `service_criticality` del cliente e tradotta dalla sua matrice. Una cella
 *    che manca nomina la combinazione e la pagina dove completarla.
 *
 * Siamo sul cammino della valutazione di una mappa, che gira in un job: un
 * errore qui lascia il job nella coda dei falliti, rigiocabile — la stessa
 * regola dell'ingest degli allarmi (ondata 4).
 */
export async function serviceImpactOf(
  tenantId: string, criticality: string | null | undefined, ctx: { mapId: string; serviceName?: string },
): Promise<string> {
  if (criticality == null || criticality === '') {
    throw new ValidationError(
      `Il servizio ${ctx.serviceName ? `"${ctx.serviceName}" ` : ''}(mappa ${ctx.mapId}) non ha una criticità: ` +
      `compila «Criticità» sull'applicazione di business per poter aprire un incident di servizio con l'impatto giusto. ` +
      `Ammessi: ${(await domainVocabulary(tenantId, 'service_criticality')).join(', ')}.`,
    )
  }
  const c = await assertDomainValue(tenantId, 'service_criticality', criticality)
  return resolveDomainValue(tenantId, 'service_impact', c)
}

/**
 * Le criticità che la matrice del cliente traduce nell'impatto più alto: è la
 * definizione di «servizio critico» per il banner della pagina Servizi, che
 * prima la copiava a mano nel web (`CriticalServicesBanner.tsx`) e la mandava
 * al server come filtro — quindi un servizio con una criticità nuova non
 * compariva mai nel banner, in silenzio.
 *
 * «Più alto» si legge dal vocabolario `impact`: l'ULTIMO valore, perché i
 * vocabolari di scala del prodotto sono ordinati dal più basso al più alto
 * (`impact = [low, medium, high]`), ed è l'ordine che l'admin vede e riordina
 * nel Dizionario.
 */
export async function criticalServiceCriticalities(tenantId: string): Promise<string[]> {
  const impacts = await domainVocabulary(tenantId, 'impact')
  const highest = impacts[impacts.length - 1]
  if (highest === undefined) {
    throw new Error(`Vocabolario "impact" del cliente ${tenantId}: vuoto, non c'è un impatto «più alto»`)
  }
  const matrix = await loadDomainMatrix(tenantId, 'service_impact')
  return Object.keys(matrix.entries).filter((k) => matrix.entries[k] === highest)
}

/**
 * Urgenza dell'incident dalla salute del servizio. La salute NON è un
 * vocabolario del cliente (`SERVICE_HEALTHS` è un concetto del prodotto: la
 * mappa la calcola), quindi questa tabella resta nel codice — e non esiste
 * una matrice `service_urgency` nel vocabolario chiuso di
 * `DOMAIN_MATRIX_KINDS`. Limite dichiarato nel rapporto dell'ondata 7.
 *
 * Ciò che l'ondata 7 sistema è il lato d'**uscita**: i due valori sono del
 * vocabolario `urgency` del cliente e vengono validati, così chi lo rinomina
 * ottiene un errore che lo dice invece di un'urgenza fantasma sull'incident.
 */
export const URGENCY_BY_HEALTH: Readonly<Partial<Record<ServiceHealth, string>>> = { down: 'high', degraded: 'medium' }

export async function serviceUrgencyOf(tenantId: string, health: ServiceHealth): Promise<string> {
  const urgency = URGENCY_BY_HEALTH[health]
  if (!urgency) throw new Error(`Service health "${health}" has no incident urgency: only down and degraded open an incident`)
  return assertDomainValue(tenantId, 'urgency', urgency)
}

// ── Testi ────────────────────────────────────────────────────────────────────

export function serviceIncidentTitle(serviceName: string, health: ServiceHealth): string {
  return `Servizio ${serviceName}: ${SERVICE_HEALTH_LABEL_IT[health]}`
}

/** Una causa in una riga: nome del CI, salute, percorso dal CI malato al livello 1. */
export function causeLine(c: StoredCause): string {
  const path = c.path.map((p) => p.name).join(' → ')
  return `- ${c.ci.name} (${SERVICE_HEALTH_LABEL_IT[c.health]})${c.critical ? ', critico' : ''}${path ? ` — percorso: ${path}` : ''}`
}

/** Riga introduttiva dell'elenco degli incident tecnici già aperti sui componenti (ondata 4). */
export const TECHNICAL_INCIDENTS_HEADING = 'Incident tecnici già aperti sui componenti:'

/**
 * Descrizione dell'incident del servizio. `technical` (ondata 4) sono gli
 * incident tecnici già aperti sui CI delle cause: se ce ne sono, la
 * descrizione li elenca dopo i componenti; se non ce ne sono, nessuna riga in
 * più (mai un «nessuno» da leggere).
 */
export function serviceIncidentDescription(
  serviceName: string, health: ServiceHealth, impactScore: number, causes: readonly StoredCause[],
  technical: readonly TechnicalIncidentRef[] = [],
): string {
  return [
    `Il servizio "${serviceName}" è ${SERVICE_HEALTH_LABEL_IT[health]} secondo la mappa dei componenti.`,
    `Punteggio d'impatto: ${impactScore}/100.`,
    `Componenti che pesano (${causes.length}):`,
    ...causes.map(causeLine),
    ...(technical.length ? [TECHNICAL_INCIDENTS_HEADING, ...technical.map((t) => `- ${t.number} ${t.title}`)] : []),
  ].join('\n')
}

// ── Lettura dell'incident del servizio ───────────────────────────────────────

/** L'incident del servizio con quanto serve a decidere: passo, cause riportate l'ultima volta, note già scritte (manutenzione, «resta aperto»). */
export interface ServiceIncidentRow extends OpenIncidentRow {
  number:             string
  causeIds:           string[]
  maintenanceNotedAt: string | null
  keptOpenNotedAt:    string | null
}

interface RawServiceIncidentRow { incidentId: string; instanceId: string; step: string; number: string | null; causeIds: unknown; maintenanceNotedAt: unknown; keptOpenNotedAt: unknown }

/**
 * L'incident non chiuso collegato alla mappa. Come per gli allarmi, un incident
 * in `resolved` NON è chiuso: va riaperto se il servizio ricade, non affiancato
 * da un secondo incident. Solo un passo terminale diverso da `resolved` è
 * definitivo.
 */
export const FIND_SERVICE_INCIDENT_CYPHER = `
  MATCH (i:Incident {tenant_id: $tenantId})-[r:IMPACTS_SERVICE]->(m:ServiceMap {id: $mapId, tenant_id: $tenantId})
  MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
  WHERE NOT wi.current_step IN $terminalSteps OR wi.current_step = $resolvedStep
  RETURN i.id AS incidentId, wi.id AS instanceId, wi.current_step AS step, i.number AS number,
         r.cause_ids AS causeIds, r.maintenance_noted_at AS maintenanceNotedAt, r.kept_open_noted_at AS keptOpenNotedAt,
         i.created_at AS createdAt
  ORDER BY createdAt DESC LIMIT 1`

export async function findServiceIncident(session: Session, tenantId: string, mapId: string, info: IncidentStepInfo): Promise<ServiceIncidentRow | null> {
  const row = await runQueryOne<RawServiceIncidentRow>(session, FIND_SERVICE_INCIDENT_CYPHER, {
    tenantId, mapId, terminalSteps: info.terminalSteps, resolvedStep: info.resolvedStep,
  })
  if (!row) return null
  return {
    incidentId:         row.incidentId,
    instanceId:         row.instanceId,
    step:               row.step,
    number:             row.number ?? '',
    causeIds:           Array.isArray(row.causeIds) ? row.causeIds.map(toStr) : [],
    maintenanceNotedAt: row.maintenanceNotedAt == null ? null : toStr(row.maintenanceNotedAt),
    keptOpenNotedAt:    row.keptOpenNotedAt == null ? null : toStr(row.keptOpenNotedAt),
  }
}

/**
 * Crea (all'apertura) o aggiorna la relazione `(:Incident)-[:IMPACTS_SERVICE]->(:ServiceMap)`:
 * `opened_by` e `at` sono scritti una volta sola (ON CREATE), `cause_ids` è
 * l'insieme delle cause riportate l'ultima volta sull'incident (serve a non
 * ripetere il commento), `maintenance_noted_at` ricorda che la nota di
 * manutenzione è già stata scritta e `kept_open_noted_at` che è già stato detto
 * perché l'incident resta aperto sotto soglia (assegnare null cancella la
 * proprietà: la nota potrà essere riscritta al prossimo giro).
 */
export const LINK_SERVICE_INCIDENT_CYPHER = `
  MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
  MATCH (m:ServiceMap {id: $mapId, tenant_id: $tenantId})
  MERGE (i)-[r:IMPACTS_SERVICE]->(m)
  ON CREATE SET r.opened_by = $openedBy, r.at = $now
  SET r.cause_ids = $causeIds,
      r.maintenance_noted_at = CASE WHEN $maintenanceNoted THEN coalesce(r.maintenance_noted_at, $now) ELSE null END,
      r.kept_open_noted_at = CASE WHEN $keptOpenNoted THEN coalesce(r.kept_open_noted_at, $now) ELSE null END
  RETURN r.at AS at`

// ── Incident tecnici già aperti sui componenti (ondata 4) ────────────────────

/** Un incident tecnico citato nella descrizione dell'incident del servizio. */
export interface TechnicalIncidentRef { number: string; title: string }

/** Al più tanti incident tecnici nella descrizione: un elenco più lungo non si legge. */
export const SERVICE_MAX_TECHNICAL_INCIDENTS = 10

/**
 * Gli incident tecnici NON terminali che hanno fra i CI impattati uno dei
 * componenti delle cause: quelli dell'Event Management (un allarme critico su
 * un CI incluso apre sia l'incident del CI sia quello del servizio: non si
 * sopprime nulla, si mostra il collegamento) e quelli aperti a mano.
 * Gli incident DI SERVIZIO sono esclusi (`IMPACTS_SERVICE`): non sono incident
 * sul componente e citarli confonderebbe. Una sola query, al momento
 * dell'apertura, scopata per tenant.
 */
export const FIND_TECHNICAL_INCIDENTS_CYPHER = `
  MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTED_BY]->(ci {tenant_id: $tenantId})
  WHERE ci.id IN $ciIds AND NOT EXISTS { (i)-[:IMPACTS_SERVICE]->(:ServiceMap {tenant_id: $tenantId}) }
  MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
  WHERE NOT wi.current_step IN $terminalSteps
  RETURN DISTINCT i.number AS number, i.title AS title, i.created_at AS createdAt
  ORDER BY createdAt DESC LIMIT toInteger($limit)`

/** Un incident del tenant per id: serve solo al recupero d'idempotenza (il marcatore può puntare a un incident cancellato). */
export const FIND_INCIDENT_BY_ID_CYPHER = `
  MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
  RETURN i.number AS number`

export async function findTechnicalIncidents(session: Session, tenantId: string, ciIds: readonly string[], info: IncidentStepInfo): Promise<TechnicalIncidentRef[]> {
  if (ciIds.length === 0) return []
  const rows = await runQuery<{ number: string | null; title: string | null }>(session, FIND_TECHNICAL_INCIDENTS_CYPHER, {
    tenantId, ciIds: [...ciIds], terminalSteps: info.terminalSteps, limit: SERVICE_MAX_TECHNICAL_INCIDENTS,
  })
  return rows.map((r) => ({ number: r.number == null ? '' : toStr(r.number), title: r.title == null ? '' : toStr(r.title) }))
}

/** I due marcatori di «nota già scritta» sulla relazione: si passano sempre entrambi (null = cancella). */
interface LinkNotes { maintenanceNoted: boolean; keptOpenNoted: boolean }

async function linkServiceIncident(session: Session, tenantId: string, mapId: string, incidentId: string, causeIds: readonly string[], notes: LinkNotes, now: string): Promise<void> {
  const row = await runQueryOne<{ at: string }>(session, LINK_SERVICE_INCIDENT_CYPHER, {
    tenantId, mapId, incidentId, causeIds: [...causeIds],
    maintenanceNoted: notes.maintenanceNoted, keptOpenNoted: notes.keptOpenNoted,
    now, openedBy: MONITORING_ACTOR,
  })
  if (!row) throw new Error(`Incident ${incidentId} or ServiceMap ${mapId} vanished while linking them (tenant ${tenantId})`)
}

/** Nessuna nota da conservare: il caso normale (l'incident è sopra soglia o appena aperto). */
const NO_NOTES: LinkNotes = { maintenanceNoted: false, keptOpenNoted: false }

// ── Riconciliazione ──────────────────────────────────────────────────────────

export interface ServiceIncidentInput {
  tenantId:    string
  mapId:       string
  serviceId:   string
  /** Nome della mappa = nome del servizio. */
  serviceName: string
  /** `BusinessApplication.criticality`: da qui l'impatto dell'incident. */
  criticality: string | null
  status:      ServiceMapStatus
  rules:       ServiceImpactRules
  health:      ServiceHealth
  impactScore: number
  causes:      readonly StoredCause[]
  /** actor_id dell'evento di dominio (l'incident e i commenti sono sempre del monitoraggio). */
  actorId:     string
  now:         string
  /** Solo per i log. */
  jobId?:      string
}

/**
 * Esito della riconciliazione:
 *  - `opened` / `reopened` / `updated` / `resolved`: l'incident è stato toccato;
 *  - `resolve_skipped`: nessun cammino verso `resolved` dal passo corrente (commento, nessuna forzatura);
 *  - `maintenance`: nota di manutenzione scritta (una volta sola);
 *  - `kept_open`: il servizio non è tornato operativo ma non raggiunge più la
 *    soglia (degradato sotto soglia, `unknown`, regola passata a `never`):
 *    l'incident resta aperto con UN commento onesto (una volta sola);
 *  - `disabled`: soglia `never`; `inactive`: mappa non `active` (bozza o in pausa);
 *  - `none`: niente da fare.
 */
export type ServiceIncidentOutcome = 'none' | 'opened' | 'reopened' | 'updated' | 'resolved' | 'resolve_skipped' | 'maintenance' | 'kept_open' | 'disabled' | 'inactive'

export interface ServiceIncidentResult {
  outcome:        ServiceIncidentOutcome
  incidentId:     string | null
  incidentNumber: string | null
}

/**
 * Porta l'incident del servizio nello stato coerente con la salute appena
 * scritta. Tutto sotto il lock della mappa; un errore propaga al motore (il job
 * ritenta, la passata periodica è la rete di sicurezza).
 */
export async function reconcileServiceIncident(input: ServiceIncidentInput): Promise<ServiceIncidentResult> {
  const session = getSession(undefined, 'WRITE')
  try {
    return await withRedisLock<ServiceIncidentResult>(
      serviceIncidentLockKey(input.tenantId, input.mapId),
      SERVICE_INCIDENT_LOCK_OPTS,
      () => reconcile(session, input),
      undefined,
      `the service incident of map ${input.mapId} could not be reconciled`,
    )
  } finally {
    await session.close()
  }
}

async function reconcile(session: Session, input: ServiceIncidentInput): Promise<ServiceIncidentResult> {
  const { tenantId, mapId, health, rules, status } = input
  const logCtx = { tenantId, mapId, jobId: input.jobId, health, openIncidentFrom: rules.open_incident_from, status }
  const info = await incidentStepInfo(session, tenantId)
  const open = await findServiceIncident(session, tenantId, mapId, info)
  const causeIds = causeIdsOf(input.causes)
  const done = (outcome: ServiceIncidentOutcome): ServiceIncidentResult =>
    ({ outcome, incidentId: open?.incidentId ?? null, incidentNumber: open?.number ?? null })

  // Manutenzione: né apertura né chiusura. Un incident aperto resta, con UNA
  // nota che lo dice (la valutazione successiva la trova già scritta).
  if (health === 'maintenance') {
    if (!open) return done('none')
    if (open.maintenanceNotedAt) return done('none')
    await (await incidents()).addIncidentComment(open.incidentId, monitoringCtx(tenantId),
      `Servizio in manutenzione: la valutazione resta sospesa (una change in finestra riguarda un componente critico di "${input.serviceName}")`)
    await linkServiceIncident(session, tenantId, mapId, open.incidentId, open.causeIds, { maintenanceNoted: true, keptOpenNoted: open.keptOpenNotedAt !== null }, input.now)
    log.info({ ...logCtx, incidentId: open.incidentId }, 'Service in maintenance: open incident annotated once')
    return done('maintenance')
  }

  if (meetsServiceOpenThreshold(health, rules.open_incident_from)) {
    if (!open) {
      if (status !== 'active') {
        log.debug(logCtx, 'Service map is not active: no incident opened (its health is still evaluated)')
        return done('inactive')
      }
      return openServiceIncident(session, input, causeIds, info)
    }
    if (open.step === info.resolvedStep) {
      if (status !== 'active') {
        log.debug({ ...logCtx, incidentId: open.incidentId }, 'Service map is not active: resolved incident not reopened')
        return done('inactive')
      }
      await reopenIncident(session, tenantId, open, info,
        `Il servizio "${input.serviceName}" è di nuovo ${SERVICE_HEALTH_LABEL_IT[health]} (punteggio ${input.impactScore}/100)`)
      await (await incidents()).addIncidentComment(open.incidentId, monitoringCtx(tenantId),
        `Riaperto dal monitoraggio: ${serviceIncidentDescription(input.serviceName, health, input.impactScore, input.causes)}`)
      await linkServiceIncident(session, tenantId, mapId, open.incidentId, causeIds, NO_NOTES, input.now)
      // Una riapertura conta come apertura (metrics.ts): il servizio è di nuovo fuori servizio.
      serviceIncidentsOpenedTotal.inc({})
      log.info({ ...logCtx, incidentId: open.incidentId }, 'Service incident reopened')
      return done('reopened')
    }
    // Incident già aperto: un commento SOLO se l'insieme delle cause è cambiato.
    if (sameCauseIds(open.causeIds, causeIds)) {
      // Il servizio è di nuovo sopra soglia: le note («in manutenzione»,
      // «resta aperto») vanno azzerate, così potranno essere riscritte.
      if (open.maintenanceNotedAt || open.keptOpenNotedAt) await linkServiceIncident(session, tenantId, mapId, open.incidentId, causeIds, NO_NOTES, input.now)
      return done('none')
    }
    // `cause_ids` PRIMA del commento (revisione 2 · I2): se il commento fallisce
    // e il job ritenta, il confronto è già allineato e non nasce un doppione.
    await linkServiceIncident(session, tenantId, mapId, open.incidentId, causeIds, NO_NOTES, input.now)
    await (await incidents()).addIncidentComment(open.incidentId, monitoringCtx(tenantId),
      `Causa aggiornata: il servizio è ${SERVICE_HEALTH_LABEL_IT[health]} (punteggio ${input.impactScore}/100). Componenti che pesano (${input.causes.length}):\n${input.causes.map(causeLine).join('\n')}`)
    log.info({ ...logCtx, incidentId: open.incidentId, causes: causeIds }, 'Service incident causes changed: one comment written')
    return done('updated')
  }

  // Sotto soglia (o soglia `never`). L'incident si chiude SOLO se il servizio è
  // davvero tornato operativo (revisione 2 · I1): prima bastava «non raggiunge
  // più la soglia», e un servizio ancora degradato — o di stato sconosciuto, o
  // con la regola appena passata a `never` — veniva chiuso dal monitoraggio con
  // la causa «Servizio tornato operativo», falsa.
  if (open && open.step !== info.resolvedStep) {
    if (health === 'operational') return resolveServiceIncident(session, input, open, info)
    return keepServiceIncidentOpen(session, input, open, rules.open_incident_from)
  }
  // Nessun incident da chiudere: le note vanno rimesse in condizione di essere
  // riscritte alla prossima volta (assegnare null cancella).
  if (open && (open.maintenanceNotedAt || open.keptOpenNotedAt)) {
    await linkServiceIncident(session, tenantId, mapId, open.incidentId, open.causeIds, NO_NOTES, input.now)
  }
  return done(rules.open_incident_from === 'never' ? 'disabled' : 'none')
}

/**
 * Perché l'incident resta aperto pur non raggiungendo più la soglia. Testi
 * espliciti per i tre casi, nessuna frase inventata a runtime.
 */
export function keptOpenReason(health: ServiceHealth, openFrom: ServiceOpenIncidentFrom, serviceName: string): string {
  if (openFrom === 'never') {
    return `La regola del servizio "${serviceName}" è passata a "mai aprire incident": questo incident resta aperto, va chiuso a mano.`
  }
  if (health === 'unknown') {
    return `Il servizio "${serviceName}" è di stato sconosciuto (nessun componente con una salute nota): l'incident resta aperto.`
  }
  return `Il servizio "${serviceName}" è ${SERVICE_HEALTH_LABEL_IT[health]}, sotto la soglia di apertura ("${openFrom}"): l'incident resta aperto.`
}

/**
 * Sotto soglia ma non operativo: l'incident RESTA aperto con UN commento
 * onesto, scritto una volta sola (`kept_open_noted_at` sulla relazione,
 * azzerato quando il servizio torna sopra soglia o si chiude davvero).
 */
async function keepServiceIncidentOpen(session: Session, input: ServiceIncidentInput, open: ServiceIncidentRow, openFrom: ServiceOpenIncidentFrom): Promise<ServiceIncidentResult> {
  const { tenantId, mapId, health } = input
  const result: ServiceIncidentResult = { outcome: 'kept_open', incidentId: open.incidentId, incidentNumber: open.number }
  if (open.keptOpenNotedAt) return { ...result, outcome: 'none' }
  await linkServiceIncident(session, tenantId, mapId, open.incidentId, open.causeIds, { maintenanceNoted: false, keptOpenNoted: true }, input.now)
  await (await incidents()).addIncidentComment(open.incidentId, monitoringCtx(tenantId), keptOpenReason(health, openFrom, input.serviceName))
  log.info({ tenantId, mapId, jobId: input.jobId, incidentId: open.incidentId, health, openIncidentFrom: openFrom }, 'Service is below the opening threshold but not operational: its incident is kept open (noted once)')
  return result
}

function monitoringCtx(tenantId: string) {
  return { tenantId, userId: MONITORING_ACTOR }
}

/**
 * Marcatore di idempotenza dell'apertura (revisione 2 · I2): `createIncident`
 * committa nella sua sessione, la `IMPACTS_SERVICE` è uno statement dopo — se
 * quello fallisce il job ritenta, `findServiceIncident` non trova nulla e
 * nascerebbe un SECONDO incident «Servizio X: non disponibile». Il marcatore
 * ricorda l'id per un'ora: al retry si ricollega quello già creato.
 */
export function serviceIncidentOpenedKey(tenantId: string, mapId: string): string {
  return `og:services:incident:opened:${tenantId}:${mapId}`
}

/** Vita del marcatore: abbondante per coprire i 5 tentativi con backoff, corta abbastanza da non impedire un'apertura vera più tardi. */
export const SERVICE_INCIDENT_OPENED_TTL_SECONDS = 3600

/**
 * Apertura: incident del monitoraggio con i CI delle cause come impattati,
 * relazione, evento di dominio, audit. La descrizione cita gli incident
 * tecnici già aperti sui componenti (ondata 4): nessuna soppressione, solo il
 * collegamento visibile — una query in più, qui e solo qui.
 *
 * Prima di creare si guarda il marcatore Redis: se un'apertura precedente è
 * arrivata a `createIncident` ma non alla relazione, si ricollega quell'incident
 * invece di crearne un altro (nessun doppione, un solo evento, una sola
 * notifica).
 */
async function openServiceIncident(session: Session, input: ServiceIncidentInput, causeIds: readonly string[], info: IncidentStepInfo): Promise<ServiceIncidentResult> {
  const { tenantId, mapId, health, impactScore } = input
  if (causeIds.length === 0) {
    throw new Error(`ServiceMap ${mapId} is "${health}" with no causes: an incident must have at least one impacted CI (tenant ${tenantId})`)
  }
  const redis = getSharedRedis()
  const key = serviceIncidentOpenedKey(tenantId, mapId)
  const orphan = await redis.get(key)
  let incident: { id: string; number: string } | null = null
  let technical: TechnicalIncidentRef[] = []
  let severity: string | null = null
  let impact: string | null = null
  let urgency: string | null = null
  if (orphan) {
    // L'incident esiste già (creato al giro precedente) ma non è collegato:
    // `findServiceIncident` cerca solo via IMPACTS_SERVICE e non l'ha visto.
    const row = await runQueryOne<{ number: string | null }>(session, FIND_INCIDENT_BY_ID_CYPHER, { tenantId, incidentId: orphan })
    if (row) {
      incident = { id: orphan, number: row.number == null ? '' : toStr(row.number) }
      log.warn({ tenantId, mapId, jobId: input.jobId, incidentId: orphan }, 'Service incident was already created by a previous attempt: relinked instead of opening a second one')
    } else {
      log.warn({ tenantId, mapId, incidentId: orphan }, 'Service incident idempotency marker points to an incident that no longer exists: opening a new one')
      await redis.del(key)
    }
  }

  if (!incident) {
    impact  = await serviceImpactOf(tenantId, input.criticality, { mapId, serviceName: input.serviceName })
    urgency = await serviceUrgencyOf(tenantId, health)
    severity = await derivePriority(tenantId, impact, urgency)
    technical = await findTechnicalIncidents(session, tenantId, causeIds, info)
    incident = await (await incidents()).createIncident({
      title:         serviceIncidentTitle(input.serviceName, health),
      description:   serviceIncidentDescription(input.serviceName, health, impactScore, input.causes, technical),
      severity,
      impact,
      urgency,
      affectedCIIds: causeIds.slice(0, SERVICE_MAX_CAUSES),
    }, monitoringCtx(tenantId))
    // SUBITO dopo la creazione, prima di qualunque altra scrittura che possa
    // fallire. `NX`: se un altro attore l'ha già scritto non lo si sovrascrive.
    await redis.set(key, incident.id, 'EX', SERVICE_INCIDENT_OPENED_TTL_SECONDS, 'NX')
  }

  await linkServiceIncident(session, tenantId, mapId, incident.id, causeIds, NO_NOTES, input.now)

  const payload: ServiceIncidentOpenedPayload = {
    id: mapId, map_id: mapId, service_id: input.serviceId, name: input.serviceName,
    incident_id: incident.id, incident_number: incident.number, health, impact_score: impactScore,
  }
  await publishEvent('service.incident_opened', tenantId, input.actorId, payload, input.now)
  void audit(monitoringContext(tenantId), 'service.incident_opened', 'ServiceMap', mapId, {
    incidentId: incident.id, incidentNumber: incident.number, health, impactScore, impact, urgency, severity,
    criticality: input.criticality, causes: [...causeIds], technicalIncidents: technical.map((t) => t.number),
  })
  serviceIncidentsOpenedTotal.inc({})
  log.info({ tenantId, mapId, jobId: input.jobId, incidentId: incident.id, incidentNumber: incident.number, health, impactScore, severity, causes: causeIds.length },
    'Service incident opened')
  return { outcome: 'opened', incidentId: incident.id, incidentNumber: incident.number }
}

/** Causa della risoluzione, costruita dalla salute VERA (mai «tornato operativo» se non lo è: I1). */
export function serviceResolveCause(health: ServiceHealth): string {
  return `Servizio tornato ${SERVICE_HEALTH_LABEL_IT[health]}`
}

/**
 * Chiusura automatica: dal passo corrente si va a `resolved` direttamente
 * oppure percorrendo i passi intermedi trovati nella definizione
 * (`findAutoResolvePath`, la stessa degli allarmi rientrati); un solo commento
 * riassuntivo alla fine. Nessun cammino percorribile → commento e basta: mai
 * una transizione forzata. Ci si arriva solo con `health = operational`
 * (revisione 2 · I1): gli altri casi tengono l'incident aperto.
 */
async function resolveServiceIncident(session: Session, input: ServiceIncidentInput, open: ServiceIncidentRow, info: IncidentStepInfo): Promise<ServiceIncidentResult> {
  const { tenantId, mapId, health, impactScore } = input
  const ctx = monitoringCtx(tenantId)
  const incidentService = await incidents()
  const transitions = await (await engine()).getAvailableTransitions(session, open.instanceId, tenantId)
  const path = transitions.some((t) => t.toStep === info.resolvedStep)
    ? []
    : findAutoResolvePath(await loadDefinitionTransitions(session, open.instanceId, tenantId), open.step, info.resolvedStep)

  const back = `Il servizio "${input.serviceName}" è tornato ${SERVICE_HEALTH_LABEL_IT[health]} (punteggio ${impactScore}/100)`
  if (!path) {
    await incidentService.addIncidentComment(open.incidentId, ctx,
      `${back}; l'incident è in "${open.step}" e non può essere risolto automaticamente da questo passo`)
    await linkServiceIncident(session, tenantId, mapId, open.incidentId, causeIdsOf(input.causes), NO_NOTES, input.now)
    log.info({ tenantId, mapId, jobId: input.jobId, incidentId: open.incidentId, step: open.step }, 'Service is back but its incident cannot be auto-resolved from this step')
    return { outcome: 'resolve_skipped', incidentId: open.incidentId, incidentNumber: open.number }
  }

  for (const hop of path) {
    await runMonitoringTransition(session, tenantId, open.incidentId, open.instanceId, hop.toStep, hop.trigger,
      `Chiusura automatica dal monitoraggio: passaggio a ${hop.toLabel ?? hop.toStep}`, 'service auto-resolve', false)
  }
  // La transizione "Risolvi" richiede la causa (rootCause = notes), costruita
  // dalla salute vera.
  await incidentService.resolveIncident(open.incidentId, ctx, serviceResolveCause(health))
  const via = path.length ? ` — passando per ${path.map((h) => h.toLabel ?? h.toStep).join(', ')}` : ''
  await incidentService.addIncidentComment(open.incidentId, ctx, `Risolto automaticamente: ${back}${via}`)
  await linkServiceIncident(session, tenantId, mapId, open.incidentId, causeIdsOf(input.causes), NO_NOTES, input.now)
  // L'incident del servizio è chiuso: il marcatore d'idempotenza non serve più
  // (una ricaduta deve poter aprire, o riaprire, senza inciampare in un id vecchio).
  try {
    await getSharedRedis().del(serviceIncidentOpenedKey(tenantId, mapId))
  } catch (err) {
    log.warn({ err, tenantId, mapId }, 'Service incident idempotency marker could not be cleared (it expires on its own)')
  }
  void audit(monitoringContext(tenantId), 'service.incident_resolved', 'ServiceMap', mapId, {
    incidentId: open.incidentId, incidentNumber: open.number, health, impactScore, path: path.map((h) => h.toStep),
  })
  // Solo la chiusura vera: un `resolve_skipped` (nessun cammino verso resolved) è uscito sopra.
  serviceIncidentsResolvedTotal.inc({})
  log.info({ tenantId, mapId, jobId: input.jobId, incidentId: open.incidentId, health, path: path.map((h) => h.toStep) }, 'Service incident auto-resolved')
  return { outcome: 'resolved', incidentId: open.incidentId, incidentNumber: open.number }
}
