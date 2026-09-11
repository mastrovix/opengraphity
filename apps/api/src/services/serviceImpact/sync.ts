/**
 * Servizi monitorati — mappa VIVA: sincronizzazione con la CMDB (ondata 5).
 *
 * Fino all'ondata 4 la mappa era congelata: il diff con il grafo
 * (`serviceMapProposal`) si applicava a mano. Da qui il default si inverte —
 * la mappa si aggiorna da sola e un interruttore per mappa (`auto_sync`) la
 * congela, riportandola al comportamento di prima.
 *
 * **Immediata, non periodica.** Non esistono eventi di dominio sui cambi di
 * relazione fra CI (solo `ci.health_changed`), quindi ogni scrittura che crea
 * o cancella una relazione fra CI — o cancella un CI — chiama
 * `notifyCIGraphChanged`, che accoda UNA sincronizzazione per mappa
 * interessata (job id fisso: BullMQ deduplica, un import che tocca 500
 * relazioni produce una sincronizzazione per mappa, non 500). La passata
 * periodica (`syncStaleOrOldMaps`, ogni 30 minuti) è solo la rete di
 * sicurezza per le scritture fatte da percorsi non strumentati (script,
 * migrazioni, Cypher a mano).
 *
 * **Cosa tocca la sincronizzazione**: aggiunge i componenti nuovi
 * (`added_by: 'auto'`), toglie quelli `auto` non più raggiungibili, aggiorna
 * `level` e `via` di chi si è spostato. **Cosa non tocca, mai**: i componenti
 * `added_by: 'manual'` (li ha messi una persona: li toglie una persona), le
 * esclusioni (`EXCLUDES`, che il diff già rispetta) e le impostazioni
 * `propagate`/`weight`/`critical` (decisioni dell'amministratore).
 *
 * Progetto: scratchpad service-impact-opengrafo.html, ondata 5.
 */
