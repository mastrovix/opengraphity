/**
 * Incident PDF export — builds a complete "audit dossier" for a single
 * incident: details, SLA, affected CIs, workflow history, comments and
 * attachment metadata. Pure pdfkit (no external assets), returns a Buffer.
 */
import { runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import { NotFoundError } from './errors.js'
import { ciTypeFromLabels } from './ciTypeFromLabels.js'
import {
  DASH, fmtDate, fmtDuration, fmtBytes, orDash,
  PAGE_MARGIN, COLOR, type Doc, type PdfMeta,
  contentWidth, ensureSpace, sectionHeading, emptyLine,
  drawTable, keyValue, badge, docHeader, createPdfBuffer,
} from './pdf/common.js'

export type { PdfMeta }

type Props = Record<string, unknown>

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
  assignee: { name: string; email: string } | null
  team:     { name: string } | null
  watchers: Array<{ name: string; email: string }>
  slaStatus: {
    responseDeadline: string | null
    resolveDeadline:  string | null
    responseMet:      boolean
    resolveMet:       boolean
    breached:         boolean
  } | null
  affectedCIs: Array<{ name: string; type: string; environment: string | null; status: string | null }>
  workflowHistory: Array<{
    stepName:    string
    enteredAt:   string | null
    exitedAt:    string | null
    durationMs:  number | null
    triggeredBy: string | null
    triggerType: string | null
    notes:       string | null
  }>
  comments:    Array<{ author: string | null; createdAt: string | null; text: string }>
  attachments: Array<{ filename: string; sizeBytes: number; uploadedBy: string | null; uploadedAt: string | null }>
}

// ── Data loading (tenant-scoped Cypher) ───────────────────────────────────────

