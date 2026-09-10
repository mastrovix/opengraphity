/**
 * Lint statico: ogni MATCH su un nodo di dominio deve essere scopato per tenant.
 *
 * La revisione ITSM ha trovato ~30 pattern `(x:Label {id: $id})` senza
 * `tenant_id`, sparsi e sfuggiti a tutti; una regola meccanica è l'unico modo
 * per non ritrovarseli. Euristica: per ogni `MATCH (alias:Label {...})` (anche
 * OPTIONAL) con Label di dominio, la mappa proprietà o la riga successiva
 * (WHERE) devono contenere `tenant_id`. Un caso legittimo si marca con
 * `// tenant-ok` sulla riga precedente o sulla riga stessa.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const apiSrc = join(here, '../..')

// Ogni label di dominio che porta tenant_id. I tipi del metamodello
// (CITypeDefinition, EnumTypeDefinition) possono essere condivisi con tenant
// 'system': il pattern ammesso è `WHERE x.tenant_id IN [$tenantId, 'system']`.
const DOMAIN_LABELS = [
  'Incident', 'Problem', 'Change', 'ServiceRequest', 'KBArticle',
  'Team', 'User',
  'AssessmentTask', 'DeployPlanTask', 'ValidationTest', 'DeploymentTask', 'ReviewTask', 'ChangeApproval',
  'WorkflowInstance', 'WorkflowDefinition', 'WorkflowStep',
  'NotificationChannel', 'NotificationRule', 'OutboundWebhook', 'InboundWebhook', 'ApiKey',
  'SyncSource', 'SyncRun',
  'ReportTemplate', 'ReportSection', 'ReportConversation', 'DashboardConfig', 'DashboardWidget', 'CustomWidget',
  'Anomaly', 'AnomalyConfig', 'AutoTrigger', 'BusinessRule', 'SLAPolicyNode', 'OLAContract', 'SLAStatus',
  'Attachment', 'EntityComment', 'AuditEntry', 'ApprovalRequest', 'InternalMessage', 'Notification',
  'CIGroup', 'ConfigurationItem', 'EnumTypeDefinition', 'CITypeDefinition',
  'FieldVisibilityRule', 'FieldRequirementRule', 'ITILCIRelationRule', 'ServiceCatalogItem', 'AssessmentQuestion',
  'Event', 'CIAlias', 'EventHistoryEntry',
  'ServiceMap', 'ServiceHealthEntry',
]

// Tutta l'API (Ondata 1 della revisione a tappeto). Fuori: script operativi
// (hanno guardie proprie: --tenant obbligatorio) e test.
const SCOPE = ['.']
const EXCLUDED_DIRS = new Set(['__tests__', 'scripts'])

function listFiles(p: string): string[] {
  const full = p.startsWith('/') ? p : join(apiSrc, p)
  if (statSync(full).isFile()) return [full]
  const out: string[] = []
  for (const f of readdirSync(full)) {
    const child = join(full, f)
    if (statSync(child).isDirectory()) {
      if (!EXCLUDED_DIRS.has(f)) out.push(...listFiles(child))
    } else if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')) {
      out.push(child)
    }
  }
  return out
}

const MATCH_RE = new RegExp(`MATCH \\((\\w+):(${DOMAIN_LABELS.join('|')})\\s*\\{([^}]*)\\}`, 'g')

interface Offender { file: string; line: number; text: string }

function scan(file: string): Offender[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  const out: Offender[] = []
  lines.forEach((line, i) => {
    MATCH_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = MATCH_RE.exec(line)) !== null) {
      const props = m[3]!
      if (props.includes('tenant_id')) continue
      const next = lines[i + 1] ?? ''
      const prev = lines[i - 1] ?? ''
      if (line.slice(m.index + m[0].length).includes('tenant_id')) continue // WHERE inline sulla stessa riga
      if (next.includes('tenant_id')) continue           // WHERE x.tenant_id = … sulla riga dopo
      if (line.includes('tenant-ok') || prev.includes('tenant-ok')) continue
      out.push({ file: relative(apiSrc, file), line: i + 1, text: line.trim() })
    }
  })
  return out
}

describe('tenant scoping sui MATCH di dominio (tutta l\'API)', () => {
  const files = SCOPE.flatMap(listFiles)
  it('perimetro non vuoto', () => { expect(files.length).toBeGreaterThan(100) })
  for (const f of files) {
    it(relative(apiSrc, f), () => {
      const offenders = scan(f)
      expect(offenders.map((o) => `${o.file}:${o.line}  ${o.text}`)).toEqual([])
    })
  }
})

/**
 * Stessa regola per i MERGE (Ondata 4): un `MERGE (x:Label {…})` senza
 * tenant_id nella chiave di match può agganciare (o creare) un nodo di un
 * altro tenant. La mappa proprietà può essere multi-riga (es. anomalyEngine),
 * quindi qui si scansiona il contenuto intero e non riga per riga. Sono
 * ammessi, come per i MATCH, `tenant_id` sulla riga di chiusura della mappa o
 * su quella successiva (tipicamente `ON CREATE SET x.tenant_id = $tenantId`,
 * usato dai task della change keyed su `change_key` = uuid della change) e il
 * marcatore `// tenant-ok`.
 */