import { getSession, runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { ValidationError } from '../../lib/errors.js'
import { runPagedPass, type PagedPassResult } from '../../lib/pagedPass.js'
import { serviceMapSyncsTotal } from '../../middleware/metrics.js'
import { SERVICE_MAP_MAX_NODES, SERVICE_MAP_STATUSES, SERVICE_STALE_OVER_LIMIT, type ServiceMapStatus } from '../../lib/serviceVocabularies.js'
import { MONITORING_ACTOR, monitoringContext, toNumber } from '../events/shared.js'
import { ServiceMapTooLargeError } from './build.js'
import { computeServiceMapDiff, type ServiceMapDiff } from './config.js'
import { evaluateServiceMap, type EvaluateResult } from './engine.js'
import { serviceConfigHistoryParams, SERVICE_HISTORY_STATE_FROM_MAP, serviceHistoryWriteCypher } from './history.js'

const log = logger.child({ module: 'service-impact' })

/**
 * La coda si carica al momento dell'uso: `jobs/serviceImpactWorker.ts` importa
 * questo modulo per eseguire il job `sync`, quindi un import statico
 * all'indietro sarebbe un ciclo (stesso motivo di services/events/deps.ts).
 */
const queue = () => import('../../jobs/serviceImpactWorker.js')

/** Mappe non sincronizzate da più di così: la passata di sicurezza le riprende. */
export const SERVICE_MAP_SYNC_EVERY_MS = 30 * 60 * 1000

/**
 * Chi ha chiesto la sincronizzazione: `periodic` = automatica (job accodato da
 * `notifyCIGraphChanged` quando la CMDB cambia, oppure passata di sicurezza),
 * `manual` = il pulsante «Sincronizza ora» di un amministratore.
 */
export type ServiceMapSyncTrigger = 'periodic' | 'manual'

export interface SyncServiceMapResult {
  mapId:     string
  /** Versione della mappa dopo la sincronizzazione (invariata se non è cambiato nulla). */
  version:   number
  status:    ServiceMapStatus
  added:     number
  removed:   number
  moved:     number
  /** Componenti dismessi trovati nella mappa: non contano nel calcolo e il diff li propone in rimozione (revisione 2 · D6.3). */
  retired:   number
  /** True se la composizione è cambiata (versione + 1, cronologia, rivalutazione). */
  changed:   boolean
  /**
   * Perché non è stato applicato nulla: `limit` = la proposta supera il tetto
   * dei 500 nodi (la mappa è marcata `stale`), `paused` = mappa ferma (nessuna
   * scrittura, nemmeno `synced_at`). null quando la sincronizzazione è andata.
   */
  skipped:   'limit' | 'paused' | null
  /** Il motivo dello `skipped` (per il log e la cronologia); null altrimenti. */
  reason:    string | null
  syncedAt:  string
  /** Nota scritta in cronologia; null quando non c'era niente da fare. */
  note:      string | null
  /** Esito della rivalutazione che segue una composizione cambiata; null altrimenti. */
  evaluation: EvaluateResult | null
}

// ── Notifica dalla CMDB (il meccanismo principale) ───────────────────────────

/**
 * Le mappe VIVE (`auto_sync = true`, non in pausa) del tenant toccate da uno
 * di questi CI: quelle che ne includono almeno uno, più quelle il cui
 * SERVIZIO è uno di essi (una `REALIZES` nuova sulla BusinessApplication
 * cambia la mappa senza toccare nessun componente incluso), più quelle che lo
 * ricordano in `node_ids`.
 *
 * L'ultima condizione è il caso della **cancellazione** (revisione 2 · S1): il
 * `DETACH DELETE` del CI porta via la `INCLUDES`, quindi quando
 * `notifyCIGraphChanged` gira — dopo il commit, come deve — l'`EXISTS` è già
 * falso e la mappa non verrebbe trovata. `node_ids` esiste proprio per
 * ricordare gli id spariti: senza questo `any(...)` la mappa resta «da
 * rivedere» fino alla passata di sicurezza dei 30 minuti.
 */
export const MAPS_TOUCHED_BY_CIS_CYPHER = `
  MATCH (m:ServiceMap {tenant_id: $tenantId})
  WHERE m.auto_sync = true AND m.status <> 'paused'
    AND (m.service_id IN $ciIds
         OR any(x IN m.node_ids WHERE x IN $ciIds)
         OR EXISTS { (m)-[:INCLUDES]->(ci {tenant_id: $tenantId}) WHERE ci.id IN $ciIds })
  RETURN m.id AS id
  ORDER BY id`

/**
 * Avvisa il motore che il grafo dei CI è cambiato: accoda UNA sincronizzazione
 * per ogni mappa viva interessata (job id fisso `svcsync-<tenant>-<mapId>`,
 * ritardo di 2 s — BullMQ scarta i doppioni finché il job esiste).
 *
 * **Va chiamata DOPO il commit** della scrittura CMDB e **non lancia mai**: la
 * modifica alla CMDB è già scritta e non si annulla perché la coda (o Neo4j)
 * non risponde; l'errore viene loggato ad alta severità e la passata periodica
 * di sicurezza recupera entro 30 minuti. Restituisce il numero di mappe
 * accodate (0 anche in caso di errore: il chiamante non lo usa per decidere).
 */
export async function notifyCIGraphChanged(tenantId: string, ciIds: readonly string[], reason: string): Promise<number> {
  const ids = [...new Set(ciIds.filter((id) => typeof id === 'string' && id !== ''))]
  if (ids.length === 0) return 0
  try {
    const session = getSession()
    let maps: { id: string }[]
    try {
      maps = await runQuery<{ id: string }>(session, MAPS_TOUCHED_BY_CIS_CYPHER, { tenantId, ciIds: ids })
    } finally { await session.close() }
    if (maps.length === 0) return 0

    const { enqueueServiceMapSync } = await queue()
    for (const m of maps) await enqueueServiceMapSync(tenantId, m.id, 'periodic')
    log.info({ tenantId, reason, cis: ids.length, maps: maps.map((m) => m.id) }, 'CI graph changed: service map synchronizations enqueued')
    return maps.length
  } catch (err) {
    // Alta severità: la CMDB è già cambiata e le mappe vive restano indietro
    // fino alla passata di sicurezza. Mai un'eccezione qui: annullerebbe
    // un'operazione CMDB riuscita.
    log.error({ err, tenantId, reason, cis: ids }, 'CI graph changed: service map synchronizations could NOT be enqueued (the periodic pass will catch up)')
    return 0
  }
}

// ── Segnali di manutenzione (revisione 2 · D6.1) ─────────────────────────────

/**
 * Le mappe del tenant da rivalutare quando cambia la manutenzione di questi CI:
 * quelle che li includono, tranne le mappe in pausa (che non si valutano da
 * sole). Non c'entra `auto_sync`: la composizione non cambia, cambia la salute.
 */
export const MAPS_INCLUDING_CIS_CYPHER = `
  MATCH (m:ServiceMap {tenant_id: $tenantId})-[:INCLUDES]->(ci {tenant_id: $tenantId})
  WHERE m.status <> 'paused' AND ci.id IN $ciIds
  RETURN DISTINCT m.id AS id
  ORDER BY id`

/**
 * Avvisa il motore che la **manutenzione** di uno o più CI è cambiata: una
 * change è entrata o uscita dalla finestra, oppure il ciclo di vita del CI è
 * passato da o verso `maintenance`. Accoda UNA valutazione per mappa
 * interessata (trigger `maintenance`).
 *
 * Stesse regole di `notifyCIGraphChanged`: si chiama **dopo il commit** e **non
 * lancia mai** — la transizione della change (o l'aggiornamento del CI) è già
 * scritta e non si annulla perché la coda non risponde; la passata periodica
 * recupera entro 15 minuti. Restituisce il numero di mappe accodate (0 anche in
 * caso di errore).
 *
 * Senza questo segnale la salute `maintenance` compariva e spariva solo alla
 * passata periodica: durante il rilascio il servizio risultava `down` (con
 * l'incident aperto) e dopo restava «in manutenzione» — quindi senza incident —
 * anche a componente critico ancora giù.
 */
export async function notifyCIMaintenanceChanged(tenantId: string, ciIds: readonly string[], reason: string): Promise<number> {
  const ids = [...new Set(ciIds.filter((id) => typeof id === 'string' && id !== ''))]
  if (ids.length === 0) return 0
  try {
    const session = getSession()
    let maps: { id: string }[]
    try {
      maps = await runQuery<{ id: string }>(session, MAPS_INCLUDING_CIS_CYPHER, { tenantId, ciIds: ids })
    } finally { await session.close() }
    if (maps.length === 0) return 0

    const { enqueueServiceMapEvaluation } = await queue()
    for (const m of maps) await enqueueServiceMapEvaluation(tenantId, m.id, 'maintenance')
    log.info({ tenantId, reason, cis: ids.length, maps: maps.map((m) => m.id) }, 'CI maintenance changed: service map evaluations enqueued')
    return maps.length
  } catch (err) {
    log.error({ err, tenantId, reason, cis: ids }, 'CI maintenance changed: service map evaluations could NOT be enqueued (the periodic pass will catch up)')
    return 0
  }
}

/** I CI che una change tocca (`AFFECTS_CI`), per i segnali di finestra. */
export const CHANGE_AFFECTED_CIS_CYPHER = `
  MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci {tenant_id: $tenantId})
  RETURN DISTINCT ci.id AS id
  ORDER BY id`

/**
 * `notifyCIMaintenanceChanged` sui CI di una change: la usano l'ingresso e
 * l'uscita dai passi di finestra (change/autoTransitions.ts), `deleteChange` (la
 * finestra sparisce con la change) e la fine del job `reevaluate-change-window`.
 * Non lancia mai, per gli stessi motivi.
 */
export async function notifyChangeWindowChanged(tenantId: string, changeId: string, reason: string): Promise<number> {
  let ciIds: string[]
  try {
    const session = getSession()
    try {
      ciIds = (await runQuery<{ id: string }>(session, CHANGE_AFFECTED_CIS_CYPHER, { tenantId, changeId })).map((r) => r.id)
    } finally { await session.close() }
  } catch (err) {
    log.error({ err, tenantId, changeId, reason }, 'Change window changed: affected CIs could NOT be read (the periodic pass will catch up)')
    return 0
  }
  return notifyCIMaintenanceChanged(tenantId, ciIds, reason)
}

// ── Note leggibili per la cronologia ─────────────────────────────────────────

/**
 * «Sincronizzazione automatica: +2, −1, ~3 spostati» / «Sincronizzazione
 * richiesta da …», con la coda «N componenti dismessi esclusi dal calcolo»
 * quando la sincronizzazione ne trova (revisione 2 · D6.3). La coda si scrive
 * solo insieme a una sincronizzazione che cambia davvero qualcosa: una mappa
 * con un componente dismesso non deve produrre una voce di cronologia ogni
 * mezz'ora (stesso criterio della voce «oltre il tetto»).
 */
export function serviceSyncNote(trigger: ServiceMapSyncTrigger, counts: { added: number; removed: number; moved: number; retired?: number }, actorId: string): string {
  const what = `+${counts.added}, −${counts.removed}, ~${counts.moved} spostati`
  const retired = counts.retired && counts.retired > 0
    ? `; ${counts.retired} ${counts.retired === 1 ? 'componente dismesso escluso' : 'componenti dismessi esclusi'} dal calcolo`
    : ''
  return (trigger === 'manual'
    ? `Sincronizzazione richiesta da ${actorId}: ${what}`
    : `Sincronizzazione automatica: ${what}`) + retired
}

/** Motivo dello stop oltre il tetto: dice il numero e cosa fare (mai una mappa tagliata a metà). */
export function serviceSyncLimitNote(totalProposed: number | null, detail: string): string {
  const count = totalProposed == null ? 'La mappa costruita adesso' : `La mappa costruita adesso avrebbe ${totalProposed} componenti e`
  return `Sincronizzazione saltata: ${count} supera il tetto di ${SERVICE_MAP_MAX_NODES} componenti (${detail}). Riduci la profondità o escludi dei componenti.`
}

// ── Scritture ────────────────────────────────────────────────────────────────

/**
 * Guardia ottimistica che prende il lock PRIMA di confrontare (revisione 2 · X1):
 * il `SET` blocca il nodo, il `WHERE` legge il valore vero. Con il vecchio
 * `MATCH … WITH m.version AS version WHERE version = $expected … SET` due
 * scrittori potevano leggere la stessa versione e scrivere entrambi (Neo4j
 * prende il lock solo al `SET` e non rivaluta il `WHERE`). Nessuna riga → il
 * chiamante lancia e la transazione viene annullata, incremento compreso.
 * La versione nuova è già `version`: nessun `SET m.version` più avanti.
 */
const VERSION_GUARD = `
  MATCH (m:ServiceMap {id: $mapId, tenant_id: $tenantId})
  SET m.version = m.version + 1
  WITH m, m.version AS version
  WHERE version = toInteger($expectedVersion) + 1`

/**
 * Applica la sincronizzazione in UNO statement: aggiunge le INCLUDES nuove
 * (`added_by: 'auto'`), toglie quelle da rimuovere, sposta (`level`/`via`) chi
 * si è spostato, ricalcola `node_ids` dalle INCLUDES rimaste e spegne `stale`
 * (gli id spariti dalla CMDB vengono tolti: il loro CI non esiste più, non c'è
 * più nessuna impostazione da conservare). La guardia di versione è la stessa
 * delle scritture di configurazione: se qualcuno ha toccato la mappa fra il
 * diff e la scrittura, la transazione non scrive nulla.
 */
export const SYNC_APPLY_CYPHER = `${VERSION_GUARD}
  CALL {
    WITH m
    UNWIND $addNodes AS n
    MATCH (ci {id: n.ciId, tenant_id: $tenantId})
    CREATE (m)-[:INCLUDES {level: toInteger(n.level), role: n.role, propagate: n.propagate, weight: toInteger(n.weight),
                           critical: n.critical, via: n.via, added_by: 'auto', added_at: $now}]->(ci)
    RETURN count(ci) AS added
  }
  CALL {
    WITH m
    UNWIND $removeIds AS rid
    OPTIONAL MATCH (m)-[inc:INCLUDES]->(ci {id: rid, tenant_id: $tenantId})
    WITH collect(inc) AS incs
    FOREACH (x IN incs | DELETE x)
    RETURN size(incs) AS removed
  }
  CALL {
    WITH m
    UNWIND $moveNodes AS n
    MATCH (m)-[inc:INCLUDES]->(ci {id: n.ciId, tenant_id: $tenantId})
    SET inc.level = toInteger(n.level), inc.via = n.via
    RETURN count(inc) AS moved
  }
  WITH m, version, added, removed, moved, [(m)-[:INCLUDES]->(ci {tenant_id: $tenantId}) | ci.id] AS includedIds
  SET m.node_ids = includedIds, m.stale = false, m.stale_reason = null, m.synced_at = $now
  SET m.updated_at = $now, m.updated_by = $actorId
  ${serviceHistoryWriteCypher({ fields: SERVICE_HISTORY_STATE_FROM_MAP })}
  RETURN m.version AS version, m.status AS status, added, removed, moved`

/** Niente da fare: solo l'istante della sincronizzazione (nessuna versione nuova, nessuna voce, nessun evento). */
export const SYNC_TOUCH_CYPHER = `
  MATCH (m:ServiceMap {id: $mapId, tenant_id: $tenantId})
  SET m.synced_at = $now
  RETURN m.version AS version, m.status AS status`

/**
 * Oltre il tetto: NIENTE viene applicato, la mappa è marcata `stale` così
 * l'amministratore la vede fra quelle da rivedere, e `synced_at` registra il
 * tentativo (la passata riproverà fra 30 minuti). La voce di cronologia si
 * scrive SOLO la prima volta (`NOT wasStale`), come la voce «diventata stale»
 * del motore: una mappa troppo grande non deve riempire la cronologia di una
 * voce ogni mezz'ora. Il log `warn` e la metrica, quelli, restano a ogni giro.
 */
export const SYNC_SKIP_LIMIT_CYPHER = `
  MATCH (m:ServiceMap {id: $mapId, tenant_id: $tenantId})
  WITH m, coalesce(m.stale, false) AS wasStale
  WITH m, wasStale, (NOT wasStale) AS becameStale
  SET m.stale = true, m.stale_reason = '${SERVICE_STALE_OVER_LIMIT}', m.synced_at = $now
  ${serviceHistoryWriteCypher({ when: 'becameStale', imports: ['wasStale', 'becameStale'], fields: SERVICE_HISTORY_STATE_FROM_MAP })}
  RETURN m.version AS version, m.status AS status, wasStale`

interface SyncRow { version: unknown; status: string }

function assertStatus(value: unknown, mapId: string): ServiceMapStatus {
  if (typeof value !== 'string' || !(SERVICE_MAP_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`ServiceMap ${mapId} status is ${JSON.stringify(value)}: expected one of ${SERVICE_MAP_STATUSES.join(', ')}`)
  }
  return value as ServiceMapStatus
}

/** Cosa la sincronizzazione applicherebbe, dal diff: aggiunte, rimozioni (solo `auto` e id spariti) e spostamenti. */
export function syncPlanOf(diff: ServiceMapDiff): { add: ServiceMapDiff['added']; removeIds: string[]; move: { ciId: string; level: number; via: string | null }[]; retired: number } {
  // Componenti dismessi (revisione 2 · D6.3): il diff li propone in rimozione,
  // ma la sincronizzazione automatica NON li toglie — togliere una INCLUDES
  // butta via peso, criticità ed esclusioni decise da una persona solo perché
  // qualcuno ha marcato il CI dismesso nella CMDB. Non contano già più nel
  // calcolo (`excludedReason = lifecycle_decommissioned`): qui si contano
  // soltanto, per dirlo nella nota.
  const retired = diff.removed.filter((r) => r.reason === 'lifecycle')
  const removable = diff.removed.filter((r) => r.reason !== 'lifecycle')
  return {
    add: diff.added,
    // Solo i componenti messi dalla costruzione automatica: quelli aggiunti a
    // mano restano finché una persona non li toglie. Gli id spariti dalla CMDB
    // non hanno più una INCLUDES (né un `added_by`): vanno via da `node_ids`.
    removeIds: [
      ...removable.filter((r) => r.node !== null && r.node.addedBy === 'auto').map((r) => r.ciId),
      ...removable.filter((r) => r.node === null).map((r) => r.ciId),
    ],
    move: diff.moved.map((m) => ({ ciId: m.node.ciId, level: m.proposedLevel, via: m.proposedVia })),
    retired: retired.length,
  }
}

/**
 * Sincronizza la mappa con il grafo di adesso.
 *
 * Mappe in pausa: mai, nemmeno a mano (una mappa ferma resta ferma;
 * riattivarla è l'azione esplicita che serve). Mappe con `auto_sync = false`:
 * la passata e `notifyCIGraphChanged` non le toccano, ma la sincronizzazione
 * manuale funziona — è un'azione esplicita dell'amministratore.
 */
export async function syncServiceMap(
  tenantId: string,
  mapId: string,
  trigger: ServiceMapSyncTrigger,
  actorId: string = MONITORING_ACTOR,
  now: string = new Date().toISOString(),
): Promise<SyncServiceMapResult> {
  const session = getSession(undefined, 'WRITE')
  let result: SyncServiceMapResult
  try {
    result = await session.executeWrite(async (tx) => {
      let diff: ServiceMapDiff
      try {
        diff = await computeServiceMapDiff(tx, tenantId, mapId, now)
      } catch (err) {
        // Tetto superato dalla COSTRUZIONE (la proposta non si può nemmeno
        // calcolare per intero): la mappa resta com'è, marcata da rivedere.
        if (err instanceof ServiceMapTooLargeError) {
          return skipOverLimit(tx, { tenantId, mapId, now, note: serviceSyncLimitNote(null, err.message) })
        }
        throw err
      }
      // Mappa ferma: nessuna scrittura, nemmeno `synced_at`. Il rifiuto vero e
      // proprio (per il trigger manuale) arriva fuori dalla transazione.
      if (diff.status === 'paused') {
        return {
          mapId, version: diff.version, status: diff.status,
          added: 0, removed: 0, moved: 0, retired: 0, changed: false, skipped: 'paused' as const,
          reason: `ServiceMap ${mapId} is paused`, syncedAt: now, note: null, evaluation: null,
        }
      }

      const plan = syncPlanOf(diff)
      // Rimozioni che cancellano davvero una INCLUDES: gli id spariti dalla
      // CMDB non ne hanno più una (vanno via solo da `node_ids`).
      const deletions = plan.removeIds.filter((id) => !diff.missing.includes(id)).length
      // Tetto anche sul RISULTATO: i componenti aggiunti a mano non stanno
      // nella proposta e si sommano a quelli proposti.
      const finalCount = diff.nodeCount + plan.add.length - deletions
      if (diff.totalProposed > SERVICE_MAP_MAX_NODES || finalCount > SERVICE_MAP_MAX_NODES) {
        return skipOverLimit(tx, {
          tenantId, mapId, now,
          note: serviceSyncLimitNote(Math.max(diff.totalProposed, finalCount), `${diff.totalProposed} proposti, ${finalCount} dopo la sincronizzazione`),
        })
      }

      if (plan.add.length === 0 && plan.removeIds.length === 0 && plan.move.length === 0) {
        const row = await runQueryOne<SyncRow>(tx, SYNC_TOUCH_CYPHER, { mapId, tenantId, now })
        if (!row) throw new Error(`ServiceMap ${mapId} vanished while synchronizing (tenant ${tenantId})`)
        return {
          mapId, version: toNumber(row.version), status: assertStatus(row.status, mapId),
          added: 0, removed: 0, moved: 0, retired: plan.retired, changed: false, skipped: null, reason: null, syncedAt: now, note: null, evaluation: null,
        }
      }

      const counts = { added: plan.add.length, removed: plan.removeIds.length, moved: plan.move.length }
      const note = serviceSyncNote(trigger, { ...counts, retired: plan.retired }, actorId)
      const row = await runQueryOne<SyncRow & { added: unknown; removed: unknown; moved: unknown }>(tx, SYNC_APPLY_CYPHER, {
        mapId, tenantId, expectedVersion: diff.version, now, actorId,
        addNodes: plan.add.map((n) => ({ ciId: n.ciId, level: n.level, role: n.role, propagate: n.propagate, weight: n.weight, critical: n.critical, via: n.via })),
        removeIds: plan.removeIds, moveNodes: plan.move,
        ...serviceConfigHistoryParams('map_changed', note, now),
      })
      if (!row) throw new Error(`ServiceMap ${mapId} changed while synchronizing (expected version ${diff.version}): the transaction was rolled back, the next pass will retry`)
      const written = { added: toNumber(row.added), removed: toNumber(row.removed), moved: toNumber(row.moved) }
      if (written.added !== counts.added || written.removed !== deletions || written.moved !== counts.moved) {
        throw new Error(`ServiceMap ${mapId}: synchronized ${written.added}/${counts.added} additions, ${written.removed}/${deletions} removals, ${written.moved}/${counts.moved} moves (a CI vanished while writing): the transaction was rolled back`)
      }
      return {
        mapId, version: toNumber(row.version), status: assertStatus(row.status, mapId),
        ...counts, retired: plan.retired, changed: true, skipped: null, reason: null, syncedAt: now, note, evaluation: null,
      }
    })
  } catch (err) {
    serviceMapSyncsTotal.inc({ result: 'error' })
    throw err
  } finally { await session.close() }

  // Mappa in pausa: la richiesta manuale è un errore dell'utente (riattivala),
  // non un guasto del motore — non conta nella metrica degli errori. Dal
  // periodico non ci si arriva (la passata e `notifyCIGraphChanged` filtrano
  // le `paused`): può capitare solo se la mappa è stata messa in pausa fra
  // l'accodamento e l'esecuzione, e allora è giusto non fare nulla.
  if (result.skipped === 'paused') {
    if (trigger === 'manual') {
      throw new ValidationError(`ServiceMap ${mapId} is paused: reactivate it before synchronizing (a paused map is never evaluated nor synchronized)`)
    }
    log.info({ tenantId, mapId, trigger }, 'Service map synchronization skipped: the map is paused')
    return result
  }
  if (result.skipped === 'limit') {
    log.warn({ tenantId, mapId, trigger, reason: result.reason }, 'Service map synchronization skipped: the map would exceed the node cap')
    serviceMapSyncsTotal.inc({ result: 'skipped_limit' })
    return result
  }
  if (result.retired > 0) {
    log.info({ tenantId, mapId, trigger, retired: result.retired }, 'Service map has decommissioned components: they do not count in the calculation and the proposal marks them for removal')
  }
  if (!result.changed) {
    log.debug({ tenantId, mapId, trigger }, 'Service map already in sync with the CMDB')
    serviceMapSyncsTotal.inc({ result: 'unchanged' })
    return result
  }

  log.info({ tenantId, mapId, trigger, version: result.version, added: result.added, removed: result.removed, moved: result.moved, retired: result.retired }, 'Service map synchronized with the CMDB')
  void audit(actorId === MONITORING_ACTOR ? monitoringContext(tenantId) : { tenantId, userId: actorId, userEmail: actorId, role: 'admin' }, 'service_map.synced', 'ServiceMap', mapId, {
    trigger, version: result.version, added: result.added, removed: result.removed, moved: result.moved, note: result.note,
  })
  // La composizione è cambiata: la salute va ricalcolata subito (un componente
  // nuovo può essere giù). Le mappe in pausa non arrivano qui.
  try {
    const evaluation = await evaluateServiceMap({ tenantId, mapId, trigger: 'map_changed', actorId, now })
    serviceMapSyncsTotal.inc({ result: 'changed' })
    return { ...result, evaluation }
  } catch (err) {
    serviceMapSyncsTotal.inc({ result: 'error' })
    throw err
  }
}

interface SkipInput { tenantId: string; mapId: string; now: string; note: string }

/** Marca la mappa da rivedere senza applicare nulla (con la voce di cronologia solo la prima volta). */
async function skipOverLimit(tx: Queryable, input: SkipInput): Promise<SyncServiceMapResult> {
  const row = await runQueryOne<SyncRow & { wasStale: unknown }>(tx, SYNC_SKIP_LIMIT_CYPHER, {
    mapId: input.mapId, tenantId: input.tenantId, now: input.now,
    ...serviceConfigHistoryParams('map_changed', input.note, input.now),
  })
  if (!row) throw new Error(`ServiceMap ${input.mapId} vanished while synchronizing (tenant ${input.tenantId})`)
  return {
    mapId: input.mapId, version: toNumber(row.version), status: assertStatus(row.status, input.mapId),
    added: 0, removed: 0, moved: 0, retired: 0, changed: false, skipped: 'limit', reason: input.note, syncedAt: input.now,
    note: row.wasStale === true ? null : input.note, evaluation: null,
  }
}

// ── Passata periodica (rete di sicurezza) ────────────────────────────────────

interface MapRef { tenantId: string; id: string }

/**
 * Mappe vive (`auto_sync = true`, non in pausa) non sincronizzate da più di
 * SERVICE_MAP_SYNC_EVERY_MS (o mai), di ogni tenant, paginate
 * (lib/pagedPass.ts). Recupera solo ciò che `notifyCIGraphChanged` non ha
 * visto: scritture da script, migrazioni, Cypher a mano, o una coda che era
 * giù. Un errore su una mappa non ferma le altre ma fa fallire il job alla
 * fine, con tutti i motivi.
 */
export async function syncStaleOrOldMaps(now: string = new Date().toISOString()): Promise<PagedPassResult> {
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error(`syncStaleOrOldMaps: "${now}" is not an ISO date`)
  const cutoff = new Date(nowMs - SERVICE_MAP_SYNC_EVERY_MS).toISOString()
  const result = await runPagedPass<MapRef>({
    fetchPage: async (cursor, limit) => {
      const session = getSession()
      try {
        return await runQuery<MapRef>(session, `
          // tenant-ok: passata di manutenzione su tutti i tenant; ogni mappa è poi sincronizzata nel suo tenant.
          MATCH (m:ServiceMap)
          WHERE m.auto_sync = true AND m.status <> 'paused'
            AND (m.synced_at IS NULL OR m.synced_at < $cutoff) AND m.id > $cursor
          RETURN m.tenant_id AS tenantId, m.id AS id
          ORDER BY m.id LIMIT toInteger($limit)
        `, { cutoff, cursor, limit })
      } finally { await session.close() }
    },
    keyOf:   (r) => r.id,
    handle:  async (r) => { await syncServiceMap(r.tenantId, r.id, 'periodic', MONITORING_ACTOR, now) },
    onError: (r, err) => log.error({ err, tenantId: r.tenantId, mapId: r.id }, 'Periodic service map synchronization failed'),
  })
  if (result.truncated) log.warn({ evaluated: result.evaluated }, 'syncStaleOrOldMaps: page cap reached, remaining maps are synchronized on the next pass')
  if (result.failed > 0) throw new Error(`syncStaleOrOldMaps: ${result.failed}/${result.evaluated} service maps failed synchronization (see logs)`)
  return result
}
