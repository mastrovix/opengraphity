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
import { ENTITY_NEO4J_LABELS, TICKET_ENTITY_TYPES } from '@opengraphity/types'
import type { TaskToCreate } from '@opengraphity/workflow'
import { runQuery, runQueryOne } from './db.js'
import { nextSequenceBlock, type SessionOrTx } from './sequence.js'
import { firstTeamCypher, TEAM_NOW_PARAM } from './ticketTeamHistory.js'
import { logger } from './logger.js'
import { matchById } from './cypherLookups.js'

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
  /**
   * SOLO SUI TICKET (rimedio, 20 set 2026). `ENTITY_NEO4J_LABELS` contiene
   * anche `kb_article`, perché il motore sa muovere anche gli articoli. Ma un
   * compito su un articolo sarebbe legale e **irraggiungibile**: nessuna
   * pagina della knowledge base mostra i compiti, «I miei compiti» non sa
   * dove portare (l'articolo non ha un numero né una rotta fra quelle dei
   * ticket), e con la guardia l'articolo si bloccherebbe senza che esista
   * un'interfaccia per sbloccarlo.
   *
   * La risposta era già scritta accanto alla mappa: `TICKET_ENTITY_TYPES`,
   * col commento «l'articolo della knowledge base non è un ticket».
   */
  if (!(TICKET_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    throw new Error(
      `Tasks: "${entityType}" is not a ticket — a task can only hang from ${TICKET_ENTITY_TYPES.join(', ')}. ` +
      'On anything else it would be created and then be unreachable.',
    )
  }
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
      /**
       * DUE MODI, UN PARAMETRO SOLO (ondata 5). Il campo nominato può essere:
       *  - un campo SQUADRA, e allora la squadra è quella scelta;
       *  - un campo CI, e allora è chi SUPPORTA quel CI.
       * Nel disegnatore è una tendina sola — «prendi la squadra dal campo
       * ‹Applicazione›» — perché per chi la scrive è la stessa domanda. Due
       * parametri avrebbero voluto dire spiegare la differenza a chi non ha
       * motivo di conoscerla.
       */
      const riga = await runQueryOne<{ teamId: string | null }>(session, `
        ${matchById('ticket', { id: '$entityId' })}
        OPTIONAL MATCH (ticket)-[:FORM_REFERS_TO_TEAM {field: $campo}]->(diretta:Team {tenant_id: $tenantId})
        OPTIONAL MATCH (ticket)-[:FORM_REFERS_TO_CI {field: $campo}]->(:ConfigurationItem)-[:SUPPORTED_BY]->(delCi:Team {tenant_id: $tenantId})
        RETURN coalesce(diretta.id, delCi.id) AS teamId
        LIMIT 1
      `, { entityId: task.entityId, tenantId: task.tenantId, campo: task.teamFromField })
      squadra = riga?.teamId ?? null
      if (!squadra) {
        logger.warn(
          { entityId: task.entityId, campo: task.teamFromField, tenantId: task.tenantId },
          '[tasks] the form field named by the step action gives no team (empty, or the chosen CI has no support group): the task has no assignee',
        )
      }
    }
    const now     = new Date().toISOString()
    const chiave  = chiaveCompito(task.entityId, task.stepName, task.actionIndex)
    /**
     * IL NUMERO SOLO SE IL TASK NASCE DAVVERO (rimedio, 20 set 2026).
     *
     * La MERGE qui sotto è sulla chiave naturale: rientrare nel passo non
     * crea niente. Ma il codice si prendeva comunque, sempre, quindi il
     * contatore correva e la numerazione usciva coi buchi — «dov'è il
     * TASK00000065?».
     *
     * Resta una corsa possibile: due scritture simultanee vedono entrambe
     * «non c'è» e prendono un numero a testa, poi la MERGE ne fa nascere uno
     * solo. Quel buco è il prezzo di non tenere un lucchetto sul contatore, e
     * la differenza è fra un buco a ogni rientro e un buco solo quando due
     * cose accadono nello stesso istante.
     */
    const gia = await runQueryOne<{ id: string }>(session, `
      MATCH (k:Task {tenant_id: $tenantId, task_key: $chiave}) RETURN k.id AS id
    `, { tenantId: task.tenantId, chiave })
    const codice = gia
      ? null
      : await nextSequenceBlock(session, task.tenantId, 'task', 1)
        .then((ultimo) => 'TASK' + String(ultimo).padStart(8, '0'))
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
      ${matchById('ticket', { id: '$entityId' })}
      WITH ticket WHERE $etichetta IN labels(ticket)
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
        /*
         * A task CANCELLED because the ticket was concluded comes back when the
         * reopened ticket re-enters the step (review of 23 Sep 2026): the MERGE
         * matched it and left it cancelled, so the step's all_tasks_complete
         * counted nothing to do and let the ticket move on with no work done.
         * A COMPLETED task stays completed: that is the loop the key is for.
         */
        // The state LAST: the other items read the state as it was.
        ON MATCH SET
          k.completed_at = CASE WHEN k.state = $annullato THEN null ELSE k.completed_at END,
          k.completed_by = CASE WHEN k.state = $annullato THEN null ELSE k.completed_by END,
          k.cancel_reason = CASE WHEN k.state = $annullato THEN null ELSE k.cancel_reason END,
          k.reopened_at  = CASE WHEN k.state = $annullato THEN $now ELSE k.reopened_at END,
          k.state        = CASE WHEN k.state = $annullato THEN $statoIniziale ELSE k.state END
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
      taskKey:    chiave,
      id:         uuidv4(),
      code:       codice,
      title:      task.title,
      description: task.description,
      statoIniziale: task.after ? TASK_STATE.WAITING : TASK_STATE.OPEN,
      annullato:  TASK_STATE.CANCELLED,
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
    ${matchById('ticket', { id: '$entityId' })}
    MATCH (ticket)-[:HAS_TASK]->(k:Task {tenant_id: $tenantId})
    WHERE k.step_name = $stepName AND k.state IN $daFare
    RETURN count(k) AS quanti
  `, { entityId, tenantId, stepName, daFare: [TASK_STATE.OPEN, TASK_STATE.WAITING] })
  return Number(righe[0]?.quanti ?? 0)
}

/**
 * ANNULLA I COMPITI APERTI di un ticket che si è concluso (rimedio, 20 set
 * 2026).
 *
 * Senza, un incident risolto con tre compiti aperti se li porta dietro per
 * sempre: restano in «I miei compiti» della squadra, e chi li vede non ha
 * modo di sapere che il lavoro non serve più. La guardia protegge solo dove
 * il disegnatore l'ha messa, quindi un ticket si chiude coi compiti aperti
 * ogni volta che nessuno ha scritto quella condizione.
 *
 * Si ANNULLANO, non si completano: nessuno li ha fatti, e scrivere «fatto»
 * su un lavoro che non è stato fatto è una bugia nel registro. Il motivo lo
 * mette il prodotto, così chi li ritrova sa perché sono spariti. Vale anche
 * per quelli in attesa, che non partiranno mai.
 *
 * Torna quanti ne ha annullati.
 */
export async function annullaCompitiDelTicketConcluso(
  tenantId: string,
  entityId: string,
  motivo: string,
): Promise<number> {
  const session = getSession(undefined, 'WRITE')
  try {
    const righe = await runQuery<{ quanti: unknown }>(session, `
      ${matchById('ticket', { id: '$entityId' })}
      MATCH (ticket)-[:HAS_TASK]->(k:Task {tenant_id: $tenantId})
      WHERE k.state IN $daFare
      SET k.state = $annullato, k.completed_at = $ora, k.completed_by = $attore, k.cancel_reason = $motivo
      RETURN count(k) AS quanti
    `, {
      entityId, tenantId, daFare: [TASK_STATE.OPEN, TASK_STATE.WAITING],
      annullato: TASK_STATE.CANCELLED, ora: new Date().toISOString(),
      attore: 'system', motivo,
    })
    return Number(righe[0]?.quanti ?? 0)
  } finally {
    await session.close()
  }
}

/** I compiti di un ticket, dal più recente. */
export async function compitiDelTicket(tenantId: string, entityId: string): Promise<TicketTask[]> {
  const session = getSession(undefined, 'READ')
  try {
    const righe = await runQuery<Record<string, unknown>>(session, `
      ${matchById('ticket', { id: '$entityId' })}
      MATCH (ticket)-[:HAS_TASK]->(k:Task {tenant_id: $tenantId})
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
