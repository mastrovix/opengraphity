/**
 * Problem PDF export — builds the full "Problem Audit Report" for a single
 * problem: details, root cause/workaround, affected CIs, related incidents
 * and changes, workflow history, comments and attachment metadata.
 * Pure pdfkit, returns a Buffer. Shared parts live in ./pdf/ticketDossier.ts.
 */
import type { ValueColor } from '@opengraphity/types'
import { pdfText } from './pdf/texts.js'
import { loadVocabularyEntries } from './vocabularyEntries.js'
import { runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import {
  DASH, fmtDate, orDash, COLOR, valueColorInk, type Doc, type PdfMeta, type PdfLocale,
  sectionHeading, emptyLine, drawTable, keyValue, badge, createPdfBuffer,
} from './pdf/common.js'
import {
  loadTicketDossier, renderTicketDossier, userRef,
  affectedCIsSection, workflowHistorySection, commentsSection, attachmentsSection,
  type Props, type UserRef, type AffectedCI, type WorkflowHistoryEntry, type AttachmentEntry, type CustomFieldLine, customFieldsSection,
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
    /** Il colore che il Dizionario del cliente dà alla priorità, o null se non ne ha. */
    priorityColor: ValueColor | null
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
  customFields:    CustomFieldLine[]
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
    comments:   { label: 'Comment', authorProp: 'author_id' },
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
      priorityColor: p['priority'] ? ((await loadVocabularyEntries(tenantId, 'priority')).colors[p['priority'] as string] ?? null) : null,
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
    customFields:    common.customFields,
  }
}

// ── Builder ───────────────────────────────────────────────────────────────────


export async function buildProblemPdf(data: ProblemDossier, meta: PdfMeta): Promise<Buffer> {
  return createPdfBuffer(
    `Problem Audit Report ${data.problem.number || data.problem.id}`,
    meta,
    (doc) => renderDossier(doc, data, meta.locale),
  )
}

function renderDossier(doc: Doc, data: ProblemDossier, locale: PdfLocale): void {
  const pr = data.problem

  renderTicketDossier(doc, {
    reportTitle: pdfText(locale, 'reportProblem'),
    entityTitle: `${pr.number || pr.id} ${DASH} ${pr.title}`,
    badges: (doc, x, y) => {
      let bx = x
      // C-18: etichette dei badge tradotte.
      bx += badge(doc, bx, y, `${pdfText(locale, 'badgePriority')}: ${(pr.priority || pdfText(locale, 'notAvailable')).toUpperCase()}`,
        valueColorInk(pr.priorityColor)) + 6
      badge(doc, bx, y, `${pdfText(locale, 'badgeStatus')}: ${(pr.status || pdfText(locale, 'notAvailable')).toUpperCase().replace(/_/g, ' ')}`, COLOR.brand)
    },
    sections: [
      detailsSection(data, locale),
      customFieldsSection(data.customFields, locale),
      affectedCIsSection(data.affectedCIs, locale),
      relatedIncidentsSection(data.relatedIncidents, locale),
      relatedChangesSection(data.relatedChanges, locale),
      workflowHistorySection(data.workflowHistory, locale),
      commentsSection(data.comments, locale),
      attachmentsSection(data.attachments, locale),
    ],
  })
}

function detailsSection(data: ProblemDossier, locale: PdfLocale) {
  const pr = data.problem
  return (doc: Doc): void => {
    sectionHeading(doc, pdfText(locale, 'details'))
    keyValue(doc, pdfText(locale, 'description'), orDash(pr.description))
    keyValue(doc, pdfText(locale, 'rootCause'), orDash(pr.rootCause))
    keyValue(doc, pdfText(locale, 'workaround'), orDash(pr.workaround))
    keyValue(doc, pdfText(locale, 'affectedUsers'), pr.affectedUsers != null ? String(pr.affectedUsers) : DASH)
    keyValue(doc, pdfText(locale, 'createdBy'), data.createdBy
      ? `${data.createdBy.name} <${data.createdBy.email}>`
      : DASH)
    keyValue(doc, pdfText(locale, 'assignee'), data.assignee
      ? `${data.assignee.name} <${data.assignee.email}>`
      : DASH)
    keyValue(doc, pdfText(locale, 'team'), data.team ? data.team.name : DASH)
    keyValue(doc, pdfText(locale, 'createdAt'), fmtDate(pr.createdAt, locale))
    keyValue(doc, pdfText(locale, 'updatedAt'), fmtDate(pr.updatedAt, locale))
    keyValue(doc, pdfText(locale, 'resolvedAt'), fmtDate(pr.resolvedAt, locale))
    keyValue(doc, pdfText(locale, 'closedAt'), fmtDate(pr.closedAt, locale))
  }
}

function relatedIncidentsSection(items: ProblemDossier['relatedIncidents'], locale: PdfLocale) {
  return (doc: Doc): void => {
    sectionHeading(doc, pdfText(locale, 'relatedIncidents', { count: items.length }))
    if (!items.length) { emptyLine(doc, pdfText(locale, 'noRelatedIncidents')); return }
    drawTable(doc,
      [
        { header: pdfText(locale, 'colNumber'), width: 100 },
        { header: pdfText(locale, 'colTitle'),  width: 295 },
        { header: 'Status', width: 100 },
      ],
      items.map((i) => [orDash(i.number), i.title, orDash(i.status)]),
    )
  }
}

function relatedChangesSection(items: ProblemDossier['relatedChanges'], locale: PdfLocale) {
  return (doc: Doc): void => {
    sectionHeading(doc, pdfText(locale, 'relatedChanges', { count: items.length }))
    if (!items.length) { emptyLine(doc, pdfText(locale, 'noRelatedChanges')); return }
    drawTable(doc,
      [
        { header: pdfText(locale, 'colCode'),  width: 100 },
        { header: pdfText(locale, 'colTitle'), width: 295 },
        { header: 'Status', width: 100 },
      ],
      items.map((c) => [orDash(c.code), c.title, orDash(c.status)]),
    )
  }
}
