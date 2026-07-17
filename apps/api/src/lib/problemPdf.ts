/**
 * Problem PDF export — builds the full "Problem Audit Report" for a single
 * problem: details, root cause/workaround, affected CIs, related incidents
 * and changes, workflow history, comments and attachment metadata.
 * Pure pdfkit, returns a Buffer.
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
  createdBy: { name: string; email: string } | null
  assignee:  { name: string; email: string } | null
  team:      { name: string } | null
  affectedCIs:      Array<{ name: string; type: string; environment: string | null; status: string | null }>
  relatedIncidents: Array<{ number: string; title: string; status: string }>
  relatedChanges:   Array<{ code: string; title: string; status: string }>
  workflowHistory: Array<{
    stepName:    string
    enteredAt:   string | null
    exitedAt:    string | null
    durationMs:  number | null
    triggeredBy: string | null
    triggerType: string | null
    notes:       string | null
  }>
  comments:    Array<{ author: string | null; type: string; createdAt: string | null; text: string }>
  attachments: Array<{ filename: string; sizeBytes: number; uploadedBy: string | null; uploadedAt: string | null }>
}

// ── Data loading (tenant-scoped Cypher) ───────────────────────────────────────

function userRef(p: Props | null): { name: string; email: string } | null {
  if (!p || !p['id']) return null
  return { name: (p['name'] ?? '') as string, email: (p['email'] ?? '') as string }
}

export async function loadProblemDossier(
  session: Queryable,
  id: string,
  tenantId: string,
): Promise<ProblemDossier> {
  const base = await runQueryOne<{
    props: Props
    uProps: Props | null
    tProps: Props | null
    cProps: Props | null
  }>(session, `
    MATCH (p:Problem {id: $id, tenant_id: $tenantId})
    OPTIONAL MATCH (p)-[:ASSIGNED_TO]->(u:User)
    OPTIONAL MATCH (p)-[:ASSIGNED_TO_TEAM]->(t:Team)
    OPTIONAL MATCH (p)-[:CREATED_BY]->(cb:User)
    RETURN properties(p) AS props, properties(u) AS uProps,
           properties(t) AS tProps, properties(cb) AS cProps
  `, { id, tenantId })

  if (!base) throw new NotFoundError('Problem', id)
  const p = base.props

  const ciRows = await runQuery<{ props: Props; nodeLabels: string[] }>(session, `
    MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:AFFECTS]->(ci)
    WHERE ci.tenant_id = $tenantId
    RETURN properties(ci) AS props, labels(ci) AS nodeLabels
    ORDER BY ci.name ASC
  `, { id, tenantId })

  const incidentRows = await runQuery<{ number: string | null; title: string | null; status: string | null }>(session, `
    MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:CAUSED_BY]->(i:Incident)
    RETURN i.number AS number, i.title AS title, i.status AS status
    ORDER BY i.created_at ASC
  `, { id, tenantId })

  const changeRows = await runQuery<{ code: string | null; title: string | null; status: string | null }>(session, `
    MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:RESOLVED_BY]->(c:Change)
    OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN c.code AS code, c.title AS title,
           coalesce(wi.current_step, c.status) AS status
    ORDER BY c.created_at ASC
  `, { id, tenantId })

  const historyRows = await runQuery<{ eProps: Props }>(session, `
    MATCH (p:Problem {id: $id, tenant_id: $tenantId})
          -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
          -[:STEP_HISTORY]->(exec:WorkflowStepExecution)
    RETURN properties(exec) AS eProps
    ORDER BY exec.entered_at ASC
  `, { id, tenantId })

  const commentRows = await runQuery<{ cProps: Props; uProps: Props | null }>(session, `
    MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:HAS_COMMENT]->(c:ProblemComment)
    OPTIONAL MATCH (u:User {id: c.created_by, tenant_id: $tenantId})
    RETURN properties(c) AS cProps, properties(u) AS uProps
    ORDER BY c.created_at ASC
  `, { id, tenantId })

  const attachmentRows = await runQuery<{ filename: string; sizeBytes: number | null; uploadedBy: string | null; uploadedAt: string | null }>(session, `
    MATCH (a:Attachment {tenant_id: $tenantId, entity_type: 'problem', entity_id: $id})
    OPTIONAL MATCH (u:User {id: a.uploaded_by, tenant_id: $tenantId})
    RETURN a.filename                              AS filename,
           a.size_bytes                            AS sizeBytes,
           coalesce(u.name, u.email, a.uploaded_by) AS uploadedBy,
           a.uploaded_at                           AS uploadedAt
    ORDER BY a.uploaded_at DESC
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
    createdBy: userRef(base.cProps),
    assignee:  userRef(base.uProps),
    team:      base.tProps ? { name: (base.tProps['name'] ?? '') as string } : null,
    affectedCIs: ciRows.map((r) => ({
      name:        (r.props['name'] ?? r.props['id'] ?? '') as string,
      type:        ciTypeFromLabels(r.nodeLabels ?? []),
      environment: (r.props['environment'] ?? null) as string | null,
      status:      (r.props['status'] ?? null) as string | null,
    })),
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
      type:      (r.cProps['type'] ?? 'manual') as string,
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

  // ── Header ──
  docHeader(doc, 'Problem Audit Report', `${pr.number || pr.id} ${DASH} ${pr.title}`)

  // Badges: priority + status
  let bx = PAGE_MARGIN.left
  const by = doc.y
  bx += badge(doc, bx, by, `PRIORITY: ${(pr.priority || 'n/d').toUpperCase()}`,
    PRIORITY_COLORS[pr.priority?.toLowerCase() ?? ''] ?? COLOR.muted) + 6
  badge(doc, bx, by, `STATUS: ${(pr.status || 'n/d').toUpperCase().replace(/_/g, ' ')}`, COLOR.brand)
  doc.y = by + 24
  doc.x = PAGE_MARGIN.left

  // ── Dettagli ──
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

  // ── Incident correlati ──
  sectionHeading(doc, `Incident correlati (${data.relatedIncidents.length})`)
  if (!data.relatedIncidents.length) {
    emptyLine(doc, 'Nessun incident correlato.')
  } else {
    drawTable(doc,
      [
        { header: 'Numero', width: 100 },
        { header: 'Titolo', width: 295 },
        { header: 'Status', width: 100 },
      ],
      data.relatedIncidents.map((i) => [orDash(i.number), i.title, orDash(i.status)]),
    )
  }

  // ── Change correlate ──
  sectionHeading(doc, `Change correlate (${data.relatedChanges.length})`)
  if (!data.relatedChanges.length) {
    emptyLine(doc, 'Nessuna change correlata.')
  } else {
    drawTable(doc,
      [
        { header: 'Codice', width: 100 },
        { header: 'Titolo', width: 295 },
        { header: 'Status', width: 100 },
      ],
      data.relatedChanges.map((c) => [orDash(c.code), c.title, orDash(c.status)]),
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
        .text(`  [${c.type}]  ${DASH}  ${fmtDate(c.createdAt)}`)
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
