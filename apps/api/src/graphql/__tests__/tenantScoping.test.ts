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
