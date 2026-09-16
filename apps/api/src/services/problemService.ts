import { v4 as uuidv4 } from 'uuid'
import { customFieldDefs, resolveCustomFieldWrites, type CustomFieldInput } from '../lib/ticketCustomFields.js'
import { creationStepContext } from '../lib/customFieldSteps.js'
import { nextTicketNumber } from '../lib/ticketNumbering.js'
import { resolveNewTicketPriority } from '../lib/priority.js'
import { workflowEngine } from '@opengraphity/workflow'
import { runQuery } from '@opengraphity/neo4j'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import type { ServiceCtx } from './incidentService.js'
import { ValidationError } from '../lib/errors.js'
import { assertDomainValue } from '../lib/domainMatrix.js'
import { publishStepEnteredForEntity } from '../lib/stepEnteredPublisher.js'
import { validateStringLength } from '../lib/validation.js'
import { logger } from '../lib/logger.js'
import { publishEvent } from '../lib/publishEvent.js'
import { getInitialStepName } from '../lib/workflowHelpers.js'
import { type ProblemCreatedPayload } from '@opengraphity/types'
import { ciLabelPredicateForTenant } from '../lib/ciLabelsForTenant.js'
import { assertCIsLinkable } from '../lib/ticketCIExclusions.js'

/**
 * Il payload degli eventi del problem. È **lo stesso tipo** che consuma il
 * motore SLA (`@opengraphity/types`), non una copia: due dichiarazioni dello
 * stesso payload sono esattamente come i due lati hanno finito per divergere
 * (il consumatore leggeva `impact`, il produttore spediva `priority`).
 */
export type ProblemEventPayload = ProblemCreatedPayload

type Props = Record<string, unknown>

/**
 * Il payload del problem per gli eventi di dominio è costruito da
 * `lib/stepEnteredPublisher.ts` (revisione totale · C-1), che serve tutte le
 * entità e tutti i cammini. Qui restava una copia usata solo dalla
 * pubblicazione della transizione, che ora passa da lì.
 */

// buildEvent removed — using shared publishEvent


// ── Public service operations ─────────────────────────────────────────────────

