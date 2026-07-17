/**
 * Change PDF export — builds the full "Change Audit Report" for a single
 * change: details, approval route, per-CI task dossier (assessments, plan,
 * validation, deployment, review), workflow history, audit trail and
 * attachment metadata. Pure pdfkit, returns a Buffer.
 */
import { runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import { NotFoundError } from './errors.js'
import { ciTypeFromLabels } from './ciTypeFromLabels.js'
import { ASSESSMENT_ROLE } from './taskStatus.js'
import {
  DASH, fmtDate, fmtDuration, fmtBytes, orDash,
  PAGE_MARGIN, COLOR, type Doc, type PdfMeta,
  ensureSpace, sectionHeading, emptyLine,
  drawTable, keyValue, badge, docHeader, createPdfBuffer,
} from './pdf/common.js'

export type { PdfMeta }

type Props = Record<string, unknown>

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
    description:        string | null
    aggregateRiskScore: number | null
    approvalRoute:      string | null
    approvalStatus:     string | null
    approvalAt:         string | null
    createdAt:          string | null
    updatedAt:          string | null
  }
  phase:       string | null   // workflow instance current_step
  requester:   { name: string; email: string } | null
  changeOwner: { name: string; email: string } | null
  affectedCIs: ChangeCIDossier[]
  workflowHistory: Array<{
    stepName:    string
    enteredAt:   string | null
    exitedAt:    string | null
    durationMs:  number | null
    triggeredBy: string | null
    triggerType: string | null
    notes:       string | null
  }>
  auditTrail: Array<{
    timestamp: string | null
    action:    string
    detail:    string | null
    actor:     string | null
  }>
  attachments: Array<{ filename: string; sizeBytes: number; uploadedBy: string | null; uploadedAt: string | null }>
}

// ── Data loading (tenant-scoped Cypher) ───────────────────────────────────────

