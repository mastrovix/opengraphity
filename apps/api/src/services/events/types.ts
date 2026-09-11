/**
 * Tipi della pipeline di correlazione condivisi fra i moduli di
 * `services/events/` (solo tipi: nessun import a runtime, nessun ciclo).
 */
import type { CorrelationOutcome } from '../../lib/eventVocabularies.js'
import type { Props } from './shared.js'

/** Evento caricato dal grafo con il CI agganciato (RAISED_ON), se c'è. */
export interface EventRecord { props: Props; ciId: string | null }

/** Esiti di `event.correlated` (oltre a quelli scritti sull'evento). */
export type PipelineOutcome = CorrelationOutcome | 'auto_resolved' | 'auto_resolve_skipped'

/**
 * `ingest`     — tutto (soppressione, salute, ritardo, correlazione / chiusura).
 * `reevaluate` — come ingest ma senza ritardo (mutation reevaluateEvent,
 *                linkEventToCI, fine finestra, job periodico).
 * `resume`     — job ritardato: soppressione e salute già fatte, si riparte dal
 *                raggruppamento se l'evento è ancora firing.
 */
export type PipelineMode = 'ingest' | 'reevaluate' | 'resume'

export interface PipelineInput {
  tenantId: string
  eventId:  string
  /** actor_id degli eventi di dominio; default 'monitoring'. */
  actorId?: string
  now?:     string
  mode?:    PipelineMode
  /**
   * Solo in `ingest`: true se questo payload APRE UN CICLO sull'allarme —
   * Event creato, oppure allarme rientrato che torna acceso (`first_seen_at` =
   * istante di questo payload). Alimenta il contatore di tempesta della
   * sorgente. Non lo apre una ripetizione (`repeat_interval`: firing su firing)
   * né il retry `duplicate` dello stesso payload (revisione 2 · B2-03).
   */
  opensCycle?: boolean
  /**
   * Evento già letto dal chiamante (l'ingest lo ha appena scritto e ha le
   * proprietà post-scrittura e il CI): evita la rilettura (M11). Assente →
   * la pipeline lo carica dal grafo.
   */
  record?:  EventRecord
  /** Id del job BullMQ che ha avviato la pipeline: solo per i log (ritrova l'allarme in coda). */
  jobId?:   string
}

export interface PipelineResult {
  outcome:              PipelineOutcome
  /** Stato dell'evento dopo la pipeline. */
  status:               string
  suppressedByChangeId: string | null
  incidentId:           string | null
}