export async function createProblem(
  input: { title: string; description?: string; priority?: string; impact?: string; urgency?: string; category?: string; affectedCIs?: string[]; relatedIncidents?: string[]; workaround?: string; acknowledgeNoSla?: boolean | null; customFields?: CustomFieldInput[] | null },
  ctx: ServiceCtx,
) {
  validateStringLength(input.title, 'title', 1, 500)
  // B-3: la categoria è un valore del vocabolario del cliente, come per gli
  // incident. Prima veniva usata per scegliere il workflow e poi scartata.
  if (input.category != null) await assertDomainValue(ctx.tenantId, 'category', input.category)
  // CM-8: i tipi di CI esclusi per i problem, prima di scrivere.
  await assertCIsLinkable(ctx.tenantId, 'problem', input.affectedCIs ?? [])
  // ITIL: Priority = f(Impact, Urgency). Impatto+urgenza vincono. Ondata 7
  // (C-8): valori validati contro i vocabolari del cliente e tradotti dalla
  // sua matrice `priority` — mai piu' un `medium` ricostruito in silenzio.
  const resolved = await resolveNewTicketPriority(ctx.tenantId, { severity: input.priority, impact: input.impact, urgency: input.urgency }, 'priority')
  const priority = resolved.severity
  const impact   = resolved.impact
  const urgency  = resolved.urgency
  // Campi personalizzati (ondata 4): solo dai canali che li mandano (vedi createIncident).
  const customProps = input.customFields == null ? {} : await withSession(async (session) =>
    resolveCustomFieldWrites(ctx.tenantId, 'problem', await customFieldDefs(session, ctx.tenantId, 'problem'), input.customFields, { current: null, stepContext: await creationStepContext(session, ctx.tenantId, 'problem', input.category ?? null) }))
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    // Formato del cliente (verifica «Cosa resta cablato», ondata 6), contatore del prodotto.
    const number = await nextTicketNumber(session, ctx.tenantId, 'problem')

    const initialStatus = await getInitialStepName(session, ctx.tenantId, 'problem')
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (p:Problem {
        id:          $id,
        tenant_id:   $tenantId,
        number:      $number,
        title:       $title,
        description: $description,
        priority:    $priority,
        impact:      $impact,
        urgency:     $urgency,
        // B-3: la categoria scelta resta sul nodo — sceglie il workflow E le
        // policy SLA per categoria la leggono da qui (packages/sla/status.ts).
        category:    $category,
        status:      $status,
        workaround:  $workaround,
        created_at:  $now,
        updated_at:  $now,
        // Chi l'ha creato ha visto l'avviso «nessuna policy SLA lo copre» e
        // l'ha accettato: la diagnostica non lo conta fra i ticket senza SLA.
        sla_absence_acknowledged_at: $ackAt,
        sla_absence_acknowledged_by: $ackBy
      })
      SET p += $customProps
      RETURN properties(p) as props
    `, {
      id, tenantId: ctx.tenantId, number,
      title: input.title, description: input.description ?? null,
      priority, impact, urgency,
      category: input.category ?? null,
      workaround: input.workaround ?? null,
      status: initialStatus, now,
      ackAt: input.acknowledgeNoSla === true ? now : null,
      ackBy: input.acknowledgeNoSla === true ? ctx.userId : null,
      customProps,
    })
    if (!rows[0]) throw new Error('Failed to create problem')
    // Autore (Problem.createdBy): prima nessuno scriveva CREATED_BY e il campo
    // era sempre null.
    await runQuery(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      MERGE (p)-[:CREATED_BY]->(u)
      // Chi apre il ticket lo segue, come per gli incident (prima «Watch 0»).
      MERGE (u)-[w:WATCHES]->(p)
        ON CREATE SET w.watched_at = $now
    `, { id, tenantId: ctx.tenantId, userId: ctx.userId, now })
    return rows[0].props
  }, true)

  if (input.affectedCIs?.length) {
    // Etichette dal metamodello del tenant, e righe CONTATE: come in
    // `createIncident` (C-2), il `MERGE` sotto la lista fissa non collegava i
    // CI di un tipo del cliente e nessuno leggeva l'esito. A differenza
    // dell'incident un Problem può legittimamente non avere CI, quindi il
    // problem resta creato — ma chi ha chiesto quei CI lo viene a sapere.
    const ciPredicate = await ciLabelPredicateForTenant('ci', ctx.tenantId)
    const missing: string[] = []
    await withSession(async (session) => {
      for (const ciId of input.affectedCIs!) {
        const rows = await runQuery<{ linked: unknown }>(session, `
          MATCH (p:Problem {id: $id, tenant_id: $tenantId})
          MATCH (ci {id: $ciId, tenant_id: $tenantId})
          WHERE ${ciPredicate}
          MERGE (p)-[r:AFFECTS]->(ci)
          RETURN count(r) AS linked
        `, { id, tenantId: ctx.tenantId, ciId })
        if (Number(rows[0]?.linked ?? 0) === 0) missing.push(ciId)
      }
    }, true)
    if (missing.length > 0) {
      logger.error({ problemId: id, tenantId: ctx.tenantId, missing },
        '[problemService] CI non collegati al problem: non esistono in questo cliente o non sono Configuration Item')
      throw new ValidationError(
        `Problem created, but ${missing.length} of the ${input.affectedCIs.length} given CIs do not exist in this tenant, or are not Configuration Items (${missing.join(', ')})`,
        { key: 'errors.problem.ciMissing', params: { missing: missing.length, total: input.affectedCIs.length, ids: missing.join(', ') } },
      )
    }
  }

  if (input.relatedIncidents?.length) {
    await withSession(async (session) => {
      for (const incidentId of input.relatedIncidents!) {
        await runQuery(session, `
          MATCH (p:Problem {id: $id, tenant_id: $tenantId})
          MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
          MERGE (p)-[:CAUSED_BY]->(i)
        `, { id, tenantId: ctx.tenantId, incidentId })
      }
    }, true)
  }

  await withSession(async (session) => {
    await workflowEngine.createInstance(session, ctx.tenantId, id, 'problem', undefined, input.category ?? null)
  }, true)

  const initialStatus = await withSession((s) => getInitialStepName(s, ctx.tenantId, 'problem'))
  await publishEvent('problem.created', ctx.tenantId, ctx.userId, {
    id,
    title:      input.title,
    priority,
    status:     initialStatus,
    assignedTo: '—',
  } satisfies ProblemEventPayload)

  // Trigger, Business Rule e trigger a tempo: li mette in moto `problem.created`
  // (consumers/automationConsumer.ts).

  return created
}

/**
 * L'ingresso del problem in un passo del workflow (D-22): come per l'incident,
 * il tipo **stabile** `problem.step_entered` (col nome, l'etichetta, lo scopo e
 * la categoria del passo nel payload) e l'**alias** storico
 * `problem.<stepName>`, a cui restano agganciate le regole di fabbrica
 * (`problem.under_investigation`, `problem.deferred`, …) e quelle dei tenant.
 */
/**
 * Come per l'incident: gli eventi di dominio della transizione nascono
 * dall'hook `onStepEntered` del motore, che vede tutti i cammini (revisione
 * totale · C-1). Qui resta il solo punto d'ingresso per chi pubblica senza
 * passare dal motore.
 */
export async function publishProblemTransition(id: string, stepName: string, ctx: ServiceCtx) {
  await publishStepEnteredForEntity({
    tenantId: ctx.tenantId, actorId: ctx.userId,
    entityType: 'problem', entityId: id, stepName, enteredAt: new Date().toISOString(),
  })
}
