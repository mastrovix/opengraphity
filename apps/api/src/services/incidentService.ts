import { v4 as uuidv4 } from 'uuid'
import { customFieldDefs, resolveCustomFieldWrites, type CustomFieldInput } from '../lib/ticketCustomFields.js'
import { creationStepContext } from '../lib/customFieldSteps.js'
import { nextTicketNumber } from '../lib/ticketNumbering.js'
import { resolveNewTicketPriority } from '../lib/priority.js'
import { workflowEngine } from '@opengraphity/workflow'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import { withSession, getSession } from '../graphql/resolvers/ci-utils.js'
import { mapIncident } from '../lib/mappers.js'
import { NotFoundError, ValidationError } from '../lib/errors.js'
import { validateStringLength } from '../lib/validation.js'
import { enqueueEmbedding } from '../jobs/embeddingWorker.js'
import { publishEvent } from '../lib/publishEvent.js'
import { publishStepEnteredForEntity } from '../lib/stepEnteredPublisher.js'
import { getInitialStepName, getWorkflowSteps } from '../lib/workflowHelpers.js'
import { targetStepByCategory } from '../lib/workflowTargets.js'
import { TICKET_TEAM_ASSIGNED_EVENT, type TicketTeamAssignedPayload } from '@opengraphity/types'
import { ciLabelPredicateForTenant } from '../lib/ciLabelsForTenant.js'
import { assertUserInAssignedTeam, setTicketTeam, setTicketUser } from './ticketAssignment.js'
import { systemText } from '../lib/systemText.js'
import { assertDomainValue } from '../lib/domainMatrix.js'
import { assertCIsLinkable } from '../lib/ticketCIExclusions.js'
import { transitionFailed } from '../lib/transitionError.js'

export interface IncidentEventPayload {
  id: string; title: string; severity: string; status: string
  ciName: string; assignedTo: string
  resolved_at?: string; affected_ci_ids?: string[]
  /**
   * `incident.assigned` of a team set while the incident was being created:
   * routing, not a response — the SLA engine does not count it as one
   * (packages/sla, `handleEntityResponded`).
   */
  routed_at_creation?: boolean
}

export interface ServiceCtx {
  tenantId: string
  userId: string
  /**
   * Chi agisce quando non è una persona: il nome della regola o del trigger
   * (lib/actionExecutor.ts). Finisce in `author_label` dei commenti scritti
   * dal servizio — giro UI del 15 set 2026 · U-8: la nota «Riassegnato al team»
   * di una regola compariva come «Automation:» senza nome e con l'avatar «?».
   */
  actorLabel?: string
}

type Session = ReturnType<typeof getSession>
type Props = Record<string, unknown>

// ── Internal helpers ─────────────────────────────────────────────────────────

async function loadIncidentPayload(
  session: Session,
  incidentId: string,
  tenantId: string,
): Promise<IncidentEventPayload | null> {
  const result = await session.executeRead((tx) =>
    tx.run(`
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
      OPTIONAL MATCH (i)-[:AFFECTED_BY]->(ci)
      OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(u:User)
      RETURN i.id AS id, i.title AS title,
             i.severity AS severity, i.status AS status,
             collect(ci.name)[0] AS ciName,
             u.name AS assignedTo
    `, { incidentId, tenantId }),
  )
  if (!result.records.length) return null
  const r = result.records[0]
  return {
    id:         r.get('id')         as string,
    title:      r.get('title')      as string,
    severity:   r.get('severity')   as string,
    status:     r.get('status')     as string,
    ciName:     (r.get('ciName')    ?? '—') as string,
    assignedTo: (r.get('assignedTo') ?? '—') as string,
  }
}

async function createTransitionComment(
  session: Session,
  incidentId: string,
  tenantId: string,
  userId: string,
  text: string,
  authorLabel: string | null = null,
) {
  const now = new Date().toISOString()
  await session.executeWrite((tx) => tx.run(`
    MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
    CREATE (c:Comment {
      id:         randomUUID(),
      tenant_id:  $tenantId,
      text:       $text,
      // Testo del sistema: nota interna (lib/ticketComments.ts).
      is_internal: true,
      author_id:  $userId,
      author_label: $authorLabel,
      created_at: $now,
      updated_at: $now
    })
    CREATE (i)-[:HAS_COMMENT]->(c)
  `, { incidentId, tenantId, text, userId, authorLabel, now }))
}

/**
 * Commento in timeline scritto da un attore di sistema (es. `monitoring`,
 * services/eventCorrelation.ts). Stesso nodo :Comment delle transizioni
 * manuali: l'incident non viene toccato con Cypher fuori da questo servizio.
 */
