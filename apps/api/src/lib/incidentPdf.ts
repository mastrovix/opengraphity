/**
 * Incident PDF export — builds a complete "audit dossier" for a single
 * incident: details, SLA, affected CIs, workflow history, comments and
 * attachment metadata. Pure pdfkit (no external assets), returns a Buffer.
 * Shared loading/rendering lives in ./pdf/ticketDossier.ts.
 */
import type { ValueColor } from '@opengraphity/types'
import { pdfText } from './pdf/texts.js'
import { loadVocabularyEntries } from './vocabularyEntries.js'
import { runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import {
  DASH, fmtDate, orDash, PAGE_MARGIN, COLOR, valueColorInk, type Doc, type PdfMeta, type PdfLocale,
  contentWidth, sectionHeading, keyValue, badge, createPdfBuffer,
} from './pdf/common.js'
import {
  loadTicketDossier, renderTicketDossier,
  affectedCIsSection, workflowHistorySection, commentsSection, attachmentsSection,
  type Props, type UserRef, type AffectedCI, type WorkflowHistoryEntry, type AttachmentEntry, type CustomFieldLine, customFieldsSection,
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
    /** Il colore che il Dizionario del cliente dà alla severità, o null se non ne ha. */
    severityColor: ValueColor | null
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
  customFields:    CustomFieldLine[]
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
    WITH u, min(w.watched_at) AS watchedAt
    RETURN u.name AS name, u.email AS email
    ORDER BY watchedAt DESC
  `, { id, tenantId })

  const s = slaRow?.sProps

  return {
    incident: {
      id:          p['id']            as string,
      number:      (p['number'] ?? '') as string,
      title:       (p['title']  ?? '') as string,
      description: (p['description'] ?? null) as string | null,
      severity:    (p['severity'] ?? '') as string,
      // `Incident.severity` porta un valore del vocabolario `priority` (lo
      // dice `enumValueUsage.ts`, e il badge dell'interfaccia usa quello):
      // qui si leggeva `severity`, quindi un colore scelto dal cliente non
      // arrivava nel dossier e un valore nuovo usciva grigio (revisione
      // totale · C-19).
      severityColor: p['severity'] ? ((await loadVocabularyEntries(tenantId, 'priority')).colors[p['severity'] as string] ?? null) : null,
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
    customFields:    common.customFields,
  }
}


// ── Builder ───────────────────────────────────────────────────────────────────

export async function buildIncidentPdf(data: IncidentDossier, meta: PdfMeta): Promise<Buffer> {
  return createPdfBuffer(
    `Incident Audit Report ${data.incident.number || data.incident.id}`,
    meta,
    (doc) => renderDossier(doc, data, meta.locale),
  )
}

function renderDossier(doc: Doc, data: IncidentDossier, locale: PdfLocale): void {
  const inc = data.incident

  renderTicketDossier(doc, {
    reportTitle: pdfText(locale, 'reportIncident'),
    entityTitle: `${inc.number || inc.id} ${DASH} ${inc.title}`,
    badges: (doc, x, y) => {
      let bx = x
      // C-18: etichette dei badge tradotte.
      bx += badge(doc, bx, y, `${pdfText(locale, 'badgeSeverity')}: ${(inc.severity || pdfText(locale, 'notAvailable')).toUpperCase()}`,
        valueColorInk(inc.severityColor)) + 6
      bx += badge(doc, bx, y, `${pdfText(locale, 'badgeStatus')}: ${(inc.status || pdfText(locale, 'notAvailable')).toUpperCase()}`, COLOR.brand) + 6
      if (data.slaStatus) {
        badge(doc, bx, y, `${pdfText(locale, 'badgeSla')}: ${data.slaStatus.breached ? pdfText(locale, 'slaBreached') : pdfText(locale, 'slaOk')}`,
          data.slaStatus.breached ? '#dc2626' : '#16a34a')
      }
    },
    sections: [
      slaLine(data, locale),
      detailsSection(data, locale),
      customFieldsSection(data.customFields, locale),
      affectedCIsSection(data.affectedCIs, locale),
      workflowHistorySection(data.workflowHistory, locale),
      commentsSection(data.comments.map((c) => ({ ...c, type: null })), locale),
      attachmentsSection(data.attachments, locale),
    ],
  })
}

function slaLine(data: IncidentDossier, locale: PdfLocale) {
  return (doc: Doc): void => {
    const sla = data.slaStatus
    if (!sla) return
    doc.fontSize(8.5).font('Helvetica').fillColor(COLOR.muted).text(
      pdfText(locale, 'slaLine', {
        response: fmtDate(sla.responseDeadline, locale), responseMet: pdfText(locale, sla.responseMet ? 'met' : 'notMet'),
        resolve: fmtDate(sla.resolveDeadline, locale), resolveMet: pdfText(locale, sla.resolveMet ? 'met' : 'notMet'),
      }),
      PAGE_MARGIN.left, doc.y, { width: contentWidth(doc) },
    )
  }
}

function detailsSection(data: IncidentDossier, locale: PdfLocale) {
  const inc = data.incident
  return (doc: Doc): void => {
    sectionHeading(doc, pdfText(locale, 'details'))
    keyValue(doc, pdfText(locale, 'description'), orDash(inc.description))
    keyValue(doc, pdfText(locale, 'category'), orDash(inc.category))
    keyValue(doc, pdfText(locale, 'createdAt'), fmtDate(inc.createdAt, locale))
    keyValue(doc, pdfText(locale, 'updatedAt'), fmtDate(inc.updatedAt, locale))
    keyValue(doc, pdfText(locale, 'resolvedAt'), fmtDate(inc.resolvedAt, locale))
    keyValue(doc, pdfText(locale, 'rootCause'), orDash(inc.rootCause))
    keyValue(doc, pdfText(locale, 'assignee'), data.assignee
      ? `${data.assignee.name} <${data.assignee.email}>`
      : DASH)
    keyValue(doc, pdfText(locale, 'team'), data.team ? data.team.name : DASH)
    keyValue(doc, pdfText(locale, 'watchers'), data.watchers.length
      ? data.watchers.map((w) => w.name || w.email).join(', ')
      : DASH)
  }
}
