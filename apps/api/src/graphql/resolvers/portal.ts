import { GraphQLError } from 'graphql'
import type { Session } from 'neo4j-driver'
import { withSession } from './ci-utils.js'
import { ForbiddenError, ValidationError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { publishEvent } from '../../lib/publishEvent.js'
import { workflowEngine } from '@opengraphity/workflow'
import { validateStringLength } from '../../lib/validation.js'
import type { GraphQLContext } from '../../context.js'
import { toNumber } from '@opengraphity/neo4j'
import { getStepNamesByClass, getWorkflowSteps, TICKET_STATUS_CLASSES, type TicketStatusClass } from '../../lib/workflowHelpers.js'
import { systemText } from '../../lib/systemText.js'
import { transitionErrorI18n } from '../../lib/transitionError.js'
import * as incidentService from '../../services/incidentService.js'
import { writeTicketComment } from '../../lib/ticketComments.js'
import { localizedLabel } from '@opengraphity/types'
import { languageFor } from '../../lib/tenantLanguage.js'
import { LINGUE, labelFor, type Lingua } from '../../lib/enumValueLabels.js'
import { loadVocabularyEntries } from '../../lib/vocabularyEntries.js'
import { notifyWatchers } from './collaboration.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Read model of a portal ticket. Every portal ticket is an Incident created by
 * `incidentService.createIncident`, which always writes severity, so a node
 * missing it is corrupt data: fail loud. Category is optional (an incident
 * opened from an alarm has none)
 * (GraphQL error on that field) instead of inventing 'medium'/'other'. The
 * portal calls the priority `priority`; the incident stores it in `severity`,
 * like every other channel. `type` is structural (the portal only exposes
 * Incidents), not read from the node.
 */
function requireProp(p: Record<string, unknown>, key: string): string {
  const v = p[key]
  if (typeof v !== 'string' || v === '') {
    throw new Error(`Incident ${String(p['id'])}: missing required property '${key}'`)
  }
  return v
}

/**
 * Categoria ed etichetta del passo di workflow, per nome di passo. Ondata 7 ·
 * D-15: il portale coloriva lo stato con una mappa di otto nomi di fabbrica e
 * un grigio silenzioso per tutto il resto — un passo rinominato nel
 * disegnatore diventava una pastiglia grigia con il nome grezzo. La categoria
 * è la stessa cosa che usa il web e sopravvive a una rinomina.
 *
 * Una sola lettura dei passi per richiesta, riusata per tutti i ticket
 * dell'elenco (`loadSteps` ha già la sua cache).
 */
async function stepMeta(session: Session, tenantId: string, language: Lingua): Promise<(status: string) => { statusCategory: string | null; statusLabel: string | null }> {
  const steps = await getWorkflowSteps(session, tenantId, 'incident')
  const byName = new Map(steps.map((s) => [s.name, s]))
  return (status: string) => {
    const step = byName.get(status)
    // Passo che il workflow non ha (più): `null`, non un'etichetta inventata.
    // Il portale mostra allora il valore grezzo e lo stile neutro.
    // L'etichetta nella lingua di chi guarda (giro del 14 set 2026, #22).
    return { statusCategory: step?.category ?? null, statusLabel: step?.label != null ? localizedLabel(step.label, step.labels, language) : null }
  }
}

/** La lingua chiesta dal portale, se è una del prodotto; altrimenti quella dell'organizzazione. */
async function requestedLanguage(tenantId: string, language: string | null | undefined): Promise<Lingua> {
  return (LINGUE as readonly string[]).includes(language ?? '') ? language as Lingua : languageFor(tenantId)
}

function mapTicket(p: Record<string, unknown>) {
  return {
    id:           requireProp(p, 'id'),
    // Il numero che l'operatore vede e che si cita al telefono (giro del 14 set 2026).
    number:       requireProp(p, 'number'),
    type:         'incident',
    title:        requireProp(p, 'title'),
    description:  (p['description']  ?? null)       as string | null,
    status:       requireProp(p, 'status'),
    priority:     requireProp(p, 'severity'),
    // Facoltativa: un incident aperto da un allarme non ha categoria, e un
    // ticket così faceva fallire tutto «My tickets» (giro nel browser del 14 set 2026).
    category:     (typeof p['category'] === 'string' && p['category'] !== '' ? p['category'] : null) as string | null,
    createdAt:    requireProp(p, 'created_at'),
    updatedAt:    requireProp(p, 'updated_at'),
    assignedTeam: (p['assigned_team'] ?? null)      as string | null,
  }
}

// ── Query: myTickets ──────────────────────────────────────────────────────────

/**
 * `status` è una CLASSE (`open | in_progress | resolved | closed`), non il nome
 * di un passo: B0-3. Il portale mandava il nome `'open'`, che nessun workflow
 * definisce — la scheda «Aperti» era vuota su qualunque tenant. La traduzione
 * classe → nomi di passo viene dal workflow del tenant (`is_open`,
 * `is_initial`, `is_terminal`, `category`), quindi una rinomina dei passi non
 * la rompe, ed è la STESSA usata dal contatore della home: i due numeri
 * coincidono per costruzione.
 *
 * Fail-loud: una classe fuori vocabolario è un errore (nomina le classi
 * ammesse); una classe che nel workflow del tenant non ha nessun passo è un
 * errore che lo dice, invece di una lista vuota che il cliente leggerebbe come
 * «non ho ticket».
 */
async function resolveStatusClass(
  session: Session,
  tenantId: string,
  statusClass: string,
): Promise<string[]> {
  if (!(TICKET_STATUS_CLASSES as readonly string[]).includes(statusClass)) {
    throw new ValidationError(`status must be one of ${TICKET_STATUS_CLASSES.join(', ')} (it is a class, not a workflow step name). Got: ${JSON.stringify(statusClass)}`)
  }
  const byClass = await getStepNamesByClass(session, tenantId, 'incident')
  const names = byClass[statusClass as TicketStatusClass]
  if (names.length === 0) {
    throw new ValidationError(`The incident workflow of tenant "${tenantId}" declares no step in the "${statusClass}" class: the portal cannot list those tickets. Fix the workflow steps (is_open / is_terminal / category) in the designer.`)
  }
  return names
}

async function myTickets(
  _: unknown,
  { status, page = 1, pageSize = 20, language }: { status?: string | null; page?: number; pageSize?: number; language?: string | null },
  ctx: GraphQLContext,
) {
  const offset = (page - 1) * pageSize

  return withSession(async (session) => {
    const statuses = status ? await resolveStatusClass(session, ctx.tenantId, status) : null

    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {tenant_id: $tenantId, created_by: $userId})
        WHERE ($statuses IS NULL OR i.status IN $statuses)
        OPTIONAL MATCH (i)-[:ASSIGNED_TO_TEAM]->(t:Team)
        WITH i, t
        ORDER BY i.updated_at DESC
        SKIP toInteger($offset) LIMIT toInteger($limit)
        RETURN properties(i) AS props, t.name AS assignedTeam
      `, { tenantId: ctx.tenantId, userId: ctx.userId, statuses, offset, limit: pageSize }),
    )

    const countResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {tenant_id: $tenantId, created_by: $userId})
        WHERE ($statuses IS NULL OR i.status IN $statuses)
        RETURN count(i) AS total
      `, { tenantId: ctx.tenantId, userId: ctx.userId, statuses }),
    )

    const total = toNumber(countResult.records[0]?.get('total'))
    const meta = await stepMeta(session, ctx.tenantId, await requestedLanguage(ctx.tenantId, language))
    const items = result.records.map((r) => {
      const t = mapTicket(r.get('props') as Record<string, unknown>)
      return { ...t, ...meta(t.status), assignedTeam: (r.get('assignedTeam') ?? null) as string | null }
    })

    return { items, total }
  })
}

