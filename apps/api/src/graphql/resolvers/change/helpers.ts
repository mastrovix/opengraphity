/**
 * Shared helpers for the change/* mutation modules.
 *
 * Any utility needed by more than one mutation file lives here. Individual
 * mutation modules (assessment/plan/execution/reopen/changeMutations) import
 * from ./helpers.js only — they never import from each other, so the graph
 * stays a clean star with helpers.ts at the center.
 */

import { GraphQLError } from 'graphql'
import { NotFoundError } from '../../../lib/errors.js'
import type { ManagedTransaction } from 'neo4j-driver'
import { ForbiddenError, ValidationError } from '../../../lib/errors.js'
import { v4 as uuidv4 } from 'uuid'
import {
  TASK_STATUS, ASSESSMENT_ROLE, ROLE_LABEL, ROLE_TO_RELATION,
} from '../../../lib/taskStatus.js'
import { runQuery, runQueryOne, getSession, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
import { calculateCIRiskScore, determineApprovalRoute, deriveChangePriority } from './scoring.js'
import { getInitialStepName, getStepPurpose } from '../../../lib/workflowHelpers.js'
import { targetStepByPurpose } from '../../../lib/workflowTargets.js'
import { toNumber } from '@opengraphity/neo4j'
import { systemText } from '../../../lib/systemText.js'
import { nextSequenceBlock } from '../../../lib/sequence.js'
import { nextTicketNumber } from '../../../lib/ticketNumbering.js'
import { hasPermission } from '../../../lib/permissions.js'

export type Session = ReturnType<typeof getSession>

/**
 * Session (opens its own write tx) OR ManagedTransaction (participates in the
 * caller's open transaction). Write helpers below accept either: passed a tx,
 * their writes commit/rollback together with the caller's other writes.
 */
export type SessionOrTx = Session | ManagedTransaction

function isSession(s: SessionOrTx): s is Session {
  return typeof (s as Session).executeWrite === 'function'
}

/** Run a write statement: via tx.run inside an external tx, or in its own executeWrite. */
async function runWrite(target: SessionOrTx, cypher: string, params: Record<string, unknown>): Promise<void> {
  if (isSession(target)) {
    await target.executeWrite((tx) => tx.run(cypher, params))
  } else {
    await target.run(cypher, params)
  }
}

// ── audit ─────────────────────────────────────────────────────────────────────

export async function writeAudit(
  session: SessionOrTx,
  changeId: string,
  tenantId: string,
  action: string,
  actorId: string | null,
  detail: string | null,
  /**
   * La frase del dettaglio come chiave e dati (revisione del 14 set 2026 ·
   * CH-5): la timeline la compone nella lingua di chi guarda. `detail` resta il
   * testo inglese per chi legge l'API. Prima i dettagli erano scritti in
   * italiano e salvati così.
   */
  detailI18n?: { key: string; params: Record<string, string> },
) {
  const now = new Date().toISOString()
  await runWrite(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    CREATE (e:ChangeAuditEntry {
      id: $id, tenant_id: $tenantId, timestamp: $now,
      action: $action, detail: $detail,
      detail_key: $detailKey, detail_params: $detailParams
    })
    CREATE (c)-[:HAS_AUDIT]->(e)
    WITH e, $actorId AS aid
    OPTIONAL MATCH (u:User {id: aid, tenant_id: $tenantId})
    FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END |
      CREATE (e)-[:BY]->(u)
    )
  `, {
    changeId, tenantId, id: uuidv4(), now, action, detail, actorId,
    detailKey: detailI18n?.key ?? null, detailParams: detailI18n ? JSON.stringify(detailI18n.params) : null,
  })
}

// ── code generators ───────────────────────────────────────────────────────────

/**
 * Codici delle change e dei task — revisione del 14 set 2026 · CH-2.
 *
 * Erano `max()+1` letto e poi scritto: due change create insieme leggevano lo
 * stesso massimo e la seconda falliva sul vincolo di unicità; i codici dei task
 * scandivano TUTTI i nodi del database senza etichetta. Ora il contatore
 * atomico di `lib/sequence.ts`, come per incident, problem e richieste (i
 * contatori sono stati allineati al massimo esistente dalla migrazione
 * 20260923_1060).
 */
export async function nextChangeCode(session: SessionOrTx, tenantId: string): Promise<string> {
  // Il formato è del cliente (ondata 6 di «Nulla cablato»); il contatore resta del prodotto.
  return nextTicketNumber(session, tenantId, 'change')
}

export async function getNextTaskCodes(session: SessionOrTx, tenantId: string, count: number): Promise<string[]> {
  if (count <= 0) return []
  const last = await nextSequenceBlock(session, tenantId, 'task', count)
  return Array.from({ length: count }, (_, i) => 'TASK' + String(last - count + 1 + i).padStart(8, '0'))
}

/**
 * QUANTE CHIAVI NATURALI MANCANO DAVVERO, fra quelle che si sta per creare
 * (rimedio, 20 set 2026).
 *
 * I task nascono con una MERGE sulla chiave naturale, quindi rimettere lo
 * stesso CI in una change non ne crea di nuovi — giusto. Ma i codici si
 * prendevano PRIMA, sempre e tutti: ogni ripetizione bruciava tre numeri, e
 * la numerazione usciva coi buchi («dov'è il TASK00000065?»). Con questa si
 * chiedono solo i codici che serviranno.
 *
 * Resta una corsa possibile — due scritture simultanee vedono entrambe «non
 * c'è» e prendono un numero a testa, poi la MERGE ne fa nascere uno solo — e
 * quel buco è il prezzo di non tenere un lucchetto sul contatore. La
 * differenza è fra un buco per ogni ripetizione e un buco solo quando due
 * persone premono nello stesso istante.
 */
export async function chiaviDaCreare(
  session: SessionOrTx,
  // Un'etichetta finisce dentro al Cypher e non può essere un parametro:
  // l'insieme è chiuso, così non ci arriva niente da fuori.
  label: 'AssessmentTask' | 'DeployPlanTask' | 'ValidationTest' | 'DeploymentTask' | 'ReviewTask',
  chiavi: readonly string[],
): Promise<Set<string>> {
  if (chiavi.length === 0) return new Set()
  const righe = await runQuery<{ chiave: string }>(session, `
    MATCH (t:${label}) WHERE t.change_key IN $chiavi RETURN t.change_key AS chiave
  `, { chiavi: [...chiavi] })
  const esistenti = new Set(righe.map((r) => r.chiave))
  return new Set(chiavi.filter((k) => !esistenti.has(k)))
}

// ── sanity checks ─────────────────────────────────────────────────────────────

export async function assertCIHasOwnerAndSupport(session: Session, tenantId: string, ciIds: string[]) {
  const rows = await runQuery<{ id: string; name: string; ownerTeamId: string | null; supportTeamId: string | null }>(session, `
    UNWIND $ciIds AS ciId
    MATCH (ci {id: ciId, tenant_id: $tenantId})
    OPTIONAL MATCH (ci)-[:OWNED_BY]->(ownerT:Team)
    OPTIONAL MATCH (ci)-[:SUPPORTED_BY]->(supportT:Team)
    RETURN ci.id AS id, ci.name AS name,
           ownerT.id AS ownerTeamId,
           supportT.id AS supportTeamId
  `, { ciIds, tenantId })
  for (const r of rows) {
    if (!r.ownerTeamId || !r.supportTeamId) {
      logger.error({ ciId: r.id, ciName: r.name, hasOwner: !!r.ownerTeamId, hasSupport: !!r.supportTeamId },
        '[createChange] CI manca di Owner Group o Support Group')
      throw new ValidationError(`CI ${r.name} has no Owner Group or Support Group`, { key: 'errors.ci.missingGroups', params: { ci: r.name } })
    }
  }
}

// ── generic loaders ───────────────────────────────────────────────────────────

/** Predicato condiviso: esclude le change eliminate logicamente (deleteChange). */
export const CHANGE_NOT_DELETED = 'coalesce(c.deleted, false) = false'

export async function loadChange(session: Session, changeId: string, tenantId: string): Promise<Props | null> {
  const row = await runQueryOne<{ props: Props }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})
    WHERE ${CHANGE_NOT_DELETED}
    RETURN properties(c) AS props
  `, { id: changeId, tenantId })
  return row?.props ?? null
}

