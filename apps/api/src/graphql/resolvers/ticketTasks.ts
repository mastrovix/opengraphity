/**
 * I COMPITI DI UN TICKET, letti e chiusi (20 set 2026).
 *
 * ## Il permesso segue il TICKET, non il compito
 * Un compito non ha un permesso suo: chi può leggere un incident può leggere
 * i suoi compiti, chi lo può scrivere li può chiudere. Dichiararne uno nuovo
 * («task.read») vorrebbe dire che un giorno qualcuno lo darebbe a chi non
 * può aprire il ticket, e leggerebbe dai titoli dei compiti quello che il
 * ticket non gli mostra.
 *
 * La regola statica in `operationPermissions.ts` è l'UNIONE dei quattro
 * permessi di lettura (il guardiano dell'autorizzazione pretende una regola
 * per ogni campo dello schema, e il tipo si sa solo a runtime); qui si fa il
 * controllo preciso, sul tipo del ticket che il compito ha davvero.
 */
import { requirePermission } from '../../lib/permissions.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { getSession } from '@opengraphity/neo4j'
import { runQueryOne } from './ci-utils.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import {
  compitiDelTicket, compito, apriDipendenti, TASK_STATE, isOpenState, isPendingState,
  type TicketTask,
} from '../../lib/ticketTasks.js'
import type { GraphQLContext } from '../../context.js'
import type { Permission } from '@opengraphity/types'

/**
 * Il permesso che serve per un ticket di questo tipo. Un tipo che non è qui
 * non si indovina: si dice, invece di lasciar passare.
 */
const PERMESSO_LETTURA: Readonly<Record<string, Permission>> = {
  incident:        'incident.read',
  problem:         'problem.read',
  change:          'change.read',
  service_request: 'request.read',
  kb_article:      'kb.read',
}

const PERMESSO_SCRITTURA: Readonly<Record<string, Permission>> = {
  incident:        'incident.write',
  problem:         'problem.write',
  change:          'change.write',
  service_request: 'request.write',
  kb_article:      'kb.write',
}

function permessoDi(mappa: Readonly<Record<string, Permission>>, entityType: string, cosa: string): Permission {
  const p = mappa[entityType]
  if (!p) throw new ValidationError(`Tasks: no ${cosa} permission is declared for entity type "${entityType}"`)
  return p
}

/** Il tipo del ticket a cui il compito è appeso, letto dal compito stesso. */
async function tipoDelTicket(tenantId: string, entityId: string): Promise<string> {
  const session = getSession(undefined, 'READ')
  try {
    const riga = await runQueryOne<{ entityType: string | null }>(session, `
      MATCH (ticket {id: $entityId, tenant_id: $tenantId})-[:HAS_TASK]->(k:Task {tenant_id: $tenantId})
      RETURN k.entity_type AS entityType
      LIMIT 1
    `, { entityId, tenantId })
    return riga?.entityType ?? ''
  } finally {
    await session.close()
  }
}

export async function ticketTasks(
  _: unknown,
  args: { entityId: string },
  ctx: GraphQLContext,
): Promise<TicketTask[]> {
  /**
   * Senza compiti non c'è niente da proteggere e niente da mostrare: la
   * lista vuota non dice nulla su un ticket che chi chiede non può vedere.
   * Con dei compiti, il permesso è quello del loro tipo.
   */
  const entityType = await tipoDelTicket(ctx.tenantId, args.entityId)
  if (!entityType) return []
  requirePermission(ctx, permessoDi(PERMESSO_LETTURA, entityType, 'read'))
  return compitiDelTicket(ctx.tenantId, args.entityId)
}

/** Carica il compito e verifica che chi chiama possa scrivere il suo ticket. */
async function compitoScrivibile(ctx: GraphQLContext, taskId: string): Promise<TicketTask> {
  const trovato = await compito(ctx.tenantId, taskId)
  if (!trovato) throw new NotFoundError('Task', taskId)
  requirePermission(ctx, permessoDi(PERMESSO_SCRITTURA, trovato.entityType, 'write'))
  return trovato
}

/**
 * «LO PRENDO IO»: il compito prende un nome, restando della squadra.
 *
 * Non serve essere della squadra per prenderlo — chi può scrivere il ticket
 * può farsene carico, e capita che lo faccia chi sta già lavorando il
 * ticket. Serve invece che sia APERTO: prendersi un compito in attesa
 * significa metterci sopra un nome e poi non poterlo fare.
 */
export async function claimTicketTask(
  _: unknown,
  args: { taskId: string },
  ctx: GraphQLContext,
): Promise<TicketTask> {
  const prima = await compitoScrivibile(ctx, args.taskId)
  if (!isOpenState(prima.state)) {
    throw new ValidationError(
      `Task ${prima.code} is not open any more (${prima.state}): reload the page.`,
      { key: 'errors.task.notOpen', params: { code: prima.code, state: prima.state } },
    )
  }
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite((tx) => tx.run(`
      MATCH (k:Task {id: $taskId, tenant_id: $tenantId})
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      OPTIONAL MATCH (k)-[vecchio:ASSIGNED_TO]->(:User)
      DELETE vecchio
      WITH DISTINCT k, u
      MERGE (k)-[:ASSIGNED_TO]->(u)
    `, { taskId: args.taskId, tenantId: ctx.tenantId, userId: ctx.userId }))
  } finally {
    await session.close()
  }
  void audit(ctx, 'task.claimed', 'Task', args.taskId, { code: prima.code, entityId: prima.entityId })
  return (await compito(ctx.tenantId, args.taskId))!
}

