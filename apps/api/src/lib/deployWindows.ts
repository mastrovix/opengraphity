/**
 * Finestre del piano di rilascio di una change (DeployPlanTask.steps, JSON).
 *
 * Ogni passo del piano porta una `validationWindow` e una `releaseWindow`
 * `{ start, end }` (ISO). Qui vivono il parser (usato dal mapper GraphQL del
 * piano) e il predicato "un istante cade in una finestra", usato dalla
 * soppressione degli allarmi (services/eventCorrelation.ts): una change
 * pianificata silenzia gli eventi dei suoi CI solo dentro una finestra.
 *
 * Puro, senza fallback silenziosi: un JSON corrotto è un errore (prima
 * presentava una change "senza piano" mentre ne aveva uno rotto); una
 * finestra con date non parsabili o vuote non contiene nessun istante.
 *
 * Fusi orari (revisione 1.17): ogni data di una finestra deve avere l'offset
 * esplicito (`Z` o `±hh:mm`). Il web salva in UTC con `Z`; un piano scritto
 * via API/importazione come `2026-09-09T22:00` verrebbe interpretato da
 * `Date.parse` nel fuso del server API — non in quello del tenant — e la
 * finestra silenzierebbe gli allarmi nell'ora sbagliata. Qui il parser la
 * rifiuta (ValidationError) invece di indovinare.
 */
import { ValidationError } from './errors.js'

export interface DeployWindow { start: string; end: string }
export interface DeployStep   { title: string; validationWindow: DeployWindow; releaseWindow: DeployWindow }

type RawWindow = { start?: unknown; end?: unknown }
type RawStep   = { title?: unknown; validationWindow?: RawWindow; releaseWindow?: RawWindow }

/** `Z` oppure `±hh:mm` / `±hhmm` in coda alla stringa. */
const EXPLICIT_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * Data di una finestra: vuota (finestra non impostata) oppure ISO 8601
 * parsabile CON offset esplicito; altrimenti ValidationError con il campo.
 * Da usare anche da chi scrive il piano (saveDeployPlan), così un piano senza
 * fuso non entra mai nel grafo.
 */
export function assertWindowDate(value: unknown, field: string): string {
  const s = String(value ?? '')
  if (s === '') return s
  if (Number.isNaN(Date.parse(s))) throw new ValidationError(`${field} is not an ISO 8601 date: ${JSON.stringify(s)}`)
  if (!EXPLICIT_OFFSET_RE.test(s)) throw new ValidationError(`${field} must carry an explicit UTC offset ("Z" or "±hh:mm"), got ${JSON.stringify(s)}: a local time would be read in the API server's timezone, not the tenant's`)
  return s
}

export function parseDeploySteps(v: unknown): DeployStep[] {
  if (typeof v !== 'string' || v.length === 0) return []
  let arr: unknown
  try {
    arr = JSON.parse(v)
  } catch (e) {
    throw new Error(`Corrupt deploy steps JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!Array.isArray(arr)) throw new Error(`Deploy steps payload is not an array (got ${typeof arr})`)
  return (arr as RawStep[])
    .filter((s): s is RawStep => typeof s === 'object' && s !== null)
    .map((s, i) => ({
      title: String(s.title ?? ''),
      validationWindow: {
        start: assertWindowDate(s.validationWindow?.start, `steps[${i}].validationWindow.start`),
        end:   assertWindowDate(s.validationWindow?.end,   `steps[${i}].validationWindow.end`),
      },
      releaseWindow: {
        start: assertWindowDate(s.releaseWindow?.start, `steps[${i}].releaseWindow.start`),
        end:   assertWindowDate(s.releaseWindow?.end,   `steps[${i}].releaseWindow.end`),
      },
    }))
}

/** `start <= at <= end`; finestra vuota o con date non valide → false. */
export function windowContains(w: DeployWindow, atMs: number): boolean {
  if (!w.start || !w.end) return false
  const start = Date.parse(w.start)
  const end   = Date.parse(w.end)
  if (Number.isNaN(start) || Number.isNaN(end)) return false
  return start <= atMs && atMs <= end
}

/**
 * True se almeno un passo di almeno un piano ha una releaseWindow o una
 * validationWindow che contiene l'istante. `plans` = i JSON grezzi dei
 * DeployPlanTask della change (uno per CI); i null (nessun piano) si ignorano.
 */
export function anyDeployWindowContains(plans: readonly unknown[], atMs: number): boolean {
  for (const raw of plans) {
    if (raw == null) continue
    for (const step of parseDeploySteps(raw)) {
      if (windowContains(step.releaseWindow, atMs) || windowContains(step.validationWindow, atMs)) return true
    }
  }
  return false
}