export async function getCIName(session: SessionOrTx, ciId: string, tenantId: string): Promise<string> {
  const row = await runQueryOne<{ name: string }>(session, `
    MATCH (ci {id: $ciId, tenant_id: $tenantId})
    RETURN coalesce(ci.name, ci.id) AS name
  `, { ciId, tenantId })
  return row?.name ?? ciId
}

export async function getQuestionText(session: Session, questionId: string, tenantId: string): Promise<string> {
  const row = await runQueryOne<{ text: string }>(session, `
    MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
    RETURN q.text AS text
  `, { id: questionId, tenantId })
  return row?.text ?? questionId
}

export async function getAnswerLabel(session: Session, optionId: string, tenantId: string): Promise<string> {
  const row = await runQueryOne<{ label: string }>(session, `
    MATCH (o:AnswerOption {id: $id, tenant_id: $tenantId})
    RETURN o.label AS label
  `, { id: optionId, tenantId })
  return row?.label ?? optionId
}

// ── workflow step helpers ─────────────────────────────────────────────────────

export interface ChangeWorkflow {
  instanceId:  string
  currentStep: string
  props:       Props
}

/**
 * Change (non eliminata) + istanza di workflow + step corrente, in UNA lettura.
 * Lo step è letto dalla relazione CURRENT_STEP (la fonte autoritativa) e
 * confrontato con wi.current_step: una divergenza è corruzione e va fatta
 * emergere, non nascosta scegliendo una delle due. Sostituisce le cinque
 * grafie diverse dello stesso lookup sparse nei moduli.
 */
