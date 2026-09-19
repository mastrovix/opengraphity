/**
 * I COMPITI DI UN TICKET (20 set 2026, decisione del proprietario).
 *
 * ## Cosa risolve
 * Una richiesta di servizio approvata deve poter far partire del lavoro vero,
 * assegnato a squadre diverse: «Nuovo portatile» → il Desk prepara la
 * macchina, i Sistemi creano l'utenza. Prima si poteva assegnare la richiesta
 * a UNA persona e basta, e chi la prendeva in carico doveva ricordarsi tutto
 * e rincorrere gli altri per conto suo.
 *
 * I compiti esistevano già, ma **solo per le change** e in cinque varianti
 * scritte a mano (`change/taskKinds.ts`): assessment, piano, validazione,
 * deploy, review. Questo è il compito GENERICO, appeso a qualunque ticket.
 *
 * ## La regola d'integrità
 * `entity_type` di un compito DEVE coincidere col tipo del ticket a cui è
 * appeso: un compito di tipo incident su una change è un dato rotto — per
 * «I miei compiti», per la guardia che conterà i compiti aperti di un passo,
 * per i report e per chiunque legga il grafo dopo. Si difende in tre punti:
 *
 *  1. **Mentre si disegna**: l'azione `create_task` non ha un parametro
 *     «tipo». Lo eredita da `instance.entityType`, cioè dalla definizione di
 *     workflow che contiene il passo. Non è esprimibile una combinazione
 *     sbagliata.
 *  2. **Mentre si scrive**: qui. La query pretende che l'etichetta Neo4j del
 *     ticket sia quella del tipo dichiarato (`MATCH … WHERE $etichetta IN
 *     labels(e)`); se non lo è non scrive niente e si grida, invece di
 *     appendere un compito «quasi giusto».
 *  3. **Dopo, per sempre**: un rilievo in Diagnostica cerca i compiti il cui
 *     tipo non corrisponde al ticket. Deve essere sempre zero.
 *
 * E non esiste nessuna mutation che cambi il tipo dopo: un compito nato
 * sbagliato si annulla e se ne fa un altro. Un campo modificabile sarebbe la
 * quarta strada per rompere la regola, dopo averne chiuse tre.
 *
 * ## Perché la numerazione è quella dei compiti di change
 * Stessa sequenza `task`, stesso prefisso `TASK`: per chi lavora sono la
 * stessa cosa — qualcosa da fare con un numero — e due contatori darebbero
 * due «TASK00000007» diversi nello stesso cliente.
 */
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import { ENTITY_NEO4J_LABELS } from '@opengraphity/types'
import type { TaskToCreate } from '@opengraphity/workflow'
import { runQuery, runQueryOne } from '../graphql/resolvers/ci-utils.js'
import { nextSequenceBlock, type SessionOrTx } from './sequence.js'
import { firstTeamCypher, TEAM_NOW_PARAM } from './ticketTeamHistory.js'
import { logger } from './logger.js'

