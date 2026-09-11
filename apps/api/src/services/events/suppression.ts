/**
 * Passo 1 della pipeline: soppressione in finestra di change.
 *
 * Una change "in finestra" (passo `deployment`, oppure `scheduled` con una
 * releaseWindow/validationWindow del piano di rilascio che contiene
 * l'istante) collegata al CI dell'evento o a un CI a monte (le relazioni
 * tecniche di SUPPRESSION_REL_TYPES, fino a `suppress_upstream_hops` salti)
 * silenzia l'evento: status `suppressed`, SUPPRESSED_BY, `event.suppressed`.
 * Niente salute, niente incident.
 *
 * **Una sola definizione di «CI in finestra»** (revisione 2 · D6.2): la regola
 * vive qui e la usano sia gli allarmi (un CI per volta:
 * `findSuppressingChange`) sia i Servizi monitorati (tutti i componenti della
 * mappa in una volta). Il frammento Cypher `changeWindowSubqueryCypher` è
 * condiviso — i servizi lo innestano nella loro query di caricamento
 * (serviceImpact/engine.ts) invece di fare un giro in più — e la scelta della
 * change che copre davvero il CI è la funzione pura `pickChangeWindow`.
 *
 * Due correzioni della revisione 2 valgono per entrambi i sottosistemi:
 *  - B2-12: i piani di rilascio sono **per CI** (`dp.ci_id`), quindi la
 *    finestra del piano di un CI non silenzia gli allarmi di un altro CI della
 *    stessa change;
 *  - B2-13: a monte si percorrono le relazioni tecniche di
 *    SUPPRESSION_REL_TYPES (le stesse che i servizi navigano), non solo
 *    `DEPENDS_ON`: il caso più comune è la change sul server con gli allarmi
 *    sulle VM `HOSTED_ON`.
 */