export async function loadChangeWorkflow(session: Session, changeId: string, tenantId: string): Promise<ChangeWorkflow> {
  const row = await runQueryOne<{ props: Props; deleted: boolean; instanceId: string | null; wiStep: string | null; relStep: string | null }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})
    OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    OPTIONAL MATCH (wi)-[:CURRENT_STEP]->(s:WorkflowStep)
    RETURN properties(c) AS props, coalesce(c.deleted, false) AS deleted,
           wi.id AS instanceId, wi.current_step AS wiStep, s.name AS relStep
  `, { id: changeId, tenantId })
  if (!row) throw new NotFoundError('Change', changeId)
  if (row.deleted) throw new GraphQLError('The change was deleted: no operation is possible any more', { extensions: { code: 'CONFLICT', i18n: { key: 'errors.change.deleted' } } })
  if (!row.instanceId) throw new GraphQLError(`Change ${changeId} has no linked WorkflowInstance`, { extensions: { code: 'CONFLICT' } })
  if (!row.relStep) throw new GraphQLError(`Change ${changeId}: workflow instance without CURRENT_STEP (run the workflow seed again to relink it)`, { extensions: { code: 'CONFLICT' } })
  if (row.wiStep !== row.relStep) {
    logger.error({ changeId, wiStep: row.wiStep, relStep: row.relStep }, '[change] istanza di workflow incoerente')
    throw new GraphQLError(`Change ${changeId}: inconsistent workflow instance (current_step="${row.wiStep}", CURRENT_STEP="${row.relStep}")`, { extensions: { code: 'CONFLICT' } })
  }
  return { instanceId: row.instanceId, currentStep: row.relStep, props: row.props }
}

export async function getCurrentStep(session: Session, changeId: string, tenantId: string): Promise<string | null> {
  const row = await runQueryOne<{ step: string }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)-[:CURRENT_STEP]->(s:WorkflowStep)
    WHERE ${CHANGE_NOT_DELETED}
    RETURN s.name AS step
  `, { id: changeId, tenantId })
  return row?.step ?? null
}

/**
 * Azzera tutto ciò che deriva dagli assessment quando uno viene riaperto o
 * l'approvazione è rifiutata: rischio aggregato, rotta, esito approvazione e
 * PRIORITÀ (tipo × rischio → con rischio ignoto torna a quella del solo tipo).
 * Prima il reopen lasciava una priorità "high" con rischio null.
 */
export async function resetChangeRisk(session: SessionOrTx, changeId: string, tenantId: string): Promise<void> {
  const row = await runQueryOne<{ changeType: string | null }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId}) RETURN c.change_type AS changeType
  `, { changeId, tenantId })
  if (!row) throw new NotFoundError('Change', changeId)
  const priority = await deriveChangePriority(tenantId, row.changeType, null)
  await runWrite(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    SET c.aggregate_risk_score = null, c.approval_route = null, c.approval_status = null,
        c.priority = $priority, c.updated_at = $now
  `, { changeId, tenantId, priority, now: new Date().toISOString() })
}

