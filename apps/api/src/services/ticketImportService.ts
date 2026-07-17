/**
 * Historical data importer (migration from other ITSM tools).
 *
 * Imports Incidents and KB Articles from CSV rows. Used by BOTH:
 *   - the REST v1 routes  POST /api/v1/import/incidents | /import/kb-articles
 *   - the CLI scripts     src/scripts/import-incidents.ts | import-kb.ts
 *
 * Idempotency: every imported node carries an `import_external_id` property;
 * nodes are MERGEd on (tenant_id, import_external_id), so re-running the same
 * CSV updates the existing nodes instead of duplicating them (comments created
 * by the importer are tagged with the same key and re-created on each run).
 *
 * Transaction strategy: ONE transaction PER ROW (see comment on writeIncidentRow).
 * Rows are fully validated before any write; in execute mode invalid rows are
 * skipped (reported in `errors`) while valid rows proceed.
 */
import { v4 as uuidv4 } from 'uuid'
import { workflowEngine } from '@opengraphity/workflow'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { ManagedTransaction } from 'neo4j-driver'
import { logger } from '../lib/logger.js'
import { withSession, getSession } from '../graphql/resolvers/ci-utils.js'
import { ValidationError } from '../lib/errors.js'
import { getWorkflowSteps, type StepRow } from '../lib/workflowHelpers.js'

type Session = ReturnType<typeof getSession>

export interface ServiceCtx {
  tenantId: string
  userId:   string
}

export interface ImportRowIssue {
  row:        number
  externalId: string | null
  message:    string
}

export interface ImportResult {
  totalRows: number
  created:   number
  updated:   number
  errors:    ImportRowIssue[]
  warnings:  ImportRowIssue[]
}

export interface ImportOptions {
  dryRun?: boolean
}

export type CsvRow = Record<string, string>

// ── CSV parsing ───────────────────────────────────────────────────────────────
// The discovery CSV connector (src/discovery/connectors/csv.ts) parses line by
// line and cannot handle newlines inside quoted fields — descriptions and KB
// bodies need them — so the importer ships its own character-level parser:
// BOM, CRLF, quoted fields with commas/newlines and "" escaping.

/**
 * Parse CSV text into rows keyed by the header row.
 * - strips a leading UTF-8 BOM
 * - handles quoted fields ("" = literal quote), commas and newlines in fields
 * - accepts \n, \r\n and \r line endings
 * - skips rows whose cells are all empty
 */
export function parseCsv(text: string): CsvRow[] {
  let src = text
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1)

  const rawRows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++ }
        else inQuotes = false
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cell); cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell); cell = ''
      rawRows.push(row); row = []
    } else {
      cell += ch
    }
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rawRows.push(row) }

  const nonEmpty = rawRows.filter((r) => r.some((c) => c.trim() !== ''))
  if (nonEmpty.length === 0) return []

  const headers = nonEmpty[0]!.map((h) => h.trim())
  return nonEmpty.slice(1).map((cells) => {
    const obj: CsvRow = {}
    headers.forEach((h, idx) => { if (h) obj[h] = (cells[idx] ?? '').trim() })
    return obj
  })
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Validate an ISO-ish date string; returns normalized ISO or null when invalid. */
function parseIsoDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(value)) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

const SEVERITY_MAP: Record<string, string> = {
  low: 'low', l: 'low', minor: 'low', trivial: 'low', p4: 'low', '4': 'low', sev4: 'low',
  medium: 'medium', med: 'medium', m: 'medium', moderate: 'medium', normal: 'medium', p3: 'medium', '3': 'medium', sev3: 'medium',
  high: 'high', h: 'high', major: 'high', p2: 'high', '2': 'high', sev2: 'high',
  critical: 'critical', crit: 'critical', urgent: 'critical', blocker: 'critical', p1: 'critical', '1': 'critical', sev1: 'critical',
}

/**
 * Move an existing workflow instance to `stepName` (no-op if already there).
 * Closes the open StepExecution and records a new one, re-points CURRENT_STEP
 * and keeps wi.current_step + entity.status in sync (entity.status is set by
 * the caller's node write). Used right after workflowEngine.createInstance —
 * the engine always starts at the initial step, the import may land elsewhere.
 */
