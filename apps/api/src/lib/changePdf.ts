/**
 * Change PDF export — builds the full "Change Audit Report" for a single
 * change: details, approval route, per-CI task dossier (assessments, plan,
 * validation, deployment, review), workflow history, audit trail and
 * attachment metadata. Pure pdfkit, returns a Buffer. Shared parts live in
 * ./pdf/ticketDossier.ts.
 */
import { pdfText } from './pdf/texts.js'
import { valueColorInk } from './pdf/common.js'
import type { ValueColor } from '@opengraphity/types'
import { riskBandOf } from './riskBands.js'
import { loadVocabularyEntries } from './vocabularyEntries.js'
import { runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import { ciTypeFromLabels } from './ciTypeFromLabels.js'
import { ASSESSMENT_ROLE } from './taskStatus.js'
import {
  DASH, fmtDate, orDash, PAGE_MARGIN, COLOR, type Doc, type PdfMeta, type PdfLocale,
  ensureSpace, sectionHeading, emptyLine, drawTable, keyValue, badge, createPdfBuffer,
} from './pdf/common.js'
import {
  loadTicketDossier, renderTicketDossier, userRef,
  workflowHistorySection, attachmentsSection,
  type Props, type UserRef, type WorkflowHistoryEntry, type AttachmentEntry, type CustomFieldLine, customFieldsSection,
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
  /** Il colore della fascia di rischio del cliente per questo punteggio (C-17). */
  riskBandColor?: ValueColor | null
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
  customFields:    CustomFieldLine[]
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

  /**
   * C-17: la fascia del punteggio e il colore che il cliente le ha dato. Un
   * punteggio assente non ha fascia (il badge non viene disegnato affatto).
   */
  const score = p['aggregate_risk_score'] == null ? null : Number(p['aggregate_risk_score'])
  const riskBandColor = score == null ? null : await (async () => {
    const band = await riskBandOf(tenantId, score)
    return (await loadVocabularyEntries(tenantId, 'risk_band')).colors[band] ?? null
  })()

  return {
    riskBandColor,
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
    customFields:    common.customFields,
  }
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Il colore del badge RISK viene dalla FASCIA del cliente (revisione totale ·
 * C-17): qui c'erano le soglie 30/60 scritte nel codice, mentre le fasce di
 * rischio sono dato del cliente (`Tenant.risk_band_thresholds`). Con fasce
 * ≤20/≤50/100 un rischio 25 era «medio» nel prodotto e verde nel dossier.
 * Il colore è quello che il cliente ha scelto nel Dizionario per quel valore
 * di `risk_band`; se non ne ha scelto nessuno resta il grigio neutro, come
 * per gli altri badge di vocabolario.
 */


export async function buildChangePdf(data: ChangeDossier, meta: PdfMeta): Promise<Buffer> {
  return createPdfBuffer(
    `Change Audit Report ${data.change.code || data.change.id}`,
    meta,
    (doc) => renderDossier(doc, data, meta.locale),
  )
}

function renderDossier(doc: Doc, data: ChangeDossier, locale: PdfLocale): void {
  const ch = data.change

  renderTicketDossier(doc, {
    reportTitle: pdfText(locale, 'reportChange'),
    entityTitle: `${ch.code || ch.id} ${DASH} ${ch.title}`,
    badges: (doc, x, y) => {
      let bx = x
      // C-18: etichette dei badge tradotte, come il resto del dossier.
      bx += badge(doc, bx, y, `${pdfText(locale, 'badgePhase')}: ${(data.phase || pdfText(locale, 'notAvailable')).toUpperCase().replace(/_/g, ' ')}`, COLOR.brand) + 6
      if (ch.approvalRoute || ch.approvalStatus) {
        bx += badge(doc, bx, y,
          `${pdfText(locale, 'badgeApproval')}: ${[ch.approvalRoute, ch.approvalStatus].filter(Boolean).join(' / ').toUpperCase()}`,
          COLOR.dark) + 6
      }
      if (ch.aggregateRiskScore != null) {
        badge(doc, bx, y, `${pdfText(locale, 'badgeRisk')}: ${ch.aggregateRiskScore}`, valueColorInk(data.riskBandColor ?? null))
      }
    },
    sections: [
      detailsSection(data, locale),
      customFieldsSection(data.customFields, locale),
      ciTasksSection(data.affectedCIs, locale),
      workflowHistorySection(data.workflowHistory, locale),
      auditTrailSection(data.auditTrail, locale),
      attachmentsSection(data.attachments, locale),
    ],
  })
}

function detailsSection(data: ChangeDossier, locale: PdfLocale) {
  const ch = data.change
  return (doc: Doc): void => {
    sectionHeading(doc, pdfText(locale, 'details'))
    keyValue(doc, pdfText(locale, 'why'), orDash(ch.why))
    keyValue(doc, pdfText(locale, 'what'), orDash(ch.what))
    keyValue(doc, pdfText(locale, 'requester'), data.requester
      ? `${data.requester.name} <${data.requester.email}>`
      : DASH)
    keyValue(doc, pdfText(locale, 'changeOwner'), data.changeOwner
      ? `${data.changeOwner.name} <${data.changeOwner.email}>`
      : DASH)
    keyValue(doc, pdfText(locale, 'approval'), ch.approvalRoute || ch.approvalStatus
      ? `${orDash(ch.approvalRoute)} ${DASH} ${orDash(ch.approvalStatus)} (${fmtDate(ch.approvalAt, locale)})`
      : DASH)
    keyValue(doc, pdfText(locale, 'riskScore'), ch.aggregateRiskScore != null ? String(ch.aggregateRiskScore) : DASH)
    keyValue(doc, pdfText(locale, 'createdAt'), fmtDate(ch.createdAt, locale))
    keyValue(doc, pdfText(locale, 'updatedAt'), fmtDate(ch.updatedAt, locale))
  }
}

/** Per-CI block with the task table (assessments, plan, validation, deployment, review). */
function ciTasksSection(cis: ChangeCIDossier[], locale: PdfLocale) {
  return (doc: Doc): void => {
    sectionHeading(doc, pdfText(locale, 'affectedCIs', { count: cis.length }))
    if (!cis.length) { emptyLine(doc, pdfText(locale, 'noCIs')); return }
    for (const ci of cis) {
      ensureSpace(doc, 60)
      doc.moveDown(0.3)
      doc.fontSize(10).font('Helvetica-Bold').fillColor(COLOR.dark)
        .text(ci.name, PAGE_MARGIN.left, doc.y, { continued: true })
      doc.fontSize(8.5).font('Helvetica').fillColor(COLOR.muted)
        .text(`   ${ci.type}${ci.environment ? ` ${DASH} ${ci.environment}` : ''}` +
          `${ci.ciPhase ? ` ${DASH} ${pdfText(locale, 'phase')}: ${ci.ciPhase}` : ''}` +
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
          fmtDate(t.completedAt, locale),
        ])
      }
      pushTask('Assessment Functional', ci.assessmentOwner)
      pushTask('Assessment Technical',  ci.assessmentSupport)
      pushTask(pdfText(locale, 'deployPlan'), ci.deployPlan)
      pushTask('Validation',            ci.validation)
      pushTask('Deployment',            ci.deployment)
      pushTask('Review',                ci.review)

      if (!rows.length) {
        emptyLine(doc, pdfText(locale, 'noTasksForCI'))
        doc.moveDown(0.3)
      } else {
        drawTable(doc,
          [
            { header: pdfText(locale, 'colTask'),      width: 125 },
            { header: pdfText(locale, 'colCode'),      width: 95 },
            { header: 'Status',      width: 80 },
            { header: pdfText(locale, 'colOutcome'),   width: 90 },
            { header: pdfText(locale, 'colCompleted'), width: 105 },
          ],
          rows,
        )
      }
    }
  }
}

function auditTrailSection(entries: ChangeDossier['auditTrail'], locale: PdfLocale) {
  return (doc: Doc): void => {
    sectionHeading(doc, pdfText(locale, 'auditTrail', { count: entries.length }))
    if (!entries.length) { emptyLine(doc, pdfText(locale, 'noAudit')); return }
    drawTable(doc,
      [
        { header: pdfText(locale, 'colDate'),   width: 95 },
        { header: pdfText(locale, 'colAction'), width: 120 },
        { header: pdfText(locale, 'colUser'),   width: 100 },
        { header: pdfText(locale, 'colDetail'), width: 180 },
      ],
      entries.map((e) => [
        fmtDate(e.timestamp, locale),
        e.action.replace(/_/g, ' '),
        orDash(e.actor),
        orDash(e.detail),
      ]),
    )
  }
}