/** Istanza di workflow della change; rifiuta le change eliminate (nessuna mutation su una change cancellata). */
export async function getInstanceId(session: Session, changeId: string, tenantId: string): Promise<string> {
  const row = await runQueryOne<{ id: string | null; deleted: boolean }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})
    OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN wi.id AS id, coalesce(c.deleted, false) AS deleted
  `, { id: changeId, tenantId })
  if (!row) throw new NotFoundError('Change', changeId)
  if (row.deleted) throw new GraphQLError('The change was deleted: no operation is possible any more', { extensions: { code: 'CONFLICT', i18n: { key: 'errors.change.deleted' } } })
  if (!row.id) throw new GraphQLError(`Change ${changeId} has no linked WorkflowInstance`, { extensions: { code: 'CONFLICT' } })
  return row.id
}

export async function assertInitialStep(session: Session, changeId: string, tenantId: string): Promise<Props> {
  const props = await loadChange(session, changeId, tenantId)
  if (!props) throw new NotFoundError('Change', changeId)
  const current = await getCurrentStep(session, changeId, tenantId)
  const initial = await getInitialStepName(session, tenantId, 'change')
  if (current !== initial) {
    logger.error({ changeId, current, initial }, '[change] operazione permessa solo nello step iniziale')
    throw new GraphQLError(`Operation allowed only in the initial step: current step "${current}"`, { extensions: { code: 'CONFLICT', i18n: { key: 'errors.change.onlyInInitialStep', params: { current } } } })
  }
  return props
}

/**
 * Verifica che l'utente corrente sia membro dell'Owner Group o del Support Group
 * del CI. Solleva errore "Non autorizzato" altrimenti. Chi ha `approval.override`
 * agisce per qualunque team (ondata 7: prima era «admin»).
 */
export async function assertUserInCITeam(
  session: Session,
  ciId: string,
  tenantId: string,
  ctx: GraphQLContext,
  role: 'owner' | 'support',
) {
  if (hasPermission(ctx, 'approval.override')) return
  if (!ctx.userId) {
    logger.error({ ciId, role }, '[authz] utente non identificato')
    throw new ForbiddenError('Not authorized: the user is not identified', { key: 'errors.authz.noUser' })
  }
  const rel = ROLE_TO_RELATION[role]
  const roleLabel = ROLE_LABEL[role]
  const row = await runQueryOne<{ ok: boolean | null }>(session, `
    MATCH (ci {id: $ciId, tenant_id: $tenantId})-[:${rel}]->(team:Team)
    OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team)
    RETURN u IS NOT NULL AS ok
  `, { ciId, tenantId, userId: ctx.userId })
  if (!row || !row.ok) {
    logger.error({ userId: ctx.userId, ciId, role, tenantId }, `[authz] user ${ctx.userId} non è nel ${roleLabel} Group del CI ${ciId}`)
    throw new ForbiddenError(`Not authorized: only the CI's ${roleLabel} group can do this`, { key: 'errors.authz.wrongGroup', params: { group: roleLabel } })
  }
}

/** Riaprire un compito chiuso scavalca il team che l'ha chiuso: `approval.override` (prima «admin»). */
export function assertMayReopenTasks(ctx: GraphQLContext) {
  if (!hasPermission(ctx, 'approval.override')) {
    logger.error({ userId: ctx.userId, role: ctx.role }, '[authz] reopen tentativo senza approval.override')
    throw new ForbiddenError('Only someone who can act for any team can reopen tasks', { key: 'errors.authz.reopenAdmin' })
  }
}

// ── risk + step side-effects ──────────────────────────────────────────────────