import { getSession, runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import type { MonitoringEventPayload } from '@opengraphity/types'
import { publishEvent } from '../../lib/publishEvent.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { anyDeployWindowContains } from '../../lib/deployWindows.js'
import { SERVICE_RELATIONSHIP_TYPES } from '../../lib/serviceVocabularies.js'
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

/**
 * Relazioni percorse verso i CI a MONTE (revisione 2 · B2-13): la stessa
 * famiglia tecnica che la mappa di un servizio segue per l'impatto
 * (SERVICE_RELATIONSHIP_TYPES, lib/serviceVocabularies.ts) — «x dipende da /
 * gira su / usa y», quindi una change su y tocca x. Nessuna manopola nuova:
 * una definizione sola per allarmi e servizi.
 */
export const SUPPRESSION_REL_TYPES: string = SERVICE_RELATIONSHIP_TYPES.join('|')

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

/** La finestra che copre un CI: la change, e il CI davvero toccato (lo stesso, o quello a monte). */
export interface ChangeWindow extends SuppressingChange {
  /** CI con la `AFFECTS_CI`: uguale al CI valutato quando la copertura è diretta. */
  viaCiId:   string
  viaCiName: string
  /** True quando la change è su un CI a monte, non su quello valutato. */
  upstream:  boolean
}

/** Una candidata come esce dal Cypher: la finestra vera si decide in TypeScript (i piani sono JSON). */
export interface ChangeWindowRow extends ChangeWindow { plans: unknown[] | null }

/** `hops` deve essere un intero ≥ 0: finisce nel pattern di lunghezza variabile, non fra i parametri. */
export function assertUpstreamHops(hops: number): number {
  if (!Number.isInteger(hops) || hops < 0) throw new Error(`suppress_upstream_hops must be an integer >= 0, got ${JSON.stringify(hops)}`)
  return hops
}

/**
 * Le change candidate che coprono il nodo `ci` (già in scope nel chiamante),
 * in ordine di vicinanza (prima la copertura diretta, poi i salti a monte) e
 * poi di implementazione: il chiamante prende la prima davvero in finestra
 * (`pickChangeWindow`). Sottoquery `CALL { WITH ci … RETURN collect(…) AS
 * changes }`: una riga per nodo anche quando non c'è nessuna change (collect
 * su zero righe = lista vuota), quindi si innesta in una query più grande —
 * è così che i Servizi monitorati leggono le finestre di TUTTI i componenti
 * senza un giro in più.
 *
 * Parametri attesi dal chiamante: `$tenantId`, `$windowSteps`,
 * `$implementationStep`. `hops` è interpolato (intero validato).
 */
export function changeWindowSubqueryCypher(hops: number): string {
  const targets = assertUpstreamHops(hops) > 0
    ? `[{node: ci, dist: 0}] + [(ci)-[rel:${SUPPRESSION_REL_TYPES}*1..${hops}]->(up:ConfigurationItem {tenant_id: $tenantId}) | {node: up, dist: size(rel)}]`
    : '[{node: ci, dist: 0}]'
  return `
    CALL {
      WITH ci
      UNWIND ${targets} AS t
      WITH t.node AS target, t.dist AS dist
      WHERE target IS NOT NULL
      MATCH (c:Change {tenant_id: $tenantId})-[:AFFECTS_CI]->(target)
      WHERE coalesce(c.deleted, false) = false
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
      WHERE wi.current_step IN $windowSteps
      WITH c, wi, target, min(dist) AS dist
      ORDER BY dist, CASE WHEN wi.current_step = $implementationStep THEN 0 ELSE 1 END, c.created_at
      RETURN collect({
        changeId: c.id, code: coalesce(c.code, c.id), step: wi.current_step,
        viaCiId: target.id, viaCiName: coalesce(target.name, target.id), upstream: dist > 0,
        plans: [(c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {tenant_id: $tenantId}) WHERE dp.ci_id = target.id | dp.steps]
      }) AS changes
    }`
}

/** I parametri che `changeWindowSubqueryCypher` si aspetta (oltre a `$tenantId`). */
export const CHANGE_WINDOW_PARAMS = { windowSteps: CHANGE_WINDOW_STEPS, implementationStep: CHANGE_IMPLEMENTATION_STEP } as const

/**
 * La prima candidata davvero in finestra all'istante `atMs` (le righe arrivano
 * già ordinate dal Cypher). Funzione pura: la usano gli allarmi e i servizi.
 */
export function pickChangeWindow(rows: readonly ChangeWindowRow[] | null | undefined, atMs: number): ChangeWindow | null {
  for (const r of rows ?? []) {
    if (typeof r.step !== 'string') continue
    if (changeIsInWindow(r.step, r.plans ?? [], atMs)) {
      return { changeId: r.changeId, code: r.code, step: r.step, viaCiId: r.viaCiId, viaCiName: r.viaCiName, upstream: r.upstream === true }
    }
  }
  return null
}

/** `at` deve essere una data ISO: il confronto con le finestre del piano è in millisecondi. */
function atMsOf(at: string, what: string): number {
  const atMs = Date.parse(at)
  if (Number.isNaN(atMs)) throw new Error(`${what}: "${at}" is not an ISO date`)
  return atMs
}

/**
 * Per ogni CI dato, la change che lo copre all'istante `at` (diretta o su un
 * CI a monte entro `hops` salti), o nessuna voce se non c'è: UNA query per
 * tutti i CI. È la definizione condivisa di «CI in finestra di change»
 * (revisione 2 · D6.2). Legge nella sessione del chiamante.
 */
export async function changeWindowsForCIs(session: Queryable, tenantId: string, ciIds: readonly string[], hops: number, at: string): Promise<Map<string, ChangeWindow>> {
  const ids = [...new Set(ciIds)]
  const out = new Map<string, ChangeWindow>()
  if (ids.length === 0) return out
  const atMs = atMsOf(at, 'changeWindowsForCIs')
  const rows = await runQuery<{ ciId: string; changes: ChangeWindowRow[] | null }>(session, `
    UNWIND $ciIds AS cid
    MATCH (ci:ConfigurationItem {id: cid, tenant_id: $tenantId})
    ${changeWindowSubqueryCypher(hops)}
    RETURN ci.id AS ciId, changes
  `, { ciIds: ids, tenantId, ...CHANGE_WINDOW_PARAMS })
  for (const r of rows) {
    const window = pickChangeWindow(r.changes, atMs)
    if (window) out.set(r.ciId, window)
  }
  return out
}

/**
 * La change (non eliminata) che silenzia il CI: collegata con AFFECTS_CI al CI
 * stesso o a un CI da cui questo dipende entro `hops` salti (0 = solo diretto),
 * con il workflow in un passo "di finestra" (vedi changeIsInWindow). Preferisce
 * la più vicina, poi quella in implementazione. Lettura: apre una sessione
 * propria (chiamata anche fuori dalla pipeline).
 */
export async function findSuppressingChange(tenantId: string, ciId: string, hops: number, at: string): Promise<ChangeWindow | null> {
  assertUpstreamHops(hops)
  atMsOf(at, 'findSuppressingChange')
  const session = getSession()
  try {
    return (await changeWindowsForCIs(session, tenantId, [ciId], hops, at)).get(ciId) ?? null
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