export async function addIncidentComment(id: string, ctx: ServiceCtx, text: string): Promise<void> {
  await withSession(async (session) => {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN i.id AS id
    `, { id, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('Incident', id)
    await createTransitionComment(session, id, ctx.tenantId, ctx.userId, text, ctx.actorLabel ?? null)
  }, true)
}

/**
 * Cambia il titolo di un incident da un canale automatico (giro UI del 15 set
 * 2026 · U-6: l'incident di un servizio riaperto per «degradato» restava
 * intitolato «non disponibile»). Aggiorna anche la similarità, che legge il
 * titolo. Un incident che non esiste è un errore.
 */
export async function setIncidentTitle(id: string, ctx: ServiceCtx, title: string): Promise<void> {
  if (typeof title !== 'string' || title.trim() === '') throw new ValidationError('Incident title must not be empty')
  const now = new Date().toISOString()
  await withSession(async (session) => {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      SET i.title = $title, i.updated_at = $now
      RETURN i.id AS id
    `, { id, tenantId: ctx.tenantId, title, now })
    if (!row) throw new NotFoundError('Incident', id)
  }, true)
  // The version is the incident's updated_at, as when the similarity panel asks for it (D15).
  enqueueEmbedding({ entityType: 'incident', entityId: id, tenantId: ctx.tenantId, updatedAt: now }).catch((err: unknown) => {
    logger.error({ err, incidentId: id }, '[embeddings] enqueue failed — similarity will lag until backfill')
  })
}

// buildEvent removed — using shared publishEvent from lib/publishEvent.ts


/** A resolved/assigned incident must always reload; a null payload after a
 *  successful write is a real error, not a reason to publish a fabricated event. */
function requirePayload(payload: IncidentEventPayload | null, id: string): IncidentEventPayload {
  if (!payload) throw new Error(`Incident ${id} not found while building event payload`)
  return payload
}

// ── Public service operations ─────────────────────────────────────────────────

/**
 * Da dove arriva l'incident. `portal`: l'ha aperto l'utente finale dal portale.
 *
 * Revisione del 14 set 2026 · IT-4: il portale scriveva l'incident con una
 * Cypher sua — niente numero, niente `incident.created` (quindi niente SLA,
 * regole di notifica, automazioni, embedding, osservatore), priorità copiata
 * senza matrice. Ora passa di qui come ogni altro canale. L'unica differenza è
 * dichiarata: l'utente finale non conosce i CI, quindi dal portale l'incident
 * può nascere senza CI impattato, e il Service Desk lo collega nella presa in
 * carico. Categoria e priorità sono validate contro il Dizionario del cliente
 * (anche quando il cliente non ne ha una copia: IT-7).
 */
export type IncidentChannel = 'agent' | 'portal'

/**
 * WHO TAKES A NEW INCIDENT (the owner's rule, 23 Sep 2026).
 *
 * «When you create an incident you name a CI, and it is assigned
 * automatically to its support group.» The team is `teamId` when the caller
 * chose one — the form prefills it with the CI's support group, and the
 * person may change it — otherwise the support group (`SUPPORTED_BY`) of the
 * first impacted CI that has one, in the order given. Every channel goes
 * through here: the form, the REST API, Slack, the inbound webhooks, the
 * monitoring alarms (tour of 23 Sep 2026, D61: their incidents had no team,
 * and nobody was told about a critical one), the monitored services, the
 * workflow actions. A CI without a support group leaves the incident without
 * a team, as before.
 */
async function supportGroupOfCIs(tenantId: string, ciIds: readonly string[]): Promise<{ teamId: string; ciName: string } | null> {
  if (ciIds.length === 0) return null
  return withSession((session) => runQueryOne<{ teamId: string; ciName: string }>(session, `
    UNWIND range(0, size($ciIds) - 1) AS idx
    MATCH (ci:ConfigurationItem {id: $ciIds[idx], tenant_id: $tenantId})-[:SUPPORTED_BY]->(t:Team {tenant_id: $tenantId})
    RETURN t.id AS teamId, ci.name AS ciName
    ORDER BY idx, t.name
    LIMIT 1
  `, { tenantId, ciIds: [...ciIds] }))
}

/** A team chosen by the caller must exist in the tenant, checked BEFORE the incident is written. */
async function assertTeamOfTenant(tenantId: string, teamId: string): Promise<void> {
  const row = await withSession((session) => runQueryOne<{ id: string }>(session,
    'MATCH (t:Team {id: $teamId, tenant_id: $tenantId}) RETURN t.id AS id', { teamId, tenantId }))
  if (!row) throw new ValidationError(`Team ${teamId} does not exist in this organization`, { key: 'errors.incident.teamNotFound', params: { teamId } })
}

/**
 * The new incident goes to its team, and the rules on the assignment notify
 * the team — but it stays in its first step: the group's queue. Leaving that
 * step is the response of the SLA (packages/sla, `from_initial`), and the
 * response is a person of the group taking the incident in charge, not the
 * routing that happened while it was being created: moving it on here made
 * every incident with a CI «responded» at the instant it was opened. Any
 * failure says that the incident exists and what did not happen.
 */