export async function recomputeCIRiskIfReady(session: SessionOrTx, changeId: string, ciId: string, tenantId: string, actorId: string | null) {
  const row = await runQueryOne<{ ownerDone: boolean; supportDone: boolean; ownerScore: unknown; supportScore: unknown }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_ASSESSMENT]->(t:AssessmentTask {ci_id: $ciId})
    WITH collect({role: t.responder_role, status: t.status, score: t.score}) AS tasks
    RETURN
      any(x IN tasks WHERE x.role = '${ASSESSMENT_ROLE.OWNER}'   AND x.status = '${TASK_STATUS.COMPLETED}') AS ownerDone,
      any(x IN tasks WHERE x.role = '${ASSESSMENT_ROLE.SUPPORT}' AND x.status = '${TASK_STATUS.COMPLETED}') AS supportDone,
      [x IN tasks WHERE x.role = '${ASSESSMENT_ROLE.OWNER}'   | x.score][0] AS ownerScore,
      [x IN tasks WHERE x.role = '${ASSESSMENT_ROLE.SUPPORT}' | x.score][0] AS supportScore
  `, { changeId, ciId, tenantId })
  if (!row || !row.ownerDone || !row.supportDone) return

  const os = row.ownerScore != null ? toNumber(row.ownerScore) : 0
  const ss = row.supportScore != null ? toNumber(row.supportScore) : 0
  const ciRisk = calculateCIRiskScore(os, ss)

  await runWrite(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci {id: $ciId})
    SET r.risk_score = $risk, r.ci_phase = 'assessed'
  `, { changeId, ciId, tenantId, risk: ciRisk })

  const ciName = await getCIName(session, ciId, tenantId)
  await writeAudit(session, changeId, tenantId, 'ci_risk_computed', actorId, `${ciName}: risk ${ciRisk}`,
    { key: 'ciRisk', params: { ci: ciName, score: String(ciRisk) } })
}

export async function computeAggregateRisk(session: SessionOrTx, changeId: string, tenantId: string) {
  const row = await runQueryOne<{ maxRisk: unknown; unassessed: unknown; changeType: string | null }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->()
    RETURN max(r.risk_score) AS maxRisk, count(CASE WHEN r.risk_score IS NULL THEN 1 END) AS unassessed, c.change_type AS changeType
  `, { changeId, tenantId })
  // Giro UI del 15 set 2026 · U-24 (scelta del proprietario): finché un CI
  // della change non ha il suo rischio, il rischio aggregato NON è noto. Prima
  // `max` ignorava i null e ne usciva 0: dopo la prima attività su tre la
  // change passava da MEDIUM a «LOW · 0», una fascia bassa mai misurata. Ora
  // resta la priorità iniziale del tipo, come in `resetChangeRisk`.
  if (!row || toNumber(row.unassessed) > 0) {
    await resetChangeRisk(session, changeId, tenantId)
    return
  }
  const maxRisk = row.maxRisk != null ? toNumber(row.maxRisk) : 0
  const approvalRoute = await determineApprovalRoute(tenantId, maxRisk)
  // Priorità (ITIL) = tipo × rischio, ricalcolata e MEMORIZZATA quando il
  // rischio aggregato cambia.
  const priority = await deriveChangePriority(tenantId, row.changeType, maxRisk)
  await runWrite(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    SET c.aggregate_risk_score = $maxRisk,
        c.approval_route       = $route,
        c.priority             = $priority,
        c.updated_at           = $now
  `, { changeId, tenantId, maxRisk, route: approvalRoute, priority, now: new Date().toISOString() })
}

