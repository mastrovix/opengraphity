/**
 * Servizi monitorati — cronologia della salute del servizio.
 *
 * Una voce `ServiceHealthEntry` per ogni cambiamento di salute della mappa
 * (e per gli eventi che la riguardano: creazione, mappa cambiata/stale),
 * agganciata con `(:ServiceMap)-[:HAS_HEALTH_HISTORY]->(:ServiceHealthEntry)`.
 * Stesso schema della cronologia dell'allarme (services/events/history.ts):
 * la voce si scrive NELLO STESSO statement di chi scrive lo stato (frammento
 * `serviceHistoryWriteCypher` con `m` — la ServiceMap — in scope), mai un
 * fire-and-forget; il cap (SERVICE_HISTORY_MAX voci, mai la prima con
 * trigger `created`) è applicato dallo stesso statement.
 *
 * Il frammento è parametrizzato da un prefisso perché uno statement può
 * scrivere due voci (es. la salute cambiata E la mappa diventata stale nella
 * stessa valutazione): ognuna ha i suoi parametri `$<prefisso>*`, e il cap
 * gira una volta sola (`cap`/`capWhen`). Vincolo di unicità su `id` e indice
 * (tenant_id, map_id, at) in packages/neo4j/src/init.ts.
 */
import { v4 as uuidv4 } from 'uuid'
import { SERVICE_HISTORY_MAX, type ServiceHealth, type ServiceHealthTrigger } from '../../lib/serviceVocabularies.js'
import type { ImpactCause } from './rules.js'

/** Riferimento a un CI conservato nella spiegazione (istantanea al momento della valutazione). */
export interface CauseCIRef { id: string; name: string; type: string; health: string | null }

/** Una causa come viene salvata in `ServiceMap.explanation` / `ServiceHealthEntry.cause` (JSON): la ImpactCause con i riferimenti risolti. */
export interface StoredCause extends Omit<ImpactCause, 'path'> {
  ci:   CauseCIRef
  path: CauseCIRef[]
}

export interface ServiceHistoryEntry {
  trigger:        ServiceHealthTrigger
  health:         ServiceHealth
  previousHealth: ServiceHealth | null
  impactScore:    number
  causes:         StoredCause[]
  at?:            string
  note?:          string | null
}

/** Insieme delle cause per id, senza duplicati (l'insieme, non l'ordine: il confronto fra valutazioni è fra insiemi). */
export function causeIdsOf(causes: readonly StoredCause[]): string[] {
  return [...new Set(causes.map((c) => c.ciId))]
}

/** Due insiemi di id uguali a meno dell'ordine. */
export function sameCauseIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

export const SERVICE_HISTORY_DEFAULT_PREFIX = 'h'

export interface ServiceHistoryWriteOptions {
  /** Condizione Cypher (booleana) sotto cui la voce viene scritta; default `true`. Può leggere `m` e le variabili in `imports`. */
  when?:    string
  /** Variabili (oltre a `m`) lette da `when`/`capWhen`/`fields`: importate nel CALL del cap. */
  imports?: readonly string[]
  /** Prefisso dei parametri `$<prefisso>Id`, `$<prefisso>At`, … (default `h`). */
  prefix?:  string
  /**
   * Campi come espressioni Cypher al posto dei parametri: `previous_health`
   * dalla riga (valutazione), oppure salute/punteggio/cause dalla mappa
   * (`SERVICE_HISTORY_STATE_FROM_MAP`) quando il chiamante non li conosce.
   */
  fields?:  { health?: string; previousHealth?: string; impactScore?: string; cause?: string }
  /** Applica il cap dopo la voce (default true; false quando un altro frammento nello stesso statement lo fa). */
  cap?:     boolean
  /** Condizione del cap (default = `when`): utile quando lo statement scrive più voci e il cap deve girare se ALMENO una è stata scritta. */
  capWhen?: string
}

/**
 * Frammento Cypher che scrive UNA voce agganciata a `m` (già in scope) e
 * applica il cap, da accodare a uno statement che ha appena scritto lo stato:
 *
 *   FOREACH (… CASE WHEN <when> …) | CREATE (m)-[:HAS_HEALTH_HISTORY]->(:ServiceHealthEntry {…})
 *   WITH *
 *   CALL { … cancella le voci oltre SERVICE_HISTORY_MAX, dalla più vecchia, mai la `created` }
 *
 * Richiede `$tenantId` nei parametri. Tutte le variabili in scope restano
 * disponibili dopo il frammento (`WITH *`).
 */
