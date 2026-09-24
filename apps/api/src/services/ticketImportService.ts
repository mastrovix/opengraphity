/**
 * Historical data importer (migration from other ITSM tools).
 *
 * Imports tickets (incidents, problems, changes, service requests) and KB
 * Articles from CSV rows. Used by BOTH:
 *   - the REST v1 routes  POST /api/v1/import/incidents | problems | changes |
 *                         service-requests | kb-articles
 *   - the CLI scripts     src/scripts/import-incidents.ts | import-kb.ts
 *
 * Idempotency: every imported node carries an `import_external_id` property;
 * nodes are MERGEd on (tenant_id, import_external_id), so re-running the same
 * CSV updates the existing nodes instead of duplicating them (comments created
 * by the importer are tagged with the same key and re-created on each run).
 *
 * Transaction strategy: ONE transaction PER ROW (see comment in importTickets).
 * Rows are fully validated before any write; in execute mode invalid rows are
 * skipped (reported in `errors`) while valid rows proceed.
 */
import { assignTeamCypher, TEAM_NOW_PARAM } from '../lib/ticketTeamHistory.js'
import { v4 as uuidv4 } from 'uuid'
import { workflowEngine } from '@opengraphity/workflow'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { ManagedTransaction } from 'neo4j-driver'
import { logger } from '../lib/logger.js'
import { withSession, getSession } from '../graphql/resolvers/ci-utils.js'
import { ValidationError } from '../lib/errors.js'
import { getWorkflowSteps, type StepRow } from '../lib/workflowHelpers.js'
import { domainVocabulary } from '../lib/domainMatrix.js'
import { resolveDomainValue } from '../lib/domainValue.js'
import { customFieldDefs, resolveCustomFieldWrites, type CustomFieldInput } from '../lib/ticketCustomFields.js'
import { raiseSequenceTo } from '../lib/sequence.js'
import { nextTicketNumber, ticketNumbering } from '../lib/ticketNumbering.js'
import { matchById } from '../lib/cypherLookups.js'

type Session = ReturnType<typeof getSession>

export interface ServiceCtx {
  tenantId: string
  userId:   string
}

export interface ImportRowIssue {
  row:        number
  externalId: string | null
  /** Il messaggio in inglese (log, API). */
  message:    string
  /**
   * La chiave e i dati del messaggio: il web compone la frase nella lingua di
   * chi importa (revisione del 14 set 2026 · lingua). Prima i messaggi erano
   * italiani per ogni cliente.
   */
  messageKey:    ImportIssueKey
  messageParams: Record<string, string>
}

/** I messaggi dell'importazione, in inglese; la traduzione sta nel web (`pages.import.issue.*`). */
const IMPORT_MESSAGES = {
  externalIdRequired:     () => 'external_id is required',
  externalIdDuplicate:    (p: Record<string, string>) => `external_id duplicated in the file: "${p['id']}"`,
  titleRequired:          () => 'title is required',
  titleTooLong:           (p: Record<string, string>) => `title is longer than ${p['max']} characters`,
  bodyTooLong:            (p: Record<string, string>) => `body is longer than ${p['max']} characters`,
  severityRequired:       () => 'severity is required (the value to translate with the «Import Severity» matrix)',
  severityNotPrecomputed: (p: Record<string, string>) => `severity "${p['value']}" not resolved (internal error: value not precomputed)`,
  severityUntranslatable: (p: Record<string, string>) => `severity "${p['value']}" cannot be translated: ${p['reason']} Add the value to the «Import Severity» dictionary and the cell to the matrix, or fix the file.`,
  unknownStatusInitial:   (p: Record<string, string>) => `unknown status "${p['status']}" — using the initial step "${p['step']}"`,
  unknownStatusDraft:     (p: Record<string, string>) => `unknown status "${p['status']}" — using "draft"`,
  invalidDate:            (p: Record<string, string>) => `${p['field']} is not a valid ISO date: "${p['value']}"`,
  numberDuplicate:        (p: Record<string, string>) => `number duplicated in the file: "${p['number']}"`,
  numberInUse:            (p: Record<string, string>) => `number "${p['number']}" is already used by another ticket (uniqueness violation)`,
  columnRequired:         (p: Record<string, string>) => `${p['column']} is required`,
  vocabularyUnknown:      (p: Record<string, string>) => `${p['column']} "${p['value']}" is not in the dictionary of this organization (${p['allowed']})`,
  integerOutOfRange:      (p: Record<string, string>) => `${p['column']} "${p['value']}" must be an integer between ${p['min']} and ${p['max']}`,
  assigneeNotFound:       (p: Record<string, string>) => `assignee_email "${p['email']}" not found — assignment skipped`,
  teamNotFound:           (p: Record<string, string>) => `team_name "${p['team']}" not found — team assignment skipped`,
  commentsInvalidJson:    () => 'comments is not valid JSON',
  commentsNotArray:       () => 'comments must be a JSON array',
  commentTextRequired:    (p: Record<string, string>) => `comments[${p['index']}]: text is required`,
  commentInvalidDate:     (p: Record<string, string>) => `comments[${p['index']}]: created_at is not a valid ISO date`,
  commentAuthorNotFound:  (p: Record<string, string>) => `comments[${p['index']}]: author_email "${p['email']}" not found`,
  commentInternalNotBoolean: (p: Record<string, string>) => `comments[${p['index']}]: internal must be true or false`,
  kbCategoryUnknown:      (p: Record<string, string>) => `category "${p['category']}" is not one of the KB categories in the Dictionary (${p['allowed']})`,
  kbNoPublishedStep:      (p: Record<string, string>) => `the kb_article workflow has no "published" step — the article stays in the initial step "${p['step']}"`,
  kbNoWorkflow:           () => 'no active workflow definition for "kb_article" — article imported without a workflow instance',
  customFieldInvalid:     (p: Record<string, string>) => `custom field column "${p['field']}": ${p['error']}`,
  writeFailed:            (p: Record<string, string>) => `write failed: ${p['error']}`,
} as const satisfies Record<string, (p: Record<string, string>) => string>

