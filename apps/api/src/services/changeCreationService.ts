/**
 * Shared Change (RFC) creation logic.
 *
 * Single source of truth used by BOTH:
 *   - the GraphQL `createChange` mutation (graphql/resolvers/change/changeMutations.ts)
 *   - the REST v1 `POST /api/v1/changes` route (rest/v1/changes.ts)
 *
 * The whole RFC bootstrap lives here: CI Owner/Support Group validation,
 * progressive CHG code generation, AssessmentTask (functional + technical)
 * and DeployPlanTask creation per CI, workflow instance creation and the
 * change-level audit entry. Callers only decide how to shape the response.
 *
 * Errors are thrown as lib/errors.js classes (ValidationError, ...): GraphQL
 * lets them bubble up as-is, the REST route translates them into HTTP 400.
 */
import { firstTeamCypher } from '../lib/ticketTeamHistory.js'
import { v4 as uuidv4 } from 'uuid'
import { customFieldDefs, resolveCustomFieldWrites, type CustomFieldInput } from '../lib/ticketCustomFields.js'
import { creationStepContext } from '../lib/customFieldSteps.js'
import { workflowEngine } from '@opengraphity/workflow'
import { ValidationError } from '../lib/errors.js'
import { publishEvent } from '../lib/publishEvent.js'
import { TASK_STATUS, ASSESSMENT_ROLE } from '../lib/taskStatus.js'
import { deriveChangePriority } from '../graphql/resolvers/change/scoring.js'
import { assertDomainValue } from '../lib/domainMatrix.js'
import { assertCIsLinkable } from '../lib/ticketCIExclusions.js'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import { getInitialStepName } from '../lib/workflowHelpers.js'
import {
  writeAudit,
  nextChangeCode,
  getNextTaskCodes,
  assertCIHasOwnerAndSupport,
} from '../graphql/resolvers/change/helpers.js'

export interface ChangeCreationInput {
  title:         string
  why:           string          // motivazione (WHY) — obbligatorio
  what:          string          // cosa si cambia (WHAT) — obbligatorio
  changeOwner?:  string | null
  affectedCIIds: string[]
  changeType?:   string | null   // un valore del vocabolario `change_type` del cliente — obbligatorio
  /** Campi personalizzati (ondata 4): assenti dai canali che non li conoscono (azione di passo). */
  customFields?: CustomFieldInput[] | null
}

export interface ChangeCreationCtx {
  tenantId: string
  userId:   string
}

export interface CreatedChange {
  id:   string
  code: string
}