/**
 * FAR RIPARTIRE IL TICKET quando l'ultimo compito si chiude (rimedio, 20 set
 * 2026).
 *
 * «Il passo aspetta» non serve a niente se, chiuso l'ultimo compito, nessuno
 * riprova la transizione. Tutte e cinque le mutation dei compiti di change
 * chiamano `evaluateAutoTransitions`; le due nuove non lo facevano, quindi
 * un arco automatico guardato da `all_tasks_complete` non scattava mai al
 * momento giusto: si vedeva «Fatto» dappertutto e la change ferma.
 *
 * Solo per le CHANGE, perché il camminatore delle auto-transizioni è loro
 * (`change/autoTransitions.ts`): per incident, problem e richieste il
 * prodotto non ne ha uno, e fingere il contrario sarebbe peggio che dirlo.
 * Un fallimento qui non annulla la chiusura del compito, che è già scritta e
 * giusta: si logga.
 */
async function riprovaLeTransizioniAutomatiche(ctx: GraphQLContext, task: TicketTask): Promise<void> {
  if (task.entityType !== 'change') return
  try {
    const { evaluateAutoTransitions } = await import('./change/autoTransitions.js')
    const session = getSession(undefined, 'WRITE')
    try { await evaluateAutoTransitions(session, task.entityId, ctx) }
    finally { await session.close() }
  } catch (err) {
    logger.error({ err, taskId: task.id, changeId: task.entityId, tenantId: ctx.tenantId },
      '[tasks] the task was closed but the change did not re-evaluate its automatic transitions')
  }
}

export async function completeTicketTask(
  _: unknown,
  args: { taskId: string; note?: string | null },
  ctx: GraphQLContext,
): Promise<TicketTask> {
  const prima = await compitoScrivibile(ctx, args.taskId)
  // Richiudere un compito già chiuso non è un no-op silenzioso: chi lo fa sta
  // guardando una pagina vecchia, e deve saperlo.
  // Chiudere un compito ancora IN ATTESA non si può: il suo turno non è
  // arrivato, e dire «fatto» su un lavoro che non poteva partire è una
  // bugia nel registro.
  if (!isOpenState(prima.state)) {
    throw new ValidationError(
      `Task ${prima.code} is not open any more (${prima.state}): reload the page.`,
      { key: 'errors.task.notOpen', params: { code: prima.code, state: prima.state } },
    )
  }
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite((tx) => tx.run(`
      MATCH (k:Task {id: $taskId, tenant_id: $tenantId})
      SET k.state        = $completed,
          k.completed_at = $now,
          k.completed_by = $userId,
          k.completion_note = $note
    `, {
      taskId: args.taskId, tenantId: ctx.tenantId, completed: TASK_STATE.COMPLETED,
      now: new Date().toISOString(), userId: ctx.userId, note: args.note?.trim() || null,
    }))
    // Chi aspettava questo compito parte adesso.
    await session.executeWrite((tx) => apriDipendenti(tx, ctx.tenantId, args.taskId))
  } finally {
    await session.close()
  }
  await riprovaLeTransizioniAutomatiche(ctx, prima)
  void audit(ctx, 'task.completed', 'Task', args.taskId, { code: prima.code, entityId: prima.entityId })
  return (await compito(ctx.tenantId, args.taskId))!
}

export async function cancelTicketTask(
  _: unknown,
  args: { taskId: string; reason: string },
  ctx: GraphQLContext,
): Promise<TicketTask> {
  const prima = await compitoScrivibile(ctx, args.taskId)
  // Si annulla anche un compito IN ATTESA: «non serve più» si sa spesso
  // prima che il suo turno arrivi.
  if (!isPendingState(prima.state)) {
    throw new ValidationError(
      `Task ${prima.code} is not open any more (${prima.state}): reload the page.`,
      { key: 'errors.task.notOpen', params: { code: prima.code, state: prima.state } },
    )
  }
  // Il motivo è obbligatorio: un compito sparito senza spiegazione lascia chi
  // lo aspettava a chiedersi se il lavoro è stato fatto o dimenticato.
  const motivo = args.reason.trim()
  if (!motivo) {
    throw new ValidationError(
      'Cancelling a task needs a reason: whoever was waiting for it must know why it is gone.',
      { key: 'errors.task.cancelNeedsReason' },
    )
  }
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite((tx) => tx.run(`
      MATCH (k:Task {id: $taskId, tenant_id: $tenantId})
      SET k.state         = $cancelled,
          k.completed_at  = $now,
          k.completed_by  = $userId,
          k.cancel_reason = $reason
    `, {
      taskId: args.taskId, tenantId: ctx.tenantId, cancelled: TASK_STATE.CANCELLED,
      now: new Date().toISOString(), userId: ctx.userId, reason: motivo,
    }))
    /**
     * ANCHE annullando si apre chi aspettava. È la conseguenza dall'altro
     * lato, quella che si dimentica: senza, un compito annullato lascerebbe
     * il seguito fermo per sempre, e con lui il passo — che la guardia tiene
     * chiuso finché c'è qualcosa in attesa.
     */
    await session.executeWrite((tx) => apriDipendenti(tx, ctx.tenantId, args.taskId))
  } finally {
    await session.close()
  }
  // Anche annullando: un compito annullato non conta più per la guardia,
  // quindi può essere lui l'ultimo che teneva fermo il passo.
  await riprovaLeTransizioniAutomatiche(ctx, prima)
  void audit(ctx, 'task.cancelled', 'Task', args.taskId, { code: prima.code, entityId: prima.entityId, reason: motivo })
  return (await compito(ctx.tenantId, args.taskId))!
}
