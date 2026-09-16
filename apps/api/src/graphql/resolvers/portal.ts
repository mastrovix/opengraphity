import { GraphQLError } from 'graphql'
import { creationStepContext, ticketStepContext } from '../../lib/customFieldSteps.js'
import { customFieldDefs, customFieldValues, type CustomFieldInput } from '../../lib/ticketCustomFields.js'
import type { Session } from 'neo4j-driver'
import { withSession } from './ci-utils.js'
import { ForbiddenError, ValidationError } from '../../lib/errors.js'
import { listPage } from '../../lib/listLimit.js'
import { audit } from '../../lib/audit.js'
import { publishEvent } from '../../lib/publishEvent.js'
import { workflowEngine } from '@opengraphity/workflow'
import { validateStringLength } from '../../lib/validation.js'
import type { GraphQLContext } from '../../context.js'
import { toNumber } from '@opengraphity/neo4j'
import { getStepNamesByClass, getWorkflowSteps, isEntityClosed, TICKET_STATUS_CLASSES, type TicketStatusClass } from '../../lib/workflowHelpers.js'
import { systemText } from '../../lib/systemText.js'
import { transitionErrorI18n } from '../../lib/transitionError.js'
import * as incidentService from '../../services/incidentService.js'
import { writeTicketComment } from '../../lib/ticketComments.js'
import { localizedLabel } from '@opengraphity/types'
import { languageFor } from '../../lib/tenantLanguage.js'
import { LINGUE, labelFor, type Lingua } from '../../lib/enumValueLabels.js'
import { loadVocabularyEntries } from '../../lib/vocabularyEntries.js'
import type { ValueColor } from '@opengraphity/types'
import {
  PORTAL_SEVERITY_VOCABULARY, portalSeverityChoices, portalSeverityOptions, setPortalSeverityOptions,
  type PortalSeverityOption, type PortalSeverityOptionInput,
} from '../../lib/portalSeverityOptions.js'
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
function requireProp(p: Record<string, unknown>, key: string, what = 'Ticket'): string {
  const v = p[key]
  if (typeof v !== 'string' || v === '') {
    throw new Error(`${what} ${String(p['id'])}: missing required property '${key}'`)
  }
  return v
}

/**
 * I DUE TIPI DI TICKET CHE L'UTENTE FINALE APRE (revisione totale · H-2, scelta
 * del proprietario del 16 set 2026).
 *
 * Il portale permette di aprire un incident («il gestionale non si apre») e una
 * richiesta dal catalogo («mi serve un portatile»), ma ogni lettura leggeva solo
 * `:Incident`: dopo l'invio la richiesta non compariva da nessuna parte — non si
 * poteva seguirla, commentarla, né vedere l'approvazione. Ora incident e
 * richieste stanno nella STESSA lista, ognuno col suo tipo, e il dettaglio
 * funziona per entrambi.
 *
 * Le due entità differiscono in tre punti, ed è tutto qui: l'etichetta Neo4j, il
 * campo della priorità (`severity` per l'incident, `priority` per la richiesta) e
 * il tipo di entità con cui si leggono workflow e campi personalizzati.
 */
export const PORTAL_TICKET_KINDS = ['incident', 'service_request'] as const
export type PortalTicketKind = (typeof PORTAL_TICKET_KINDS)[number]

const PORTAL_TICKET_SHAPE: Readonly<Record<PortalTicketKind, { label: string; priorityProp: string }>> = {
  incident:        { label: 'Incident',       priorityProp: 'severity' },
  service_request: { label: 'ServiceRequest', priorityProp: 'priority' },
}

