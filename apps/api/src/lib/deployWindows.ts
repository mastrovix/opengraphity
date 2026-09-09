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
 */

export interface DeployWindow { start: string; end: string }
export interface DeployStep   { title: string; validationWindow: DeployWindow; releaseWindow: DeployWindow }

type RawWindow = { start?: unknown; end?: unknown }
type RawStep   = { title?: unknown; validationWindow?: RawWindow; releaseWindow?: RawWindow }

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
    .map((s) => ({
      title: String(s.title ?? ''),
      validationWindow: {
        start: String(s.validationWindow?.start ?? ''),
        end:   String(s.validationWindow?.end   ?? ''),
      },
      releaseWindow: {
        start: String(s.releaseWindow?.start ?? ''),
        end:   String(s.releaseWindow?.end   ?? ''),
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