// ── Query: myTicket ───────────────────────────────────────────────────────────

async function myTicket(
  _: unknown,
  { id, language }: { id: string; language?: string | null },
  ctx: GraphQLContext,
) {
  const lingua = await requestedLanguage(ctx.tenantId, language)
  return withSession(async (session) => {
    const ticketResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})
        OPTIONAL MATCH (i)-[:ASSIGNED_TO_TEAM]->(t:Team)
        RETURN properties(i) AS props, t.name AS assignedTeam
      `, { id, tenantId: ctx.tenantId }),
    )

    if (!ticketResult.records.length) throw new ForbiddenError('Ticket not found')

    const props = ticketResult.records[0].get('props') as Record<string, unknown>
    if (props['created_by'] !== ctx.userId) throw new ForbiddenError('Access denied')

    const mapped = mapTicket(props)
    const ticket = {
      ...mapped,
      ...(await stepMeta(session, ctx.tenantId, lingua))(mapped.status),
      assignedTeam: (ticketResult.records[0].get('assignedTeam') ?? null) as string | null,
    }

    // Le risposte pubbliche del ticket: stesso modello dei commenti dello staff
    // (lib/ticketComments.ts). Prima il portale leggeva un modello suo, e
    // l'utente non vedeva mai le risposte dell'operatore (F1). Le note interne
    // restano allo staff: passa solo `is_internal = false`, esplicito.
    const commentsResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_COMMENT]->(c:Comment)
        WHERE c.is_internal = false
        OPTIONAL MATCH (u:User {id: c.author_id, tenant_id: $tenantId})
        RETURN c.id AS id, c.text AS body, c.author_id AS authorId,
               coalesce(u.name, u.email, '') AS authorName, coalesce(u.email, '') AS authorEmail,
               c.created_at AS createdAt, c.updated_at AS updatedAt
        ORDER BY c.created_at ASC
      `, { id, tenantId: ctx.tenantId }),
    )

    const comments = commentsResult.records.map((r) => ({
      id:          r.get('id')          as string,
      body:        r.get('body')        as string,
      isInternal:  false,
      authorId:    r.get('authorId')    as string,
      authorName:  r.get('authorName')  as string,
      authorEmail: r.get('authorEmail') as string,
      createdAt:   r.get('createdAt')   as string,
      updatedAt:   r.get('updatedAt')   as string,
    }))

    // Load attachments — the REST upload creates Attachment nodes keyed by
    // entity_type/entity_id properties, not a HAS_ATTACHMENT relationship
    const attachmentsResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (a:Attachment {tenant_id: $tenantId, entity_type: 'incident', entity_id: $id})
        RETURN a.id AS id, a.filename AS filename, a.mime_type AS mimeType,
               a.size_bytes AS sizeBytes, a.uploaded_by AS uploadedBy,
               a.uploaded_at AS uploadedAt, a.description AS description
        ORDER BY a.uploaded_at ASC
      `, { id, tenantId: ctx.tenantId }),
    )

    const attachments = attachmentsResult.records.map((r) => ({
      id:          r.get('id')          as string,
      filename:    r.get('filename')    as string,
      mimeType:    r.get('mimeType')    as string,
      sizeBytes:   toNumber(r.get('sizeBytes')),
      uploadedBy:  r.get('uploadedBy')  as string,
      uploadedAt:  r.get('uploadedAt')  as string,
      description: (r.get('description') ?? null) as string | null,
      downloadUrl: `/api/attachments/${r.get('id') as string}`,
    }))

    // Load workflow history
    const historyResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
              -[:STEP_HISTORY]->(exec:WorkflowStepExecution)
        RETURN exec.from_step AS fromStep, exec.step_name AS toStep,
               exec.entered_at AS triggeredAt, exec.triggered_by AS triggeredBy
        ORDER BY exec.entered_at ASC
      `, { id, tenantId: ctx.tenantId }),
    )

    // Nomi dei passi → etichette nella lingua di chi guarda (giro del 14 set
    // 2026: la storia diceva «start → new»). Un passo che il workflow non ha
    // più resta col suo nome; la prima voce non ha un passo di partenza.
    const stepLabel = await stepMeta(session, ctx.tenantId, lingua)
    const history = historyResult.records.map((r) => ({
      fromStep:    (r.get('fromStep')    ?? 'start') as string,
      toStep:      r.get('toStep')      as string,
      fromLabel:   r.get('fromStep') == null ? null : stepLabel(r.get('fromStep') as string).statusLabel,
      toLabel:     stepLabel(r.get('toStep') as string).statusLabel,
      label:       null,
      triggeredAt: r.get('triggeredAt') as string,
      triggeredBy: (r.get('triggeredBy') ?? '') as string,
    }))

    return { ...ticket, comments, attachments, history }
  })
}

