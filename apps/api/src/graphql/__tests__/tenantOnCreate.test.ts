/**
 * Lint statico, gemello di `tenantScoping`: lì si guarda come si LEGGE, qui
 * come si SCRIVE. Ogni `CREATE (x:Label { … })` di un nodo di dominio deve
 * scrivere `tenant_id` nella mappa di proprietà.
 *
 * Il difetto che lo motiva (B-3): `addWorkflowStep` creava il `WorkflowStep`
 * senza `tenant_id`. Nessun errore, nessun log — ma da quel momento
 * `updateWorkflowStep` rispondeva «non trovato», `removeWorkflowStep` «Cannot
 * remove step» e le transizioni in uscita dal passo sparivano dal disegnatore
 * pur restando percorribili dal motore. Un nodo senza tenant è invisibile a chi
 * filtra per tenant e visibile a chi non filtra: il peggiore dei due mondi.
 *
 * Euristica: dal `CREATE (alias:Label {` si legge in avanti fino alla `}` che
 * chiude la mappa; dentro ci deve essere `tenant_id`. Un caso legittimo (nodo
 * davvero globale) si marca con `// tenant-ok` nel blocco o sulla riga prima.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const apiSrc = join(here, '../..')

/** Le label che portano `tenant_id`; stesso elenco di tenantScoping.test.ts. */
const DOMAIN_LABELS = [
  'Incident', 'Problem', 'Change', 'ServiceRequest', 'KBArticle',
  'Team', 'User',
  'AssessmentTask', 'DeployPlanTask', 'ValidationTest', 'DeploymentTask', 'ReviewTask', 'ChangeApproval',
  'WorkflowInstance', 'WorkflowDefinition', 'WorkflowStep', 'WorkflowStepExecution',
  'NotificationChannel', 'NotificationRule', 'OutboundWebhook', 'InboundWebhook', 'ApiKey',
  'SyncSource', 'SyncRun',
  'ReportTemplate', 'ReportSection', 'ReportConversation', 'DashboardConfig', 'DashboardWidget', 'CustomWidget',
  'Anomaly', 'AnomalyConfig', 'AutoTrigger', 'BusinessRule', 'SLAPolicyNode', 'OLAContract', 'SLAStatus',
  'Attachment', 'EntityComment', 'Comment', 'AuditEntry', 'ApprovalRequest', 'InternalMessage', 'Notification',
  'CIGroup', 'ConfigurationItem', 'EnumTypeDefinition', 'CITypeDefinition',
  'FieldVisibilityRule', 'FieldRequirementRule', 'ITILCIRelationRule', 'ServiceCatalogItem', 'AssessmentQuestion',
  'Event', 'CIAlias', 'EventHistoryEntry',
  'ServiceMap', 'ServiceHealthEntry',
]

const EXCLUDED_DIRS = new Set(['__tests__'])

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

const CREATE_RE = new RegExp(`CREATE \\((\\w*):(${DOMAIN_LABELS.join('|')}) *\\{`, 'g')

interface Offender { file: string; line: number; label: string }

export function scanCreates(source: string, file: string): Offender[] {
  const lines = source.split('\n')
  const out: Offender[] = []
  lines.forEach((line, i) => {
    CREATE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CREATE_RE.exec(line)) !== null) {
      // Blocco = dalla graffa aperta fino alla prima graffa chiusa.
      let block = line.slice(m.index)
      let j = i
      while (!block.slice(block.indexOf('{') + 1).includes('}') && j < lines.length - 1) {
        j++
        block += `\n${lines[j]}`
      }
      if (block.includes('tenant_id')) continue
      if (block.includes('tenant-ok') || (lines[i - 1] ?? '').includes('tenant-ok')) continue
      out.push({ file, line: i + 1, label: m[2]! })
    }
  })
  return out
}

describe('tenant_id su ogni CREATE di un nodo di dominio (tutta l\'API)', () => {
  const files = listFiles('.')
  it('perimetro non vuoto', () => { expect(files.length).toBeGreaterThan(100) })

  it('nessun CREATE di dominio senza tenant_id', () => {
    const offenders = files.flatMap((f) => scanCreates(readFileSync(f, 'utf8'), relative(apiSrc, f)))
    expect(offenders.map((o) => `${o.file}:${o.line}  CREATE (:${o.label})`)).toEqual([])
  })

  it('riconosce il difetto che lo motiva (addWorkflowStep senza tenant_id)', () => {
    const broken = `
      MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
      CREATE (s:WorkflowStep {
        id:            $stepId,
        definition_id: $definitionId,
        name:          $name
      })
    `
    expect(scanCreates(broken, 'finto.ts')).toHaveLength(1)
    expect(scanCreates(broken.replace('id:            $stepId,', 'id: $stepId, tenant_id: $tenantId,'), 'finto.ts')).toEqual([])
  })
})