export function serviceHistoryWriteCypher(opts: ServiceHistoryWriteOptions = {}): string {
  const p = opts.prefix ?? SERVICE_HISTORY_DEFAULT_PREFIX
  const when = opts.when ?? 'true'
  const capWhen = opts.capWhen ?? when
  const imports = ['m', ...(opts.imports ?? [])].join(', ')
  const health         = opts.fields?.health ?? `$${p}Health`
  const previousHealth = opts.fields?.previousHealth ?? `$${p}PreviousHealth`
  const impactScore    = opts.fields?.impactScore ?? `$${p}ImpactScore`
  const cause          = opts.fields?.cause ?? `$${p}Cause`
  const lines = [
    `FOREACH (_ IN CASE WHEN ${when} THEN [1] ELSE [] END |`,
    `  CREATE (m)-[:HAS_HEALTH_HISTORY]->(:ServiceHealthEntry {id: $${p}Id, tenant_id: $tenantId, map_id: m.id, at: $${p}At, health: ${health}, previous_health: ${previousHealth},`,
    `    impact_score: toInteger(${impactScore}), cause: ${cause}, trigger: $${p}Trigger, note: $${p}Note})`,
    `)`,
    `WITH *`,
  ]
  if (opts.cap ?? true) {
    lines.push(
      `CALL {`,
      `  WITH ${imports}`,
      `  UNWIND CASE WHEN ${capWhen} THEN [1] ELSE [] END AS _`,
      `  MATCH (m)-[:HAS_HEALTH_HISTORY]->(old:ServiceHealthEntry {tenant_id: $tenantId})`,
      `  WHERE old.trigger <> 'created'`,
      `  WITH old ORDER BY old.at DESC, old.id DESC`,
      `  SKIP ${SERVICE_HISTORY_MAX - 1}`,
      `  DETACH DELETE old`,
      `}`,
    )
  }
  return lines.join('\n      ')
}

/**
 * Campi di stato letti dalla mappa NEL Cypher, per le voci di
 * configurazione (`rules_changed`, `map_changed` dell'ondata 2): la voce
 * fotografa la salute com'è al momento della modifica — che il chiamante non
 * conosce senza una lettura in più — e non è una transizione di salute
 * (`previous_health` null). La rivalutazione che segue scrive la sua voce solo
 * se la salute cambia davvero.
 */
export const SERVICE_HISTORY_STATE_FROM_MAP: Required<Pick<NonNullable<ServiceHistoryWriteOptions['fields']>, 'health' | 'previousHealth' | 'impactScore' | 'cause'>> = {
  health:         'm.health',
  previousHealth: 'null',
  impactScore:    'm.impact_score',
  cause:          'm.explanation',
}

/** Parametri di una voce di configurazione: solo id, istante, trigger e nota (il resto viene dal Cypher, `SERVICE_HISTORY_STATE_FROM_MAP`). */
export function serviceConfigHistoryParams(trigger: ServiceHealthTrigger, note: string, now: string, prefix: string = SERVICE_HISTORY_DEFAULT_PREFIX): Record<string, unknown> {
  return {
    [`${prefix}Id`]:      uuidv4(),
    [`${prefix}At`]:      now,
    [`${prefix}Trigger`]: trigger,
    [`${prefix}Note`]:    note,
  }
}

/** Parametri `$<prefisso>*` di una voce (id nuovo a ogni chiamata; `cause` serializzato in JSON). */
export function serviceHistoryParams(entry: ServiceHistoryEntry, now: string, prefix: string = SERVICE_HISTORY_DEFAULT_PREFIX): Record<string, unknown> {
  return {
    [`${prefix}Id`]:             uuidv4(),
    [`${prefix}At`]:             entry.at ?? now,
    [`${prefix}Health`]:         entry.health,
    [`${prefix}PreviousHealth`]: entry.previousHealth,
    [`${prefix}ImpactScore`]:    entry.impactScore,
    [`${prefix}Cause`]:          JSON.stringify(entry.causes),
    [`${prefix}Trigger`]:        entry.trigger,
    [`${prefix}Note`]:           entry.note ?? null,
  }
}
