/**
 * Problem PDF export — builds the full "Problem Audit Report" for a single
 * problem: details, root cause/workaround, affected CIs, related incidents
 * and changes, workflow history, comments and attachment metadata.
 * Pure pdfkit, returns a Buffer. Shared parts live in ./pdf/ticketDossier.ts.
 */
import { runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import {
  DASH, fmtDate, orDash, COLOR, type Doc, type PdfMeta,
  sectionHeading, emptyLine, drawTable, keyValue, badge, createPdfBuffer,
} from './pdf/common.js'
import {
  loadTicketDossier, renderTicketDossier, userRef,
  affectedCIsSection, workflowHistorySection, commentsSection, attachmentsSection,
  type Props, type UserRef, type AffectedCI, type WorkflowHistoryEntry, type AttachmentEntry,
} from './pdf/ticketDossier.js'

export type { PdfMeta }

// ── Dossier shape ─────────────────────────────────────────────────────────────

export interface ProblemDossier {
  problem: {
    id:            string
    number:        string
    title:         string
    description:   string | null
    priority:      string
    status:        string
    rootCause:     string | null
    workaround:    string | null
    affectedUsers: number | null
    createdAt:     string | null
    updatedAt:     string | null
    resolvedAt:    string | null
    closedAt:      string | null
  }
  createdBy: UserRef | null
  assignee:  UserRef | null
  team:      { name: string } | null
  affectedCIs:      AffectedCI[]
  relatedIncidents: Array<{ number: string; title: string; status: string }>
  relatedChanges:   Array<{ code: string; title: string; status: string }>
  workflowHistory:  WorkflowHistoryEntry[]
  comments:         Array<{ author: string | null; type: string; createdAt: string | null; text: string }>
  attachments:      AttachmentEntry[]
}

// ── Data loading (tenant-scoped Cypher) ───────────────────────────────────────

export async function loadProblemDossier(
  session: Queryable,
  id: string,
  tenantId: string,
): Promise<ProblemDossier> {
  const common = await loadTicketDossier(session, {
    label:      'Problem',
    entityType: 'problem',
    ciRelation: 'AFFECTS',
    comments:   { label: 'ProblemComment', authorProp: 'created_by' },
  }, id, tenantId)
  const p = common.props

  const creator = await runQueryOne<{ cProps: Props | null }>(session, `
    MATCH (p:Problem {id: $id, tenant_id: $tenantId})
    OPTIONAL MATCH (p)-[:CREATED_BY]->(cb:User)
    RETURN properties(cb) AS cProps
  `, { id, tenantId })

  const incidentRows = await runQuery<{ number: string | null; title: string | null; status: string | null }>(session, `
    MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:CAUSED_BY]->(i:Incident)
    RETURN i.number AS number, i.title AS title, i.status AS status
    ORDER BY i.created_at ASC
  `, { id, tenantId })

  const changeRows = await runQuery<{ code: string | null; title: string | null; status: string | null }>(session, `
    MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:RESOLVED_BY]->(c:Change)
    WHERE coalesce(c.deleted, false) = false
    OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN c.code AS code, c.title AS title,
           coalesce(wi.current_step, c.status) AS status
    ORDER BY c.created_at ASC
  `, { id, tenantId })

  return {
    problem: {
      id:            p['id']            as string,
      number:        (p['number'] ?? '') as string,
      title:         (p['title']  ?? '') as string,
      description:   (p['description'] ?? null) as string | null,
      priority:      (p['priority'] ?? '') as string,
      status:        (p['status']   ?? '') as string,
      rootCause:     (p['root_cause'] ?? null) as string | null,
      workaround:    (p['workaround'] ?? null) as string | null,
      affectedUsers: p['affected_users'] == null ? null : Number(p['affected_users']),
      createdAt:     (p['created_at']  ?? null) as string | null,
      updatedAt:     (p['updated_at']  ?? null) as string | null,
      resolvedAt:    (p['resolved_at'] ?? null) as string | null,
      closedAt:      (p['closed_at']   ?? null) as string | null,
    },
    createdBy: userRef(creator?.cProps),
    assignee:  common.assignee,
    team:      common.team,
    affectedCIs: common.affectedCIs,
    relatedIncidents: incidentRows.map((r) => ({
      number: r.number ?? '',
      title:  r.title  ?? '',
      status: r.status ?? '',
    })),
    relatedChanges: changeRows.map((r) => ({
      code:   r.code   ?? '',
      title:  r.title  ?? '',
      status: r.status ?? '',
    })),
    workflowHistory: common.workflowHistory,
    comments:        common.comments.map((c) => ({ ...c, type: c.type ?? 'manual' })),
    attachments:     common.attachments,
  }
}

// ── Builder ───────────────────────────────────────────────────────────────────

const PRIORITY_COLORS: Record<string, string> = {
  critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#16a34a',
}

export async function buildProblemPdf(data: ProblemDossier, meta: PdfMeta): Promise<Buffer> {
  return createPdfBuffer(
    `Problem Audit Report ${data.problem.number || data.problem.id}`,
    meta,
    (doc) => renderDossier(doc, data),
  )
}

function renderDossier(doc: Doc, data: ProblemDossier): void {
  const pr = data.problem

  renderTicketDossier(doc, {
    reportTitle: 'Problem Audit Report',
    entityTitle: `${pr.number || pr.id} ${DASH} ${pr.title}`,
    badges: (doc, x, y) => {
      let bx = x
      bx += badge(doc, bx, y, `PRIORITY: ${(pr.priority || 'n/d').toUpperCase()}`,
        PRIORITY_COLORS[pr.priority?.toLowerCase() ?? ''] ?? COLOR.muted) + 6
      badge(doc, bx, y, `STATUS: ${(pr.status || 'n/d').toUpperCase().replace(/_/g, ' ')}`, COLOR.brand)
    },
    sections: [
      detailsSection(data),
      affectedCIsSection(data.affectedCIs),
      relatedIncidentsSection(data.relatedIncidents),
      relatedChangesSection(data.relatedChanges),
      workflowHistorySection(data.workflowHistory),
      commentsSection(data.comments),
      attachmentsSection(data.attachments),
    ],
  })
}

function detailsSection(data: ProblemDossier) {
  const pr = data.problem
  return (doc: Doc): void => {
    sectionHeading(doc, 'Dettagli')
    keyValue(doc, 'Descrizione', orDash(pr.description))
    keyValue(doc, 'Root cause', orDash(pr.rootCause))
    keyValue(doc, 'Workaround', orDash(pr.workaround))
    keyValue(doc, 'Utenti impattati', pr.affectedUsers != null ? String(pr.affectedUsers) : DASH)
    keyValue(doc, 'Creato da', data.createdBy
      ? `${data.createdBy.name} <${data.createdBy.email}>`
      : DASH)
    keyValue(doc, 'Assegnatario', data.assignee
      ? `${data.assignee.name} <${data.assignee.email}>`
      : DASH)
    keyValue(doc, 'Team', data.team ? data.team.name : DASH)
    keyValue(doc, 'Creato il', fmtDate(pr.createdAt))
    keyValue(doc, 'Aggiornato il', fmtDate(pr.updatedAt))
    keyValue(doc, 'Risolto il', fmtDate(pr.resolvedAt))
    keyValue(doc, 'Chiuso il', fmtDate(pr.closedAt))
  }
}

function relatedIncidentsSection(items: ProblemDossier['relatedIncidents']) {
  return (doc: Doc): void => {
    sectionHeading(doc, `Incident correlati (${items.length})`)
    if (!items.length) { emptyLine(doc, 'Nessun incident correlato.'); return }
    drawTable(doc,
      [
        { header: 'Numero', width: 100 },
        { header: 'Titolo', width: 295 },
        { header: 'Status', width: 100 },
      ],
      items.map((i) => [orDash(i.number), i.title, orDash(i.status)]),
    )
  }
}

function relatedChangesSection(items: ProblemDossier['relatedChanges']) {
  return (doc: Doc): void => {
    sectionHeading(doc, `Change correlate (${items.length})`)
    if (!items.length) { emptyLine(doc, 'Nessuna change correlata.'); return }
    drawTable(doc,
      [
        { header: 'Codice', width: 100 },
        { header: 'Titolo', width: 295 },
        { header: 'Status', width: 100 },
      ],
      items.map((c) => [orDash(c.code), c.title, orDash(c.status)]),
    )
  }
}
