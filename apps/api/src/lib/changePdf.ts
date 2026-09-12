/**
 * Change PDF export — builds the full "Change Audit Report" for a single
 * change: details, approval route, per-CI task dossier (assessments, plan,
 * validation, deployment, review), workflow history, audit trail and
 * attachment metadata. Pure pdfkit, returns a Buffer. Shared parts live in
 * ./pdf/ticketDossier.ts.
 */
import { runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import { ciTypeFromLabels } from './ciTypeFromLabels.js'
import { ASSESSMENT_ROLE } from './taskStatus.js'
import {
  DASH, fmtDate, orDash, PAGE_MARGIN, COLOR, type Doc, type PdfMeta,
  ensureSpace, sectionHeading, emptyLine, drawTable, keyValue, badge, createPdfBuffer,
} from './pdf/common.js'
import {
  loadTicketDossier, renderTicketDossier, userRef,
  workflowHistorySection, attachmentsSection,
  type Props, type UserRef, type WorkflowHistoryEntry, type AttachmentEntry,
} from './pdf/ticketDossier.js'

export type { PdfMeta }

// ── Dossier shape ─────────────────────────────────────────────────────────────

export interface ChangeTaskInfo {
  code:        string
  status:      string
  score:       number | null   // assessments only
  result:      string | null   // validation / review only
  completedAt: string | null   // completed_at / tested_at / deployed_at / reviewed_at
}

export interface ChangeCIDossier {
  name:              string
  type:              string
  environment:       string | null
  riskScore:         number | null
  ciPhase:           string | null
  assessmentOwner:   ChangeTaskInfo | null   // Functional
  assessmentSupport: ChangeTaskInfo | null   // Technical
  deployPlan:        ChangeTaskInfo | null
  validation:        ChangeTaskInfo | null
  deployment:        ChangeTaskInfo | null
  review:            ChangeTaskInfo | null
}

export interface ChangeDossier {
  change: {
    id:                 string
    code:               string
    title:              string
    why:                string | null
    what:               string | null
    aggregateRiskScore: number | null
    approvalRoute:      string | null
    approvalStatus:     string | null
    approvalAt:         string | null
    createdAt:          string | null
    updatedAt:          string | null
  }
  phase:       string | null   // workflow instance current_step
  requester:   UserRef | null
  changeOwner: UserRef | null
  affectedCIs: ChangeCIDossier[]
  workflowHistory: WorkflowHistoryEntry[]
  auditTrail: Array<{
    timestamp: string | null
    action:    string
    detail:    string | null
    actor:     string | null
  }>
  attachments: AttachmentEntry[]
}

// ── Data loading (tenant-scoped Cypher) ───────────────────────────────────────

function taskInfo(p: Props | null, dateProp: string): ChangeTaskInfo | null {
  if (!p || !p['id']) return null
  return {
    code:        (p['code'] ?? '') as string,
    status:      (p['status'] ?? '') as string,
    score:       p['score'] == null ? null : Number(p['score']),
    result:      (p['result'] ?? null) as string | null,
    completedAt: (p[dateProp] ?? null) as string | null,
  }
}

export async function loadChangeDossier(
  session: Queryable,
  id: string,
  tenantId: string,
): Promise<ChangeDossier> {
  // Change has no assignee/comments: the common loader still provides the
  // entity, workflow history and attachments (and NotFound on soft-deleted).
  const common = await loadTicketDossier(session, {
    label:      'Change',
    entityType: 'change',
    softDelete: true,
  }, id, tenantId)
  const p = common.props

  const people = await runQueryOne<{ reqUser: Props | null; ownerUser: Props | null; currentStep: string | null }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})
    OPTIONAL MATCH (c)-[:REQUESTED_BY]->(req:User)
    OPTIONAL MATCH (c)-[:OWNED_BY]->(owner:User)
    OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN properties(req)   AS reqUser,
           properties(owner) AS ownerUser,
           wi.current_step   AS currentStep
  `, { id, tenantId })

  const ciRows = await runQuery<{
    ciProps: Props
    nodeLabels: string[]
    ciPhase: string | null
    riskScore: unknown
    ownerTask: Props | null
    supportTask: Props | null
    deployPlan: Props | null
    validation: Props | null
    deployment: Props | null
    review: Props | null
  }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci)
    WHERE ci.tenant_id = $tenantId
    OPTIONAL MATCH (c)-[:HAS_ASSESSMENT]->(ownerT:AssessmentTask)
      WHERE ownerT.ci_id = ci.id AND ownerT.responder_role = $ownerRole
    OPTIONAL MATCH (c)-[:HAS_ASSESSMENT]->(supportT:AssessmentTask)
      WHERE supportT.ci_id = ci.id AND supportT.responder_role = $supportRole
    OPTIONAL MATCH (c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask) WHERE dp.ci_id = ci.id
    OPTIONAL MATCH (c)-[:HAS_VALIDATION]->(vt:ValidationTest) WHERE vt.ci_id = ci.id
    OPTIONAL MATCH (c)-[:HAS_DEPLOYMENT]->(dt:DeploymentTask) WHERE dt.ci_id = ci.id
    OPTIONAL MATCH (c)-[:HAS_REVIEW]->(rv:ReviewTask) WHERE rv.ci_id = ci.id
    RETURN properties(ci) AS ciProps, labels(ci) AS nodeLabels,
           r.ci_phase   AS ciPhase,
           r.risk_score AS riskScore,
           properties(ownerT)   AS ownerTask,
           properties(supportT) AS supportTask,
           properties(dp) AS deployPlan,
           properties(vt) AS validation,
           properties(dt) AS deployment,
           properties(rv) AS review
    ORDER BY ci.name ASC
  `, { id, tenantId, ownerRole: ASSESSMENT_ROLE.OWNER, supportRole: ASSESSMENT_ROLE.SUPPORT })

  const auditRows = await runQuery<{ aProps: Props; uProps: Props | null }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_AUDIT]->(e:ChangeAuditEntry)
    OPTIONAL MATCH (e)-[:BY]->(u:User)
    RETURN properties(e) AS aProps, properties(u) AS uProps
    ORDER BY e.timestamp ASC
  `, { id, tenantId })

  return {
    change: {
      id:                 p['id']           as string,
      code:               (p['code']  ?? '') as string,
      title:              (p['title'] ?? '') as string,
      why:                (p['why']  ?? null) as string | null,
      what:               (p['what'] ?? null) as string | null,
      aggregateRiskScore: p['aggregate_risk_score'] == null ? null : Number(p['aggregate_risk_score']),
      approvalRoute:      (p['approval_route']  ?? null) as string | null,
      approvalStatus:     (p['approval_status'] ?? null) as string | null,
      approvalAt:         (p['approval_at']     ?? null) as string | null,
      createdAt:          (p['created_at']      ?? null) as string | null,
      updatedAt:          (p['updated_at']      ?? null) as string | null,
    },
    phase:       people?.currentStep ?? null,
    requester:   userRef(people?.reqUser),
    changeOwner: userRef(people?.ownerUser),
    affectedCIs: ciRows.map((r) => ({
      name:              (r.ciProps['name'] ?? r.ciProps['id'] ?? '') as string,
      type:              ciTypeFromLabels(tenantId, r.nodeLabels ?? []),
      environment:       (r.ciProps['environment'] ?? null) as string | null,
      riskScore:         r.riskScore == null ? null : Number(r.riskScore),
      ciPhase:           (r.ciPhase ?? null) as string | null,
      assessmentOwner:   taskInfo(r.ownerTask,   'completed_at'),
      assessmentSupport: taskInfo(r.supportTask, 'completed_at'),
      deployPlan:        taskInfo(r.deployPlan,  'completed_at'),
      validation:        taskInfo(r.validation,  'tested_at'),
      deployment:        taskInfo(r.deployment,  'deployed_at'),
      review:            taskInfo(r.review,      'reviewed_at'),
    })),
    workflowHistory: common.workflowHistory,
    auditTrail: auditRows.map((r) => ({
      timestamp: (r.aProps['timestamp'] ?? null) as string | null,
      action:    (r.aProps['action'] ?? '') as string,
      detail:    (r.aProps['detail'] ?? null) as string | null,
      actor:     r.uProps ? ((r.uProps['name'] ?? r.uProps['email'] ?? null) as string | null) : null,
    })),
    attachments: common.attachments,
  }
}

// ── Builder ───────────────────────────────────────────────────────────────────

const RISK_COLORS = (score: number): string =>
  score <= 30 ? '#16a34a' : score <= 60 ? '#d97706' : '#dc2626'

export async function buildChangePdf(data: ChangeDossier, meta: PdfMeta): Promise<Buffer> {
  return createPdfBuffer(
    `Change Audit Report ${data.change.code || data.change.id}`,
    meta,
    (doc) => renderDossier(doc, data),
  )
}

function renderDossier(doc: Doc, data: ChangeDossier): void {
  const ch = data.change

  renderTicketDossier(doc, {
    reportTitle: 'Change Audit Report',
    entityTitle: `${ch.code || ch.id} ${DASH} ${ch.title}`,
    badges: (doc, x, y) => {
      let bx = x
      bx += badge(doc, bx, y, `PHASE: ${(data.phase || 'n/d').toUpperCase().replace(/_/g, ' ')}`, COLOR.brand) + 6
      if (ch.approvalRoute || ch.approvalStatus) {
        bx += badge(doc, bx, y,
          `APPROVAL: ${[ch.approvalRoute, ch.approvalStatus].filter(Boolean).join(' / ').toUpperCase()}`,
          COLOR.dark) + 6
      }
      if (ch.aggregateRiskScore != null) {
        badge(doc, bx, y, `RISK: ${ch.aggregateRiskScore}`, RISK_COLORS(ch.aggregateRiskScore))
      }
    },
    sections: [
      detailsSection(data),
      ciTasksSection(data.affectedCIs),
      workflowHistorySection(data.workflowHistory),
      auditTrailSection(data.auditTrail),
      attachmentsSection(data.attachments),
    ],
  })
}

function detailsSection(data: ChangeDossier) {
  const ch = data.change
  return (doc: Doc): void => {
    sectionHeading(doc, 'Dettagli')
    keyValue(doc, 'Perché', orDash(ch.why))
    keyValue(doc, 'Cosa', orDash(ch.what))
    keyValue(doc, 'Richiedente', data.requester
      ? `${data.requester.name} <${data.requester.email}>`
      : DASH)
    keyValue(doc, 'Change owner', data.changeOwner
      ? `${data.changeOwner.name} <${data.changeOwner.email}>`
      : DASH)
    keyValue(doc, 'Approvazione', ch.approvalRoute || ch.approvalStatus
      ? `${orDash(ch.approvalRoute)} ${DASH} ${orDash(ch.approvalStatus)} (${fmtDate(ch.approvalAt)})`
      : DASH)
    keyValue(doc, 'Risk score', ch.aggregateRiskScore != null ? String(ch.aggregateRiskScore) : DASH)
    keyValue(doc, 'Creato il', fmtDate(ch.createdAt))
    keyValue(doc, 'Aggiornato il', fmtDate(ch.updatedAt))
  }
}

/** Per-CI block with the task table (assessments, plan, validation, deployment, review). */
function ciTasksSection(cis: ChangeCIDossier[]) {
  return (doc: Doc): void => {
    sectionHeading(doc, `CI impattati (${cis.length})`)
    if (!cis.length) { emptyLine(doc, 'Nessun CI collegato.'); return }
    for (const ci of cis) {
      ensureSpace(doc, 60)
      doc.moveDown(0.3)
      doc.fontSize(10).font('Helvetica-Bold').fillColor(COLOR.dark)
        .text(ci.name, PAGE_MARGIN.left, doc.y, { continued: true })
      doc.fontSize(8.5).font('Helvetica').fillColor(COLOR.muted)
        .text(`   ${ci.type}${ci.environment ? ` ${DASH} ${ci.environment}` : ''}` +
          `${ci.ciPhase ? ` ${DASH} fase: ${ci.ciPhase}` : ''}` +
          `${ci.riskScore != null ? ` ${DASH} risk score: ${ci.riskScore}` : ''}`)
      doc.moveDown(0.2)
      doc.x = PAGE_MARGIN.left

      const rows: string[][] = []
      const pushTask = (label: string, t: ChangeTaskInfo | null): void => {
        if (!t) return
        rows.push([
          label,
          orDash(t.code),
          orDash(t.status),
          t.score != null ? `score: ${t.score}` : orDash(t.result),
          fmtDate(t.completedAt),
        ])
      }
      pushTask('Assessment Functional', ci.assessmentOwner)
      pushTask('Assessment Technical',  ci.assessmentSupport)
      pushTask('Piano di deploy',       ci.deployPlan)
      pushTask('Validation',            ci.validation)
      pushTask('Deployment',            ci.deployment)
      pushTask('Review',                ci.review)

      if (!rows.length) {
        emptyLine(doc, 'Nessun task per questo CI.')
        doc.moveDown(0.3)
      } else {
        drawTable(doc,
          [
            { header: 'Task',        width: 125 },
            { header: 'Codice',      width: 95 },
            { header: 'Status',      width: 80 },
            { header: 'Esito/Score', width: 90 },
            { header: 'Completato',  width: 105 },
          ],
          rows,
        )
      }
    }
  }
}

function auditTrailSection(entries: ChangeDossier['auditTrail']) {
  return (doc: Doc): void => {
    sectionHeading(doc, `Audit trail (${entries.length})`)
    if (!entries.length) { emptyLine(doc, 'Nessuna voce di audit.'); return }
    drawTable(doc,
      [
        { header: 'Data',      width: 95 },
        { header: 'Azione',    width: 120 },
        { header: 'Utente',    width: 100 },
        { header: 'Dettaglio', width: 180 },
      ],
      entries.map((e) => [
        fmtDate(e.timestamp),
        e.action.replace(/_/g, ' '),
        orDash(e.actor),
        orDash(e.detail),
      ]),
    )
  }
}
