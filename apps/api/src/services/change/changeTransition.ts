/**
 * MOVING A CHANGE BY HAND (wave 7 · C1): what the change's own button does,
 * for the GraphQL mutation (executeChangeTransition, which then reads the
 * change back for the page) and for the REST API (POST /api/v1/changes/:id/
 * transition, which used to call that resolver).
 */
import type { Session } from 'neo4j-driver'
import type { GraphQLContext } from '../../context.js'
import { personActor, refusalError, transitionTicket } from '../ticketTransition.js'
import { evaluateAutoTransitions } from './autoTransitions.js'
import { afterEnterStep, loadChangeWorkflow, writeAudit } from './helpers.js'

export interface ChangeTransitionArgs {
  changeId: string
  toStep:   string
  notes?:   string | null
}

/**
 * Moves the change of `ctx`'s tenant to `toStep`, as the person of `ctx`, and
 * runs what follows the entry: the phase's tasks, the Audit Log line, the
 * automatic transitions. A refusal is thrown as the person's error. Returns
 * the errors of the step's actions, which never undo the move.
 */
export async function transitionChange(session: Session, ctx: GraphQLContext, args: ChangeTransitionArgs): Promise<{ actionErrors: string[] }> {
  // Una sola lettura coerente: change non eliminata + istanza + step corrente
  // (dalla relazione CURRENT_STEP, verificata contro wi.current_step).
  const { instanceId } = await loadChangeWorkflow(session, args.changeId, ctx.tenantId)

  // The pipeline of the transitions (wave 7 · B1) checks, in its order, the
  // write permission, IL VARCO DELLA FINESTRA DI RILASCIO (terza revisione *
  // C1: the manual gate, whose sentences name the two ways out), the
  // required fields of the step being entered (ondata 8 · B-21: the notes
  // count as a value) and its metadata — the same guards as every other
  // path, which is what the gate's own comment used to promise.
  //
  // Il rollback non è più un campo del change: è valutato (con punteggio)
  // nell'assessment tecnico ("Is a tested rollback plan available?"), che si
  // completa prima del deploy. Nessun gate sul testo qui.
  const outcome = await transitionTicket(session, {
    tenantId: ctx.tenantId, instanceId, toStep: args.toStep, notes: args.notes ?? null,
    actor: personActor(ctx), triggerType: 'manual',
  })
  if (!outcome.moved) throw refusalError(outcome.refusal)

  await afterEnterStep(session, args.changeId, ctx.tenantId, args.toStep)
  // Azione STABILE, passo nei dettagli (D-22, applicato a incident e problem
  // e non alle change: `change_transition_<passo>` metteva il nome del passo
  // nell'identità dell'azione, e una rinomina spezzava in due la storia dei
  // filtri della timeline — revisione totale · B-19). Le voci storiche NON
  // si riscrivono: il web sa ancora leggere il vecchio prefisso.
  const notes = args.notes?.trim()
  await writeAudit(session, args.changeId, ctx.tenantId,
    'change_step_entered', ctx.userId,
    notes ? `${args.toStep}: ${notes}` : args.toStep,
    // `notes` porta già i due punti quando c'è: è punteggiatura, non lingua,
    // e la frase resta una sola chiave per entrambi i casi.
    { key: 'stepEntered', params: { step: args.toStep, notes: notes ? `: ${notes}` : '' } })

  await evaluateAutoTransitions(session, args.changeId, ctx, afterEnterStep)
  return { actionErrors: outcome.actionErrors }
}