/** Gli stati di un compito. Non è un vocabolario del cliente: è il suo ciclo di vita. */
export const TASK_STATE = {
  /** Aspetta che un altro compito dello stesso passo sia chiuso. */
  WAITING:   'waiting',
  OPEN:      'open',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const

export type TaskState = (typeof TASK_STATE)[keyof typeof TASK_STATE]

/** Un compito aperto è l'unico che chiede qualcosa a qualcuno ORA. */
export function isOpenState(state: string): boolean {
  return state === TASK_STATE.OPEN
}

/**
 * Un compito ancora DA FARE: aperto, o in attesa del suo turno. Sono questi
 * che tengono fermo il passo — un compito in attesa è lavoro non fatto, non
 * lavoro che non c'è.
 */
export function isPendingState(state: string): boolean {
  return state === TASK_STATE.OPEN || state === TASK_STATE.WAITING
}

export interface TicketTask {
  id:          string
  code:        string
  title:       string
  description: string | null
  state:       string
  /** Il titolo del compito che sta aspettando, se è in attesa. */
  afterTitle:  string | null
  entityType:  string
  entityId:    string
  stepName:    string
  dueAt:       string | null
  teamId:      string | null
  teamName:    string | null
  assigneeId:   string | null
  assigneeName: string | null
  createdAt:   string
  completedAt: string | null
  completedById: string | null
  cancelReason: string | null
}

const RITORNO_COMPITO = `
  k.id AS id, k.code AS code, k.title AS title, k.description AS description,
  k.state AS state, k.after_title AS afterTitle, k.entity_type AS entityType, k.step_name AS stepName,
  k.due_at AS dueAt, k.created_at AS createdAt,
  k.completed_at AS completedAt, k.completed_by AS completedById,
  k.cancel_reason AS cancelReason,
  team.id AS teamId, team.name AS teamName,
  assignee.id AS assigneeId, assignee.name AS assigneeName,
  ticket.id AS entityId
`

/** Le corrispondenze del `RETURN` qui sopra, in un posto solo. */
function mapCompito(r: Record<string, unknown>): TicketTask {
  return {
    id:            r['id']            as string,
    code:          r['code']          as string,
    title:         r['title']         as string,
    description:   (r['description']  as string | null) ?? null,
    state:         r['state']         as string,
    afterTitle:    (r['afterTitle']   as string | null) ?? null,
    entityType:    r['entityType']    as string,
    entityId:      r['entityId']      as string,
    stepName:      r['stepName']      as string,
    dueAt:         (r['dueAt']        as string | null) ?? null,
    teamId:        (r['teamId']       as string | null) ?? null,
    teamName:      (r['teamName']     as string | null) ?? null,
    assigneeId:    (r['assigneeId']   as string | null) ?? null,
    assigneeName:  (r['assigneeName'] as string | null) ?? null,
    createdAt:     r['createdAt']     as string,
    completedAt:   (r['completedAt']  as string | null) ?? null,
    completedById: (r['completedById'] as string | null) ?? null,
    cancelReason:  (r['cancelReason'] as string | null) ?? null,
  }
}

/**
 * L'etichetta Neo4j di un tipo di entità, dall'allowlist che il motore usa
 * già per scrivere lo `status` di un ticket. Non se ne inventa una seconda:
 * un tipo che il motore non sa muovere non è un tipo su cui appendere
 * compiti.
 */
function etichettaDi(entityType: string): string {
  const etichetta = ENTITY_NEO4J_LABELS[entityType]
  if (!etichetta) {
    throw new Error(`Tasks: unknown entity type "${entityType}" — it is not in the product's allowlist (ENTITY_NEO4J_LABELS)`)
  }
  return etichetta
}

/**
 * La CHIAVE NATURALE di un compito: ticket + passo + posizione dell'azione.
 *
 * Un ticket che torna indietro e riavanza ripassa dalle azioni d'ingresso del
 * passo: senza questa chiave si ritroverebbe i compiti in doppio a ogni giro.
 * È l'idioma di `change_key` sugli assessment delle change.
 *
 * Si usa la POSIZIONE dell'azione e non il titolo: il titolo può cambiare
 * (una correzione nel disegnatore, un template che risolve diversamente) e
 * cambiandolo si duplicherebbe il compito su un ticket già in corso.
 */
export function chiaveCompito(entityId: string, stepName: string, actionIndex: number): string {
  return `${entityId}::${stepName}::${String(actionIndex)}`
}

/**
 * Scrive un compito. È la funzione registrata nel motore
 * (`registerTaskCreator`): la chiama l'azione `create_task` di un passo, da
 * qualunque cammino arrivi la transizione.
 *
 * Torna l'id del compito — quello esistente se il passo è stato rifatto.
 */
export async function creaCompito(task: TaskToCreate): Promise<string> {
  const etichetta = etichettaDi(task.entityType)
  const session   = getSession(undefined, 'WRITE')
  try {
    /**
     * LA SQUADRA DAL MODULO (ondata 4). Se il passo dice «prendila dal campo
     * X», la si legge dalla risposta: un campo squadra del modulo è una
     * relazione `FORM_REFERS_TO_TEAM` sul ticket. Vince sulla squadra fissa
     * scelta nel disegnatore — è il dato di QUESTA richiesta contro una
     * scelta fatta una volta per tutte.
     *
     * Se il campo non ha risposta non si ripiega sulla squadra fissa in
     * silenzio: sarebbe un compito che finisce alla squadra sbagliata senza
     * che nessuno lo sappia. Il compito nasce senza destinatario, e la
     * Diagnostica lo dice.
     */
    let squadra = task.teamId
    if (task.teamFromField) {
      const riga = await runQueryOne<{ teamId: string | null }>(session, `
        MATCH (ticket {id: $entityId, tenant_id: $tenantId})-[r:FORM_REFERS_TO_TEAM {field: $campo}]->(team:Team {tenant_id: $tenantId})
        RETURN team.id AS teamId
        LIMIT 1
      `, { entityId: task.entityId, tenantId: task.tenantId, campo: task.teamFromField })
      squadra = riga?.teamId ?? null
      if (!squadra) {
        logger.warn(
          { entityId: task.entityId, campo: task.teamFromField, tenantId: task.tenantId },
          '[tasks] the form field named by the step action has no team in it: the task has no assignee',
        )
      }
    }
    const now       = new Date().toISOString()
    const [codice]  = await nextSequenceBlock(session, task.tenantId, 'task', 1)
      .then((ultimo) => ['TASK' + String(ultimo).padStart(8, '0')])
    const dueAt = task.dueInDays == null
      ? null
      : new Date(Date.now() + task.dueInDays * 86_400_000).toISOString()

    /**
     * LA SECONDA DIFESA sul tipo: `$etichetta IN labels(ticket)`. Se il
     * ticket non è del tipo dichiarato la MATCH non trova niente, non si
     * scrive un bel niente, e sotto si grida — invece di appendere un
     * compito di tipo incident a una change.
     */
    const righe = await runQuery<Record<string, unknown>>(session, `
      MATCH (ticket {id: $entityId, tenant_id: $tenantId})
      WHERE $etichetta IN labels(ticket)
      OPTIONAL MATCH (squadra:Team {id: $teamId, tenant_id: $tenantId})
      MERGE (ticket)-[:HAS_TASK]->(k:Task {tenant_id: $tenantId, task_key: $taskKey})
        ON CREATE SET
          k.id          = $id,
          k.code        = $code,
          k.title       = $title,
          k.description = $description,
          k.state       = $statoIniziale,
          k.after_title = $after,
          k.entity_type = $entityType,
          k.step_name   = $stepName,
          k.due_at      = $dueAt,
          k.created_at  = $now,
          k.created_by  = $createdBy
      WITH ticket, k, squadra
      FOREACH (__squadra IN CASE WHEN squadra IS NULL THEN [] ELSE [squadra] END |
        ${firstTeamCypher('k', '__squadra', `$${TEAM_NOW_PARAM}`)}
      )
      WITH ticket, k
      OPTIONAL MATCH (k)-[:ASSIGNED_TO_TEAM]->(team:Team)
      OPTIONAL MATCH (k)-[:ASSIGNED_TO]->(assignee:User)
      RETURN ${RITORNO_COMPITO}
    `, {
      entityId:   task.entityId,
      tenantId:   task.tenantId,
      etichetta,
      teamId:     squadra,
      taskKey:    chiaveCompito(task.entityId, task.stepName, task.actionIndex),
      id:         uuidv4(),
      code:       codice,
      title:      task.title,
      description: task.description,
      statoIniziale: task.after ? TASK_STATE.WAITING : TASK_STATE.OPEN,
      after:      task.after,
      entityType: task.entityType,
      stepName:   task.stepName,
      dueAt,
      now,
      createdBy:  task.createdBy,
      [TEAM_NOW_PARAM]: now,
    })

    const creato = righe[0]
    if (!creato) {
      throw new Error(
        `create_task: ${task.entityType} "${task.entityId}" not found, or it is not a ${etichetta}: ` +
        'a task can only hang from a ticket of its own type',
      )
    }
    if (!creato['teamId'] && squadra) {
      // La squadra indicata nel disegnatore non esiste più (cancellata dopo
      // aver scritto il workflow): il compito nasce senza destinatario, e lo
      // si dice. Ripiegare su una squadra a caso vorrebbe dire assegnare
      // lavoro a gente che non sa di averlo.
      logger.error(
        { taskId: creato['id'], teamId: task.teamId, tenantId: task.tenantId, entityId: task.entityId },
        '[tasks] the team named by the step action does not exist: the task has no assignee',
      )
    }
    return creato['id'] as string
  } finally {
    await session.close()
  }
}

/**
 * APRE CHI ASPETTAVA questo compito (20 set 2026).
 *
 * Si chiama sia quando un compito è chiuso sia quando è ANNULLATO: un
 * compito annullato non deve lasciare appeso per sempre chi veniva dopo —
 * il lavoro non si fa più, ma il seguito sì. È la conseguenza dall'altro
 * lato di una regola di blocco, quella che si dimentica sempre.
 *
 * Il legame è per TITOLO, dentro lo stesso ticket e lo stesso passo: è quello
 * che il disegnatore sceglie da una tendina dei compiti fratelli, e quello
 * che chi legge la pagina vede scritto.
 *
 * Torna quanti ne ha aperti.
 */
export async function apriDipendenti(
  session: SessionOrTx,
  tenantId: string,
  taskId: string,
): Promise<number> {
  const righe = await runQuery<{ aperti: unknown }>(session, `
    MATCH (fatto:Task {id: $taskId, tenant_id: $tenantId})<-[:HAS_TASK]-(ticket)
    MATCH (ticket)-[:HAS_TASK]->(dopo:Task {tenant_id: $tenantId, state: $attesa})
    WHERE dopo.after_title = fatto.title AND dopo.step_name = fatto.step_name
    SET dopo.state = $aperto
    RETURN count(dopo) AS aperti
  `, { taskId, tenantId, attesa: TASK_STATE.WAITING, aperto: TASK_STATE.OPEN })
  return Number(righe[0]?.aperti ?? 0)
}

/**
 * Quanti compiti di QUESTO passo sono ancora da fare (aperti o in attesa).
 * La guardia `all_tasks_complete` legge questo: i compiti di un altro passo
 * non c'entrano, e gli annullati non contano.
 */
export async function compitiDaFareNelPasso(
  session: SessionOrTx,
  tenantId: string,
  entityId: string,
  stepName: string,
): Promise<number> {
  const righe = await runQuery<{ quanti: unknown }>(session, `
    MATCH (ticket {id: $entityId, tenant_id: $tenantId})-[:HAS_TASK]->(k:Task {tenant_id: $tenantId})
    WHERE k.step_name = $stepName AND k.state IN $daFare
    RETURN count(k) AS quanti
  `, { entityId, tenantId, stepName, daFare: [TASK_STATE.OPEN, TASK_STATE.WAITING] })
  return Number(righe[0]?.quanti ?? 0)
}

/** I compiti di un ticket, dal più recente. */
export async function compitiDelTicket(tenantId: string, entityId: string): Promise<TicketTask[]> {
  const session = getSession(undefined, 'READ')
  try {
    const righe = await runQuery<Record<string, unknown>>(session, `
      MATCH (ticket {id: $entityId, tenant_id: $tenantId})-[:HAS_TASK]->(k:Task {tenant_id: $tenantId})
      OPTIONAL MATCH (k)-[:ASSIGNED_TO_TEAM]->(team:Team)
      OPTIONAL MATCH (k)-[:ASSIGNED_TO]->(assignee:User)
      RETURN ${RITORNO_COMPITO}
      ORDER BY k.created_at ASC, k.code ASC
    `, { entityId, tenantId })
    return righe.map(mapCompito)
  } finally {
    await session.close()
  }
}

/** Un compito, con il ticket a cui è appeso. */
export async function compito(tenantId: string, taskId: string): Promise<TicketTask | null> {
  const session = getSession(undefined, 'READ')
  try {
    const riga = await runQueryOne<Record<string, unknown>>(session, `
      MATCH (ticket)-[:HAS_TASK]->(k:Task {id: $taskId, tenant_id: $tenantId})
      OPTIONAL MATCH (k)-[:ASSIGNED_TO_TEAM]->(team:Team)
      OPTIONAL MATCH (k)-[:ASSIGNED_TO]->(assignee:User)
      RETURN ${RITORNO_COMPITO}
    `, { taskId, tenantId })
    return riga ? mapCompito(riga) : null
  } finally {
    await session.close()
  }
}
