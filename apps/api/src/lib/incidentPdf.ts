/**
 * Incident PDF export — builds a complete "audit dossier" for a single
 * incident: details, SLA, affected CIs, workflow history, comments and
 * attachment metadata. Pure pdfkit (no external assets), returns a Buffer.
 * Shared loading/rendering lives in ./pdf/ticketDossier.ts.
 */
import { runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import {
  DASH, fmtDate, orDash, PAGE_MARGIN, COLOR, type Doc, type PdfMeta,
  contentWidth, sectionHeading, keyValue, badge, createPdfBuffer,
} from './pdf/common.js'
import {
  loadTicketDossier, renderTicketDossier,
  affectedCIsSection, workflowHistorySection, commentsSection, attachmentsSection,
  type Props, type UserRef, type AffectedCI, type WorkflowHistoryEntry, type AttachmentEntry,
} from './pdf/ticketDossier.js'

export type { PdfMeta }

// ── Dossier shape ─────────────────────────────────────────────────────────────

export interface IncidentDossier {
  incident: {
    id:          string
    number:      string
    title:       string
    description: string | null
    severity:    string
    status:      string
    category:    string | null
    createdAt:   string | null
    updatedAt:   string | null
    resolvedAt:  string | null
    rootCause:   string | null
  }
  assignee: UserRef | null
  team:     { name: string } | null
  watchers: UserRef[]
  slaStatus: {
    responseDeadline: string | null
    resolveDeadline:  string | null
    responseMet:      boolean
    resolveMet:       boolean
    breached:         boolean
  } | null
  affectedCIs:     AffectedCI[]
  workflowHistory: WorkflowHistoryEntry[]
  comments:        Array<{ author: string | null; createdAt: string | null; text: string }>
  attachments:     AttachmentEntry[]
}

// ── Data loading (tenant-scoped Cypher) ───────────────────────────────────────

export async function loadIncidentDossier(
  session: Queryable,
  id: string,
  tenantId: string,
): Promise<IncidentDossier> {
  const common = await loadTicketDossier(session, {
    label:      'Incident',
    entityType: 'incident',
    ciRelation: 'AFFECTED_BY',
    comments:   { label: 'Comment', authorProp: 'author_id' },
  }, id, tenantId)
  const p = common.props

  const slaRow = await runQueryOne<{ sProps: Props }>(session, `
    MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    RETURN properties(s) AS sProps
    ORDER BY s.started_at DESC LIMIT 1
  `, { id, tenantId })

  const watcherRows = await runQuery<{ name: string | null; email: string | null }>(session, `
    MATCH (u:User)-[w:WATCHES]->(e:Incident {id: $id, tenant_id: $tenantId})
    RETURN u.name AS name, u.email AS email
    ORDER BY w.watched_at DESC
  `, { id, tenantId })

  const s = slaRow?.sProps

  return {
    incident: {
      id:          p['id']            as string,
      number:      (p['number'] ?? '') as string,
      title:       (p['title']  ?? '') as string,
      description: (p['description'] ?? null) as string | null,
      severity:    (p['severity'] ?? '') as string,
      status:      (p['status']   ?? '') as string,
      category:    (p['category'] ?? null) as string | null,
      createdAt:   (p['created_at']  ?? null) as string | null,
      updatedAt:   (p['updated_at']  ?? null) as string | null,
      resolvedAt:  (p['resolved_at'] ?? null) as string | null,
      rootCause:   (p['root_cause']  ?? null) as string | null,
    },
    assignee: common.assignee,
    team:     common.team,
    watchers: watcherRows.map((w) => ({ name: w.name ?? '', email: w.email ?? '' })),
    slaStatus: s
      ? {
          responseDeadline: (s['response_deadline'] ?? null) as string | null,
          resolveDeadline:  (s['resolve_deadline']  ?? null) as string | null,
          responseMet:      Boolean(s['response_met']),
          resolveMet:       Boolean(s['resolve_met']),
          breached:         Boolean(s['breached']),
        }
      : null,
    affectedCIs:     common.affectedCIs,
    workflowHistory: common.workflowHistory,
    comments:        common.comments.map((c) => ({ author: c.author, createdAt: c.createdAt, text: c.text })),
    attachments:     common.attachments,
  }
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#16a34a',
}

// ── Builder ───────────────────────────────────────────────────────────────────

export async function buildIncidentPdf(data: IncidentDossier, meta: PdfMeta): Promise<Buffer> {
  return createPdfBuffer(
    `Incident Audit Report ${data.incident.number || data.incident.id}`,
    meta,
    (doc) => renderDossier(doc, data),
  )
}

function renderDossier(doc: Doc, data: IncidentDossier): void {
  const inc = data.incident

  renderTicketDossier(doc, {
    reportTitle: 'Incident Audit Report',
    entityTitle: `${inc.number || inc.id} ${DASH} ${inc.title}`,
    badges: (doc, x, y) => {
      let bx = x
      bx += badge(doc, bx, y, `SEVERITY: ${(inc.severity || 'n/d').toUpperCase()}`,
        SEVERITY_COLORS[inc.severity?.toLowerCase() ?? ''] ?? COLOR.muted) + 6
      bx += badge(doc, bx, y, `STATUS: ${(inc.status || 'n/d').toUpperCase()}`, COLOR.brand) + 6
      if (data.slaStatus) {
        badge(doc, bx, y, data.slaStatus.breached ? 'SLA: BREACHED' : 'SLA: OK',
          data.slaStatus.breached ? '#dc2626' : '#16a34a')
      }
    },
    sections: [
      slaLine(data),
      detailsSection(data),
      affectedCIsSection(data.affectedCIs),
      workflowHistorySection(data.workflowHistory),
      commentsSection(data.comments.map((c) => ({ ...c, type: null }))),
      attachmentsSection(data.attachments),
    ],
  })
}

function slaLine(data: IncidentDossier) {
  return (doc: Doc): void => {
    const sla = data.slaStatus
    if (!sla) return
    doc.fontSize(8.5).font('Helvetica').fillColor(COLOR.muted).text(
      `SLA ${DASH} risposta entro: ${fmtDate(sla.responseDeadline)} (${sla.responseMet ? 'rispettata' : 'non rispettata'})` +
      `  |  risoluzione entro: ${fmtDate(sla.resolveDeadline)} (${sla.resolveMet ? 'rispettata' : 'non rispettata'})`,
      PAGE_MARGIN.left, doc.y, { width: contentWidth(doc) },
    )
  }
}

function detailsSection(data: IncidentDossier) {
  const inc = data.incident
  return (doc: Doc): void => {
    sectionHeading(doc, 'Dettagli')
    keyValue(doc, 'Descrizione', orDash(inc.description))
    keyValue(doc, 'Categoria', orDash(inc.category))
    keyValue(doc, 'Creato il', fmtDate(inc.createdAt))
    keyValue(doc, 'Aggiornato il', fmtDate(inc.updatedAt))
    keyValue(doc, 'Risolto il', fmtDate(inc.resolvedAt))
    keyValue(doc, 'Root cause', orDash(inc.rootCause))
    keyValue(doc, 'Assegnatario', data.assignee
      ? `${data.assignee.name} <${data.assignee.email}>`
      : DASH)
    keyValue(doc, 'Team', data.team ? data.team.name : DASH)
    keyValue(doc, 'Watcher', data.watchers.length
      ? data.watchers.map((w) => w.name || w.email).join(', ')
      : DASH)
  }
}