async function assignNewIncident(
  created: ReturnType<typeof mapIncident>, team: { teamId: string; ciName: string | null }, ctx: ServiceCtx,
): Promise<ReturnType<typeof mapIncident>> {
  try {
    return (await assignIncidentToTeam(String(created.id), team.teamId, ctx, { supportGroupOf: team.ciName })).incident
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ValidationError(
      `Incident ${String(created.number ?? created.id)} was created, but assigning it to its team failed: ${reason}`,
      { key: 'errors.incident.createdButNotAssigned', params: { number: String(created.number ?? created.id), reason } },
    )
  }
}

export async function createIncident(
  input: { title: string; description?: string; severity?: string; impact?: string; urgency?: string; category?: string; affectedCIIds?: string[]; acknowledgeNoSla?: boolean | null; customFields?: CustomFieldInput[] | null; teamId?: string | null },
  ctx: ServiceCtx,
  channel: IncidentChannel = 'agent',
) {
  validateStringLength(input.title, 'title', 1, 500)
  validateStringLength(input.description, 'description', 0, 10000)
  if (input.teamId) await assertTeamOfTenant(ctx.tenantId, input.teamId)

  // ITIL: an incident must record the impacted CI(s) — required, not optional.
  // L'eccezione dichiarata è il portale (vedi `IncidentChannel`).
  if (channel !== 'portal' && (!input.affectedCIIds || input.affectedCIIds.length === 0)) {
    throw new ValidationError('An incident must have at least one impacted CI', { key: 'errors.incident.needsCI' })
  }
  if (channel === 'portal') {
    if (!input.category) throw new ValidationError('category is required', { key: 'errors.portal.categoryRequired' })
    await assertDomainValue(ctx.tenantId, 'category', input.category)
  }
  // CM-8 (revisione del 15 set 2026): i tipi di CI esclusi per gli incident, PRIMA
  // di scrivere. Vale per ogni canale, compresi monitoraggio e servizi monitorati
  // (scelta del proprietario): l'errore nomina i CI e dove togliere l'esclusione.
  await assertCIsLinkable(ctx.tenantId, 'incident', input.affectedCIIds ?? [])

  // ITIL: Priority = f(Impact, Urgency). La priorità derivata si salva nel
  // campo `severity` (SLA/pastiglie/filtri leggono quello). Impatto+urgenza
  // vincono; la sola `severity` resta accettata per i client API.
  //
  // Ondata 7 (C-8): impatto, urgenza e severità sono validati contro i
  // VOCABOLARI DEL CLIENTE e tradotti dalla sua matrice `priority`. Prima
  // nessuno li validava: un allarme o un client API scriveva `severity =
  // 'critical'` anche su un tenant che aveva rinominato quel valore, e la
  // selezione della SLA e i report non lo contavano piu'.
  const resolved = await resolveNewTicketPriority(ctx.tenantId, input)
  const severity = resolved.severity
  const impact   = resolved.impact
  const urgency  = resolved.urgency

  // Campi personalizzati (ondata 4). Solo i canali che li conoscono li mandano
  // (pagine, portale, REST, import): lì valgono tipo, vocabolario, obbligo e
  // script. Monitoraggio, servizi e Slack non conoscono i campi del cliente e
  // non mandano la chiave — un campo obbligatorio non deve fermare un allarme,
  // come già non lo fermano le regole di obbligatorietà.
  const customProps = input.customFields == null ? {} : await withSession(async (session) =>
    resolveCustomFieldWrites(ctx.tenantId, 'incident', await customFieldDefs(session, ctx.tenantId, 'incident'), input.customFields, { current: null, endUser: channel === 'portal', stepContext: await creationStepContext(session, ctx.tenantId, 'incident', input.category ?? null) }))

  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    // Formato del cliente (verifica «Cosa resta cablato», ondata 6), contatore del prodotto.
    const number = await nextTicketNumber(session, ctx.tenantId, 'incident')

    const initialStatus = await getInitialStepName(session, ctx.tenantId, 'incident')
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (i:Incident {
        id:           $id,
        tenant_id:    $tenantId,
        number:       $number,
        title:        $title,
        description:  $description,
        severity:     $severity,
        impact:       $impact,
        urgency:      $urgency,
        category:     $category,
        status:       $status,
        created_at:   $now,
        updated_at:   $now,
        // Chi l'ha aperto e da dove: il portale elenca i ticket dell'utente
        // per created_by, quindi un incident del portale deve portarlo.
        created_by:   $userId,
        channel:      $channel,
        // Chi l'ha creato ha visto l'avviso «nessuna policy SLA lo copre» e
        // l'ha accettato: la diagnostica non lo conta fra i ticket senza SLA.
        sla_absence_acknowledged_at: $ackAt,
        sla_absence_acknowledged_by: $ackBy
      })
      SET i += $customProps
      RETURN properties(i) as props
    `, {
      id, tenantId: ctx.tenantId, number,
      title: input.title, description: input.description ?? null,
      severity, impact, urgency,
      category: input.category ?? null,
      status: initialStatus, now,
      userId: ctx.userId, channel,
      ackAt: input.acknowledgeNoSla === true ? now : null,
      ackBy: input.acknowledgeNoSla === true ? ctx.userId : null,
      customProps,
    })
    if (!rows[0]) throw new ValidationError('Failed to create incident')
    return mapIncident(rows[0].props)
  }, true)

  // C-2 (CRITICO): il collegamento ai CI impattati viene CONTATO e, se manca,
  // l'operazione fallisce. Prima il `MERGE` girava sotto un predicato con le
  // etichette fisse e nessuno leggeva il risultato: un CI di un tipo del
  // cliente (o cancellato fra la creazione e questo passo) dava zero righe,
  // cioè un incident senza `AFFECTED_BY` — in contraddizione con la guardia
  // «un incident deve avere almeno un CI impattato» tre righe sopra, senza
  // errore, senza log, e invisibile all'incident di servizio (che cita gli
  // incident tecnici proprio via `AFFECTED_BY`). Contare le righe scritte è la
  // pratica già usata due volte nello stesso sottosistema
  // (serviceImpact/build.ts:241-243, config.ts:612-614).
  if (input.affectedCIIds && input.affectedCIIds.length > 0) {
    const affectedCIIds = input.affectedCIIds
    const ciPredicate = await ciLabelPredicateForTenant('ci', ctx.tenantId)
    const missing: string[] = []
    await withSession(async (session) => {
      for (const ciId of affectedCIIds) {
        const rows = await runQuery<{ linked: unknown }>(session, `
          MATCH (i:Incident {id: $id, tenant_id: $tenantId})
          MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
          WHERE ${ciPredicate}
          MERGE (i)-[r:AFFECTED_BY]->(ci)
          RETURN count(r) AS linked
        `, { id, tenantId: ctx.tenantId, ciId })
        if (Number(rows[0]?.linked ?? 0) === 0) missing.push(ciId)
      }
    }, true)
    if (missing.length > 0) {
      // L'incident era già stato committato in una transazione sua: lasciarlo
      // lì significherebbe tenere in banca dati proprio l'incident senza CI
      // che la guardia vieta, e senza istanza di workflow (creata dopo). Lo si
      // toglie e si dice perché.
      await withSession(async (session) => {
        await runQuery(session, `
          MATCH (i:Incident {id: $id, tenant_id: $tenantId}) DETACH DELETE i
        `, { id, tenantId: ctx.tenantId })
      }, true)
      logger.error({ incidentId: id, tenantId: ctx.tenantId, missing, number: created.number },
        '[incidentService] CI impattati non collegabili: incident annullato (violerebbe l\'invariante «almeno un CI impattato»)')
      throw new ValidationError(
        `Incident not created: ${missing.length} of the ${affectedCIIds.length} impacted CIs do not exist in this tenant, or are not Configuration Items (${missing.join(', ')})`,
        { key: 'errors.incident.ciMissing', params: { missing: missing.length, total: affectedCIIds.length, ids: missing.join(', ') } },
      )
    }
  }

  /**
   * Un incident SENZA workflow non deve restare nel grafo (revisione totale ·
   * B-6): la creazione passa da più transazioni, e se `createInstance`
   * falliva — un workflow di categoria senza passo iniziale, due passi
   * marcati iniziali, un errore transiente — l'incident era già committato,
   * numerato e collegato ai CI, ma senza istanza: non si poteva transizionare
   * né chiudere, e l'unico rimedio era il database. Si annulla come per i CI
   * mancanti, e si dice perché.
   */
  try {
    await withSession(async (session) => {
      await workflowEngine.createInstance(session, ctx.tenantId, id, 'incident', undefined, input.category ?? null)
    }, true)
  } catch (err) {
    await withSession(async (session) => {
      await runQuery(session, 'MATCH (i:Incident {id: $id, tenant_id: $tenantId}) DETACH DELETE i', { id, tenantId: ctx.tenantId })
    }, true)
    logger.error({ err, incidentId: id, tenantId: ctx.tenantId, number: created.number, category: input.category ?? null },
      '[incidentService] istanza di workflow non creata: incident annullato (resterebbe senza workflow)')
    throw new ValidationError(
      `Incident not created: its workflow instance could not be started (${err instanceof Error ? err.message : String(err)})`,
      { key: 'errors.incident.workflowInstance', params: { reason: err instanceof Error ? err.message : String(err) } },
    )
  }

  // Auto-watch: creator becomes watcher
  await withSession(async (session) => {
    await session.executeWrite(tx => tx.run(`
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      MATCH (i:Incident {id: $entityId, tenant_id: $tenantId})
      MERGE (u)-[:WATCHES {watched_at: $now}]->(i)
    `, { userId: ctx.userId, tenantId: ctx.tenantId, entityId: id, now }))
  }, true)

  // Il CI e l'assegnatario VERI nel payload (revisione totale · B-7): erano
  // scritti a mano come «—», e una regola di notifica che mette il CI nel
  // testo mostrava «—» anche su un incident con tre CI. Il payload si rilegge
  // dal grafo, come fa `assignIncidentToUser`.
  const createdPayload = await withSession((s) => loadIncidentPayload(s, id, ctx.tenantId))
  await publishEvent('incident.created', ctx.tenantId, ctx.userId, {
    ...requirePayload(createdPayload, id),
    affected_ci_ids: input.affectedCIIds ?? [],
  } satisfies IncidentEventPayload, now)

  // Trigger, Business Rule e trigger a tempo: li mette in moto `incident.created`
  // (consumers/automationConsumer.ts), come per ogni altro ticket e evento.
  enqueueEmbedding({ entityType: 'incident', entityId: id, tenantId: ctx.tenantId, updatedAt: now }).catch((err: unknown) => {
    logger.error({ err, incidentId: id }, '[embeddings] enqueue failed — similarity will lag until backfill')
  })

  // After `incident.created`: the SLA starts there, and the assignment may change its policy (SL-10).
  const team = input.teamId
    ? { teamId: input.teamId, ciName: null }
    : await supportGroupOfCIs(ctx.tenantId, input.affectedCIIds ?? [])
  return team ? assignNewIncident(created, team, ctx) : created
}

export async function resolveIncident(
  id: string,
  ctx: ServiceCtx,
  notes?: string,
) {
  const now = new Date().toISOString()

  const resolved = await withSession(async (session) => {
    // Transition workflow to the step marked as category='resolved' (or,
    // if none, the first terminal step). The engine syncs entity.status
    // and records the step history; we only handle fields the engine
    // doesn't know about (resolved_at, root_cause).
    const instanceRow = await runQueryOne<{ instanceId: string }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId
    `, { id, tenantId: ctx.tenantId })
    if (!instanceRow) throw new NotFoundError('Incident', id)

    const steps = await getWorkflowSteps(session, ctx.tenantId, 'incident')
    const resolvedStep =
      steps.find((s) => s.category === 'resolved') ??
      steps.find((s) => s.isTerminal)
    if (!resolvedStep) throw new ValidationError('No resolved/terminal step in incident workflow')

    const result = await workflowEngine.transition(
      session,
      { instanceId: instanceRow.instanceId, toStepName: resolvedStep.name,
        triggeredBy: ctx.userId, triggerType: 'manual', notes: notes ?? undefined, tenantId: ctx.tenantId },
      { userId: ctx.userId, notes, entityData: {} },
    )
    // Revisione del 14 set 2026 · IT-2: l'esito era ignorato. Un rifiuto del
    // motore (condizione, arco mancante, transizione concorrente) lasciava
    // l'incident nel passo di prima ma con `resolved_at` scritto e
    // `incident.resolved` pubblicato: risolto per SLA e notifiche, aperto per
    // chi ci lavora.
    if (!result.success) throw transitionFailed(result, `Incident ${id}: the workflow refused the transition to "${resolvedStep.name}"`)

    // Fields the engine doesn't touch.
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      SET i.resolved_at = $now,
          i.root_cause  = coalesce($rootCause, i.root_cause),
          i.updated_at  = $now
      RETURN properties(i) as props
    `, { id, tenantId: ctx.tenantId, now, rootCause: notes ?? null })
    if (!rows[0]) throw new NotFoundError('Incident', id)
    return mapIncident(rows[0].props)
  }, true)

  const payload = await withSession((s) => loadIncidentPayload(s, id, ctx.tenantId))
  await publishEvent('incident.resolved', ctx.tenantId, ctx.userId, {
    ...requirePayload(payload, id),
    resolved_at: now,
  } satisfies IncidentEventPayload, now)

  return resolved
}

export async function assignIncidentToTeam(
  id: string,
  teamId: string,
  ctx: ServiceCtx,
  /**
   * Set by the creation: the incident stays in its first step (see
   * `assignNewIncident`), and when the team is the support group of a CI
   * (`supportGroupOf`, its name) the note says so.
   */
  atCreation?: { supportGroupOf: string | null },
) {
  if (!teamId?.trim()) throw new ValidationError('teamId is required', { key: 'errors.assignment.teamRequired' })
  const now = new Date().toISOString()

  // IT-2: l'avanzamento automatico dal passo iniziale poteva essere rifiutato
  // dal motore senza che nessuno lo sapesse. L'assegnazione resta (è ciò che
  // la persona ha chiesto, ed è già scritta), l'evento parte, e poi l'errore
  // dice che il ticket non è avanzato e perché.
  let advanceRefused: { result: Awaited<ReturnType<typeof workflowEngine.transition>>; toStep: string } | null = null
  /*
   * I nomi escono dal servizio perché il REGISTRO li vuole (20 set 2026,
   * ondata 2): `incident.assigned` non diceva né a chi né da chi, e le due
   * mutation — a squadra e a persona — scrivevano la stessa identica riga.
   */
  let nomi: { teamName: string; previousTeamName: string | null; unassignedUserName: string | null } =
    { teamName: '', previousTeamName: null, unassignedUserName: null }
  let advanced = false
  const assigned = await withSession(async (session) => {
    const { teamName, previousTeamName, unassignedUserName } = await setTicketTeam(session, 'Incident', id, teamId, ctx.tenantId)
    nomi = { teamName, previousTeamName, unassignedUserName }
    // D11: «Reassigned» only when there was a team before.
    const transitionNotes = atCreation?.supportGroupOf
      ? await systemText(ctx.tenantId, 'incident.autoAssignedTeam', { team: teamName, ci: atCreation.supportGroupOf })
      : await systemText(ctx.tenantId, previousTeamName ? 'incident.reassignedTeam' : 'incident.assignedTeam', { team: teamName })
    // M-10: l'assegnatario che non è nel gruppo nuovo è stato staccato. Non è
    // un dettaglio tecnico: chi guarda il ticket deve sapere che non ha più un
    // assegnatario, e perché.
    if (unassignedUserName) {
      await createTransitionComment(session, id, ctx.tenantId, ctx.userId,
        await systemText(ctx.tenantId, 'incident.unassignedOnTeamChange', { user: unassignedUserName, team: teamName }),
        ctx.actorLabel ?? null)
    }

    const wiResult = await session.executeRead((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId, wi.current_step AS currentStep
    `, { id, tenantId: ctx.tenantId }))

    if (wiResult.records.length > 0) {
      const instanceId  = wiResult.records[0]!.get('instanceId')  as string
      const currentStep = wiResult.records[0]!.get('currentStep') as string
      const initialStep = await getInitialStepName(session, ctx.tenantId, 'incident')

      if (currentStep === initialStep && !atCreation) {
        // Assigning a team from the initial step auto-advances the workflow.
        // Take the first manual transition available — the workflow defines
        // the post-assignment step, not this service.
        const next = await assignmentAdvanceTarget(session, ctx.tenantId, instanceId)
        if (next) {
          const result = await workflowEngine.transition(
            session,
            { instanceId, toStepName: next.toStep, triggeredBy: ctx.userId, triggerType: 'automatic', notes: transitionNotes, actorLabel: ctx.actorLabel ?? null, tenantId: ctx.tenantId },
            { userId: ctx.userId, entityData: {} },
          )
          if (!result.success) advanceRefused = { result, toStep: next.toStep }
          else advanced = true
        }
      } else {
        // Reassignment while already past the initial step, or the team of a
        // new incident: just log a history entry against the current step,
        // no transition.
        await session.executeWrite((tx) => tx.run(`
          MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
          CREATE (wi)-[:STEP_HISTORY]->(:WorkflowStepExecution {
            id:           randomUUID(),
            tenant_id:    $tenantId,
            instance_id:  wi.id,
            step_name:    wi.current_step,
            entered_at:   $now,
            exited_at:    $now,
            duration_ms:  toInteger(0),
            triggered_by: $userId,
            trigger_type: 'manual',
            notes:        $notes
          })
        `, { incidentId: id, tenantId: ctx.tenantId, now, userId: ctx.userId, notes: transitionNotes }))
      }
      // D12: a transition already wrote «Workflow: <step> — <note>» on the
      // ticket (lib/stepEnteredPublisher.ts); writing the note again made two.
      if (!advanced) await createTransitionComment(session, id, ctx.tenantId, ctx.userId, transitionNotes, ctx.actorLabel ?? null)
    }

    const r = await session.executeRead((tx) => tx.run(
      `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
      { id, tenantId: ctx.tenantId },
    ))
    if (!r.records[0]) throw new NotFoundError('Incident', id)
    const assigned = mapIncident(r.records[0].get('props') as Props)
    // B-7: il CI era «—» su «assegnato al team» e corretto su «assegnato a
    // persona». Ora il payload è lo stesso, letto dal grafo; l'assegnatario è
    // il gruppo, che è quello che è appena stato scelto.
    const assignedPayload = await loadIncidentPayload(session, id, ctx.tenantId)
    await publishEvent('incident.assigned', ctx.tenantId, ctx.userId, {
      ...requirePayload(assignedPayload, id),
      assignedTo: teamName,
      ...(atCreation ? { routed_at_creation: true } : {}),
    } satisfies IncidentEventPayload, now)
    // SL-10: la policy SLA può dipendere dal gruppo appena assegnato.
    await publishEvent(TICKET_TEAM_ASSIGNED_EVENT, ctx.tenantId, ctx.userId, { entity_type: 'incident', entity_id: id, team_id: teamId } satisfies TicketTeamAssignedPayload, now)
    return assigned
  }, true)
  if (advanceRefused) throw assignedButNotAdvanced(id, advanceRefused)
  return { incident: assigned, ...nomi }
}

/**
 * Dove va l'incident quando lo si assegna dal passo iniziale — revisione del
 * 14 set 2026 · IT-3.
 *
 * Prima: la PRIMA transizione restituita dal motore, cioè l'ordine in cui il
 * grafo restituiva gli archi. Con due archi in uscita dal passo iniziale (il
 * workflow «Security» di c-test ne ha due) la destinazione cambiava fra un
 * caricamento e l'altro. Adesso la regola è dichiarata e la decide il cliente
 * nel disegnatore: fra le transizioni manuali disponibili, verso passi aperti e
 * non terminali, quella verso il passo con l'ordine (`step_order`) più basso; a
 * pari ordine, il nome.
 */
async function assignmentAdvanceTarget(session: Session, tenantId: string, instanceId: string): Promise<{ toStep: string } | null> {
  const transitions = await workflowEngine.getAvailableTransitions(session, instanceId)
  if (transitions.length === 0) return null
  const steps = new Map((await getWorkflowSteps(session, tenantId, 'incident')).map((s) => [s.name, s]))
  const candidates = transitions
    .map((t) => ({ t, step: steps.get(t.toStep) }))
    .filter((c) => c.step && c.step.isOpen && !c.step.isTerminal)
    .sort((a, b) => ((a.step!.stepOrder ?? Number.MAX_SAFE_INTEGER) - (b.step!.stepOrder ?? Number.MAX_SAFE_INTEGER)) || a.t.toStep.localeCompare(b.t.toStep))
  return candidates[0]?.t ?? null
}

/** L'assegnazione è avvenuta, l'avanzamento automatico no: l'errore lo dice. */
function assignedButNotAdvanced(
  id: string,
  refused: { result: Awaited<ReturnType<typeof workflowEngine.transition>>; toStep: string },
) {
  const reason = transitionFailed(refused.result, 'the workflow refused the transition')
  return new ValidationError(
    `Incident ${id}: the assignment was saved, but the incident did not move to "${refused.toStep}": ${reason.message}`,
    { key: 'errors.incident.assignedButNotAdvanced', params: { step: refused.toStep, reason: reason.message } },
  )
}

export async function assignIncidentToUser(
  id: string,
  userId: string | null,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()
  let advanceRefused: { result: Awaited<ReturnType<typeof workflowEngine.transition>>; toStep: string } | null = null
  // I nomi escono dal servizio perché il registro li vuole: vedi
  // `assignIncidentToTeam`.
  let nomi: { userName: string | null; previousUserName: string | null } = { userName: null, previousUserName: null }
  let advanced = false

  const assigned = await withSession(async (session) => {
    if (!userId) {
      const { previousUserName } = await setTicketUser(session, 'Incident', id, null, ctx.tenantId)
      nomi = { userName: null, previousUserName }
      const r = await session.executeRead((tx) => tx.run(
        `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
        { id, tenantId: ctx.tenantId },
      ))
      if (!r.records[0]) throw new NotFoundError('Incident', id)
      return mapIncident(r.records[0].get('props') as Props)
    }

    // Regola ITSM condivisa con il problem (services/ticketAssignment.ts):
    // prima il gruppo, poi un utente di quel gruppo.
    await assertUserInAssignedTeam(session, 'Incident', id, userId, ctx.tenantId)
    const { userName: assignedName, previousUserName } = await setTicketUser(session, 'Incident', id, userId, ctx.tenantId)
    const userName = assignedName ?? userId
    nomi = { userName: assignedName, previousUserName }

    const wiResult = await session.executeRead((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId, wi.current_step AS currentStep
    `, { id, tenantId: ctx.tenantId }))

    if (wiResult.records.length > 0) {
      const instanceId  = wiResult.records[0]!.get('instanceId')  as string
      const currentStep = wiResult.records[0]!.get('currentStep') as string
      const initialStep = await getInitialStepName(session, ctx.tenantId, 'incident')

      // Auto-advance SOLO dallo step iniziale (come per il team): assegnare
      // una persona a un incident già avviato non deve far scattare una
      // transizione arbitraria (transitions[0] potrebbe essere "resolved").
      // Da qualunque altro step si registra soltanto l'assegnazione (sotto).
      // D11: «Reassigned» only when someone had it before; the same sentence
      // in the history and in the note.
      const note = await systemText(ctx.tenantId, previousUserName ? 'incident.reassignedUser' : 'incident.assignedUser', { user: userName })
      const next = currentStep === initialStep ? await assignmentAdvanceTarget(session, ctx.tenantId, instanceId) : null
      if (currentStep === initialStep && next) {
        const result = await workflowEngine.transition(
          session,
          { instanceId, toStepName: next.toStep, triggeredBy: ctx.userId, triggerType: 'automatic', notes: note, actorLabel: ctx.actorLabel ?? null, tenantId: ctx.tenantId },
          { userId: ctx.userId, entityData: {} },
        )
        if (!result.success) advanceRefused = { result, toStep: next.toStep }
        else advanced = true
      } else {
        await session.executeWrite((tx) => tx.run(`
          MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
          CREATE (wi)-[:STEP_HISTORY]->(:WorkflowStepExecution {
            id:           randomUUID(),
            tenant_id:    $tenantId,
            instance_id:  wi.id,
            step_name:    wi.current_step,
            entered_at:   $now,
            exited_at:    $now,
            duration_ms:  toInteger(0),
            triggered_by: $userId,
            trigger_type: 'manual',
            notes:        $notes
          })
        `, { incidentId: id, tenantId: ctx.tenantId, now, userId: ctx.userId, notes: note }))
      }
      // D12: after a transition the note is already on the ticket, see assignIncidentToTeam.
      if (!advanced) await createTransitionComment(session, id, ctx.tenantId, ctx.userId, note, ctx.actorLabel ?? null)
    }

    const r = await session.executeRead((tx) => tx.run(
      `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
      { id, tenantId: ctx.tenantId },
    ))
    if (!r.records[0]) throw new NotFoundError('Incident', id)
    const assigned = mapIncident(r.records[0].get('props') as Props)
    const assignedPayload = await loadIncidentPayload(session, id, ctx.tenantId)
    await publishEvent('incident.assigned', ctx.tenantId, ctx.userId,
      requirePayload(assignedPayload, id),
      now,
    )
    return assigned
  }, true)
  if (advanceRefused) throw assignedButNotAdvanced(id, advanceRefused)
  return { incident: assigned, ...nomi }
}

