/**
 * A MOVE THE PIPELINE REFUSED, AS AN ERROR (wave 7 · B1).
 *
 * The pipeline of the transitions (services/ticketTransition.ts) answers with
 * a refusal; a path that has to throw it — a person's mutation, a step of the
 * monitoring — throws this, and the refusal travels with it. Who catches it
 * can tell an answer from a failure: a final refusal does not change by
 * retrying (the ticket already carries the note that says why), an error that
 * may be transient does.
 *
 * A module of its own, with no dependencies: the paths that catch it load
 * the pipeline lazily, and their tests replace it.
 */
import { GraphQLError } from 'graphql'
import type { TransitionRefusal } from '../services/ticketTransition.js'

export class TransitionRefusedError extends GraphQLError {
  readonly refusal: TransitionRefusal

  /** The error a person sees for the refusal; `message` replaces its sentence for a log or a job. */
  constructor(refusal: TransitionRefusal, message: string = refusal.message) {
    super(message, {
      extensions: { code: refusal.code, ...(refusal.extensions ?? {}), ...(refusal.i18n ? { i18n: refusal.i18n } : {}) },
    })
    this.refusal = refusal
  }
}

/** A refusal that retrying does not change: the path stops without a retry. */
export function isFinalRefusal(err: unknown): err is TransitionRefusedError {
  return err instanceof TransitionRefusedError && err.refusal.final
}