// TRANSACTIONAL: all writes in single tx — ValidationTest + DeploymentTask per
// ogni CI (creazione + relazioni HAS_VALIDATION/HAS_DEPLOYMENT) vengono creati
// in un'unica statement/tx: o tutti o nessuno. Le letture (CI, task codes)
// restano prima della scrittura.
async function createValidationAndDeploymentTasks(session: SessionOrTx, changeId: string, tenantId: string) {
  const ciRows = await runQuery<{ ciId: string }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
    RETURN ci.id AS ciId ORDER BY ci.name
  `, { changeId, tenantId })
  if (ciRows.length === 0) return

  /*
   * I CODICI SI PRENDONO SOLO PER I TASK CHE NASCONO DAVVERO (revisione del
   * 22 set 2026).
   *
   * Qui se ne prendevano `ciRows.length * 2` SEMPRE, e le MERGE più sotto
   * sono sulla chiave naturale: rientrare nel passo non crea niente di nuovo,
   * ma bruciava due codici per CI a ogni giro e la numerazione usciva coi
   * buchi. È lo stesso difetto che `chiaviDaCreare` chiude per gli
   * assessment; qui non era mai stato applicato.
   *
   * E la chiave si scrive UNA volta sola, in TypeScript, e viaggia nella riga
   * dell'UNWIND: prima era scritta anche in Cypher (`$changeId + '-' + ci.id`)
   * e due scritture della stessa cosa divergono — è esattamente così che la
   * chiave del piano di rilascio aveva perso il suo suffisso.
   */
  const chiavi = ciRows.map((r) => ({
    ciId:   r.ciId,
    valKey: `${changeId}-${r.ciId}`,
    depKey: `${changeId}-${r.ciId}-exec`,
  }))
  const daCreare = new Set([
    ...await chiaviDaCreare(session, 'ValidationTest',  chiavi.map((c) => c.valKey)),
    ...await chiaviDaCreare(session, 'DeploymentTask',  chiavi.map((c) => c.depKey)),
  ])
  const codes = await getNextTaskCodes(session, tenantId, daCreare.size)
  let prossimo = 0
  const codicePer = (chiave: string) => (daCreare.has(chiave) ? codes[prossimo++]! : null)
  const ciCodes = chiavi.map((c) => ({
    ciId: c.ciId, valKey: c.valKey, depKey: c.depKey,
    valCode: codicePer(c.valKey), depCode: codicePer(c.depKey),
  }))
  const now = new Date().toISOString()
  await runWrite(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    UNWIND $ciCodes AS cc
    MATCH (c)-[:AFFECTS_CI]->(ci {id: cc.ciId})
    MERGE (vt:ValidationTest {change_key: cc.valKey})
      ON CREATE SET vt.id = randomUUID(), vt.code = cc.valCode, vt.tenant_id = $tenantId,
        vt.ci_id = ci.id, vt.status = '${TASK_STATUS.PENDING}',
        vt.result = null, vt.tested_at = null, vt.created_at = $now
    MERGE (c)-[:HAS_VALIDATION]->(vt)
    WITH c, ci, cc
    MERGE (dt:DeploymentTask {change_key: cc.depKey})
      ON CREATE SET dt.id = randomUUID(), dt.code = cc.depCode, dt.tenant_id = $tenantId,
        dt.ci_id = ci.id, dt.status = '${TASK_STATUS.PENDING}',
        dt.created_at = $now
    MERGE (c)-[:HAS_DEPLOYMENT]->(dt)
  `, { changeId, tenantId, now, ciCodes })
}

// TRANSACTIONAL: all writes in single tx — un ReviewTask per CI, o tutti o nessuno.
async function createReviewTasks(session: SessionOrTx, changeId: string, tenantId: string) {
  const ciRows = await runQuery<{ ciId: string }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
    RETURN ci.id AS ciId ORDER BY ci.name
  `, { changeId, tenantId })
  if (ciRows.length === 0) return
  // Stessa regola degli altri task: la chiave si scrive una volta sola, in
  // TypeScript, e i codici si prendono solo per quelli che nascono davvero.
  const chiavi = ciRows.map((r) => ({ ciId: r.ciId, key: `${changeId}-${r.ciId}-review` }))
  const daCreare = await chiaviDaCreare(session, 'ReviewTask', chiavi.map((c) => c.key))
  const codes = await getNextTaskCodes(session, tenantId, daCreare.size)
  let prossimo = 0
  const ciCodes = chiavi.map((c) => ({
    ciId: c.ciId, key: c.key, code: daCreare.has(c.key) ? codes[prossimo++]! : null,
  }))
  const now = new Date().toISOString()
  await runWrite(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    UNWIND $ciCodes AS cc
    MERGE (rv:ReviewTask {change_key: cc.key})
      ON CREATE SET rv.id = randomUUID(), rv.code = cc.code, rv.tenant_id = $tenantId,
        rv.ci_id = cc.ciId, rv.status = '${TASK_STATUS.PENDING}', rv.created_at = $now
    MERGE (c)-[:HAS_REVIEW]->(rv)
  `, { changeId, tenantId, now, ciCodes })
}

// Dispatch table keyed by the step's `on_enter_create` metadata.
const ON_ENTER_CREATORS: Record<string, (session: SessionOrTx, changeId: string, tenantId: string) => Promise<void>> = {
  validation_and_deployment: createValidationAndDeploymentTasks,
  review:                    createReviewTasks,
}