const MERGE_RE = new RegExp(`MERGE \\((\\w+):(${DOMAIN_LABELS.join('|')})\\s*\\{([^}]*)\\}`, 'g')

function scanMergeContent(content: string, displayName: string): Offender[] {
  const lines = content.split('\n')
  const out: Offender[] = []
  MERGE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MERGE_RE.exec(content)) !== null) {
    if (m[3]!.includes('tenant_id')) continue
    const startLine = content.slice(0, m.index).split('\n').length - 1        // 0-based
    const endLine = startLine + m[0].split('\n').length - 1
    const endCol = content.slice(0, m.index + m[0].length).split('\n').pop()!.length
    if ((lines[endLine] ?? '').slice(endCol).includes('tenant_id')) continue  // WHERE/SET inline dopo la mappa
    if ((lines[endLine + 1] ?? '').includes('tenant_id')) continue           // ON CREATE SET x.tenant_id = … sulla riga dopo
    const startText = lines[startLine] ?? ''
    if (startText.includes('tenant-ok') || (lines[startLine - 1] ?? '').includes('tenant-ok')) continue
    out.push({ file: displayName, line: startLine + 1, text: startText.trim() })
  }
  return out
}

const scanMerge = (file: string) => scanMergeContent(readFileSync(file, 'utf8'), relative(apiSrc, file))

describe('tenant scoping sui MERGE di dominio (tutta l\'API)', () => {
  const files = SCOPE.flatMap(listFiles)

  it('l\'euristica accetta chiave/riga-dopo/multi-riga/marcatore e segnala il resto', () => {
    const sample = [
      "MERGE (u:User {email: $email, tenant_id: $tenantId})",         // ok: nella chiave
      "MERGE (t:AssessmentTask {change_key: $changeId + '-owner'})",  // ok: riga successiva
      "  ON CREATE SET t.id = randomUUID(), t.tenant_id = $tenantId",
      "MERGE (a:Anomaly {",                                            // ok: mappa multi-riga
      "  tenant_id: $tenantId, fingerprint: $fp",
      "})",
      "// tenant-ok",
      "MERGE (k:ApiKey {id: $id})",                                    // ok: marcatore
      "MERGE (x:Incident {id: $id})",                                  // VIOLAZIONE
      "RETURN x",
      "MERGE (y:Problem {",                                            // VIOLAZIONE multi-riga
      "  id: $id",
      "})",
    ].join('\n')
    expect(scanMergeContent(sample, 'sample.ts')).toEqual([
      { file: 'sample.ts', line: 9, text: 'MERGE (x:Incident {id: $id})' },
      { file: 'sample.ts', line: 11, text: 'MERGE (y:Problem {' },
    ])
  })

  for (const f of files) {
    it(relative(apiSrc, f), () => {
      const offenders = scanMerge(f)
      expect(offenders.map((o) => `${o.file}:${o.line}  ${o.text}`)).toEqual([])
    })
  }
})