function userRef(p: Props | null): { name: string; email: string } | null {
  if (!p || !p['id']) return null
  return { name: (p['name'] ?? '') as string, email: (p['email'] ?? '') as string }
}

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
  const base = await runQueryOne<{
    props: Props
    reqUser: Props | null
    ownerUser: Props | null
    currentStep: string | null
  }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})
    OPTIONAL MATCH (c)-[:REQUESTED_BY]->(req:User)
    OPTIONAL MATCH (c)-[:OWNED_BY]->(owner:User)
    OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN properties(c) AS props,
           properties(req)   AS reqUser,
           properties(owner) AS ownerUser,
           wi.current_step   AS currentStep
  `, { id, tenantId })

  if (!base) throw new NotFoundError('Change', id)
  const p = base.props

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

  const historyRows = await runQuery<{ eProps: Props }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})
          -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
          -[:STEP_HISTORY]->(exec:WorkflowStepExecution)
    RETURN properties(exec) AS eProps
    ORDER BY exec.entered_at ASC
  `, { id, tenantId })

  const auditRows = await runQuery<{ aProps: Props; uProps: Props | null }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_AUDIT]->(e:ChangeAuditEntry)
    OPTIONAL MATCH (e)-[:BY]->(u:User)
    RETURN properties(e) AS aProps, properties(u) AS uProps
    ORDER BY e.timestamp ASC
  `, { id, tenantId })

  const attachmentRows = await runQuery<{ filename: string; sizeBytes: number | null; uploadedBy: string | null; uploadedAt: string | null }>(session, `
    MATCH (a:Attachment {tenant_id: $tenantId, entity_type: 'change', entity_id: $id})
    OPTIONAL MATCH (u:User {id: a.uploaded_by, tenant_id: $tenantId})
    RETURN a.filename                              AS filename,
           a.size_bytes                            AS sizeBytes,
           coalesce(u.name, u.email, a.uploaded_by) AS uploadedBy,
           a.uploaded_at                           AS uploadedAt
    ORDER BY a.uploaded_at DESC
  `, { id, tenantId })

  return {
    change: {
      id:                 p['id']           as string,
      code:               (p['code']  ?? '') as string,
      title:              (p['title'] ?? '') as string,
      description:        (p['description'] ?? null) as string | null,
      aggregateRiskScore: p['aggregate_risk_score'] == null ? null : Number(p['aggregate_risk_score']),
      approvalRoute:      (p['approval_route']  ?? null) as string | null,
      approvalStatus:     (p['approval_status'] ?? null) as string | null,
      approvalAt:         (p['approval_at']     ?? null) as string | null,
      createdAt:          (p['created_at']      ?? null) as string | null,
      updatedAt:          (p['updated_at']      ?? null) as string | null,
    },
    phase:       base.currentStep ?? null,
    requester:   userRef(base.reqUser),
    changeOwner: userRef(base.ownerUser),
    affectedCIs: ciRows.map((r) => ({
      name:              (r.ciProps['name'] ?? r.ciProps['id'] ?? '') as string,
      type:              ciTypeFromLabels(r.nodeLabels ?? []),
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
    workflowHistory: historyRows.map((r) => ({
      stepName:    (r.eProps['step_name'] ?? '') as string,
      enteredAt:   (r.eProps['entered_at'] ?? null) as string | null,
      exitedAt:    (r.eProps['exited_at']  ?? null) as string | null,
      durationMs:  r.eProps['duration_ms'] == null ? null : Math.round(Number(r.eProps['duration_ms'])),
      triggeredBy: (r.eProps['triggered_by'] ?? null) as string | null,
      triggerType: (r.eProps['trigger_type'] ?? null) as string | null,
      notes:       (r.eProps['notes'] ?? null) as string | null,
    })),
    auditTrail: auditRows.map((r) => ({
      timestamp: (r.aProps['timestamp'] ?? null) as string | null,
      action:    (r.aProps['action'] ?? '') as string,
      detail:    (r.aProps['detail'] ?? null) as string | null,
      actor:     r.uProps ? ((r.uProps['name'] ?? r.uProps['email'] ?? null) as string | null) : null,
    })),
    attachments: attachmentRows.map((r) => ({
      filename:   r.filename ?? '',
      sizeBytes:  r.sizeBytes == null ? 0 : Number(r.sizeBytes),
      uploadedBy: r.uploadedBy ?? null,
      uploadedAt: r.uploadedAt ?? null,
    })),
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

  // ── Header ──
  docHeader(doc, 'Change Audit Report', `${ch.code || ch.id} ${DASH} ${ch.title}`)

  // Badges: phase + approval + risk
  let bx = PAGE_MARGIN.left
  const by = doc.y
  bx += badge(doc, bx, by, `PHASE: ${(data.phase || 'n/d').toUpperCase().replace(/_/g, ' ')}`, COLOR.brand) + 6
  if (ch.approvalRoute || ch.approvalStatus) {
    bx += badge(doc, bx, by,
      `APPROVAL: ${[ch.approvalRoute, ch.approvalStatus].filter(Boolean).join(' / ').toUpperCase()}`,
      COLOR.dark) + 6
  }
  if (ch.aggregateRiskScore != null) {
    badge(doc, bx, by, `RISK: ${ch.aggregateRiskScore}`, RISK_COLORS(ch.aggregateRiskScore))
  }
  doc.y = by + 24
  doc.x = PAGE_MARGIN.left

  // ── Dettagli ──
  sectionHeading(doc, 'Dettagli')
  keyValue(doc, 'Descrizione', orDash(ch.description))
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

  // ── CI impattati con task ──
  sectionHeading(doc, `CI impattati (${data.affectedCIs.length})`)
  if (!data.affectedCIs.length) {
    emptyLine(doc, 'Nessun CI collegato.')
  } else {
    for (const ci of data.affectedCIs) {
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

  // ── Cronologia workflow ──
  sectionHeading(doc, `Cronologia workflow (${data.workflowHistory.length})`)
  if (!data.workflowHistory.length) {
    emptyLine(doc, 'Nessuna cronologia workflow.')
  } else {
    drawTable(doc,
      [
        { header: 'Step',       width: 75 },
        { header: 'Entrata',    width: 82 },
        { header: 'Uscita',     width: 82 },
        { header: 'Durata',     width: 50 },
        { header: 'Attore',     width: 78 },
        { header: 'Trigger',    width: 48 },
        { header: 'Note',       width: 80 },
      ],
      data.workflowHistory.map((h) => [
        h.stepName.replace(/_/g, ' '),
        fmtDate(h.enteredAt),
        fmtDate(h.exitedAt),
        fmtDuration(h.durationMs),
        orDash(h.triggeredBy),
        orDash(h.triggerType),
        orDash(h.notes),
      ]),
    )
  }

  // ── Audit trail ──
  sectionHeading(doc, `Audit trail (${data.auditTrail.length})`)
  if (!data.auditTrail.length) {
    emptyLine(doc, 'Nessuna voce di audit.')
  } else {
    drawTable(doc,
      [
        { header: 'Data',     width: 95 },
        { header: 'Azione',   width: 120 },
        { header: 'Utente',   width: 100 },
        { header: 'Dettaglio', width: 180 },
      ],
      data.auditTrail.map((e) => [
        fmtDate(e.timestamp),
        e.action.replace(/_/g, ' '),
        orDash(e.actor),
        orDash(e.detail),
      ]),
    )
  }

  // ── Allegati ──
  sectionHeading(doc, `Allegati (${data.attachments.length})`)
  if (!data.attachments.length) {
    emptyLine(doc, 'Nessun allegato.')
  } else {
    drawTable(doc,
      [
        { header: 'Filename',    width: 210 },
        { header: 'Dimensione',  width: 70 },
        { header: 'Caricato da', width: 120 },
        { header: 'Caricato il', width: 95 },
      ],
      data.attachments.map((a) => [
        a.filename,
        fmtBytes(a.sizeBytes),
        orDash(a.uploadedBy),
        fmtDate(a.uploadedAt),
      ]),
    )
  }
}