// TRANSACTIONAL: all writes in single tx (vedi executeWrite unico più sotto).
export async function createChangeRFC(
  input: ChangeCreationInput,
  ctx: ChangeCreationCtx,
): Promise<CreatedChange> {
  const { title, changeOwner, affectedCIIds } = input
  const why  = input.why?.trim()  ?? ''
  const what = input.what?.trim() ?? ''
  // Ondata 7 (B-14): il tipo è validato contro il vocabolario `change_type`
  // DEL CLIENTE, non contro una lista scritta qui.
  //
  // Prima: `['standard','normal','emergency'].includes(x) ? x : 'normal'` —
  // un tipo aggiunto dal cliente (`major`) veniva sostituito con `normal` in
  // silenzio, e la change nasceva con priorità e rotta d'approvazione di una
  // change ordinaria. Ora un tipo fuori vocabolario è un rifiuto che elenca
  // gli ammessi.
  //
  // Il tipo è OBBLIGATORIO (verifica «Cosa resta cablato», ondata 1). Era un
  // default dichiarato, `normal`, per chi non lo passava (REST, azione di
  // passo): la scelta di come nasce una change non la fa il codice, e un
  // valore di ripiego è comunque un valore che il cliente non ha scelto.
  if (!input.changeType || input.changeType.trim() === '') {
    throw new ValidationError('changeType is required: pass a value of the change_type vocabulary', { key: 'errors.change.typeRequired' })
  }
  const changeType = await assertDomainValue(ctx.tenantId, 'change_type', input.changeType)
  if (!affectedCIIds || affectedCIIds.length === 0) {
    throw new ValidationError('A change must have at least one impacted CI', { key: 'errors.change.needsCI' })
  }
  if (!title || title.trim().length === 0) {
    throw new ValidationError('title is required', { key: 'errors.titleRequired' })
  }
  if (!why)  throw new ValidationError('The "why" field is required', { key: 'errors.change.whyRequired' })
  if (!what) throw new ValidationError('The "what" field is required', { key: 'errors.change.whatRequired' })
  // CM-8 (revisione del 15 set 2026): i tipi di CI esclusi per le change. Prima
  // le regole «change» (cinque su c-one) non erano applicate da nessuna parte.
  await assertCIsLinkable(ctx.tenantId, 'change', affectedCIIds)
  const customProps = input.customFields == null ? {} : await withSession(async (session) =>
    resolveCustomFieldWrites(ctx.tenantId, 'change', await customFieldDefs(session, ctx.tenantId, 'change'), input.customFields, { current: null, stepContext: await creationStepContext(session, ctx.tenantId, 'change', null) }))
  const created = await withSession(async (session) => {
    // Letture e validazioni PRIMA della transazione: se falliscono non c'è nulla da annullare.
    await assertCIHasOwnerAndSupport(session, ctx.tenantId, affectedCIIds)
    const code = await nextChangeCode(session, ctx.tenantId)
    const taskCodes = await getNextTaskCodes(session, ctx.tenantId, affectedCIIds.length * 3)
    const ciTasks = affectedCIIds.map((ciId, i) => ({
      ciId,
      ownerCode:   taskCodes[i * 3]!,
      supportCode: taskCodes[i * 3 + 1]!,
      planCode:    taskCodes[i * 3 + 2]!,
    }))
    const id = uuidv4()
    const now = new Date().toISOString()
    // Priorità = tipo × fascia di rischio, con rischio non ancora valutato:
    // letta dalla matrice del cliente PRIMA della transazione di scrittura.
    const priority = await deriveChangePriority(ctx.tenantId, changeType, null)
    // A change is born in its initial step, like incidents and problems (tour of
    // 23 Sep 2026, D3): without `status` the 177 changes in assessment showed
    // as «(none)» in the reports, the «Open Changes» KPI left them out and the
    // assistant did not see them.
    const initialStatus = await getInitialStepName(session, ctx.tenantId, 'change')

    // TRANSACTIONAL: all writes in single tx — Change + AFFECTS_CI + 2 AssessmentTask
    // e 1 DeployPlanTask per CI + ASSIGNED_TO_TEAM + WorkflowInstance + audit entry.
    // workflowEngine.createInstance e writeAudit ricevono la ManagedTransaction e
    // partecipano alla stessa tx: se un punto qualsiasi fallisce, rollback totale
    // (nessun Change orfano senza workflow, nessun audit senza Change).
    await session.executeWrite(async (tx) => {
      await tx.run(`
      CREATE (c:Change {
        // F18 (revisione del 14 set 2026): number come gli altri ticket, stesso valore di code.
        id: $id, tenant_id: $tenantId, code: $code, number: $code,
        title: $title, why: $why, what: $what,
        change_type: $changeType,
        status: $initialStatus,
        aggregate_risk_score: null,
        priority: $priority,
        approval_route: null, approval_status: null,
        created_at: $now, updated_at: $now
      })
      SET c += $customProps
      WITH c
      OPTIONAL MATCH (req:User {id: $requesterId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN req IS NULL THEN [] ELSE [1] END |
        CREATE (c)-[:REQUESTED_BY]->(req)
        MERGE (req)-[w:WATCHES]->(c)
          ON CREATE SET w.watched_at = $now
      )
      WITH c
      OPTIONAL MATCH (owner:User {id: $ownerId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN owner IS NULL THEN [] ELSE [1] END |
        CREATE (c)-[:OWNED_BY]->(owner)
      )
      WITH c
      UNWIND $ciTasks AS ct
      MATCH (ci:ConfigurationItem {id: ct.ciId, tenant_id: $tenantId})
      MATCH (ci)-[:OWNED_BY]->(ownerTeam:Team)
      MATCH (ci)-[:SUPPORTED_BY]->(supportTeam:Team)
      CREATE (c)-[:AFFECTS_CI {ci_phase: 'assessment'}]->(ci)
      // change_key identifica il task per (change, CI, ruolo): è la chiave su
      // cui addCIToChange fa MERGE. I task creati qui non l'avevano, quindi
      // quel MERGE non li trovava e ri-aggiungere un CI già collegato creava un
      // SECONDO assessment owner, uno support e un piano — la change non
      // usciva più dall'analisi, perché all_assessments_complete aspettava i
      // duplicati (revisione totale · B-8).
      CREATE (ownerT:AssessmentTask {
        id: randomUUID(), code: ct.ownerCode, tenant_id: $tenantId, ci_id: ci.id,
        change_key: $id + '-' + ci.id + '-owner',
        responder_role: '${ASSESSMENT_ROLE.OWNER}', status: '${TASK_STATUS.PENDING}', score: null, created_at: $now
      })
      CREATE (c)-[:HAS_ASSESSMENT]->(ownerT)
      ${firstTeamCypher('ownerT', 'ownerTeam', '$now')}
      CREATE (supportT:AssessmentTask {
        id: randomUUID(), code: ct.supportCode, tenant_id: $tenantId, ci_id: ci.id,
        change_key: $id + '-' + ci.id + '-support',
        responder_role: '${ASSESSMENT_ROLE.SUPPORT}', status: '${TASK_STATUS.PENDING}', score: null, created_at: $now
      })
      CREATE (c)-[:HAS_ASSESSMENT]->(supportT)
      ${firstTeamCypher('supportT', 'supportTeam', '$now')}
      CREATE (dp:DeployPlanTask {
        id: randomUUID(), code: ct.planCode, tenant_id: $tenantId, ci_id: ci.id,
        change_key: $id + '-' + ci.id + '-deployplan',
        status: '${TASK_STATUS.PENDING}', steps: '[]',
        created_at: $now
      })
      CREATE (c)-[:HAS_DEPLOY_PLAN]->(dp)
      ${firstTeamCypher('dp', 'supportTeam', '$now')}
      `, {
        id, code, title, why, what,
        changeType,
        priority,
        initialStatus,
        requesterId: ctx.userId,
        ownerId: changeOwner ?? null,
        ciTasks,
        tenantId: ctx.tenantId,
        now,
        customProps,
      })

      await workflowEngine.createInstance(tx, ctx.tenantId, id, 'change')

      await writeAudit(tx, id, ctx.tenantId, 'change_created', ctx.userId,
        `Change ${code} created with ${affectedCIIds.length} CIs`,
        { key: 'changeCreated', params: { code, count: String(affectedCIIds.length) } })
    })

    return { id, code }
  }, true)

  // L'evento di creazione: prima le change non ne avevano uno, quindi nessun
  // trigger, regola, notifica o webhook poteva reagire a una change nuova
  // (revisione del 14 set 2026 · AU-1).
  await publishEvent('change.created', ctx.tenantId, ctx.userId, { id: created.id, code: created.code, title, change_type: changeType }, new Date().toISOString())
  return created
}
