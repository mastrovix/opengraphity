/**
 * Shared "ticket dossier" loading and rendering for the audit-report PDFs
 * (incident, change, problem). The three exports used to carry identical
 * copies of the assignee/team, affected-CI, workflow-history, comment and
 * attachment queries plus their table renderers (A-23 / C-20c); they now
 * live here once. Entity-specific parts (SLA, assessment tasks, root cause…)
 * stay in the per-entity builder and are plugged in as sections.
 */
import { runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import { NotFoundError } from '../errors.js'
import { ciTypeFromLabels } from '../ciTypeFromLabels.js'
import {
  DASH, fmtDate, fmtDuration, fmtBytes, orDash,
  PAGE_MARGIN, COLOR, type Doc,
  contentWidth, ensureSpace, sectionHeading, emptyLine,
  drawTable, docHeader,
} from './common.js'

export type Props = Record<string, unknown>

// ── Shared dossier fragments ──────────────────────────────────────────────────

export interface UserRef { name: string; email: string }

export interface AffectedCI {
  name:        string
  type:        string
  environment: string | null
  status:      string | null
}

export interface WorkflowHistoryEntry {
  stepName:    string
  enteredAt:   string | null
  exitedAt:    string | null
  durationMs:  number | null
  triggeredBy: string | null
  triggerType: string | null
  notes:       string | null
}

export interface CommentEntry {
  author:    string | null
  /** Comment kind (problem comments carry one: manual/workaround/…); null when the entity has no such notion. */
  type:      string | null
  createdAt: string | null
  text:      string
}

export interface AttachmentEntry {
  filename:   string
  sizeBytes:  number
  uploadedBy: string | null
  uploadedAt: string | null
}

export function userRef(p: Props | null | undefined): UserRef | null {
  if (!p || !p['id']) return null
  return { name: (p['name'] ?? '') as string, email: (p['email'] ?? '') as string }
}

// ── Loading ───────────────────────────────────────────────────────────────────

export type TicketLabel = 'Incident' | 'Problem' | 'Change'

export interface TicketDossierSpec {
  label: TicketLabel
  /** `Attachment.entity_type` value for this ticket kind. */
  entityType: 'incident' | 'problem' | 'change'
  /** Relationship ticket → CI (AFFECTED_BY, AFFECTS). Omit to skip the CI query. */
  ciRelation?: string
  /** Comment node label + property holding the author user id. Omit when the entity has no comments. */
  comments?: { label: string; authorProp: string }
  /** Exclude soft-deleted entities (`e.deleted = true`). */
  softDelete?: boolean
}

export interface TicketDossierCommon {
  /** Raw properties of the ticket node — the caller maps its own fields. */
  props:           Props
  assignee:        UserRef | null
  team:            { name: string } | null
  affectedCIs:     AffectedCI[]
  workflowHistory: WorkflowHistoryEntry[]
  comments:        CommentEntry[]
  attachments:     AttachmentEntry[]
}

/**
 * Loads the parts every ticket dossier shares: the ticket itself with its
 * assignee/team, affected CIs, workflow step history, comments and
 * attachment metadata. Throws NotFoundError when the ticket does not exist
 * in the tenant. All Cypher is tenant-scoped; `label` comes from the
 * TicketLabel union (never from user input).
 */
export async function loadTicketDossier(
  session: Queryable,
  spec: TicketDossierSpec,
  id: string,
  tenantId: string,
): Promise<TicketDossierCommon> {
  const L = spec.label
  const softDeleteClause = spec.softDelete ? 'WHERE coalesce(e.deleted, false) = false' : ''

  const base = await runQueryOne<{ props: Props; uProps: Props | null; tProps: Props | null }>(session, `
    MATCH (e:${L} {id: $id, tenant_id: $tenantId})
    ${softDeleteClause}
    OPTIONAL MATCH (e)-[:ASSIGNED_TO]->(u:User)
    OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(t:Team)
    RETURN properties(e) AS props, properties(u) AS uProps, properties(t) AS tProps
  `, { id, tenantId })
  if (!base) throw new NotFoundError(L, id)

  const ciRows = spec.ciRelation
    ? await runQuery<{ props: Props; nodeLabels: string[] }>(session, `
        MATCH (e:${L} {id: $id, tenant_id: $tenantId})-[:${spec.ciRelation}]->(ci)
        WHERE ci.tenant_id = $tenantId
        RETURN properties(ci) AS props, labels(ci) AS nodeLabels
        ORDER BY ci.name ASC
      `, { id, tenantId })
    : []

  const historyRows = await runQuery<{ eProps: Props }>(session, `
    MATCH (e:${L} {id: $id, tenant_id: $tenantId})
          -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
          -[:STEP_HISTORY]->(exec:WorkflowStepExecution)
    RETURN properties(exec) AS eProps
    ORDER BY exec.entered_at ASC
  `, { id, tenantId })

  const commentRows = spec.comments
    ? await runQuery<{ cProps: Props; uProps: Props | null }>(session, `
        MATCH (e:${L} {id: $id, tenant_id: $tenantId})-[:HAS_COMMENT]->(c:${spec.comments.label})
        OPTIONAL MATCH (u:User {id: c.${spec.comments.authorProp}, tenant_id: $tenantId})
        RETURN properties(c) AS cProps, properties(u) AS uProps
        ORDER BY c.created_at ASC
      `, { id, tenantId })
    : []

  const attachmentRows = await runQuery<{ filename: string; sizeBytes: number | null; uploadedBy: string | null; uploadedAt: string | null }>(session, `
    MATCH (a:Attachment {tenant_id: $tenantId, entity_type: $entityType, entity_id: $id})
    OPTIONAL MATCH (u:User {id: a.uploaded_by, tenant_id: $tenantId})
    RETURN a.filename                              AS filename,
           a.size_bytes                            AS sizeBytes,
           coalesce(u.name, u.email, a.uploaded_by) AS uploadedBy,
           a.uploaded_at                           AS uploadedAt
    ORDER BY a.uploaded_at DESC
  `, { id, tenantId, entityType: spec.entityType })

  return {
    props:    base.props,
    assignee: userRef(base.uProps),
    team:     base.tProps ? { name: (base.tProps['name'] ?? '') as string } : null,
    affectedCIs: ciRows.map((r) => mapAffectedCI(tenantId, r)),
    workflowHistory: historyRows.map((r) => mapWorkflowHistory(r.eProps)),
    comments: commentRows.map((r) => ({
      author:    r.uProps ? ((r.uProps['name'] ?? r.uProps['email'] ?? null) as string | null) : null,
      type:      (r.cProps['type'] ?? null) as string | null,
      createdAt: (r.cProps['created_at'] ?? null) as string | null,
      text:      (r.cProps['text'] ?? '') as string,
    })),
    attachments: attachmentRows.map((r) => ({
      filename:   r.filename ?? '',
      sizeBytes:  r.sizeBytes == null ? 0 : Number(r.sizeBytes),
      uploadedBy: r.uploadedBy ?? null,
      uploadedAt: r.uploadedAt ?? null,
    })),
  }
}

export function mapAffectedCI(tenantId: string, r: { props: Props; nodeLabels: string[] }): AffectedCI {
  return {
    name:        (r.props['name'] ?? r.props['id'] ?? '') as string,
    type:        ciTypeFromLabels(tenantId, r.nodeLabels ?? []),
    environment: (r.props['environment'] ?? null) as string | null,
    status:      (r.props['status'] ?? null) as string | null,
  }
}

export function mapWorkflowHistory(e: Props): WorkflowHistoryEntry {
  return {
    stepName:    (e['step_name'] ?? '') as string,
    enteredAt:   (e['entered_at'] ?? null) as string | null,
    exitedAt:    (e['exited_at']  ?? null) as string | null,
    durationMs:  e['duration_ms'] == null ? null : Math.round(Number(e['duration_ms'])),
    triggeredBy: (e['triggered_by'] ?? null) as string | null,
    triggerType: (e['trigger_type'] ?? null) as string | null,
    notes:       (e['notes'] ?? null) as string | null,
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** One block of the report; runs with the cursor at the left margin. */
export type Section = (doc: Doc) => void

export interface TicketRenderSpec {
  reportTitle: string
  entityTitle: string
  /** Draws the badge row starting at (x, y); the cursor is repositioned below afterwards. */
  badges?:     (doc: Doc, x: number, y: number) => void
  sections:    Section[]
}

/** Header + badges, then every section in order. */
export function renderTicketDossier(doc: Doc, spec: TicketRenderSpec): void {
  docHeader(doc, spec.reportTitle, spec.entityTitle)
  if (spec.badges) {
    const by = doc.y
    spec.badges(doc, PAGE_MARGIN.left, by)
    doc.y = by + 24
    doc.x = PAGE_MARGIN.left
  }
  for (const section of spec.sections) {
    section(doc)
    doc.x = PAGE_MARGIN.left
  }
}

export function affectedCIsSection(cis: AffectedCI[]): Section {
  return (doc) => {
    sectionHeading(doc, `CI impattati (${cis.length})`)
    if (!cis.length) { emptyLine(doc, 'Nessun CI collegato.'); return }
    drawTable(doc,
      [
        { header: 'Nome',        width: 190 },
        { header: 'Tipo',        width: 120 },
        { header: 'Environment', width: 95 },
        { header: 'Status',      width: 90 },
      ],
      cis.map((ci) => [ci.name, ci.type, orDash(ci.environment), orDash(ci.status)]),
    )
  }
}

export function workflowHistorySection(history: WorkflowHistoryEntry[]): Section {
  return (doc) => {
    sectionHeading(doc, `Cronologia workflow (${history.length})`)
    if (!history.length) { emptyLine(doc, 'Nessuna cronologia workflow.'); return }
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
      history.map((h) => [
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
}

export function commentsSection(comments: CommentEntry[]): Section {
  return (doc) => {
    sectionHeading(doc, `Commenti (${comments.length})`)
    if (!comments.length) { emptyLine(doc, 'Nessun commento.'); return }
    for (const c of comments) {
      ensureSpace(doc, 34)
      doc.fontSize(9).font('Helvetica-Bold').fillColor(COLOR.dark)
        .text(c.author ?? 'Utente sconosciuto', PAGE_MARGIN.left, doc.y, { continued: true })
      doc.font('Helvetica').fillColor(COLOR.muted)
        .text(`  ${c.type ? `[${c.type}]  ` : ''}${DASH}  ${fmtDate(c.createdAt)}`)
      doc.moveDown(0.15)
      doc.fontSize(9).font('Helvetica').fillColor(COLOR.text)
        .text(c.text || DASH, PAGE_MARGIN.left + 10, doc.y,
          { width: contentWidth(doc) - 10, lineGap: 2.5 })
      doc.x = PAGE_MARGIN.left
      doc.moveDown(0.6)
    }
  }
}

export function attachmentsSection(attachments: AttachmentEntry[]): Section {
  return (doc) => {
    sectionHeading(doc, `Allegati (${attachments.length})`)
    if (!attachments.length) { emptyLine(doc, 'Nessun allegato.'); return }
    drawTable(doc,
      [
        { header: 'Filename',    width: 210 },
        { header: 'Dimensione',  width: 70 },
        { header: 'Caricato da', width: 120 },
        { header: 'Caricato il', width: 95 },
      ],
      attachments.map((a) => [
        a.filename,
        fmtBytes(a.sizeBytes),
        orDash(a.uploadedBy),
        fmtDate(a.uploadedAt),
      ]),
    )
  }
}
