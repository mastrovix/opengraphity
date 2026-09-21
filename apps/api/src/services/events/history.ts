/**
 * Event Management — cronologia dell'allarme.
 *
 * Una voce `EventHistoryEntry` per ogni cambiamento di stato o esito
 * dell'Event, agganciata con `(:Event)-[:HAS_HISTORY]->(:EventHistoryEntry)`:
 * creazione, cicli firing/resolved, cambio di severità, esiti di
 * correlazione, silenzio in finestra di change, sfarfallio, tempesta,
 * chiusura automatica e azioni manuali (vocabolario `EVENT_HISTORY_KINDS` in
 * lib/eventVocabularies.ts). Le ripetizioni di un payload con lo stesso stato
 * non scrivono nulla (`count`/`last_seen_at` bastano) e i cambi di salute del
 * CI non stanno qui (sono del CI, non dell'allarme).
 *
 * La voce si scrive NELLO STESSO statement di chi scrive lo stato:
 * `historyWriteCypher` è un frammento da accodare a un SET/MERGE con `e`
 * (l'Event) in scope — l'ingest lo mette dentro `ingestMergeCypher`, la
 * correlazione dentro `setCorrelation`, le mutation dentro il loro SET. Mai un
 * fire-and-forget: se la CREATE fallisce, fallisce l'operazione.
 * `appendEventHistory` serve ai punti che non hanno una scrittura dell'Event a
 * cui agganciarsi (chiusura automatica, rivalutazione richiesta) e usa la
 * sessione del chiamante.
 *
 * Cap: al massimo EVENT_HISTORY_MAX voci per evento. Lo stesso frammento che
 * scrive la voce cancella le più vecchie oltre il limite (mai la `first_seen`:
 * è il punto di partenza dell'allarme). Indice `event_history_tenant_event`
 * su (tenant_id, event_id, at) e vincolo di unicità su `id` in
 * packages/neo4j/src/init.ts. La conservazione (eventRetention.ts) cancella le
 * voci insieme all'evento.
 */
import { v4 as uuidv4 } from 'uuid'
import { runQueryOne } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import type { CorrelationOutcome, EventHistoryKind, EventSeverity } from '../../lib/eventVocabularies.js'
import { MONITORING_ACTOR } from './shared.js'

/** Massimo di voci conservate per evento; oltre, le più vecchie (mai la first_seen) vengono cancellate. */
export const EVENT_HISTORY_MAX = 200

/** Una voce da scrivere. I campi assenti restano null; `at` predefinito = `now` del chiamante, `actorId` = monitoring. */
export interface EventHistoryEntry {
  kind:        EventHistoryKind
  at?:         string
  /** Esito di correlazione: solo per kind = correlated. */
  outcome?:    CorrelationOutcome | null
  /** `monitoring` (azioni automatiche) o l'id dell'utente. */
  actorId?:    string
  incidentId?: string | null
  changeId?:   string | null
  ciId?:       string | null
  note?:       string | null
  severity?:   EventSeverity | null
}

/** Espressioni Cypher dei campi della voce; per default i parametri `$history*` prodotti da historyParams. */
export interface HistoryFieldCypher {
  id?: string; kind?: string; at?: string; outcome?: string; actorId?: string
  incidentId?: string; changeId?: string; ciId?: string; note?: string; severity?: string
}

export const HISTORY_FIELD_PARAMS: Readonly<Required<HistoryFieldCypher>> = {
  id: '$historyId', kind: '$historyKind', at: '$historyAt', outcome: '$historyOutcome', actorId: '$historyActorId',
  incidentId: '$historyIncidentId', changeId: '$historyChangeId', ciId: '$historyCiId', note: '$historyNote', severity: '$historySeverity',
}

export interface HistoryWriteOptions {
  /** Condizione Cypher (booleana) sotto cui la voce viene scritta; default `true`. Può leggere `e` e le variabili in `imports`. */
  when?:    string
  /** Variabili (oltre a `e`) lette da `when`: vengono importate nel CALL del cap. */
  imports?: readonly string[]
  /** Campi come espressioni Cypher (default: parametri `$history*`). */
  fields?:  HistoryFieldCypher
}