export type ImportIssueKey = keyof typeof IMPORT_MESSAGES

function importIssue(row: number, externalId: string | null, key: ImportIssueKey, params: Record<string, string> = {}): ImportRowIssue {
  return { row, externalId, message: IMPORT_MESSAGES[key](params), messageKey: key, messageParams: params }
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

/**
 * Severità in ingresso → severità del cliente (ondata 7 · D-16).
 *
 * Era `SEVERITY_MAP`, 25 sinonimi scritti qui, e una severità non riconosciuta
 * diventava `medium` con un avviso di riga. Due guasti, non uno:
 *  - un cliente che aggiungeva `blocker` come valore LEGITTIMO se lo vedeva
 *    riscritto in `critical` senza nemmeno un avviso, perché la mappa
 *    «risolveva»;
 *  - `critical` veniva scritto anche su un cliente che l'aveva tolto dal suo
 *    vocabolario.
 * Lo `status`, nella stessa funzione, era già risolto sui passi del workflow
 * **del tenant**: qui si allinea la severità a quel modello.
 *
 * Ora: la traduzione è la matrice `import_severity` del cliente (seminata con
 * gli stessi 25 sinonimi, così il primo giorno non cambia niente, ma ora
 * visibili e modificabili in Impostazioni → Matrici di dominio). Le severità
 * distinte del file si risolvono in un passaggio SOLO, prima del ciclo per
 * riga — come già fa la mappa dei passi — e una severità non risolvibile
 * mette la **riga in errore**, non a `medium`.
 */
async function resolveImportSeverities(
  tenantId: string, rows: readonly CsvRow[],
): Promise<Map<string, { severity: string } | { error: string }>> {
  const out = new Map<string, { severity: string } | { error: string }>()
  const distinct = new Set<string>()
  for (const row of rows) {
    const raw = (row['severity'] ?? '').trim()
    if (raw) distinct.add(raw.toLowerCase())
  }
  for (const key of distinct) {
    try {
      out.set(key, { severity: await resolveDomainValue(tenantId, 'import_severity', key) })
    } catch (e) {
      out.set(key, { error: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
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
  /*
   * The step must be one of THIS instance's workflow (review of 23 Sep 2026):
   * the status map is built from every active definition, and a status of
   * another one (a category variant) matched nothing here — the ticket kept
   * the CSV's status and a workflow elsewhere. The row fails instead, with its
   * reason. A terminal step concludes the instance, as the engine does: left
   * «active», historical closed tickets counted as open.
   */
  const probe = await tx.run(`
    ${matchById('e', { labels: 'entities', id: '$entityId' })}
    MATCH (e)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
    // tenant-ok(traversal): definizione dell'istanza dell'entità scopata
    OPTIONAL MATCH (:WorkflowDefinition {id: wi.definition_id})-[:HAS_STEP]->(target:WorkflowStep {name: $stepName})
    RETURN target IS NOT NULL AS known, coalesce(target.is_terminal, target.type = 'end', false) AS terminal
    LIMIT 1
  `, { entityId, tenantId, stepName })
  const found = probe.records[0]
  if (!found || found.get('known') !== true) {
    throw new ValidationError(`The status "${stepName}" is not a step of this ticket's workflow`,
      { key: 'errors.import.stepNotInWorkflow', params: { step: stepName } })
  }
  await tx.run(`
    ${matchById('e', { labels: 'entities', id: '$entityId' })}
    MATCH (e)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    SET wi.status = $wiStatus
  `, { entityId, tenantId, wiStatus: found.get('terminal') === true ? 'completed' : 'active' })
  await tx.run(`
    ${matchById('e', { labels: 'entities', id: '$entityId' })}
    MATCH (e)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    WHERE wi.current_step <> $stepName
    // tenant-ok(traversal): definizione dell'istanza dell'entità scopata
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
    ${matchById('e', { labels: 'entities', id: '$entityId' })}
    MATCH (e)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN wi.id AS id LIMIT 1
  `, { entityId, tenantId })
  if (existing.records.length === 0) {
    await workflowEngine.createInstance(tx, tenantId, entityId, entityType)
  }
}

// ── Ticket import (incident, problem, change, service request) ────────────────
//
// Verifica «Cosa resta cablato», ondata 5: prima si importavano solo gli
// incident. Ora i quattro tipi di ticket passano dalla stessa strada, con le
// colonne che ciascuno ha davvero:
//
//   tutti:           external_id*, title*, status, number (senza: prefisso e cifre del cliente), created_at, updated_at,
//                    comments, e una colonna per ogni campo del cliente
//   incident:        severity* (matrice «Import Severity»), description, resolved_at,
//                    assignee_email, team_name
//   problem:         priority*, impact, urgency, description, workaround, root_cause,
//                    resolved_at, assignee_email, team_name
//   change:          change_type*, priority, why, what, aggregate_risk_score, completed_at
//   service_request: priority*, description, due_date, completed_at, assignee_email, team_name
//
// Un valore di vocabolario si confronta con il vocabolario DEL CLIENTE (senza
// distinguere maiuscole): fuori vocabolario è un errore di riga, mai un valore
// scelto dal codice. La change importata è storica: nessuna approvazione,
// nessun assessment, nessun CI — il suo passo del workflow viene dal file.

export type TicketImportKind = 'incident' | 'problem' | 'change' | 'service_request'

interface VocabularyColumn { column: string; vocabulary: string; required: boolean }

interface TicketImportSpec {
  label:          'Incident' | 'Problem' | 'Change' | 'ServiceRequest'
  /** La change porta il numero anche in `code`. */
  numberIsCode:   boolean
  dateColumns:    readonly string[]
  textColumns:    readonly string[]
  vocabularies:   readonly VocabularyColumn[]
  /** Solo incident: la severità passa dalla matrice `import_severity`. */
  severityMatrix: boolean
  /** Assegnatario e team (la change si assegna per compiti, non come ticket). */
  assignable:     boolean
  /** Colonne intere con il loro intervallo. */
  integers:       ReadonlyArray<{ column: string; min: number; max: number }>
}

export const TICKET_IMPORT_SPECS: Readonly<Record<TicketImportKind, TicketImportSpec>> = {
  incident: {
    label: 'Incident', numberIsCode: false,
    dateColumns: ['resolved_at'], textColumns: ['description'], vocabularies: [],
    severityMatrix: true, assignable: true, integers: [],
  },
  problem: {
    label: 'Problem', numberIsCode: false,
    dateColumns: ['resolved_at'], textColumns: ['description', 'workaround', 'root_cause'],
    vocabularies: [
      { column: 'priority', vocabulary: 'priority', required: true },
      { column: 'impact',   vocabulary: 'impact',   required: false },
      { column: 'urgency',  vocabulary: 'urgency',  required: false },
    ],
    severityMatrix: false, assignable: true, integers: [],
  },
  change: {
    label: 'Change', numberIsCode: true,
    dateColumns: ['completed_at'], textColumns: ['why', 'what'],
    vocabularies: [
      { column: 'change_type', vocabulary: 'change_type', required: true },
      { column: 'priority',    vocabulary: 'priority',    required: false },
    ],
    severityMatrix: false, assignable: false, integers: [{ column: 'aggregate_risk_score', min: 0, max: 100 }],
  },
  service_request: {
    label: 'ServiceRequest', numberIsCode: false,
    dateColumns: ['due_date', 'completed_at'], textColumns: ['description'],
    vocabularies: [{ column: 'priority', vocabulary: 'priority', required: true }],
    severityMatrix: false, assignable: true, integers: [],
  },
}

interface TicketComment {
  text:        string
  authorEmail: string | null
  authorId:    string | null
  createdAt:   string
  /**
   * Nota interna (staff) o risposta visibile al richiedente (revisione totale
   * · D-26). I commenti importati nascevano TUTTI interni: lo storico migrato
   * da un altro strumento perdeva le risposte date al richiedente, che dal
   * portale non le vedeva più — e non c'era modo di dirlo nel CSV.
   * `internal` nel JSON del commento; assente = interno, come prima.
   */
  isInternal:  boolean
}

interface TicketPlan {
  row:           number
  externalId:    string
  exists:        boolean
  existingId:    string | null
  title:         string
  stepName:      string
  number:        string | null   // number to write (null on update = keep existing; null on create = generate)
  createdAt:     string | null   // null on update = keep existing
  updatedAt:     string
  /** Le colonne del tipo presenti nel file, già convertite (descrizione, date, vocabolari…). */
  props:         Record<string, unknown>
  assigneeId:    string | null
  teamId:        string | null
  comments:      TicketComment[] | null  // null = column absent, leave untouched
  /** Le colonne dei campi del cliente presenti nel file (ondata 4), prima della validazione. */
  customInputs:  CustomFieldInput[]
  /** Le proprietà da scrivere, dopo la validazione. */
  customProps:   Record<string, unknown>
}

interface ExistingNode {
  id:         string
  externalId: string
  number?:    string | null
}

export function importIncidents(rows: CsvRow[], ctx: ServiceCtx, opts: ImportOptions = {}): Promise<ImportResult> {
  return importTickets('incident', rows, ctx, opts)
}
export function importProblems(rows: CsvRow[], ctx: ServiceCtx, opts: ImportOptions = {}): Promise<ImportResult> {
  return importTickets('problem', rows, ctx, opts)
}
export function importChanges(rows: CsvRow[], ctx: ServiceCtx, opts: ImportOptions = {}): Promise<ImportResult> {
  return importTickets('change', rows, ctx, opts)
}
export function importServiceRequests(rows: CsvRow[], ctx: ServiceCtx, opts: ImportOptions = {}): Promise<ImportResult> {
  return importTickets('service_request', rows, ctx, opts)
}

/**
 * IL CONTATORE DEL CLIENTE SALE SOPRA OGNI NUMERO IMPORTATO.
 *
 * Prima l'import generava i numeri da `max()+1` senza toccare il contatore dei
 * ticket creati dall'app: il primo incident aperto dopo un import prendeva un
 * numero gia' usato e falliva sul vincolo di unicita'. Ora il contatore sale
 * almeno al numero piu' alto gia' presente o preservato dal file, e le righe
 * senza numero ne prendono uno dal contatore, come dalla pagina.
 *
 * Il prefisso e' quello del cliente (ondata 6 di «Nulla cablato»).
 *
 * Era in mezzo a `importTickets` fra la pianificazione e la scrittura. E' un
 * gesto solo, non produce niente che serva dopo, e da qui si legge per intero.
 */
async function alzaIlContatore(
  session: Parameters<typeof runQueryOne>[0],
  kind: TicketImportKind,
  ctx: ServiceCtx,
  spec: (typeof TICKET_IMPORT_SPECS)[TicketImportKind],
  plans: readonly TicketPlan[],
): Promise<void> {
  const { prefix } = (await ticketNumbering(ctx.tenantId))[kind]
  const numericOf = (n: string | null | undefined): number => {
    if (!n || !n.startsWith(prefix)) return 0
    const rest = n.slice(prefix.length)
    return /^\d+$/.test(rest) ? Number(rest) : 0
  }
  const maxRow = await runQueryOne<{ maxNum: number | null }>(session, `
    MATCH (n:${spec.label} {tenant_id: $tenantId})
    WHERE n.number STARTS WITH $prefix
    RETURN max(toInteger(substring(n.number, size($prefix)))) AS maxNum
  `, { tenantId: ctx.tenantId, prefix })
  const floor = Math.max(Number(maxRow?.maxNum ?? 0), ...plans.map((p) => numericOf(p.number)))
  if (floor > 0) await raiseSequenceTo(session, ctx.tenantId, kind, floor)
}

/**
 * I DATI DI RIFERIMENTO DI UN IMPORT, letti una volta sola.
 *
 * Erano le prime sessanta righe di `importTickets`, che ne contava
 * duecentotrentacinque. Non e' un pezzo qualunque: e' una FASE — si legge
 * tutto quello che serve a validare le righe (i passi del workflow, gli
 * utenti per email, le squadre, i ticket gia' presenti, i vocabolari, i campi
 * del cliente) e da li' in poi non si tocca piu' il database finche' non si
 * scrive. Averla come funzione a se' rende visibile quella linea, che nel
 * mezzo di duecento istruzioni non si vedeva.
 *
 * Le letture sono tutte QUI e non dentro il ciclo per riga: un import di
 * mille righe farebbe mille interrogazioni per la stessa risposta.
 */
async function riferimentiPerImport(
  session: Parameters<typeof getWorkflowSteps>[0],
  kind: TicketImportKind,
  rows: CsvRow[],
  ctx: ServiceCtx,
  spec: (typeof TICKET_IMPORT_SPECS)[TicketImportKind],
) {
  const steps = await getWorkflowSteps(session, ctx.tenantId, kind)
  if (steps.length === 0) {
    throw new ValidationError(`No active workflow definition for "${kind}" in tenant "${ctx.tenantId}"`, { key: 'errors.import.noWorkflow', params: { entityType: kind } })
  }
  const initialStep = steps.find((s) => s.isInitial)
  if (!initialStep) {
    throw new ValidationError(`The ${kind} workflow of tenant "${ctx.tenantId}" has no initial step`, { key: 'errors.import.noInitialStep', params: { entityType: kind } })
  }
  const stepByLowerName = new Map(steps.map((s) => [s.name.toLowerCase(), s.name]))
  const csvColumns = new Set(rows.flatMap((r) => Object.keys(r)))

  const emails = spec.assignable ? collectValues(rows, ['assignee_email']) : new Set<string>()
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
  const teamsByName  = spec.assignable ? await loadTeamsByName(session, ctx.tenantId, [...collectValues(rows, ['team_name'])]) : new Map<string, string>()

  const externalIds = rows.map((r) => (r['external_id'] ?? '').trim()).filter(Boolean)
  const existingRows = externalIds.length === 0 ? [] : await runQuery<ExistingNode>(session, `
    MATCH (n:${spec.label} {tenant_id: $tenantId})
    WHERE n.import_external_id IN $externalIds
    RETURN n.id AS id, n.import_external_id AS externalId, n.number AS number
  `, { tenantId: ctx.tenantId, externalIds })
  const existingByExternalId = new Map(existingRows.map((r) => [r.externalId, r]))

  // Numbers already taken in the tenant among those the CSV wants to preserve
  const csvNumbers = [...collectValues(rows, ['number'], false)]
  const numberRows = csvNumbers.length === 0 ? [] : await runQuery<{ number: string; externalId: string | null }>(session, `
    MATCH (n:${spec.label} {tenant_id: $tenantId})
    WHERE n.number IN $numbers
    RETURN n.number AS number, n.import_external_id AS externalId
  `, { tenantId: ctx.tenantId, numbers: csvNumbers })
  const numberOwner = new Map(numberRows.map((r) => [r.number, r.externalId]))

  // Severità (solo incident): un passaggio solo per valore distinto, PRIMA del
  // ciclo per riga (il ciclo e' sincrono, e la matrice e' una lettura).
  const severityByRaw = spec.severityMatrix ? await resolveImportSeverities(ctx.tenantId, rows) : new Map()
  const vocabularies = new Map<string, readonly string[]>()
  for (const v of spec.vocabularies) {
    if (v.required || csvColumns.has(v.column)) vocabularies.set(v.column, await domainVocabulary(ctx.tenantId, v.vocabulary))
  }

  // Campi del cliente (ondata 4): una colonna per campo, col nome del campo.
  const customDefs = await customFieldDefs(session, ctx.tenantId, kind)
  const customColumns = customDefs.filter((d) => csvColumns.has(d.name))
  return {
    initialStep, stepByLowerName, csvColumns,
    usersByEmail, teamsByName, existingByExternalId, numberOwner,
    severityByRaw, vocabularies, customDefs, customColumns,
  }
}

/** Il valore del vocabolario del cliente che corrisponde alla cella (maiuscole indifferenti), o null. */
function vocabularyValue(allowed: readonly string[], raw: string): string | null {
  const lower = raw.toLowerCase()
  return allowed.find((v) => v.toLowerCase() === lower) ?? null
}

export async function importTickets(
  kind: TicketImportKind,
  rows: CsvRow[],
  ctx: ServiceCtx,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const spec = TICKET_IMPORT_SPECS[kind]
  const dryRun = opts.dryRun ?? false
  if (!ctx.tenantId) throw new ValidationError('tenantId is required', { key: 'errors.import.tenantRequired' })
  if (!Array.isArray(rows)) throw new ValidationError('rows must be an array', { key: 'errors.import.rowsArray' })

  const result: ImportResult = { totalRows: rows.length, created: 0, updated: 0, errors: [], warnings: [] }
  if (rows.length === 0) return result

  return withSession(async (session) => {
    // ── Preload reference data (read-only, shared by dry-run and execute) ─────
    const {
      initialStep, stepByLowerName, csvColumns,
      usersByEmail, teamsByName, existingByExternalId, numberOwner,
      severityByRaw, vocabularies, customDefs, customColumns,
    } = await riferimentiPerImport(session, kind, rows, ctx, spec)

    // ── Per-row validation → plan ─────────────────────────────────────────────
    const plans: TicketPlan[] = []
    const seenExternalIds = new Set<string>()
    const seenNumbers     = new Set<string>()
    const now = new Date().toISOString()

    rows.forEach((row, idx) => {
      const rowNum = idx + 1
      const externalId = (row['external_id'] ?? '').trim() || null
      const fail = (key: ImportIssueKey, params: Record<string, string> = {}) => { result.errors.push(importIssue(rowNum, externalId, key, params)) }
      const warn = (key: ImportIssueKey, params: Record<string, string> = {}) => { result.warnings.push(importIssue(rowNum, externalId, key, params)) }
      const cell = (column: string) => (row[column] ?? '').trim()

      if (!externalId) { fail('externalIdRequired'); return }
      if (seenExternalIds.has(externalId)) { fail('externalIdDuplicate', { id: externalId }); return }

      const title = cell('title')
      if (!title) { fail('titleRequired'); return }
      if (title.length > 500) { fail('titleTooLong', { max: '500' }); return }

      const props: Record<string, unknown> = {}

      // severity (incident): tradotta dalla matrice `import_severity` del
      // cliente. Non risolvibile → riga in ERRORE: mai piu' un `medium` scritto
      // al posto di quello che il file diceva. Una riga SENZA severità è in
      // errore anche lei (verifica «Cosa resta cablato», ondata 1).
      if (spec.severityMatrix) {
        const rawSeverity = cell('severity')
        if (!rawSeverity) { fail('severityRequired'); return }
        const resolved = severityByRaw.get(rawSeverity.toLowerCase()) as { severity: string } | { error: string } | undefined
        if (!resolved) { fail('severityNotPrecomputed', { value: rawSeverity }); return }
        if ('error' in resolved) {
          fail('severityUntranslatable', { value: rawSeverity, reason: resolved.error })
          return
        }
        props['severity'] = resolved.severity
      }

      // Valori di vocabolario del tipo (priorità, impatto, tipo di change…).
      for (const v of spec.vocabularies) {
        const raw = cell(v.column)
        if (!raw) {
          if (v.required) { fail('columnRequired', { column: v.column }); return }
          if (csvColumns.has(v.column)) props[v.column] = null
          continue
        }
        const allowed = vocabularies.get(v.column) ?? []
        const value = vocabularyValue(allowed, raw)
        if (value === null) { fail('vocabularyUnknown', { column: v.column, value: raw, allowed: allowed.join(', ') }); return }
        props[v.column] = value
      }

      for (const column of spec.textColumns) {
        if (csvColumns.has(column)) props[column] = cell(column) || null
      }
      for (const n of spec.integers) {
        if (!csvColumns.has(n.column)) continue
        const raw = cell(n.column)
        if (!raw) { props[n.column] = null; continue }
        const value = Number(raw)
        if (!Number.isInteger(value) || value < n.min || value > n.max) {
          fail('integerOutOfRange', { column: n.column, value: raw, min: String(n.min), max: String(n.max) })
          return
        }
        props[n.column] = value
      }

      // status: matched case-insensitively on the tenant's workflow steps
      const rawStatus = cell('status')
      let stepName = initialStep.name
      if (rawStatus) {
        const matched = stepByLowerName.get(rawStatus.toLowerCase())
        if (matched) stepName = matched
        else warn('unknownStatusInitial', { status: rawStatus, step: initialStep.name })
      }

      // dates: invalid → row error
      const dates: Record<string, string | null> = {}
      for (const field of ['created_at', 'updated_at', ...spec.dateColumns]) {
        const raw = cell(field)
        if (!raw) { dates[field] = null; continue }
        const iso = parseIsoDate(raw)
        if (!iso) { fail('invalidDate', { field, value: raw }); return }
        dates[field] = iso
      }
      for (const field of spec.dateColumns) {
        if (csvColumns.has(field)) props[field] = dates[field]
      }

      const existing = existingByExternalId.get(externalId) ?? null

      // number: preserve when provided; collision with a different ticket → row error.
      // Without a number a new ticket gets the next value of the tenant's counter at write time.
      const rawNumber = cell('number') || null
      let number: string | null = null
      if (rawNumber) {
        if (seenNumbers.has(rawNumber)) { fail('numberDuplicate', { number: rawNumber }); return }
        const owner = numberOwner.get(rawNumber)
        if (owner !== undefined && owner !== externalId) {
          fail('numberInUse', { number: rawNumber })
          return
        }
        number = rawNumber
        seenNumbers.add(rawNumber)
      }

      // assignee / team lookups: not found → warning, do not block
      let assigneeId: string | null = null
      let teamId: string | null = null
      if (spec.assignable) {
        const assigneeEmail = cell('assignee_email')
        if (assigneeEmail) {
          assigneeId = usersByEmail.get(assigneeEmail.toLowerCase()) ?? null
          if (!assigneeId) warn('assigneeNotFound', { email: assigneeEmail })
        }
        const teamName = cell('team_name')
        if (teamName) {
          teamId = teamsByName.get(teamName.toLowerCase()) ?? null
          if (!teamId) warn('teamNotFound', { team: teamName })
        }
      }

      // comments: optional JSON array [{author_email, text, created_at}]
      let comments: TicketComment[] | null = null
      const rawComments = cell('comments')
      if (rawComments) {
        let parsed: unknown
        try { parsed = JSON.parse(rawComments) }
        catch { fail('commentsInvalidJson'); return }
        if (!Array.isArray(parsed)) { fail('commentsNotArray'); return }
        comments = []
        for (const [ci, c] of (parsed as unknown[]).entries()) {
          const obj = (c ?? {}) as { text?: unknown; author_email?: unknown; created_at?: unknown; internal?: unknown }
          const text = typeof obj.text === 'string' ? obj.text.trim() : ''
          if (!text) { fail('commentTextRequired', { index: String(ci) }); return }
          let createdAt = now
          if (typeof obj.created_at === 'string' && obj.created_at.trim()) {
            const iso = parseIsoDate(obj.created_at.trim())
            if (!iso) { fail('commentInvalidDate', { index: String(ci) }); return }
            createdAt = iso
          }
          let authorEmail: string | null = null
          let authorId: string | null = null
          if (typeof obj.author_email === 'string' && obj.author_email.trim()) {
            authorEmail = obj.author_email.trim()
            authorId = usersByEmail.get(authorEmail.toLowerCase()) ?? null
            if (!authorId) warn('commentAuthorNotFound', { index: String(ci), email: authorEmail })
          }
          /**
           * D-26: `internal: false` nel JSON del commento importato = risposta
           * visibile al richiedente dal portale. Un valore che non è booleano
           * è un errore, non un default silenzioso; assente resta interno.
           */
          if (obj.internal !== undefined && typeof obj.internal !== 'boolean') {
            fail('commentInternalNotBoolean', { index: String(ci) }); return
          }
          const isInternal = obj.internal === undefined ? true : obj.internal
          comments.push({ text, authorEmail, authorId, createdAt, isInternal })
        }
      }

      seenExternalIds.add(externalId)
      plans.push({
        row: rowNum,
        externalId,
        exists:      existing !== null,
        existingId:  existing?.id ?? null,
        title,
        stepName,
        number,
        createdAt:   dates['created_at'] ?? (existing ? null : now),
        updatedAt:   dates['updated_at'] ?? dates['created_at'] ?? now,
        props,
        assigneeId,
        teamId,
        comments,
        // Una cella vuota non cancella: nello storico importato «vuoto» vuol dire «non c'era».
        customInputs: customColumns.filter((d) => cell(d.name) !== '').map((d) => ({ name: d.name, value: cell(d.name) })),
        customProps:  {},
      })
    })

    // I campi del cliente si validano come dalla pagina (tipo, vocabolario,
    // script), una riga alla volta: una cella sbagliata mette in errore la sua
    // riga. L'obbligo NON vale nell'import: lo storico di un altro strumento
    // non ha i campi nati dopo.
    for (let i = plans.length - 1; i >= 0; i--) {
      const plan = plans[i]!
      if (plan.customInputs.length === 0) continue
      // Colonna per colonna, così l'errore nomina la colonna sbagliata.
      for (const input of plan.customInputs) {
        try {
          Object.assign(plan.customProps, await resolveCustomFieldWrites(ctx.tenantId, kind, customDefs, [input], { current: {} }))
        } catch (err) {
          result.errors.push(importIssue(plan.row, plan.externalId, 'customFieldInvalid', { field: input.name, error: err instanceof Error ? err.message : String(err) }))
          plans.splice(i, 1)
          break
        }
      }
    }
    // Le righe si scrivono nell'ordine del file (il ciclo sopra toglie da destra).
    plans.sort((x, y) => x.row - y.row)

    // ── Dry-run: report what would happen, zero writes ────────────────────────
    if (dryRun) {
      for (const p of plans) { if (p.exists) result.updated++; else result.created++ }
      return result
    }

    // ── Numbering: the tenant counter must stay ahead of every number ─────────
    await alzaIlContatore(session, kind, ctx, spec, plans)

    // ── Execute: ONE transaction PER ROW ──────────────────────────────────────
    // Rationale: each row is an independent unit (ticket + relations +
    // comments + workflow instance must commit or roll back together), and
    // per-row transactions let valid rows land even when a later row fails at
    // write time (the failure is attributed to exactly that row in `errors`).
    // A batch-of-N tx would be marginally faster but a single unexpected DB
    // error would roll back N-1 innocent rows.
    for (const p of plans) {
      try {
        await writeTicketRow(session, kind, p, ctx)
        if (p.exists) result.updated++; else result.created++
      } catch (err) {
        result.errors.push(importIssue(p.row, p.externalId, 'writeFailed', { error: err instanceof Error ? err.message : String(err) }))
      }
    }

    logger.info({
      tenantId: ctx.tenantId, kind, totalRows: result.totalRows,
      created: result.created, updated: result.updated,
      errors: result.errors.length, warnings: result.warnings.length,
    }, '[import] tickets import completed')
    return result
  }, !dryRun)
}

async function writeTicketRow(session: Session, kind: TicketImportKind, p: TicketPlan, ctx: ServiceCtx): Promise<void> {
  const spec = TICKET_IMPORT_SPECS[kind]
  const now = new Date().toISOString()
  const newId = uuidv4()
  const label = spec.label

  await session.executeWrite(async (tx) => {
    // Un ticket nuovo senza numero nel file prende il prossimo del contatore.
    const number = p.number ?? (p.exists ? null : await nextTicketNumber(tx, ctx.tenantId, kind))

    // MERGE on (tenant_id, import_external_id) → idempotent re-runs
    await tx.run(`
      MERGE (n:${label} {tenant_id: $tenantId, import_external_id: $externalId})
      ON CREATE SET n.id         = $newId,
                    n.number     = $number,${spec.numberIsCode ? '\n                    n.code       = $number,' : ''}
                    n.created_at = $createdAt
      SET n.title       = $title,
          n.status      = $status,
          n.number      = coalesce($numberUpdate, n.number),${spec.numberIsCode ? '\n          n.code        = coalesce($numberUpdate, n.code),' : ''}
          n.created_at  = coalesce($createdAt, n.created_at),
          n.updated_at  = $updatedAt
      SET n += $props
      SET n += $customProps
    `, {
      tenantId:     ctx.tenantId,
      externalId:   p.externalId,
      newId,
      number,
      numberUpdate: p.exists ? p.number : null,
      title:        p.title,
      status:       p.stepName,
      createdAt:    p.createdAt,
      updatedAt:    p.updatedAt,
      props:        p.props,
      customProps:  p.customProps,
    })

    const entityId = p.existingId ?? newId

    if (p.assigneeId) {
      await tx.run(`
        MATCH (n:${label} {tenant_id: $tenantId, import_external_id: $externalId})
        OPTIONAL MATCH (n)-[old:ASSIGNED_TO]->()
        DELETE old
        WITH DISTINCT n
        MATCH (u:User {id: $userId, tenant_id: $tenantId})
        MERGE (n)-[:ASSIGNED_TO]->(u)
      `, { tenantId: ctx.tenantId, externalId: p.externalId, userId: p.assigneeId })
    }
    if (p.teamId) {
      await tx.run(`
        MATCH (n:${label} {tenant_id: $tenantId, import_external_id: $externalId})
        MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
        // Un ticket storico: da quando il team l'avesse non si sa, il tratto parte dall'apertura (ricostruito).
        ${assignTeamCypher('n', 't', { startedAt: 'coalesce(n.created_at, $__teamNow)', inferred: true })}
      `, { tenantId: ctx.tenantId, externalId: p.externalId, teamId: p.teamId, [TEAM_NOW_PARAM]: new Date().toISOString() })
    }

    // Comments: same node shape as the ticket comments, plus import_external_id
    // so re-runs replace the imported thread instead of duplicating it.
    if (p.comments !== null) {
      await tx.run(`
        MATCH (n:${label} {tenant_id: $tenantId, import_external_id: $externalId})
        OPTIONAL MATCH (n)-[:HAS_COMMENT]->(old:Comment)
        WHERE old.import_external_id = $externalId
        DETACH DELETE old
        WITH DISTINCT n
        UNWIND $comments AS cm
        CREATE (c:Comment {
          id:                 randomUUID(),
          tenant_id:          $tenantId,
          text:               cm.text,
          // D-26: quello che dice il CSV (assente = interno).
          is_internal:        cm.isInternal,
          author_id:          cm.authorId,
          author_email:       cm.authorEmail,
          created_at:         cm.createdAt,
          updated_at:         cm.createdAt,
          import_external_id: $externalId
        })
        CREATE (n)-[:HAS_COMMENT]->(c)
      `, { tenantId: ctx.tenantId, externalId: p.externalId, comments: p.comments })
    }

    // Workflow: create the instance at the initial step (engine behavior),
    // then point it to the mapped step. entity.status already matches.
    await ensureWorkflowInstance(tx, ctx.tenantId, entityId, kind)
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
  if (!ctx.tenantId) throw new ValidationError('tenantId is required', { key: 'errors.import.tenantRequired' })
  if (!Array.isArray(rows)) throw new ValidationError('rows must be an array', { key: 'errors.import.rowsArray' })

  const result: ImportResult = { totalRows: rows.length, created: 0, updated: 0, errors: [], warnings: [] }
  if (rows.length === 0) return result

  return withSession(async (session) => {
    // kb_article workflow is optional: the KB resolver itself treats instance
    // creation as best-effort. Without a definition we import articles with
    // the raw draft/published status and no workflow instance (per-row warning).
    let steps: StepRow[]
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
    // F5: la categoria di un articolo è un valore di `kb_category` del cliente.
    const kbCategories = await domainVocabulary(ctx.tenantId, 'kb_category')
    const seenExternalIds = new Set<string>()
    const now = new Date().toISOString()

    rows.forEach((row, idx) => {
      const rowNum = idx + 1
      const externalId = (row['external_id'] ?? '').trim() || null
      const fail = (key: ImportIssueKey, params: Record<string, string> = {}) => { result.errors.push(importIssue(rowNum, externalId, key, params)) }
      const warn = (key: ImportIssueKey, params: Record<string, string> = {}) => { result.warnings.push(importIssue(rowNum, externalId, key, params)) }

      if (!externalId) { fail('externalIdRequired'); return }
      if (seenExternalIds.has(externalId)) { fail('externalIdDuplicate', { id: externalId }); return }

      const title = (row['title'] ?? '').trim()
      if (!title) { fail('titleRequired'); return }

      const body = row['body'] ?? ''
      if (body.length > 50_000) { fail('bodyTooLong', { max: '50000' }); return }

      // status: published/draft (case-insensitive), default draft
      const rawStatus = (row['status'] ?? '').trim().toLowerCase()
      let statusRaw: 'draft' | 'published' = 'draft'
      if (rawStatus === 'published') statusRaw = 'published'
      else if (rawStatus && rawStatus !== 'draft') warn('unknownStatusDraft', { status: row['status'] ?? '' })

      const dates: Record<string, string | null> = {}
      let dateError = false
      for (const field of ['created_at', 'published_at'] as const) {
        const raw = (row[field] ?? '').trim()
        if (!raw) { dates[field] = null; continue }
        const iso = parseIsoDate(raw)
        if (!iso) { fail('invalidDate', { field, value: raw }); dateError = true; break }
        dates[field] = iso
      }
      if (dateError) return

      const category = (row['category'] ?? '').trim() || null
      if (category !== null && !kbCategories.includes(category)) {
        fail('kbCategoryUnknown', { category, allowed: kbCategories.join(', ') })
        return
      }

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
            warn('kbNoPublishedStep', { step: initialStep!.name })
            stepName = initialStep!.name
          }
        } else {
          stepName = initialStep!.name
        }
      } else {
        warn('kbNoWorkflow')
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
        category,
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

    // One tx per row — same rationale as importTickets.
    for (const p of plans) {
      try {
        await writeKBRow(session, p, ctx)
        if (p.exists) result.updated++; else result.created++
      } catch (err) {
        result.errors.push(importIssue(p.row, p.externalId, 'writeFailed', { error: err instanceof Error ? err.message : String(err) }))
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