async function pointWorkflowToStep(
  tx: ManagedTransaction,
  tenantId: string,
  entityId: string,
  stepName: string,
  userId: string,
  now: string,
): Promise<void> {
  await tx.run(`
    MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    WHERE wi.current_step <> $stepName
    MATCH (wd:WorkflowDefinition {id: wi.definition_id})-[:HAS_STEP]->(target:WorkflowStep {name: $stepName})
    OPTIONAL MATCH (wi)-[cur:CURRENT_STEP]->()
    DELETE cur
    WITH DISTINCT wi, target
    CREATE (wi)-[:CURRENT_STEP]->(target)
    SET wi.current_step = $stepName, wi.updated_at = $now
    WITH wi
    OPTIONAL MATCH (wi)-[:STEP_HISTORY]->(open:WorkflowStepExecution)
    WHERE open.exited_at IS NULL
    SET open.exited_at = $now, open.duration_ms = toInteger(0)
    WITH DISTINCT wi
    CREATE (wi)-[:STEP_HISTORY]->(:WorkflowStepExecution {
      id:           randomUUID(),
      tenant_id:    $tenantId,
      instance_id:  wi.id,
      step_name:    $stepName,
      entered_at:   $now,
      exited_at:    null,
      duration_ms:  null,
      triggered_by: $userId,
      trigger_type: 'automatic',
      notes:        'import: step from CSV status'
    })
  `, { entityId, tenantId, stepName, userId, now })
}

/** Ensure the entity has a workflow instance, creating one if missing. */
async function ensureWorkflowInstance(
  tx: ManagedTransaction,
  tenantId: string,
  entityId: string,
  entityType: string,
): Promise<void> {
  const existing = await tx.run(`
    MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN wi.id AS id LIMIT 1
  `, { entityId, tenantId })
  if (existing.records.length === 0) {
    await workflowEngine.createInstance(tx, tenantId, entityId, entityType)
  }
}

// ── Incident import ───────────────────────────────────────────────────────────

interface IncidentComment {
  text:        string
  authorEmail: string | null
  authorId:    string | null
  createdAt:   string
}

interface IncidentPlan {
  row:           number
  externalId:    string
  exists:        boolean
  existingId:    string | null
  title:         string
  description:   string | null
  severity:      string
  stepName:      string
  number:        string | null   // number to write (null on update = keep existing)
  createdAt:     string | null   // null on update = keep existing
  updatedAt:     string
  resolvedAt:    string | null
  assigneeId:    string | null
  teamId:        string | null
  comments:      IncidentComment[] | null  // null = column absent, leave untouched
}

interface ExistingNode {
  id:         string
  externalId: string
  number?:    string | null
}