export async function inProgressIncident(
  id: string,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()
  const payload = await withSession((s) => loadIncidentPayload(s, id, ctx.tenantId))
  await publishEvent('incident.in_progress', ctx.tenantId, ctx.userId,
    requirePayload(payload, id),
    now,
  )
}

/**
 * L'ingresso dell'incident in un passo del workflow (D-22).
 *
 * Pubblica DUE eventi con lo stesso payload e lo stesso istante:
 *  1. `incident.step_entered` — il tipo **stabile**, che una rinomina del passo
 *     non tocca. Il nome del passo è nel payload (`step_name`), insieme a
 *     etichetta, scopo, categoria e id: è un dettaglio del passo, non
 *     l'identità dell'evento. È a questo che si agganciano le regole nuove
 *     (per scopo o per categoria) e i webhook di un passo personalizzato.
 *  2. `incident.<stepName>` — l'**alias** storico. Resta perché a lui sono
 *     agganciate le 35 regole di fabbrica, le regole già scritte dai tenant, i
 *     formatter Slack/Teams (che sono per tipo esatto: `incident.resolved` →
 *     carta «risolto») e gli abbonamenti dei webhook: toglierlo spegnerebbe
 *     tutto questo **in silenzio**, che è esattamente il difetto da chiudere.
 *
 * Il dispatcher non consegna due volte: sull'evento stabile salta se esiste
 * già una regola per l'alias di quel passo (vedi packages/notifications).
 */
