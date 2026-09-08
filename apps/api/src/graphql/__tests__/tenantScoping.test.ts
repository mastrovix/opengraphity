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

const DOMAIN_LABELS = [
  'Incident', 'Problem', 'Change', 'ServiceRequest', 'KBArticle',
  'Team', 'User',
  'AssessmentTask', 'DeployPlanTask', 'ValidationTest', 'DeploymentTask', 'ReviewTask', 'ChangeApproval',
  'WorkflowInstance',
]

// Perimetro ITSM (i moduli rivisti). Si allarga man mano che si bonifica.
const SCOPE = [
  'graphql/resolvers/incident.ts', 'graphql/resolvers/problem.ts', 'graphql/resolvers/service_request.ts',
  'graphql/resolvers/relatedTickets.ts', 'graphql/resolvers/comments.ts', 'graphql/resolvers/team.ts',
  'graphql/resolvers/change', 'graphql/resolvers/workflowMutations.ts', 'graphql/resolvers/workflowQueries.ts',
  'services/incidentService.ts', 'services/problemService.ts', 'services/requestService.ts',
  'services/changeCreationService.ts', 'services/ticketAssignment.ts', 'services/triageService.ts',
  'workflow/conditions.ts',
]

function listFiles(p: string): string[] {
  const full = join(apiSrc, p)
  if (statSync(full).isFile()) return [full]
  return readdirSync(full)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(full, f))
    .filter((f) => statSync(f).isFile())
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
      if (next.includes('tenant_id')) continue           // WHERE x.tenant_id = … sulla riga dopo
      if (line.includes('tenant-ok') || prev.includes('tenant-ok')) continue
      out.push({ file: relative(apiSrc, file), line: i + 1, text: line.trim() })
    }
  })
  return out
}

describe('tenant scoping sui MATCH di dominio (perimetro ITSM)', () => {
  const files = SCOPE.flatMap(listFiles)
  it('perimetro non vuoto', () => { expect(files.length).toBeGreaterThan(10) })
  for (const f of files) {
    it(relative(apiSrc, f), () => {
      const offenders = scan(f)
      expect(offenders.map((o) => `${o.file}:${o.line}  ${o.text}`)).toEqual([])
    })
  }
})