// ── Query: myTicketStats ──────────────────────────────────────────────────────

async function myTicketStats(
  _: unknown,
  __: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    // STESSA classificazione della scheda del portale (B0-3): `open` qui e
    // «Aperti» là sono lo stesso insieme di passi, quindi lo stesso numero.
    // `resolved` resta «risolti o chiusi», come prima.
    const byClass = await getStepNamesByClass(session, ctx.tenantId, 'incident')
    const inClass = (cls: TicketStatusClass, status: string) => byClass[cls].includes(status)

    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {tenant_id: $tenantId, created_by: $userId})
        RETURN i.status AS status, count(i) AS cnt
      `, { tenantId: ctx.tenantId, userId: ctx.userId }),
    )

    let open = 0, inProgress = 0, resolved = 0, total = 0
    const unclassified: string[] = []
    for (const r of result.records) {
      const status = r.get('status') as string
      const cnt    = toNumber(r.get('cnt'))
      total += cnt
      const isOpen     = inClass('open', status)
      const isProgress = inClass('in_progress', status)
      const isDone     = inClass('resolved', status) || inClass('closed', status)
      if (isOpen)     open       += cnt
      if (isProgress) inProgress += cnt
      if (isDone)     resolved   += cnt
      if (!isOpen && !isProgress && !isDone) unclassified.push(`${status} (${cnt})`)
    }

    // Fail-loud: un ticket in un passo che nessuna definizione attiva del
    // tenant classifica non finirebbe in nessun contatore e sparirebbe dalla
    // home restando nel totale — lo stesso silenzio della scheda «Aperti»
    // vuota (B0-3), solo spostato di un numero.
    if (unclassified.length) {
      throw new ValidationError(
        `Tenant "${ctx.tenantId}": ${unclassified.length} ticket states belong to no class of the active incident workflow `
        + `[${unclassified.join(', ')}]: the portal counters would not count them. `
        + `Fix the steps (is_open / is_terminal / category) or realign the incidents in the designer.`,
        { key: 'errors.portal.unclassifiedStates', params: { count: unclassified.length, states: unclassified.join(', ') } },
      )
    }

    return { open, inProgress, resolved, total }
  })
}

// ── Query: ticketCategories ───────────────────────────────────────────────────

/**
 * Le categorie fra cui chi apre un ticket sceglie: il vocabolario `category`
 * del cliente, nell'ordine e con le etichette del Dizionario. Giro nel browser
 * del 14 set 2026: il portale ne aveva cinque scritte nel codice, e mancava
 * «security» che il vocabolario ha.
 */
async function ticketCategories(_: unknown, args: { language?: string | null }, ctx: GraphQLContext) {
  const [vocabulary, fallback, language] = await Promise.all([
    loadVocabularyEntries(ctx.tenantId, 'category'),
    languageFor(ctx.tenantId),
    requestedLanguage(ctx.tenantId, args.language),
  ])
  if (vocabulary.values.length === 0) {
    throw new ValidationError(`Tenant "${ctx.tenantId}": the "category" dictionary has no values, so a portal ticket cannot be opened. Add them in Settings → Dictionary.`, { key: 'errors.portal.noCategories' })
  }
  return vocabulary.values.map((name) => ({ name, label: labelFor(name, vocabulary.labels, language, fallback) }))
}

// ── Mutation: createTicket ────────────────────────────────────────────────────

async function createTicket(
  _: unknown,
  { title, description, priority, category }: {
    title: string; description?: string; priority?: string | null; category: string
  },
  ctx: GraphQLContext,
) {
  validateStringLength(title, 'title', 1, 500)
  validateStringLength(description, 'description', 0, 10000)

  // No defaults: a missing priority is a client bug, not "medium".
  if (!priority) throw new ValidationError('priority is required', { key: 'errors.portal.priorityRequired' })

  // Revisione del 14 set 2026 · IT-4: il ticket nasce dal servizio, come ogni
  // incident — numero, workflow, `incident.created` (SLA, regole di notifica,
  // automazioni), embedding, osservatore. Priorità e categoria sono validate
  // lì contro il Dizionario del cliente, anche quando il cliente non ne ha una
  // copia (prima la validazione si saltava: IT-7).
  const created = await incidentService.createIncident(
    { title, description, severity: priority, category },
    { tenantId: ctx.tenantId, userId: ctx.userId },
    'portal',
  )
  const ticket = await withSession(async (session) => {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      RETURN properties(i) AS props
    `, { id: created.id, tenantId: ctx.tenantId }))
    const props = res.records[0]?.get('props') as Record<string, unknown> | undefined
    if (!props) throw new Error(`Incident ${String(created.id)} vanished right after creation`)
    return mapTicket(props)
  })

  // Evento del canale, per chi si è abbonato ai ticket del portale (webhook in
  // uscita): si aggiunge a `incident.created`, pubblicato dal servizio.
  await publishEvent('portal.ticket.created', ctx.tenantId, ctx.userId, { ticketId: ticket.id, title, category, priority, userId: ctx.userId }, ticket.createdAt)

  void audit(ctx, 'portal.ticket.created', 'Incident', ticket.id)

  return ticket
}

