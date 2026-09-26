/**
 * WHEN A WAIT IS OVER (26 Sep 2026).
 *
 * A `timer_wait` step is left by its timer job (`jobs/workflowJobWorker.ts`,
 * case `timer_wait`), which follows the step's exit once the delay has passed.
 * Nothing else may take a ticket out of a wait early: the arcs out of it are
 * `automatic` or `timer`, and a pass that follows automatic arcs without
 * looking at the step would cut every wait short — the change walker and the
 * change resume pass both did, latent only because no workflow had a wait yet.
 *
 * What another pass MAY do is finish a wait whose timer job was lost: the
 * delay is over, plus a grace for a queue that is merely slow. This is the one
 * rule for that, shared by the change resume pass (`changesStuck.ts`) and the
 * operational remedy of the other tickets (`operationsGraphRemedies.ts`).
 */

/** The step type of a wait. */
export const TIMER_WAIT_STEP = 'timer_wait'

/** How long after the end of a wait its timer job counts as lost. */
export const TIMER_GRACE_MINUTES = 15

/**
 * Whether the wait entered at `since` (the instance's last move) with a delay
 * of `delayMinutes` is over by more than the grace — i.e. its timer was lost.
 * A wait with no valid delay is never «over»: the engine reports that step as
 * misconfigured, and guessing a delay here would move tickets on a guess.
 */
export function waitTimerLost(since: string | null | undefined, delayMinutes: unknown, now: Date): boolean {
  const entered = since ? Date.parse(since) : Number.NaN
  const delay = Number(delayMinutes)
  if (Number.isNaN(entered) || !(delay > 0)) return false
  return entered + (delay + TIMER_GRACE_MINUTES) * 60_000 <= now.getTime()
}
