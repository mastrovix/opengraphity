/**
 * L'evento di dominio di un ingresso in un passo, per QUALUNQUE cammino
 * (revisione totale · C-1).
 *
 * Prima il tipo stabile `<entità>.step_entered` e l'alias storico
 * `<entità>.<passo>` — quelli a cui sono agganciate le regole di notifica, i
 * webhook in uscita e la timeline — li pubblicavano SOLO due funzioni di
 * servizio, chiamate da due cammini su quattordici: la transizione manuale
 * dell'incident e quella del problem. Tutti gli altri (l'azione
 * `transition_workflow` di regole e trigger, la scadenza di un passo, il job
 * `timer_wait`, la change che risolve il problem, la riapertura dal portale,
 * l'escalation) chiamavano `workflowEngine.transition` e basta: il ticket si
 * muoveva e nessuna notifica partiva, nessun webhook scattava, senza un solo
 * errore da nessuna parte.
 *
 * Ora l'evento nasce dall'unico punto da cui passano tutti: l'hook
 * `onStepEntered` del motore (`workflow/stepEnteredEvents.ts`). Le due
 * funzioni di servizio non lo pubblicano più, altrimenti i cammini manuali lo
 * pubblicherebbero due volte.
 *
 * Il payload è quello che i consumatori già leggono (id, title, la
 * severità/priorità, status, il CI e l'assegnatario) più i fatti del passo
 * (`loadStepFacts`): un'entità senza quel passo nel workflow attivo fa
 * FALLIRE il job, che resta nella coda dei falliti — non si inventano fatti.
 */
import neo4j from 'neo4j-driver'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { stepEnteredEventType, legacyStepEventType } from '@opengraphity/types'
import { publishEvent } from './publishEvent.js'
import { auditStepEntered, loadStepFacts } from './stepEvent.js'
import { writeTicketComment } from './ticketComments.js'
import { systemText } from './systemText.js'
import type { GraphQLContext } from '../context.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'step-entered-events' })

/**
 * Le entità che hanno un ticket nel grafo e quindi un payload da spedire.
 * L'etichetta finisce nel Cypher: allowlist, non interpolazione libera.
 * `severityProp` è il nome della proprietà che porta la gravità in quel tipo
 * (gli incident hanno `severity`, gli altri `priority`): il payload la spedisce
 * SEMPRE come `severity`, perché è così che i consumatori la leggono.
 */
const TICKET_ENTITIES: Readonly<Record<string, { label: string; severityProp: 'severity' | 'priority' }>> = {
  incident:        { label: 'Incident',       severityProp: 'severity' },
  problem:         { label: 'Problem',        severityProp: 'priority' },
  change:          { label: 'Change',         severityProp: 'priority' },
  service_request: { label: 'ServiceRequest', severityProp: 'priority' },
}

export interface StepEnteredEntityPayload {
  id:         string
  number:     string | null
  title:      string
  severity:   string
  /** La priorità con il suo nome, per i consumatori che leggono `priority` (problem, change, richieste). */
  priority:   string
  status:     string
  ciName:     string
  assignedTo: string
}

/** Il payload del ticket, o null se non esiste più (cancellato nel frattempo). */
async function loadTicketPayload(
  tenantId: string, entityType: string, entityId: string,
): Promise<StepEnteredEntityPayload | null> {
  const spec = TICKET_ENTITIES[entityType]
  if (!spec) return null
  const session = getSession(undefined, 'READ')
  try {
    return await runQueryOne<StepEnteredEntityPayload>(session, `
      MATCH (e:${spec.label} {id: $entityId, tenant_id: $tenantId})
      OPTIONAL MATCH (e)-[:AFFECTED_BY|AFFECTS|IMPACTS]->(ci)
      OPTIONAL MATCH (e)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(t:Team)
      RETURN e.id AS id,
             e.number AS number,
             coalesce(e.title, e.id) AS title,
             coalesce(e.${spec.severityProp}, 'medium') AS severity,
             coalesce(e.${spec.severityProp}, 'medium') AS priority,
             coalesce(e.status, '') AS status,
             coalesce(collect(ci.name)[0], '—') AS ciName,
             coalesce(u.name, t.name, '—') AS assignedTo
    `, { entityId, tenantId })
  } finally {
    await session.close()
  }
}

export interface StepEnteredInfo {
  tenantId:   string
  actorId:    string
  entityType: string
  entityId:   string
  stepName:   string
  enteredAt:  string
  /** Le note della transizione: finiscono nella nota interna sul ticket (B-4). */
  notes?:     string | null
  /** Who signs the note when it is not a person: the rule's name (U-8). */
  actorLabel?: string | null
  /** Il passo lasciato, per la storia. */
  fromStep?:  string | null
}