// ── Mutation: addTicketComment ────────────────────────────────────────────────

async function addTicketComment(
  _: unknown,
  { ticketId, body }: { ticketId: string; body: string },
  ctx: GraphQLContext,
) {
  validateStringLength(body, 'body', 1, 10000)

  const comment = await withSession(async (session) => {
    const check = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $ticketId, tenant_id: $tenantId})
        RETURN i.created_by AS createdBy
      `, { ticketId, tenantId: ctx.tenantId }),
    )

    if (!check.records.length) throw new ForbiddenError('Ticket not found')
    if (check.records[0].get('createdBy') !== ctx.userId) throw new ForbiddenError('Access denied')

    // Un modello solo (F1): lo staff vede questo commento nel dettaglio
    // dell'incident, e la sua risposta pubblica torna qui.
    const row = await writeTicketComment(session, {
      entityType: 'incident', entityId: ticketId, tenantId: ctx.tenantId,
      text: body, authorId: ctx.userId, isInternal: false,
    })
    if (!row) throw new ForbiddenError('Ticket not found')
    return {
      id:          row.comment['id'] as string,
      body,
      isInternal:  false,
      authorId:    ctx.userId,
      authorName:  (row.author?.['name'] ?? ctx.userEmail) as string,
      authorEmail: (row.author?.['email'] ?? ctx.userEmail) as string,
      createdAt:   row.comment['created_at'] as string,
      updatedAt:   row.comment['updated_at'] as string,
    }
  }, true)

  void audit(ctx, 'portal.comment.added', 'Incident', ticketId)
  // Chi segue il ticket (lo staff che ci lavora) deve sapere che l'utente ha scritto.
  void notifyWatchers(ctx.tenantId, 'incident', ticketId, { kind: 'text', text: comment.body.slice(0, 100) }, ctx.userId)
  return comment
}

// ── Mutation: reopenTicket ────────────────────────────────────────────────────

/**
 * Reopening is a workflow transition, never a bare `SET i.status`: the engine
 * moves WorkflowInstance.current_step and syncs Incident.status in the same
 * transaction, records the step history and keeps SLA/auto-close consistent.
 * The target step is one the workflow actually allows from the current step
 * (manual TRANSITIONS_TO), chosen among the open steps: an "in progress"-like
 * active step first, then any open step. No such transition → ValidationError.
 */
async function reopenTicket(
  _: unknown,
  { ticketId }: { ticketId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const check = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $ticketId, tenant_id: $tenantId})
        OPTIONAL MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN i.created_by AS createdBy, i.status AS status, wi.id AS instanceId
      `, { ticketId, tenantId: ctx.tenantId }),
    )

    if (!check.records.length) throw new ForbiddenError('Ticket not found')

    const r          = check.records[0]
    const createdBy  = r.get('createdBy')  as string
    const status     = r.get('status')     as string
    const instanceId = r.get('instanceId') as string | null

    if (createdBy !== ctx.userId) throw new ForbiddenError('Access denied')
    if (!instanceId) throw new ValidationError(`Ticket ${ticketId} has no workflow instance and cannot be reopened`)

    const { getWorkflowSteps } = await import('../../lib/workflowHelpers.js')
    const steps = await getWorkflowSteps(session, ctx.tenantId, 'incident')
    const resolvedStep = steps.find((s) => s.category === 'resolved')
    if (!resolvedStep || status !== resolvedStep.name) {
      throw new GraphQLError('Only resolved tickets can be reopened', { extensions: { code: 'CONFLICT' } })
    }

    // Candidate targets = manual transitions out of the current step whose
    // destination is an open step (never terminal/closed).
    const stepByName = new Map(steps.map((s) => [s.name, s]))
    const available  = await workflowEngine.getAvailableTransitions(session, instanceId, ctx.tenantId)
    const openTargets = available
      .map((t) => stepByName.get(t.toStep))
      .filter((s): s is NonNullable<typeof s> => !!s && s.isOpen)
    const reopenTo =
      openTargets.find((s) => s.category === 'active' && !s.isInitial) ??
      openTargets.find((s) => s.category === 'active') ??
      openTargets[0]
    if (!reopenTo) {
      throw new ValidationError(
        `The incident workflow defines no transition from "${status}" back to an open step: reopening is not allowed`,
      )
    }

    const result = await workflowEngine.transition(
      session,
      { instanceId, toStepName: reopenTo.name, triggeredBy: ctx.userId, triggerType: 'manual', notes: await systemText(ctx.tenantId, 'portal.reopened'), tenantId: ctx.tenantId },
      { userId: ctx.userId, entityData: {} },
    )
    if (!result.success) {
      throw new ValidationError(`Reopen failed: ${result.error ?? 'transition rejected by the workflow'}`, transitionErrorI18n(result))
    }

    void audit(ctx, 'portal.ticket.reopened', 'Incident', ticketId, { fromStep: status, toStep: reopenTo.name })

    const updated = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $ticketId, tenant_id: $tenantId})
        RETURN properties(i) AS props
      `, { ticketId, tenantId: ctx.tenantId }),
    )
    const props = updated.records[0]?.get('props') as Record<string, unknown> | undefined
    if (!props) throw new Error(`Incident ${ticketId} vanished after reopen transition`)
    return mapTicket(props)
  }, true)
}

// ── Resolver map ──────────────────────────────────────────────────────────────

export const portalResolvers = {
  Query: {
    myTickets,
    myTicket,
    myTicketStats,
    ticketCategories,
  },
  Mutation: {
    createTicket,
    addTicketComment,
    reopenTicket,
  },
}