/**
 * Side-effects to run immediately after the workflow enters a new step.
 * Reads `on_enter_create` metadata from Neo4j and dispatches to the matching
 * creator. Steps without the metadata are no-ops.
 */
export async function afterEnterStep(session: SessionOrTx, changeId: string, tenantId: string, stepName: string) {
  const row = await runQueryOne<{ hook: string | null }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    MATCH (wi)-[:CURRENT_STEP]->(step:WorkflowStep)
    WHERE step.name = $stepName
    RETURN step.on_enter_create AS hook
  `, { changeId, tenantId, stepName })
  // Entrando in un passo di SCOPO `approval` (ondata 4 · A4-2: lo scopo, non il
  // nome — il cliente può chiamarlo «CAB settimanale»): crea i requisiti di
  // approvazione (CM + owner group). Lo scopo del passo si chiede al nucleo e
  // non alla query qui sopra, che è legata al passo CORRENTE: così il gancio
  // resta corretto anche se il workflow è già avanzato.
  const purpose = await getStepPurpose(session as Session, tenantId, 'change', stepName)
  if (purpose === 'approval') {
    const { createChangeApprovals } = await import('./approvalCreation.js')
    await createChangeApprovals(session, changeId, tenantId)
    // Pre-approvata = nessun requisito: avanza subito al passo di scopo
    // `scheduled`. Terza revisione: qui c'era ancora il LETTERALE
    // `ct?.t === 'standard'`, cioe il difetto che l'ondata 8 aveva sostituito
    // con `isPreApprovedChangeType` in ogni altro posto. Due danni, non uno:
    // un cliente che rinomina `standard` non vedeva piu avanzare le sue
    // change pre-approvate (ferme in approvazione senza requisiti da
    // approvare: il vicolo cieco che il fail-loud qui sotto teme, un gradino
    // piu in alto); e un cliente che TOGLIE `standard` dai pre-approvati
    // vedeva la change transire comunque nella finestra di rilascio, con i
    // requisiti appena creati e pendenti.
    const ct = await runQueryOne<{ t: string }>(session, `MATCH (c:Change {id: $changeId, tenant_id: $tenantId}) RETURN c.change_type AS t`, { changeId, tenantId })
    const { isPreApprovedChangeType } = await import('../../../lib/changePolicy.js')
    if (ct?.t != null && await isPreApprovedChangeType(tenantId, ct.t)) {
      const { workflowEngine } = await import('@opengraphity/workflow')
      const instanceId = await getInstanceId(session as Session, changeId, tenantId)
      const toStep = await targetStepByPurpose(session as Session, tenantId, 'change', ['scheduled'],
        'pre-approval of a standard change')
      const res = await workflowEngine.transition(session as Session, { instanceId, toStepName: toStep, triggeredBy: 'system', triggerType: 'automatic', notes: await systemText(tenantId, 'change.preApproved'), tenantId }, { userId: 'system', entityData: {} })
      // Fail-loud: una pre-approvata ferma in approvazione senza requisiti non
      // si sbloccherebbe mai (nessun record da approvare).
      if (!res.success) {
        throw new GraphQLError(`Pre-approved change type "${ct.t}": pre-approval failed (${res.error ?? 'transition failed'})`, { extensions: { code: 'CONFLICT', i18n: { key: 'errors.change.preApprovalFailed', params: { type: ct.t, reason: res.error ?? '' } } } })
      }
      await afterEnterStep(session, changeId, tenantId, toStep)
    }
  }
  const hook = row?.hook
  if (!hook) return
  const creator = ON_ENTER_CREATORS[hook]
  if (!creator) {
    // Un hook sconosciuto significa workflow mal configurato: senza i task di
    // fase la change entrerebbe in deployment/review "vuota" e sembrerebbe
    // completa. Meglio bloccare.
    logger.error({ changeId, stepName, hook }, '[afterEnterStep] on_enter_create hook sconosciuto')
    throw new GraphQLError(`Workflow misconfigured: unknown on_enter_create hook "${hook}" for step "${stepName}"`, { extensions: { code: 'CONFLICT' } })
  }
  await creator(session, changeId, tenantId)
}