export async function loadIncidentDossier(
  session: Queryable,
  id: string,
  tenantId: string,
): Promise<IncidentDossier> {
  const base = await runQueryOne<{ props: Props; uProps: Props | null; tProps: Props | null }>(session, `
    MATCH (i:Incident {id: $id, tenant_id: $tenantId})
    OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(u:User)
    OPTIONAL MATCH (i)-[:ASSIGNED_TO_TEAM]->(t:Team)
    RETURN properties(i) AS props, properties(u) AS uProps, properties(t) AS tProps
  `, { id, tenantId })

  if (!base) throw new NotFoundError('Incident', id)
  const p = base.props

  const slaRow = await runQueryOne<{ sProps: Props }>(session, `
    MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    RETURN properties(s) AS sProps
    ORDER BY s.started_at DESC LIMIT 1
  `, { id, tenantId })

  const ciRows = await runQuery<{ props: Props; nodeLabels: string[] }>(session, `
    MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:AFFECTED_BY]->(ci)
    WHERE ci.tenant_id = $tenantId
    RETURN properties(ci) AS props, labels(ci) AS nodeLabels
    ORDER BY ci.name ASC
  `, { id, tenantId })

  const historyRows = await runQuery<{ eProps: Props }>(session, `
    MATCH (i:Incident {id: $id, tenant_id: $tenantId})
          -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
          -[:STEP_HISTORY]->(exec:WorkflowStepExecution)
    RETURN properties(exec) AS eProps
    ORDER BY exec.entered_at ASC
  `, { id, tenantId })

  const commentRows = await runQuery<{ cProps: Props; uProps: Props | null }>(session, `
    MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_COMMENT]->(c:Comment)
    OPTIONAL MATCH (u:User {id: c.author_id, tenant_id: $tenantId})
    RETURN properties(c) AS cProps, properties(u) AS uProps
    ORDER BY c.created_at ASC
  `, { id, tenantId })

  const watcherRows = await runQuery<{ name: string | null; email: string | null }>(session, `
    MATCH (u:User)-[w:WATCHES]->(e:Incident {id: $id, tenant_id: $tenantId})
    RETURN u.name AS name, u.email AS email
    ORDER BY w.watched_at DESC
  `, { id, tenantId })

  const attachmentRows = await runQuery<{ filename: string; sizeBytes: number | null; uploadedBy: string | null; uploadedAt: string | null }>(session, `
    MATCH (a:Attachment {tenant_id: $tenantId, entity_type: 'incident', entity_id: $id})
    OPTIONAL MATCH (u:User {id: a.uploaded_by, tenant_id: $tenantId})
    RETURN a.filename                              AS filename,
           a.size_bytes                            AS sizeBytes,
           coalesce(u.name, u.email, a.uploaded_by) AS uploadedBy,
           a.uploaded_at                           AS uploadedAt
    ORDER BY a.uploaded_at DESC
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
    assignee: base.uProps
      ? { name: (base.uProps['name'] ?? '') as string, email: (base.uProps['email'] ?? '') as string }
      : null,
    team: base.tProps ? { name: (base.tProps['name'] ?? '') as string } : null,
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
    affectedCIs: ciRows.map((r) => ({
      name:        (r.props['name'] ?? r.props['id'] ?? '') as string,
      type:        ciTypeFromLabels(r.nodeLabels ?? []),
      environment: (r.props['environment'] ?? null) as string | null,
      status:      (r.props['status'] ?? null) as string | null,
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
    comments: commentRows.map((r) => ({
      author:    r.uProps ? ((r.uProps['name'] ?? r.uProps['email'] ?? null) as string | null) : null,
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

  // ── Header ──
  docHeader(doc, 'Incident Audit Report', `${inc.number || inc.id} ${DASH} ${inc.title}`)

  // Badges: severity + status
  let bx = PAGE_MARGIN.left
  const by = doc.y
  bx += badge(doc, bx, by, `SEVERITY: ${(inc.severity || 'n/d').toUpperCase()}`,
    SEVERITY_COLORS[inc.severity?.toLowerCase() ?? ''] ?? COLOR.muted) + 6
  bx += badge(doc, bx, by, `STATUS: ${(inc.status || 'n/d').toUpperCase()}`, COLOR.brand) + 6
  if (data.slaStatus) {
    badge(doc, bx, by, data.slaStatus.breached ? 'SLA: BREACHED' : 'SLA: OK',
      data.slaStatus.breached ? '#dc2626' : '#16a34a')
  }
  doc.y = by + 24
  doc.x = PAGE_MARGIN.left

  if (data.slaStatus) {
    const sla = data.slaStatus
    doc.fontSize(8.5).font('Helvetica').fillColor(COLOR.muted).text(
      `SLA ${DASH} risposta entro: ${fmtDate(sla.responseDeadline)} (${sla.responseMet ? 'rispettata' : 'non rispettata'})` +
      `  |  risoluzione entro: ${fmtDate(sla.resolveDeadline)} (${sla.resolveMet ? 'rispettata' : 'non rispettata'})`,
      PAGE_MARGIN.left, doc.y, { width: contentWidth(doc) },
    )
  }

  // ── Dettagli ──
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

  // ── CI impattati ──
  sectionHeading(doc, `CI impattati (${data.affectedCIs.length})`)
  if (!data.affectedCIs.length) {
    emptyLine(doc, 'Nessun CI collegato.')
  } else {
    drawTable(doc,
      [
        { header: 'Nome',        width: 190 },
        { header: 'Tipo',        width: 120 },
        { header: 'Environment', width: 95 },
        { header: 'Status',      width: 90 },
      ],
      data.affectedCIs.map((ci) => [ci.name, ci.type, orDash(ci.environment), orDash(ci.status)]),
    )
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

  // ── Commenti ──
  sectionHeading(doc, `Commenti (${data.comments.length})`)
  if (!data.comments.length) {
    emptyLine(doc, 'Nessun commento.')
  } else {
    for (const c of data.comments) {
      ensureSpace(doc, 34)
      doc.fontSize(9).font('Helvetica-Bold').fillColor(COLOR.dark)
        .text(c.author ?? 'Utente sconosciuto', PAGE_MARGIN.left, doc.y, { continued: true })
      doc.font('Helvetica').fillColor(COLOR.muted)
        .text(`  ${DASH}  ${fmtDate(c.createdAt)}`)
      doc.moveDown(0.15)
      doc.fontSize(9).font('Helvetica').fillColor(COLOR.text)
        .text(c.text || DASH, PAGE_MARGIN.left + 10, doc.y,
          { width: contentWidth(doc) - 10, lineGap: 2.5 })
      doc.x = PAGE_MARGIN.left
      doc.moveDown(0.6)
    }
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