/**
 * Gli eventi di dominio della transizione di un incident si pubblicano
 * dall'hook `onStepEntered` del motore, che vede TUTTI i cammini —
 * manuali e automatici (revisione totale · C-1, `lib/stepEnteredPublisher.ts`).
 * Questa funzione resta come punto di ingresso per chi deve pubblicarli
 * SENZA passare dal motore (nessun chiamante oggi): pubblicare qui dopo una
 * transizione del motore darebbe eventi doppi.
 */
export async function publishIncidentTransition(
  id: string,
  stepName: string,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()
  await publishStepEnteredForEntity({
    tenantId: ctx.tenantId, actorId: ctx.userId,
    entityType: 'incident', entityId: id, stepName, enteredAt: now,
  })
}

export async function closeIncident(
  id: string,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()
  const payload = await withSession((s) => loadIncidentPayload(s, id, ctx.tenantId))
  await publishEvent('incident.closed', ctx.tenantId, ctx.userId,
    requirePayload(payload, id),
    now,
  )
}

export async function escalateIncident(
  id: string,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()
  await withSession(async (session) => {
    const instanceRow = await runQueryOne<{ instanceId: string }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId
    `, { id, tenantId: ctx.tenantId })
    if (!instanceRow) throw new Error(`Incident ${id}: no workflow instance to escalate`)
    // Revisione · B·N-4: era un `find` su una lista senza ordine (due passi di
    // categoria `escalated` e la scelta era quella che il database dava per
    // prima). `targetStepByCategory` ordina per `step_order` e dice cosa manca.
    const target = await targetStepByCategory(session, ctx.tenantId, 'incident', ['escalated'],
      `escalation of incident ${id}`)
    const result = await workflowEngine.transition(
      session,
      { instanceId: instanceRow.instanceId, toStepName: target,
        triggeredBy: ctx.userId, triggerType: 'manual', tenantId: ctx.tenantId },
      { userId: ctx.userId, entityData: {} },
    )
    // IT-2: senza questo controllo `incident.escalated` partiva anche quando
    // il motore aveva rifiutato l'escalation.
    if (!result.success) throw transitionFailed(result, `Incident ${id}: the workflow refused the escalation to "${target}"`)
  }, true)

  const payload = await withSession((s) => loadIncidentPayload(s, id, ctx.tenantId))
  await publishEvent('incident.escalated', ctx.tenantId, ctx.userId,
    requirePayload(payload, id),
    now,
  )
}