export async function importIncidents(
  rows: CsvRow[],
  ctx: ServiceCtx,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const dryRun = opts.dryRun ?? false
  if (!ctx.tenantId) throw new ValidationError('tenantId è obbligatorio')
  if (!Array.isArray(rows)) throw new ValidationError('rows deve essere un array')

  const result: ImportResult = { totalRows: rows.length, created: 0, updated: 0, errors: [], warnings: [] }
  if (rows.length === 0) return result

  return withSession(async (session) => {
    // ── Preload reference data (read-only, shared by dry-run and execute) ─────
    const steps = await getWorkflowSteps(session, ctx.tenantId, 'incident')
    if (steps.length === 0) {
      throw new ValidationError(`Nessuna workflow definition attiva per "incident" nel tenant "${ctx.tenantId}"`)
    }
    const initialStep = steps.find((s) => s.isInitial)
    if (!initialStep) {
      throw new ValidationError(`Il workflow incident del tenant "${ctx.tenantId}" non ha uno step iniziale`)
    }
    const stepByLowerName = new Map(steps.map((s) => [s.name.toLowerCase(), s.name]))

    const emails = collectValues(rows, ['assignee_email'])
    for (const r of rows) {
      // comment author emails also need resolution
      const raw = r['comments']
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as unknown
          if (Array.isArray(parsed)) {
            for (const c of parsed) {
              const e = (c as { author_email?: unknown })?.author_email
              if (typeof e === 'string' && e.trim()) emails.add(e.trim().toLowerCase())
            }
          }
        } catch { /* reported as row error below */ }
      }
    }
    const usersByEmail = await loadUsersByEmail(session, ctx.tenantId, [...emails])
    const teamsByName  = await loadTeamsByName(session, ctx.tenantId, [...collectValues(rows, ['team_name'])])

    const externalIds = rows.map((r) => (r['external_id'] ?? '').trim()).filter(Boolean)
    const existingRows = externalIds.length === 0 ? [] : await runQuery<ExistingNode>(session, `
      MATCH (i:Incident {tenant_id: $tenantId})
      WHERE i.import_external_id IN $externalIds
      RETURN i.id AS id, i.import_external_id AS externalId, i.number AS number
    `, { tenantId: ctx.tenantId, externalIds })
    const existingByExternalId = new Map(existingRows.map((r) => [r.externalId, r]))

    // Numbers already taken in the tenant among those the CSV wants to preserve
    const csvNumbers = [...collectValues(rows, ['number'], false)]
    const numberRows = csvNumbers.length === 0 ? [] : await runQuery<{ number: string; externalId: string | null }>(session, `
      MATCH (i:Incident {tenant_id: $tenantId})
      WHERE i.number IN $numbers
      RETURN i.number AS number, i.import_external_id AS externalId
    `, { tenantId: ctx.tenantId, numbers: csvNumbers })
    const numberOwner = new Map(numberRows.map((r) => [r.number, r.externalId]))

    // Progressive INC numbering for rows without a number: continue from the
    // highest INC number in the tenant (same format as createIncident).
    const maxRow = await runQueryOne<{ maxNum: number | null }>(session, `
      MATCH (i:Incident {tenant_id: $tenantId})
      WHERE i.number STARTS WITH 'INC'
      RETURN max(toInteger(substring(i.number, 3))) AS maxNum
    `, { tenantId: ctx.tenantId })
    let nextIncNum = Number(maxRow?.maxNum ?? 0)

    // ── Per-row validation → plan ─────────────────────────────────────────────
    const plans: IncidentPlan[] = []
    const seenExternalIds = new Set<string>()
    const seenNumbers     = new Set<string>()
    const now = new Date().toISOString()

    rows.forEach((row, idx) => {
      const rowNum = idx + 1
      const externalId = (row['external_id'] ?? '').trim() || null
      const fail = (message: string) => { result.errors.push({ row: rowNum, externalId, message }) }
      const warn = (message: string) => { result.warnings.push({ row: rowNum, externalId, message }) }

      if (!externalId) { fail('external_id è obbligatorio'); return }
      if (seenExternalIds.has(externalId)) { fail(`external_id duplicato nel file: "${externalId}"`); return }

      const title = (row['title'] ?? '').trim()
      if (!title) { fail('title è obbligatorio'); return }
      if (title.length > 500) { fail('title supera i 500 caratteri'); return }

      // severity: free values mapped case-insensitively; unknown → warning + medium
      const rawSeverity = (row['severity'] ?? '').trim()
      let severity = 'medium'
      if (rawSeverity) {
        const mapped = SEVERITY_MAP[rawSeverity.toLowerCase()]
        if (mapped) severity = mapped
        else warn(`severity sconosciuta "${rawSeverity}" — uso "medium"`)
      }

      // status: matched case-insensitively on the tenant's incident workflow steps
      const rawStatus = (row['status'] ?? '').trim()
      let stepName = initialStep.name
      if (rawStatus) {
        const matched = stepByLowerName.get(rawStatus.toLowerCase())
        if (matched) stepName = matched
        else warn(`status sconosciuto "${rawStatus}" — uso lo step iniziale "${initialStep.name}"`)
      }

      // dates: invalid → row error
      const dates: Record<string, string | null> = {}
      let dateError = false
      for (const field of ['created_at', 'updated_at', 'resolved_at'] as const) {
        const raw = (row[field] ?? '').trim()
        if (!raw) { dates[field] = null; continue }
        const iso = parseIsoDate(raw)
        if (!iso) { fail(`${field} non è una data ISO valida: "${raw}"`); dateError = true; break }
        dates[field] = iso
      }
      if (dateError) return

      const existing = existingByExternalId.get(externalId) ?? null

      // number: preserve when provided; collision with a different incident → row error
      const rawNumber = (row['number'] ?? '').trim() || null
      let number: string | null = null
      if (rawNumber) {
        if (seenNumbers.has(rawNumber)) { fail(`number duplicato nel file: "${rawNumber}"`); return }
        const owner = numberOwner.get(rawNumber)
        if (owner !== undefined && owner !== externalId) {
          fail(`number "${rawNumber}" già usato da un altro incident (violazione unicità)`)
          return
        }
        number = rawNumber
        seenNumbers.add(rawNumber)
      } else if (!existing) {
        // generate progressive INC number, skipping any value the CSV preserves
        do { nextIncNum += 1 } while (seenNumbers.has('INC' + String(nextIncNum).padStart(8, '0')))
        number = 'INC' + String(nextIncNum).padStart(8, '0')
        seenNumbers.add(number)
      } // else: update without number → keep the existing one

      // assignee / team lookups: not found → warning, do not block
      const assigneeEmail = (row['assignee_email'] ?? '').trim()
      let assigneeId: string | null = null
      if (assigneeEmail) {
        assigneeId = usersByEmail.get(assigneeEmail.toLowerCase()) ?? null
        if (!assigneeId) warn(`assignee_email "${assigneeEmail}" non trovato — assegnazione saltata`)
      }
      const teamName = (row['team_name'] ?? '').trim()
      let teamId: string | null = null
      if (teamName) {
        teamId = teamsByName.get(teamName.toLowerCase()) ?? null
        if (!teamId) warn(`team_name "${teamName}" non trovato — assegnazione team saltata`)
      }

      // comments: optional JSON array [{author_email, text, created_at}]
      let comments: IncidentComment[] | null = null
      const rawComments = (row['comments'] ?? '').trim()
      if (rawComments) {
        let parsed: unknown
        try { parsed = JSON.parse(rawComments) }
        catch { fail('comments non è JSON valido'); return }
        if (!Array.isArray(parsed)) { fail('comments deve essere un array JSON'); return }
        comments = []
        for (const [ci, c] of (parsed as unknown[]).entries()) {
          const obj = (c ?? {}) as { text?: unknown; author_email?: unknown; created_at?: unknown }
          const text = typeof obj.text === 'string' ? obj.text.trim() : ''
          if (!text) { fail(`comments[${ci}]: text è obbligatorio`); return }
          let createdAt = now
          if (typeof obj.created_at === 'string' && obj.created_at.trim()) {
            const iso = parseIsoDate(obj.created_at.trim())
            if (!iso) { fail(`comments[${ci}]: created_at non è una data ISO valida`); return }
            createdAt = iso
          }
          let authorEmail: string | null = null
          let authorId: string | null = null
          if (typeof obj.author_email === 'string' && obj.author_email.trim()) {
            authorEmail = obj.author_email.trim()
            authorId = usersByEmail.get(authorEmail.toLowerCase()) ?? null
            if (!authorId) warn(`comments[${ci}]: author_email "${authorEmail}" non trovato`)
          }
          comments.push({ text, authorEmail, authorId, createdAt })
        }
      }

      seenExternalIds.add(externalId)
      plans.push({
        row: rowNum,
        externalId,
        exists:      existing !== null,
        existingId:  existing?.id ?? null,
        title,
        description: (row['description'] ?? '').trim() || null,
        severity,
        stepName,
        number,
        createdAt:   dates['created_at'] ?? (existing ? null : now),
        updatedAt:   dates['updated_at'] ?? dates['created_at'] ?? now,
        resolvedAt:  dates['resolved_at'] ?? null,
        assigneeId,
        teamId,
        comments,
      })
    })

    // ── Dry-run: report what would happen, zero writes ────────────────────────
    if (dryRun) {
      for (const p of plans) { if (p.exists) result.updated++; else result.created++ }
      return result
    }

    // ── Execute: ONE transaction PER ROW ──────────────────────────────────────
    // Rationale: each row is an independent unit (incident + relations +
    // comments + workflow instance must commit or roll back together), and
    // per-row transactions let valid rows land even when a later row fails at
    // write time (the failure is attributed to exactly that row in `errors`).
    // A batch-of-N tx would be marginally faster but a single unexpected DB
    // error would roll back N-1 innocent rows.
    for (const p of plans) {
      try {
        await writeIncidentRow(session, p, ctx)
        if (p.exists) result.updated++; else result.created++
      } catch (err) {
        result.errors.push({
          row: p.row, externalId: p.externalId,
          message: `scrittura fallita: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    logger.info({
      tenantId: ctx.tenantId, totalRows: result.totalRows,
      created: result.created, updated: result.updated,
      errors: result.errors.length, warnings: result.warnings.length,
    }, '[import] incidents import completed')
    return result
  }, !dryRun)
}

async function writeIncidentRow(session: Session, p: IncidentPlan, ctx: ServiceCtx): Promise<void> {
  const now = new Date().toISOString()
  const newId = uuidv4()

  await session.executeWrite(async (tx) => {
    // MERGE on (tenant_id, import_external_id) → idempotent re-runs
    await tx.run(`
      MERGE (i:Incident {tenant_id: $tenantId, import_external_id: $externalId})
      ON CREATE SET i.id         = $newId,
                    i.number     = $number,
                    i.created_at = $createdAt
      SET i.title       = $title,
          i.description = $description,
          i.severity    = $severity,
          i.status      = $status,
          i.number      = coalesce($numberUpdate, i.number),
          i.created_at  = coalesce($createdAt, i.created_at),
          i.updated_at  = $updatedAt,
          i.resolved_at = $resolvedAt
    `, {
      tenantId:     ctx.tenantId,
      externalId:   p.externalId,
      newId,
      number:       p.number,
      numberUpdate: p.exists ? p.number : null,
      title:        p.title,
      description:  p.description,
      severity:     p.severity,
      status:       p.stepName,
      createdAt:    p.createdAt,
      updatedAt:    p.updatedAt,
      resolvedAt:   p.resolvedAt,
    })

    const entityId = p.existingId ?? newId

    if (p.assigneeId) {
      await tx.run(`
        MATCH (i:Incident {tenant_id: $tenantId, import_external_id: $externalId})
        OPTIONAL MATCH (i)-[old:ASSIGNED_TO]->()
        DELETE old
        WITH DISTINCT i
        MATCH (u:User {id: $userId, tenant_id: $tenantId})
        MERGE (i)-[:ASSIGNED_TO]->(u)
      `, { tenantId: ctx.tenantId, externalId: p.externalId, userId: p.assigneeId })
    }
    if (p.teamId) {
      await tx.run(`
        MATCH (i:Incident {tenant_id: $tenantId, import_external_id: $externalId})
        OPTIONAL MATCH (i)-[old:ASSIGNED_TO_TEAM]->()
        DELETE old
        WITH DISTINCT i
        MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
        MERGE (i)-[:ASSIGNED_TO_TEAM]->(t)
      `, { tenantId: ctx.tenantId, externalId: p.externalId, teamId: p.teamId })
    }

    // Comments: same node shape as addIncidentComment, plus import_external_id
    // so re-runs replace the imported thread instead of duplicating it.
    if (p.comments !== null) {
      await tx.run(`
        MATCH (i:Incident {tenant_id: $tenantId, import_external_id: $externalId})
        OPTIONAL MATCH (i)-[:HAS_COMMENT]->(old:Comment)
        WHERE old.import_external_id = $externalId
        DETACH DELETE old
        WITH DISTINCT i
        UNWIND $comments AS cm
        CREATE (c:Comment {
          id:                 randomUUID(),
          tenant_id:          $tenantId,
          text:               cm.text,
          author_id:          cm.authorId,
          author_email:       cm.authorEmail,
          created_at:         cm.createdAt,
          updated_at:         cm.createdAt,
          import_external_id: $externalId
        })
        CREATE (i)-[:HAS_COMMENT]->(c)
      `, { tenantId: ctx.tenantId, externalId: p.externalId, comments: p.comments })
    }

    // Workflow: create the instance at the initial step (engine behavior),
    // then point it to the mapped step. entity.status already matches.
    await ensureWorkflowInstance(tx, ctx.tenantId, entityId, 'incident')
    await pointWorkflowToStep(tx, ctx.tenantId, entityId, p.stepName, ctx.userId, now)
  })
}

// ── KB article import ─────────────────────────────────────────────────────────

interface KBPlan {
  row:          number
  externalId:   string
  exists:       boolean
  existingId:   string | null
  title:        string
  slug:         string | null   // null on update = keep existing slug
  body:         string
  category:     string | null
  tags:         string          // JSON string, same storage as the KB resolver
  statusRaw:    'draft' | 'published'
  stepName:     string | null   // null when the tenant has no kb_article workflow
  authorName:   string | null
  createdAt:    string | null
  updatedAt:    string
  publishedAt:  string | null
}

/** Same slug algorithm as the KB resolver (graphql/resolvers/knowledgeBase.ts). */
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[àáâãäå]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
}

export async function importKBArticles(
  rows: CsvRow[],
  ctx: ServiceCtx,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const dryRun = opts.dryRun ?? false
  if (!ctx.tenantId) throw new ValidationError('tenantId è obbligatorio')
  if (!Array.isArray(rows)) throw new ValidationError('rows deve essere un array')

  const result: ImportResult = { totalRows: rows.length, created: 0, updated: 0, errors: [], warnings: [] }
  if (rows.length === 0) return result

  return withSession(async (session) => {
    // kb_article workflow is optional: the KB resolver itself treats instance
    // creation as best-effort. Without a definition we import articles with
    // the raw draft/published status and no workflow instance (per-row warning).
    let steps: StepRow[] = []
    try { steps = await getWorkflowSteps(session, ctx.tenantId, 'kb_article') }
    catch { steps = [] }
    const initialStep   = steps.find((s) => s.isInitial) ?? null
    const publishedStep =
      steps.find((s) => s.category === 'published') ??
      steps.find((s) => s.name.toLowerCase() === 'published') ?? null
    const hasWorkflow = steps.length > 0 && initialStep !== null

    const externalIds = rows.map((r) => (r['external_id'] ?? '').trim()).filter(Boolean)
    const existingRows = externalIds.length === 0 ? [] : await runQuery<ExistingNode>(session, `
      MATCH (a:KBArticle {tenant_id: $tenantId})
      WHERE a.import_external_id IN $externalIds
      RETURN a.id AS id, a.import_external_id AS externalId
    `, { tenantId: ctx.tenantId, externalIds })
    const existingByExternalId = new Map(existingRows.map((r) => [r.externalId, r]))

    // All existing tenant slugs — needed to dedup generated ones (-2, -3, ...)
    const slugRows = await runQuery<{ slug: string }>(session, `
      MATCH (a:KBArticle {tenant_id: $tenantId})
      WHERE a.slug IS NOT NULL
      RETURN a.slug AS slug
    `, { tenantId: ctx.tenantId })
    const takenSlugs = new Set(slugRows.map((r) => r.slug))

    const plans: KBPlan[] = []
    const seenExternalIds = new Set<string>()
    const now = new Date().toISOString()

    rows.forEach((row, idx) => {
      const rowNum = idx + 1
      const externalId = (row['external_id'] ?? '').trim() || null
      const fail = (message: string) => { result.errors.push({ row: rowNum, externalId, message }) }
      const warn = (message: string) => { result.warnings.push({ row: rowNum, externalId, message }) }

      if (!externalId) { fail('external_id è obbligatorio'); return }
      if (seenExternalIds.has(externalId)) { fail(`external_id duplicato nel file: "${externalId}"`); return }

      const title = (row['title'] ?? '').trim()
      if (!title) { fail('title è obbligatorio'); return }

      const body = row['body'] ?? ''
      if (body.length > 50_000) { fail('body supera i 50000 caratteri'); return }

      // status: published/draft (case-insensitive), default draft
      const rawStatus = (row['status'] ?? '').trim().toLowerCase()
      let statusRaw: 'draft' | 'published' = 'draft'
      if (rawStatus === 'published') statusRaw = 'published'
      else if (rawStatus && rawStatus !== 'draft') warn(`status sconosciuto "${row['status']}" — uso "draft"`)

      const dates: Record<string, string | null> = {}
      let dateError = false
      for (const field of ['created_at', 'published_at'] as const) {
        const raw = (row[field] ?? '').trim()
        if (!raw) { dates[field] = null; continue }
        const iso = parseIsoDate(raw)
        if (!iso) { fail(`${field} non è una data ISO valida: "${raw}"`); dateError = true; break }
        dates[field] = iso
      }
      if (dateError) return

      const existing = existingByExternalId.get(externalId) ?? null

      // slug: generated from title, deduped with -2, -3, ... suffixes.
      // On update the existing slug is kept (stable URLs).
      let slug: string | null = null
      if (!existing) {
        const base = generateSlug(title) || 'articolo'
        slug = base
        for (let n = 2; takenSlugs.has(slug); n++) slug = `${base}-${n}`
        takenSlugs.add(slug)
      }

      // workflow step mapping
      let stepName: string | null = null
      if (hasWorkflow) {
        if (statusRaw === 'published') {
          if (publishedStep) stepName = publishedStep.name
          else {
            warn(`il workflow kb_article non ha uno step "published" — l'articolo resta allo step iniziale "${initialStep!.name}"`)
            stepName = initialStep!.name
          }
        } else {
          stepName = initialStep!.name
        }
      } else {
        warn('nessuna workflow definition attiva per "kb_article" — articolo importato senza workflow instance')
      }

      const tags = (row['tags'] ?? '')
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean)

      const createdAt   = dates['created_at']
      const publishedAt = statusRaw === 'published'
        ? (dates['published_at'] ?? createdAt ?? now)
        : null

      seenExternalIds.add(externalId)
      plans.push({
        row: rowNum,
        externalId,
        exists:     existing !== null,
        existingId: existing?.id ?? null,
        title,
        slug,
        body,
        category:   (row['category'] ?? '').trim() || null,
        tags:       JSON.stringify(tags),
        statusRaw,
        stepName,
        authorName: (row['author_name'] ?? '').trim() || null,
        createdAt:  createdAt ?? (existing ? null : now),
        updatedAt:  now,
        publishedAt,
      })
    })

    if (dryRun) {
      for (const p of plans) { if (p.exists) result.updated++; else result.created++ }
      return result
    }

    // One tx per row — same rationale as importIncidents.
    for (const p of plans) {
      try {
        await writeKBRow(session, p, ctx)
        if (p.exists) result.updated++; else result.created++
      } catch (err) {
        result.errors.push({
          row: p.row, externalId: p.externalId,
          message: `scrittura fallita: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    logger.info({
      tenantId: ctx.tenantId, totalRows: result.totalRows,
      created: result.created, updated: result.updated,
      errors: result.errors.length, warnings: result.warnings.length,
    }, '[import] kb articles import completed')
    return result
  }, !dryRun)
}

async function writeKBRow(session: Session, p: KBPlan, ctx: ServiceCtx): Promise<void> {
  const now = new Date().toISOString()
  const newId = uuidv4()
  // entity.status mirrors the KB resolver convention: the workflow step name
  // when a workflow exists, the raw draft/published value otherwise.
  const status = p.stepName ?? p.statusRaw

  await session.executeWrite(async (tx) => {
    await tx.run(`
      MERGE (a:KBArticle {tenant_id: $tenantId, import_external_id: $externalId})
      ON CREATE SET a.id                = $newId,
                    a.slug              = $slug,
                    a.author_id         = null,
                    a.views             = 0,
                    a.helpful_count     = 0,
                    a.not_helpful_count = 0,
                    a.created_at        = $createdAt
      SET a.title        = $title,
          a.body         = $body,
          a.category     = $category,
          a.tags         = $tags,
          a.status       = $status,
          a.author_name  = coalesce($authorName, a.author_name),
          a.created_at   = coalesce($createdAt, a.created_at),
          a.updated_at   = $updatedAt,
          a.published_at = $publishedAt
    `, {
      tenantId:    ctx.tenantId,
      externalId:  p.externalId,
      newId,
      slug:        p.slug,
      title:       p.title,
      body:        p.body,
      category:    p.category,
      tags:        p.tags,
      status,
      authorName:  p.authorName,
      createdAt:   p.createdAt,
      updatedAt:   p.updatedAt,
      publishedAt: p.publishedAt,
    })

    if (p.stepName !== null) {
      const entityId = p.existingId ?? newId
      await ensureWorkflowInstance(tx, ctx.tenantId, entityId, 'kb_article')
      await pointWorkflowToStep(tx, ctx.tenantId, entityId, p.stepName, ctx.userId, now)
    }
  })
}

// ── Lookup helpers ────────────────────────────────────────────────────────────

function collectValues(rows: CsvRow[], fields: string[], lowercase = true): Set<string> {
  const out = new Set<string>()
  for (const row of rows) {
    for (const f of fields) {
      const v = (row[f] ?? '').trim()
      if (v) out.add(lowercase ? v.toLowerCase() : v)
    }
  }
  return out
}

async function loadUsersByEmail(session: Session, tenantId: string, emails: string[]): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map()
  const rows = await runQuery<{ email: string; id: string }>(session, `
    MATCH (u:User {tenant_id: $tenantId})
    WHERE toLower(u.email) IN $emails
    RETURN toLower(u.email) AS email, u.id AS id
  `, { tenantId, emails })
  return new Map(rows.map((r) => [r.email, r.id]))
}

async function loadTeamsByName(session: Session, tenantId: string, names: string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map()
  const rows = await runQuery<{ name: string; id: string }>(session, `
    MATCH (t:Team {tenant_id: $tenantId})
    WHERE toLower(t.name) IN $names
    RETURN toLower(t.name) AS name, t.id AS id
  `, { tenantId, names })
  return new Map(rows.map((r) => [r.name, r.id]))
}
