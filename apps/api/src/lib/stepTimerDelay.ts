/**
 * THE DELAY OF A TIMED WAIT (review of 23 Sep 2026).
 *
 * A `timer_wait` step moves the ticket on after its delay. It was accepted
 * with no delay, or with zero or less: the engine logged «no valid
 * timer_delay_minutes» and the ticket stayed on the step for ever — and no
 * mutation could set the delay afterwards, while a ticket sitting there also
 * made the step impossible to delete. The delay is now required on creation
 * and editable from the step panel, with this one check.
 */
import { ValidationError } from './errors.js'

export function assertTimerDelayMinutes(value: unknown, where: string): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (value == null || value === '' || !Number.isInteger(n) || n <= 0) {
    throw new ValidationError(
      `${where}: a timed wait needs its delay, a whole number of minutes greater than zero (got ${JSON.stringify(value ?? null)})`,
      { key: 'errors.workflow.timerDelayRequired', params: { where } },
    )
  }
  return n
}
