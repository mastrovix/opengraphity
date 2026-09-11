/**
 * Profili di processo (revisione 2 · D1.1): LA tabella «profilo → cosa parte»,
 * letta sia da index.ts (processo API) sia da worker.ts (processo worker).
 *
 * Fino alla revisione 2 tutti i worker BullMQ e i consumer di dominio
 * giravano nel processo HTTP — ~70 slot di job sopra un pool Neo4j da 50
 * condiviso con i resolver — e l'unico precedente di estrazione era
 * EMBEDDING_WORKER_EXTERNAL, cablato per un solo worker. Qui la regola è una
 * sola e vale per gruppi di lavoro:
 *
 *   WORKER_PROFILE   processo API (index.ts)          processo worker (worker.ts)
 *   ─────────────────────────────────────────────────────────────────────────
 *   all (default)    ITSM + events                    embedding
 *   api              ITSM                             — (non valido per worker.ts)
 *   events           — (non valido per index.ts)      events
 *
 * `events` = i quattro worker dell'Event Management / Servizi monitorati
 * (`events-ingest`, `events-correlate`, `events-maintenance`,
 * `services-impact`) più il consumer `service-impact-consumer`.
 * `embedding` = il worker `embeddings` (ONNX, CPU-bound), che nel processo API
 * resta governato da EMBEDDING_WORKER_EXTERNAL come prima: nel processo worker
 * gira con il profilo `all` (il servizio compose `worker`), NON con `events`
 * (il servizio `events-worker`): due container che caricano il modello sono
 * memoria buttata, e il lavoro degli allarmi non deve aspettare l'inferenza.
 * Il lavoro ITSM (workflow, notifiche, SLA, webhook in uscita, report,
 * discovery, backup) resta sempre nell'API: non ha un profilo suo (ancora).
 *
 * Un profilo non ammesso per il processo è un errore di configurazione
 * all'avvio (fail-fast), mai un default: `WORKER_PROFILE=api` su worker.ts
 * vorrebbe dire «non fare nulla», `events` su index.ts «l'API è il worker».
 */

export const WORKER_PROFILES = ['all', 'api', 'events'] as const
export type WorkerProfile = (typeof WORKER_PROFILES)[number]

export const PROCESS_KINDS = ['api', 'worker'] as const
export type ProcessKind = (typeof PROCESS_KINDS)[number]

export const WORK_GROUPS = ['events', 'embedding'] as const
export type WorkGroup = (typeof WORK_GROUPS)[number]

/** Le unità del gruppo `events`: nomi delle code (e del consumer) che il gruppo avvia. */
export const EVENT_WORK_UNITS = ['events-ingest', 'events-correlate', 'events-maintenance', 'services-impact', 'service-impact-consumer'] as const

/** La tabella: per ogni profilo, i gruppi che ogni processo avvia. `null` = profilo non ammesso per quel processo. */
export const PROFILE_TABLE: Readonly<Record<WorkerProfile, Readonly<Record<ProcessKind, readonly WorkGroup[] | null>>>> = {
  all:    { api: ['events'], worker: ['embedding'] },
  api:    { api: [],         worker: null },
  events: { api: null,       worker: ['events'] },
}

/** Profili ammessi per un processo (derivati dalla tabella, non duplicati a mano). */
export function allowedProfiles(process: ProcessKind): readonly WorkerProfile[] {
  return WORKER_PROFILES.filter((p) => PROFILE_TABLE[p][process] !== null)
}

/**
 * I gruppi di lavoro che `process` avvia con `profile`. Lancia se il profilo
 * non è ammesso per quel processo, con l'elenco di quelli validi.
 */
export function workGroupsFor(process: ProcessKind, profile: WorkerProfile): readonly WorkGroup[] {
  const groups = PROFILE_TABLE[profile][process]
  if (groups === null) {
    throw new Error(`WORKER_PROFILE=${profile} is not valid for the ${process} process (allowed: ${allowedProfiles(process).join(', ')})`)
  }
  return groups
}

/** True se `process` con `profile` avvia il gruppo `group`. Stessa validazione di `workGroupsFor`. */
export function runsWorkGroup(process: ProcessKind, profile: WorkerProfile, group: WorkGroup): boolean {
  return workGroupsFor(process, profile).includes(group)
}