/** Il tipo di un nodo dalle sue etichette: nient'altro entra in questi elenchi. */
function kindOfLabels(labels: readonly string[], id: string): PortalTicketKind {
  const kind = PORTAL_TICKET_KINDS.find((k) => labels.includes(PORTAL_TICKET_SHAPE[k].label))
  if (!kind) throw new Error(`Portal ticket ${id} has none of the labels ${PORTAL_TICKET_KINDS.map((k) => PORTAL_TICKET_SHAPE[k].label).join(', ')}`)
  return kind
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
async function stepMeta(session: Session, tenantId: string, language: Lingua): Promise<(status: string, kind?: PortalTicketKind) => { statusCategory: string | null; statusLabel: string | null }> {
  // Un workflow per tipo di ticket (H-2): l'etichetta e la categoria del passo
  // di una richiesta vengono dal SUO workflow, non da quello degli incident.
  const byKind = new Map<PortalTicketKind, Map<string, Awaited<ReturnType<typeof getWorkflowSteps>>[number]>>()
  for (const kind of PORTAL_TICKET_KINDS) {
    const steps = await getWorkflowSteps(session, tenantId, kind)
    byKind.set(kind, new Map(steps.map((s) => [s.name, s])))
  }
  return (status: string, kind: PortalTicketKind = 'incident') => {
    const step = byKind.get(kind)?.get(status)
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

/**
 * Etichetta e colore della severità di un ticket, nella lingua di chi guarda
 * (verifica «Cosa resta cablato», ondata 1): le parole che l'amministratore ha
 * scelto per il portale se il valore è una delle scelte, altrimenti
 * l'etichetta del Dizionario; il colore è quello del Dizionario. Prima il
 * portale colorava con una mappa `high/medium/low` scritta nella pagina.
 */
async function severityMeta(tenantId: string, language: Lingua): Promise<(value: string) => { priorityLabel: string; priorityColor: ValueColor | null }> {
  const [options, vocabulary, fallback] = await Promise.all([
    portalSeverityOptions(tenantId),
    loadVocabularyEntries(tenantId, PORTAL_SEVERITY_VOCABULARY),
    languageFor(tenantId),
  ])
  const chosen = new Map((options ?? []).map((o) => [o.value, o.labels[language]]))
  return (value: string) => ({
    priorityLabel: chosen.get(value) ?? labelFor(value, vocabulary.labels, language, fallback),
    priorityColor: vocabulary.colors[value] ?? null,
  })
}

function mapTicket(p: Record<string, unknown>, kind: PortalTicketKind = 'incident') {
  const shape = PORTAL_TICKET_SHAPE[kind]
  return {
    id:           requireProp(p, 'id', shape.label),
    // Il numero che l'operatore vede e che si cita al telefono (giro del 14 set 2026).
    number:       requireProp(p, 'number', shape.label),
    type:         kind,
    title:        requireProp(p, 'title', shape.label),
    description:  (p['description']  ?? null)       as string | null,
    status:       requireProp(p, 'status', shape.label),
    priority:     requireProp(p, shape.priorityProp, shape.label),
    // Facoltativa: un incident aperto da un allarme non ha categoria, e un
    // ticket così faceva fallire tutto «My tickets» (giro nel browser del 14 set 2026).
    category:     (typeof p['category'] === 'string' && p['category'] !== '' ? p['category'] : null) as string | null,
    createdAt:    requireProp(p, 'created_at', shape.label),
    updatedAt:    requireProp(p, 'updated_at', shape.label),
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
  kind: PortalTicketKind = 'incident',
): Promise<string[]> {
  if (!(TICKET_STATUS_CLASSES as readonly string[]).includes(statusClass)) {
    throw new ValidationError(`status must be one of ${TICKET_STATUS_CLASSES.join(', ')} (it is a class, not a workflow step name). Got: ${JSON.stringify(statusClass)}`)
  }
  const byClass = await getStepNamesByClass(session, tenantId, kind)
  const names = byClass[statusClass as TicketStatusClass]
  if (names.length === 0) {
    throw new ValidationError(`The ${kind} workflow of tenant "${tenantId}" declares no step in the "${statusClass}" class: the portal cannot list those tickets. Fix the workflow steps (is_open / is_terminal / category) in the designer.`)
  }
  return names
}

async function myTickets(
  _: unknown,
  { status, page = 1, pageSize = 20, language }: { status?: string | null; page?: number; pageSize?: number; language?: string | null },
  ctx: GraphQLContext,
) {
  /**
   * Pagina e dimensione VALIDATE (revisione totale · B-24 e H-38, lo stesso
   * difetto visto da due revisori): `page: 0` dava uno
   * SKIP negativo e un errore Cypher invece di un messaggio, e `pageSize` non
   * aveva tetto — una richiesta poteva chiedere tutto.
   */
  const { limit: safePageSize, offset } = listPage(
    { limit: pageSize, offset: (Math.max(1, Math.trunc(page)) - 1) * Math.max(1, Math.trunc(pageSize)) },
    20,
  )
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError(`page must be an integer >= 1 (got ${String(page)})`, { key: 'errors.list.page', params: { got: String(page) } })
  }

  return withSession(async (session) => {
    // Una classe di stato vale per entrambi i workflow: i passi si risolvono
    // per tipo, e il filtro confronta ogni ticket coi passi del SUO tipo (H-2).
    const statuses = status
      ? { incident: await resolveStatusClass(session, ctx.tenantId, status, 'incident'), service_request: await resolveStatusClass(session, ctx.tenantId, status, 'service_request') }
      : null
    const params = {
      tenantId: ctx.tenantId, userId: ctx.userId, offset, limit: safePageSize,
      incidentStatuses: statuses?.incident ?? null, requestStatuses: statuses?.service_request ?? null,
    }
    const whereClause = `
      WHERE ($incidentStatuses IS NULL
             OR (e:Incident       AND e.status IN $incidentStatuses)
             OR (e:ServiceRequest AND e.status IN $requestStatuses))
    `

    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e {tenant_id: $tenantId, created_by: $userId})
        WHERE (e:Incident OR e:ServiceRequest)
        ${whereClause.replace('WHERE', 'AND')}
        OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(t:Team)
        WITH e, t
        ORDER BY e.updated_at DESC
        SKIP toInteger($offset) LIMIT toInteger($limit)
        RETURN properties(e) AS props, labels(e) AS labels, t.name AS assignedTeam
      `, params),
    )

    const countResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e {tenant_id: $tenantId, created_by: $userId})
        WHERE (e:Incident OR e:ServiceRequest)
        ${whereClause.replace('WHERE', 'AND')}
        RETURN count(e) AS total
      `, params),
    )

    const total = toNumber(countResult.records[0]?.get('total'))
    const lingua = await requestedLanguage(ctx.tenantId, language)
    const [meta, severity] = await Promise.all([stepMeta(session, ctx.tenantId, lingua), severityMeta(ctx.tenantId, lingua)])
    const items = result.records.map((r) => {
      const props = r.get('props') as Record<string, unknown>
      const kind = kindOfLabels(r.get('labels') as string[], String(props['id']))
      const t = mapTicket(props, kind)
      return { ...t, ...meta(t.status, kind), ...severity(t.priority), assignedTeam: (r.get('assignedTeam') ?? null) as string | null }
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
    // Incident o richiesta: il portale apre entrambi (H-2).
    const ticketResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e {id: $id, tenant_id: $tenantId})
        WHERE e:Incident OR e:ServiceRequest
        OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(t:Team)
        RETURN properties(e) AS props, labels(e) AS labels, t.name AS assignedTeam
      `, { id, tenantId: ctx.tenantId }),
    )

    if (!ticketResult.records.length) throw new ForbiddenError('Ticket not found')

    const props = ticketResult.records[0].get('props') as Record<string, unknown>
    if (props['created_by'] !== ctx.userId) throw new ForbiddenError('Access denied')
    const kind = kindOfLabels(ticketResult.records[0].get('labels') as string[], id)

    const mapped = mapTicket(props, kind)
    const ticket = {
      ...mapped,
      ...(await stepMeta(session, ctx.tenantId, lingua))(mapped.status, kind),
      ...(await severityMeta(ctx.tenantId, lingua))(mapped.priority),
      assignedTeam: (ticketResult.records[0].get('assignedTeam') ?? null) as string | null,
    }

    // Le risposte pubbliche del ticket: stesso modello dei commenti dello staff
    // (lib/ticketComments.ts). Prima il portale leggeva un modello suo, e
    // l'utente non vedeva mai le risposte dell'operatore (F1). Le note interne
    // restano allo staff: passa solo `is_internal = false`, esplicito.
    const commentsResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e {id: $id, tenant_id: $tenantId})-[:HAS_COMMENT]->(c:Comment)
        WHERE c.is_internal = false
        OPTIONAL MATCH (u:User {id: c.author_id, tenant_id: $tenantId})
        RETURN c.id AS id, c.text AS body, c.author_id AS authorId,
               // L'e-mail dello staff non esce verso il portale (revisione totale · H-37): solo la propria.
               coalesce(u.name, '') AS authorName,
               CASE WHEN c.author_id = $userId THEN coalesce(u.email, '') ELSE '' END AS authorEmail,
               c.created_at AS createdAt, c.updated_at AS updatedAt,
               c.edited_at AS editedAt, c.edited_by_name AS editedByName,
               c.deleted_at AS deletedAt, c.deleted_by_name AS deletedByName
        ORDER BY c.created_at ASC
      `, { id, tenantId: ctx.tenantId, userId: ctx.userId }),
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
      editedAt:      (r.get('editedAt')      ?? null) as string | null,
      editedByName:  (r.get('editedByName')  ?? null) as string | null,
      deletedAt:     (r.get('deletedAt')     ?? null) as string | null,
      deletedByName: (r.get('deletedByName') ?? null) as string | null,
    }))

    // Load attachments — the REST upload creates Attachment nodes keyed by
    // entity_type/entity_id properties, not a HAS_ATTACHMENT relationship
    const attachmentsResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (a:Attachment {tenant_id: $tenantId, entity_type: $entityType, entity_id: $id})
        RETURN a.id AS id, a.filename AS filename, a.mime_type AS mimeType,
               a.size_bytes AS sizeBytes, a.uploaded_by AS uploadedBy,
               a.uploaded_at AS uploadedAt, a.description AS description
        ORDER BY a.uploaded_at ASC
      `, { id, tenantId: ctx.tenantId, entityType: kind }),
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
        MATCH (e {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
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
      // H-49: niente «start» inventato — la prima voce non ha un passo di partenza.
      fromStep:    (r.get('fromStep') ?? null) as string | null,
      toStep:      r.get('toStep')      as string,
      fromLabel:   r.get('fromStep') == null ? null : stepLabel(r.get('fromStep') as string, kind).statusLabel,
      toLabel:     stepLabel(r.get('toStep') as string, kind).statusLabel,
      label:       null,
      triggeredAt: r.get('triggeredAt') as string,
      triggeredBy: (r.get('triggeredBy') ?? '') as string,
    }))

    // I campi del cliente che l'amministratore offre all'utente finale (ondata 4).
    // Solo quelli che nella fase del ticket si vedono (secondo giro UI del 15 set 2026).
    const customFields = customFieldValues(await customFieldDefs(session, ctx.tenantId, kind), props, { onlyVisibleToEndUser: true, stepContext: await ticketStepContext(session, ctx.tenantId, id) })
      .filter((f) => f.visible)

    return { ...ticket, comments, attachments, history, customFields }
  })
}

// ── Query: portalCustomFields ────────────────────────────────────────────────

/**
 * I campi personalizzati che il portale offre aprendo un incident o una
 * richiesta: solo quelli marcati «visibile all'utente finale» (ondata 4).
 */
async function portalCustomFields(_: unknown, { entityType, category }: { entityType: string; category?: string | null }, ctx: GraphQLContext) {
  if (entityType !== 'incident' && entityType !== 'service_request') {
    throw new ValidationError(`The portal opens incidents and service requests, not "${entityType}".`, { key: 'errors.customField.entityType', params: { entityType } })
  }
  // Solo quelli che all'apertura si vedono: la fase iniziale del workflow (secondo giro UI del 15 set 2026).
  return withSession(async (session) => customFieldValues(await customFieldDefs(session, ctx.tenantId, entityType), {}, {
    onlyVisibleToEndUser: true, stepContext: await creationStepContext(session, ctx.tenantId, entityType, category ?? null),
  }).filter((f) => f.visible))
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
    // Un workflow per tipo (H-2): un passo si classifica con quello del suo tipo.
    const byKind: Record<PortalTicketKind, Awaited<ReturnType<typeof getStepNamesByClass>>> = {
      incident:        await getStepNamesByClass(session, ctx.tenantId, 'incident'),
      service_request: await getStepNamesByClass(session, ctx.tenantId, 'service_request'),
    }
    const inClass = (cls: TicketStatusClass, status: string, kind: PortalTicketKind) => byKind[kind][cls].includes(status)

    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e {tenant_id: $tenantId, created_by: $userId})
        WHERE e:Incident OR e:ServiceRequest
        RETURN e.status AS status, head([l IN labels(e) WHERE l IN ['Incident', 'ServiceRequest']]) AS label, count(e) AS cnt
      `, { tenantId: ctx.tenantId, userId: ctx.userId }),
    )

    let open = 0, inProgress = 0, resolved = 0, total = 0
    const unclassified: string[] = []
    for (const r of result.records) {
      const status = r.get('status') as string
      const kind   = kindOfLabels([r.get('label') as string], status)
      const cnt    = toNumber(r.get('cnt'))
      total += cnt
      const isOpen     = inClass('open', status, kind)
      const isProgress = inClass('in_progress', status, kind)
      const isDone     = inClass('resolved', status, kind) || inClass('closed', status, kind)
      if (isOpen)     open       += cnt
      if (isProgress) inProgress += cnt
      if (isDone)     resolved   += cnt
      if (!isOpen && !isProgress && !isDone) unclassified.push(`${kind}:${status} (${cnt})`)
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
/** Le severità che l'utente finale può scegliere, nella sua lingua. */
async function portalSeverityChoicesQuery(_: unknown, args: { language?: string | null }, ctx: GraphQLContext) {
  return portalSeverityChoices(ctx.tenantId, await requestedLanguage(ctx.tenantId, args.language))
}

/** La scelta dell'amministratore, com'è salvata (null = non dichiarata). */
async function portalSeverityOptionsQuery(_: unknown, __: unknown, ctx: GraphQLContext) {
  const options = await portalSeverityOptions(ctx.tenantId)
  return options === null ? null : options.map(toGraphQLOption)
}

async function setPortalSeverityOptionsMutation(_: unknown, args: { options: PortalSeverityOptionInput[] }, ctx: GraphQLContext) {
  const saved = await setPortalSeverityOptions(ctx.tenantId, args.options)
  void audit(ctx, 'tenant.portal_severity_options.updated', 'Tenant', ctx.tenantId, { options: saved })
  return saved.map(toGraphQLOption)
}

function toGraphQLOption(o: PortalSeverityOption) {
  return { value: o.value, labels: Object.entries(o.labels).map(([language, label]) => ({ language, label })) }
}

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
  { title, description, priority, category, customFields }: {
    title: string; description?: string; priority?: string | null; category: string; customFields?: CustomFieldInput[] | null
  },
  ctx: GraphQLContext,
) {
  validateStringLength(title, 'title', 1, 500)
  validateStringLength(description, 'description', 0, 10000)

  // No defaults: a missing priority is a client bug, not "medium".
  if (!priority) throw new ValidationError('priority is required', { key: 'errors.portal.priorityRequired' })
  // Solo le severità che l'amministratore offre nel portale (verifica «Cosa
  // resta cablato», ondata 1): il vocabolario intero lo valida il servizio, ma
  // dal portale non si apre un ticket con un valore che il portale non offre.
  const lingua = await languageFor(ctx.tenantId)
  const choices = await portalSeverityChoices(ctx.tenantId, lingua)
  if (!choices.some((c) => c.value === priority)) {
    throw new ValidationError(
      `"${priority}" is not one of the severities offered in the portal (${choices.map((c) => c.value).join(', ')}).`,
      { key: 'errors.portal.severityNotOffered', params: { value: priority, allowed: choices.map((c) => c.label).join(', ') } },
    )
  }

  // Revisione del 14 set 2026 · IT-4: il ticket nasce dal servizio, come ogni
  // incident — numero, workflow, `incident.created` (SLA, regole di notifica,
  // automazioni), embedding, osservatore. Priorità e categoria sono validate
  // lì contro il Dizionario del cliente, anche quando il cliente non ne ha una
  // copia (prima la validazione si saltava: IT-7).
  const created = await incidentService.createIncident(
    // I campi del cliente passano sempre dal controllo: un campo obbligatorio
    // offerto all'utente finale va compilato anche se il client non lo manda.
    { title, description, severity: priority, category, customFields: customFields ?? [] },
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
    const mapped = mapTicket(props)
    return { ...mapped, ...(await severityMeta(ctx.tenantId, lingua))(mapped.priority) }
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
        MATCH (e {id: $ticketId, tenant_id: $tenantId})
        WHERE e:Incident OR e:ServiceRequest
        RETURN e.created_by AS createdBy, labels(e) AS labels
      `, { ticketId, tenantId: ctx.tenantId }),
    )

    if (!check.records.length) throw new ForbiddenError('Ticket not found')
    const kind = kindOfLabels(check.records[0].get('labels') as string[], ticketId)
    if (check.records[0].get('createdBy') !== ctx.userId) throw new ForbiddenError('Access denied')
    if (await isEntityClosed(session, ticketId, ctx.tenantId)) {
      throw new ValidationError('The ticket is closed: open a new one', { key: 'errors.comment.ticketClosed' })
    }

    // Un modello solo (F1): lo staff vede questo commento nel dettaglio
    // dell'incident, e la sua risposta pubblica torna qui.
    const row = await writeTicketComment(session, {
      entityType: kind, entityId: ticketId, tenantId: ctx.tenantId,
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
      entityKind:  kind,
      entityLabel: PORTAL_TICKET_SHAPE[kind].label,
    }
  }, true)

  void audit(ctx, 'portal.comment.added', comment.entityLabel, ticketId)
  // Chi segue il ticket (lo staff che ci lavora) deve sapere che l'utente ha scritto.
  void notifyWatchers(ctx.tenantId, comment.entityKind, ticketId, { kind: 'text', text: comment.body.slice(0, 100) }, ctx.userId)
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
        MATCH (e {id: $ticketId, tenant_id: $tenantId})
        WHERE e:Incident OR e:ServiceRequest
        OPTIONAL MATCH (e)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN e.created_by AS createdBy, e.status AS status, wi.id AS instanceId, labels(e) AS labels
      `, { ticketId, tenantId: ctx.tenantId }),
    )

    if (!check.records.length) throw new ForbiddenError('Ticket not found')

    const r          = check.records[0]
    const createdBy  = r.get('createdBy')  as string
    const status     = r.get('status')     as string
    const instanceId = r.get('instanceId') as string | null

    if (createdBy !== ctx.userId) throw new ForbiddenError('Access denied')
    if (!instanceId) throw new ValidationError(`Ticket ${ticketId} has no workflow instance and cannot be reopened`)

    const kind = kindOfLabels(r.get('labels') as string[], ticketId)
    const { getWorkflowSteps } = await import('../../lib/workflowHelpers.js')
    const steps = await getWorkflowSteps(session, ctx.tenantId, kind)
    // Revisione totale · H-12: si riapre da QUALUNQUE passo di categoria
    // `resolved`, non solo dal primo che il workflow dichiara — il portale
    // offre «Riapri» su tutti, e sul secondo l'API rispondeva CONFLICT.
    if (!steps.some((s) => s.category === 'resolved' && s.name === status)) {
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
        `The ${kind} workflow defines no transition from "${status}" back to an open step: reopening is not allowed`,
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

    void audit(ctx, 'portal.ticket.reopened', PORTAL_TICKET_SHAPE[kind].label, ticketId, { fromStep: status, toStep: reopenTo.name })

    const updated = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e {id: $ticketId, tenant_id: $tenantId})
        WHERE e:Incident OR e:ServiceRequest
        RETURN properties(e) AS props
      `, { ticketId, tenantId: ctx.tenantId }),
    )
    const props = updated.records[0]?.get('props') as Record<string, unknown> | undefined
    if (!props) throw new Error(`${PORTAL_TICKET_SHAPE[kind].label} ${ticketId} vanished after reopen transition`)
    const mapped = mapTicket(props, kind)
    return { ...mapped, ...(await severityMeta(ctx.tenantId, await languageFor(ctx.tenantId)))(mapped.priority) }
  }, true)
}

// ── Resolver map ──────────────────────────────────────────────────────────────

export const portalResolvers = {
  Query: {
    myTickets,
    myTicket,
    portalCustomFields,
    myTicketStats,
    ticketCategories,
    portalSeverityChoices: portalSeverityChoicesQuery,
    portalSeverityOptions: portalSeverityOptionsQuery,
  },
  Mutation: {
    createTicket,
    addTicketComment,
    reopenTicket,
    setPortalSeverityOptions: setPortalSeverityOptionsMutation,
  },
}
