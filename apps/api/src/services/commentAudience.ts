/**
 * Who hears of a comment (wave 7 · C1), whichever door it came in by: the
 * detail of a ticket, the generic comments, the REST API. Apart from the
 * helpers it calls, so a test pins the audience with the helpers faked.
 */
import type { GraphQLContext } from '../context.js'
import { parseMentions } from '../lib/mentionParser.js'
import { autoWatch, getEntityTitle, notifyMentions, notifyWatchers } from './collaboration.js'

/** Who wrote the comment: a person, or an API key standing for one. */
export type CommentAuthor = Pick<GraphQLContext, 'tenantId' | 'userId' | 'userEmail'>

/**
 * Chi deve sapere di un commento: chi lo scrive diventa osservatore, i
 * menzionati ricevono la menzione, gli osservatori l'aggiornamento. Una
 * funzione per tutte le porte da cui si commenta (CO-3: il dettaglio di
 * incident e problem non notificava nessuno).
 */
export async function notifyCommentAudience(ctx: CommentAuthor, entityType: string, entityId: string, body: string, isInternal = false): Promise<void> {
  await autoWatch(ctx.tenantId, ctx.userId, entityId)
  const mentions = parseMentions(body)
  // Il titolo del ticket nella menzione: prima si passava l'id, e la frase diceva «in incident "3f2a…"».
  if (mentions.length > 0) await notifyMentions(ctx.tenantId, ctx.userEmail, entityType, entityId, await getEntityTitle(ctx.tenantId, entityId), mentions, 'comment', body.slice(0, 200))
  // `isInternal`: una nota interna non si annuncia a chi non può leggerla —
  // l'utente del portale che ha aperto il ticket è osservatore (revisione
  // totale · M-16).
  await notifyWatchers(ctx.tenantId, entityType, entityId, { kind: 'comment', author: ctx.userEmail }, ctx.userId, isInternal)
}