/**
 * Frammento Cypher che scrive UNA voce agganciata a `e` (già in scope) e
 * applica il cap, da accodare a uno statement che ha appena scritto lo stato:
 *
 *   FOREACH (… CASE WHEN <when> …) | CREATE (e)-[:HAS_HISTORY]->(:EventHistoryEntry {…})
 *   WITH *
 *   CALL { … cancella le voci oltre EVENT_HISTORY_MAX, dalla più vecchia, mai la first_seen }
 *
 * Il CALL è una unit subquery (nessun RETURN): non cambia le righe dello
 * statement che lo ospita, e gira solo quando la voce è stata scritta (stessa
 * condizione). Richiede `$tenantId` nei parametri. Tutte le variabili in scope
 * restano disponibili dopo il frammento (`WITH *`).
 */
export function historyWriteCypher(opts: HistoryWriteOptions = {}): string {
  const f = { ...HISTORY_FIELD_PARAMS, ...opts.fields }
  const when = opts.when ?? 'true'
  const imports = ['e', ...(opts.imports ?? [])].join(', ')
  return [
    `FOREACH (_ IN CASE WHEN ${when} THEN [1] ELSE [] END |`,
    `  CREATE (e)-[:HAS_HISTORY]->(:EventHistoryEntry {id: ${f.id}, tenant_id: $tenantId, event_id: e.id, at: ${f.at}, kind: ${f.kind}, outcome: ${f.outcome},`,
    `    actor_id: ${f.actorId}, incident_id: ${f.incidentId}, change_id: ${f.changeId}, ci_id: ${f.ciId}, note: ${f.note}, severity: ${f.severity}})`,
    `)`,
    `WITH *`,
    `CALL {`,
    `  WITH ${imports}`,
    `  UNWIND CASE WHEN ${when} THEN [1] ELSE [] END AS _`,
    `  MATCH (e)-[:HAS_HISTORY]->(old:EventHistoryEntry {tenant_id: $tenantId})`,
    `  WHERE old.kind <> 'first_seen'`,
    `  WITH old ORDER BY old.at DESC, old.id DESC`,
    `  SKIP ${EVENT_HISTORY_MAX - 1}`,
    `  DETACH DELETE old`,
    `}`,
  ].join('\n      ')
}

/**
 * Parametri `$history*` di una voce (id nuovo a ogni chiamata). `outcome` è
 * ammesso solo con kind `correlated`: un esito su un'altra voce è un errore di
 * programmazione, non un dato da salvare.
 */
export function historyParams(entry: EventHistoryEntry, now: string): Record<string, unknown> {
  if (entry.outcome != null && entry.kind !== 'correlated') {
    throw new Error(`Event history entry ${entry.kind} cannot carry a correlation outcome (${entry.outcome})`)
  }
  return {
    historyId:         uuidv4(),
    historyKind:       entry.kind,
    historyAt:         entry.at ?? now,
    historyOutcome:    entry.outcome ?? null,
    historyActorId:    entry.actorId ?? MONITORING_ACTOR,
    historyIncidentId: entry.incidentId ?? null,
    historyChangeId:   entry.changeId ?? null,
    historyCiId:       entry.ciId ?? null,
    historyNote:       entry.note ?? null,
    historySeverity:   entry.severity ?? null,
  }
}

/**
 * Scrive una voce da sola, nella sessione del chiamante: per i punti senza una
 * scrittura dell'Event nello stesso statement. Evento assente → errore (mai
 * una cronologia scritta nel vuoto o saltata in silenzio).
 */
export async function appendEventHistory(session: Session, tenantId: string, eventId: string, entry: EventHistoryEntry, now: string = new Date().toISOString()): Promise<void> {
  const row = await runQueryOne<{ id: string }>(session, `
    MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
    ${historyWriteCypher()}
    RETURN e.id AS id
  `, { eventId, tenantId, ...historyParams(entry, now) })
  if (!row) throw new Error(`Event ${eventId} not found while appending history entry ${entry.kind} (tenant ${tenantId})`)
}