/**
 * Pubblica il tipo stabile e l'alias del passo per l'entità che si è mossa.
 * Un'entità senza payload (tipo non gestito, o ticket cancellato) NON è un
 * errore silenzioso: si scrive nel log perché resti visibile.
 */
export async function publishStepEnteredForEntity(info: StepEnteredInfo): Promise<void> {
  if (!TICKET_ENTITIES[info.entityType]) return
  const payload = await loadTicketPayload(info.tenantId, info.entityType, info.entityId)
  if (!payload) {
    log.warn({ tenantId: info.tenantId, entityType: info.entityType, entityId: info.entityId, step: info.stepName },
      'Ingresso in un passo senza il ticket nel grafo: evento di dominio non pubblicato')
    return
  }
  const session = getSession(undefined, 'READ')
  let facts
  try {
    facts = await loadStepFacts(session, info.tenantId, info.entityType, info.stepName)
  } finally {
    await session.close()
  }
  const body = { ...payload, ...facts }
  await publishEvent(stepEnteredEventType(info.entityType), info.tenantId, info.actorId, body, info.enteredAt)
  await publishEvent(legacyStepEventType(info.entityType, info.stepName), info.tenantId, info.actorId, body, info.enteredAt)

  // La NOTA e la voce di AUDIT, dallo stesso punto (revisione totale · B-4/B-5).
  await writeStepEnteredTrace(info)
}

/**
 * La nota interna sul ticket e la voce d'Audit Log dell'ingresso nel passo.
 *
 * Revisione totale · B-4/B-5: le scriveva solo la transizione MANUALE
 * dell'incident (e per il problem solo l'audit). Un incident risolto in blocco
 * dall'elenco, uno chiuso da una change, un problem portato avanti dalla sua
 * change, una riapertura dal portale, un'escalation: il ticket si muoveva, la
 * timeline non lo diceva e nell'Audit Log non c'era niente. Adesso passano da
 * qui, che è l'unico punto comune a tutti i cammini.
 *
 * Né la nota né l'audit fanno fallire la transizione: la transizione è già
 * avvenuta. Un errore si scrive nel log, perché un buco nella storia è un
 * difetto e non deve restare muto.
 */
async function writeStepEnteredTrace(info: StepEnteredInfo): Promise<void> {
  const session = getSession(undefined, neo4j.session.WRITE)
  try {
    const stepLabel = await stepDisplayLabel(session, info.tenantId, info.entityType, info.stepName)
    const text = info.notes?.trim()
      ? await systemText(info.tenantId, 'workflow.transitionCommentNotes', { step: stepLabel, notes: info.notes.trim() })
      : await systemText(info.tenantId, 'workflow.transitionComment', { step: stepLabel })
    await writeTicketComment(session, {
      entityType: info.entityType,
      entityId:   info.entityId,
      tenantId:   info.tenantId,
      text,
      authorId:   info.actorId,
      authorLabel: info.actorLabel ?? null,
      isInternal: true,
      createdAt:  info.enteredAt,
    })
  } catch (err) {
    log.error({ err, tenantId: info.tenantId, entityType: info.entityType, entityId: info.entityId, step: info.stepName },
      'Nota di transizione non scritta: la storia del ticket non mostra questo passaggio')
  } finally {
    await session.close()
  }

  const auditSession = getSession(undefined, neo4j.session.WRITE)
  try {
    const spec = TICKET_ENTITIES[info.entityType]
    if (!spec) return
    const actor = await runQueryOne<{ email: string | null }>(auditSession,
      'MATCH (u:User {id: $actorId, tenant_id: $tenantId}) RETURN u.email AS email',
      { actorId: info.actorId, tenantId: info.tenantId })
    await auditStepEntered(
      auditSession,
      // Il contesto minimo che `audit()` usa: chi, quale organizzazione, e
      // l'e-mail se l'attore è una persona (per i cammini automatici è
      // «system» e non c'è).
      { tenantId: info.tenantId, userId: info.actorId, userEmail: actor?.email ?? info.actorId } as unknown as GraphQLContext,
      info.entityType, spec.label, info.entityId, info.stepName,
    )
  } catch (err) {
    log.error({ err, tenantId: info.tenantId, entityType: info.entityType, entityId: info.entityId, step: info.stepName },
      'Voce di audit dell-ingresso nel passo non scritta')
  } finally {
    await auditSession.close()
  }
}

/** L'etichetta del passo nella lingua del cliente, o il nome se non c'è. */
async function stepDisplayLabel(
  session: ReturnType<typeof getSession>, tenantId: string, entityType: string, stepName: string,
): Promise<string> {
  const row = await runQueryOne<{ label: string | null }>(session, `
    MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})-[:HAS_STEP]->(s:WorkflowStep {name: $stepName})
    RETURN s.label AS label LIMIT 1
  `, { tenantId, entityType, stepName })
  return row?.label ?? stepName
}
