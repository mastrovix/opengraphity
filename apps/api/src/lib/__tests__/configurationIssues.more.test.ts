/**
 * CONFIGURATION ISSUES — THE CHECKS `configurationIssues.test.ts` DOES NOT REACH.
 *
 * The banner is the only place where a tenant administrator learns that
 * something in the configuration stops work. Pinned here:
 *  - task integrity: a task whose declared ticket type does not match the
 *    ticket it hangs on (an error — it corrupts reports), open tasks with no
 *    team and no assignee (work nobody knows they have), and tasks waiting
 *    for a task that does not exist on the ticket (they never start, and hold
 *    the step);
 *  - step deadlines that cannot move their ticket: `error` as soon as one
 *    FAILED, only `warning` when they were merely refused, and the list of
 *    tickets is capped so the banner stays readable;
 *  - changes parked with an open path;
 *  - the self-analysis GitHub link, reported ONLY on the platform tenant;
 *  - a matrix cell whose value is not in the output vocabulary is an error
 *    of its own (it stops a ticket from opening);
 *  - vocabulary labels: the tenant's own copy wins over the shipped one
 *    whatever order the rows come back in;
 *  - the per-tenant cache: invalidating one tenant does not keep serving it
 *    stale, and does not force a recompute for the others.
 *
 * Every other check is fed "healthy" empty answers; each test looks only at
 * the issue kinds it is about.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  enumRows: [] as Array<{ name: string; owner: string; values: string[]; labels: string | null }>,
  taskRows: { mismatch: [] as unknown[], noTeam: [] as unknown[], waiting: [] as unknown[] },
  blocked: [] as Array<{ number: string; step: string; outcome: string }>,
  stuck: [] as string[],
  autoanalisi: null as null | { repo: string; token: string },
  vocabularies: {} as Record<string, string[]>,
  matrices: {} as Record<string, Record<string, string>>,
  schemaReads: 0,
}))

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, cypher: string) => {
    if (cypher.includes('AS actual')) return h.taskRows.mismatch
    if (cypher.includes('ASSIGNED_TO_TEAM')) return h.taskRows.noTeam
    if (cypher.includes('after_title')) return h.taskRows.waiting
    return []
  }),
  runQueryOne: vi.fn(async () => null),
  getSession: () => ({
    executeRead: (fn: (tx: { run: () => Promise<unknown> }) => unknown) => fn({
      run: async () => ({
        records: h.enumRows.map((r) => ({
          get: (k: string) => ({ name: r.name, owner: r.owner, values: r.values, labels: r.labels } as Record<string, unknown>)[k] ?? null,
        })),
      }),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('../schemaCache.js', () => ({ getSchemaState: vi.fn(async () => { h.schemaReads++; return { degraded: false, reason: null } }) }))
vi.mock('../catalogForm.js', () => ({ formFieldsWithFormula: vi.fn(async () => []) }))
vi.mock('../scriptingPlan.js', () => ({ getScriptingPlan: vi.fn(async () => ({ plan: 'enterprise', enabled: true })) }))
vi.mock('../tenantLanguage.js', () => ({ tenantDefaultLanguage: vi.fn(async () => 'en'), LINGUA_DI_ULTIMA_ISTANZA: 'en' }))
vi.mock('../provisionTenantData.js', () => ({ tenantProvisioningGaps: vi.fn(async () => []) }))
vi.mock('../tenantTimezone.js', () => ({ tenantTimezone: vi.fn(async () => 'Europe/Rome') }))
vi.mock('../migrationState.js', () => ({ pendingMigrations: vi.fn(async () => []) }))
vi.mock('../serviceCalendars.js', () => ({ businessHoursWithoutCalendar: vi.fn(async () => []) }))
vi.mock('../teamSourcing.js', () => ({ teamsWithoutSourcing: vi.fn(async () => ({ count: 0, names: [] })) }))
vi.mock('../ticketsWithoutSla.js', () => ({ ticketsWithoutSla: vi.fn(async () => ({ count: 0, numbers: [] })) }))
vi.mock('../workflowStepRoles.js', () => ({ workflowsMissingStepRoles: vi.fn(async () => []) }))
vi.mock('../vocabularyShippedDrift.js', () => ({
  vocabulariesBehindShipped: vi.fn(async () => []),
  vocabulariesCopiedWithoutChanges: vi.fn(async () => []),
}))
vi.mock('../portalSeverityOptions.js', () => ({ PORTAL_SEVERITY_VOCABULARY: 'severity', portalSeverityOptions: vi.fn(async () => [{ value: 'low', labels: {} }]) }))
vi.mock('../tenantInAppRetention.js', () => ({ tenantInAppRetentionDays: vi.fn(async () => 30) }))
vi.mock('../catalogItemPriority.js', () => ({ catalogItemsWithoutPriority: vi.fn(async () => []), catalogItemsWithLegacyCategory: vi.fn(async () => []) }))
vi.mock('../stepDeadlineBlocked.js', () => ({ blockedStepDeadlines: vi.fn(async () => h.blocked) }))
vi.mock('../slackChannelsWithoutWorkspace.js', () => ({ slackChannelsWithoutWorkspace: vi.fn(async () => []) }))
vi.mock('../serviceIncidentProblems.js', () => ({ serviceMapsWithIncidentProblem: vi.fn(async () => []) }))
vi.mock('../ticketCustomFields.js', () => ({ customFieldDefs: vi.fn(async () => []) }))
vi.mock('../customFieldSteps.js', async (importOriginal) => ({ ...(await importOriginal<object>()), workflowStepsByDefinition: vi.fn(async () => []) }))
vi.mock('../olaMeasurability.js', () => ({ olaContractsMeasurability: vi.fn(async () => ({ withoutTeam: [], unmeasurable: [] })) }))
vi.mock('../metamodelDuplicateFields.js', () => ({ duplicateMetamodelFields: vi.fn(async () => []) }))
vi.mock('../catalogFormHealth.js', () => ({ catalogFormsToFix: vi.fn(async () => []) }))
vi.mock('../slaWarningCheck.js', () => ({ slaPoliciesWarningNotBeforeDeadline: vi.fn(async () => []) }))
vi.mock('../changesStuck.js', () => ({ changesStuckWithOpenPath: vi.fn(async () => h.stuck) }))
vi.mock('../autoanalisiGitHub.js', () => ({ configurazioneAutoanalisi: vi.fn(() => h.autoanalisi) }))
vi.mock('../../services/events/policy.js', () => ({
  getEventPolicy: vi.fn(async () => ({ ignore_lifecycle_statuses: [], retired_statuses: [], maintenance_statuses: [] })),
}))
vi.mock('../domainMatrix.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../domainMatrix.js')>()
  return {
    ...orig,
    domainVocabulary: vi.fn(async (_t: string, name: string) => h.vocabularies[name] ?? []),
    matrixInputValues: vi.fn(async (_t: string, kind: keyof typeof orig.DOMAIN_MATRIX_KINDS) => {
      const spec: { inputs: readonly string[] } = orig.DOMAIN_MATRIX_KINDS[kind]
      return spec.inputs.map((i) => h.vocabularies[i] ?? [])
    }),
    matrixOutputValues: vi.fn(async (_t: string, kind: keyof typeof orig.DOMAIN_MATRIX_KINDS) => h.vocabularies[orig.DOMAIN_MATRIX_KINDS[kind].output] ?? []),
    loadDomainMatrix: vi.fn(async (_t: string, kind: string) => ({ kind, entries: h.matrices[kind] ?? {}, isDefault: false, updatedAt: null })),
  }
})

const { configurationIssues, invalidateConfigurationIssues } = await import('../configurationIssues.js')
const { TENANT_DI_PIATTAFORMA } = await import('../serverLogEvents.js')

type Issue = Awaited<ReturnType<typeof configurationIssues>>[number]
const fresh = async (tenantId = 'c-one') => { invalidateConfigurationIssues(); return configurationIssues(tenantId) }
const ofKind = (issues: Issue[], kind: string) => issues.filter((i) => i.kind === kind)

beforeEach(() => {
  h.enumRows = []
  h.taskRows = { mismatch: [], noTeam: [], waiting: [] }
  h.blocked = []
  h.stuck = []
  h.autoanalisi = null
  h.vocabularies = {}
  h.matrices = {}
  h.schemaReads = 0
  invalidateConfigurationIssues()
})

describe('task integrity', () => {
  it('a task whose declared type does not match its ticket is an error, with up to five examples', async () => {
    h.taskRows.mismatch = Array.from({ length: 6 }, (_, i) => ({ code: `TSK${String(i)}`, declared: 'incident', actual: 'Change' }))
    const [issue] = ofKind(await fresh(), 'task_type_mismatch')
    expect(issue).toMatchObject({ severity: 'error', where: null })
    expect(issue!.params).toEqual({
      count: '6',
      examples: 'TSK0 (incident → Change), TSK1 (incident → Change), TSK2 (incident → Change), TSK3 (incident → Change), TSK4 (incident → Change)',
    })
  })

  it('open tasks with no team and no assignee are a warning naming the first five', async () => {
    h.taskRows.noTeam = [{ code: 'A' }, { code: 'B' }]
    const [issue] = ofKind(await fresh(), 'tasks_without_team')
    expect(issue).toMatchObject({ severity: 'warning', params: { count: '2', codes: 'A, B' } })
  })

  it('tasks waiting for a task that is not on the ticket are an error: they would never start', async () => {
    h.taskRows.waiting = [{ code: 'W1', after: 'Backup done' }]
    const [issue] = ofKind(await fresh(), 'tasks_waiting_forever')
    expect(issue).toMatchObject({ severity: 'error', params: { count: '1', examples: 'W1 → «Backup done»' } })
  })

  it('a healthy tenant gets none of the three', async () => {
    const issues = await fresh()
    for (const k of ['task_type_mismatch', 'tasks_without_team', 'tasks_waiting_forever']) expect(ofKind(issues, k)).toEqual([])
  })
})

describe('blocked step deadlines', () => {
  it('only refused deadlines are a warning', async () => {
    h.blocked = [{ number: 'INC1', step: 'triage', outcome: 'refused' }]
    const [issue] = ofKind(await fresh(), 'step_deadlines_blocked')
    expect(issue).toMatchObject({ severity: 'warning', where: '/workflow', params: { count: '1', tickets: 'INC1 (triage)' } })
  })

  it('one failed deadline makes it an error, and the list is capped at ten', async () => {
    h.blocked = Array.from({ length: 11 }, (_, i) => ({ number: `INC${String(i)}`, step: 's', outcome: i === 10 ? 'failed' : 'refused' }))
    const [issue] = ofKind(await fresh(), 'step_deadlines_blocked')
    expect(issue!.severity).toBe('error')
    expect(issue!.params['count']).toBe('11')
    expect(issue!.params['tickets']).toMatch(/^INC0 \(s\), .*INC9 \(s\), …$/)
    expect(issue!.params['tickets']).not.toContain('INC10')
  })
})

describe('stuck changes', () => {
  it('changes parked with an open path are a warning listing them', async () => {
    h.stuck = ['CHG1', 'CHG2']
    const [issue] = ofKind(await fresh(), 'changes_stuck')
    expect(issue).toMatchObject({ severity: 'warning', where: '/changes', params: { count: '2', changes: 'CHG1, CHG2' } })
  })
})

describe('self-analysis GitHub link', () => {
  it('is reported on the platform tenant when not configured', async () => {
    expect(ofKind(await fresh(TENANT_DI_PIATTAFORMA), 'autoanalisi_github_missing')).toEqual([
      { kind: 'autoanalisi_github_missing', severity: 'warning', where: '/proposals', params: {} },
    ])
  })

  it('is silent once configured', async () => {
    h.autoanalisi = { repo: 'org/repo', token: 'x' }
    expect(ofKind(await fresh(TENANT_DI_PIATTAFORMA), 'autoanalisi_github_missing')).toEqual([])
  })

  it('is never reported to a customer tenant, which has nothing to do with it', async () => {
    expect(ofKind(await fresh('c-one'), 'autoanalisi_github_missing')).toEqual([])
  })
})

describe('matrix cells outside the output vocabulary', () => {
  it('are an error of their own, counted', async () => {
    h.vocabularies = { impact: ['low'], urgency: ['low'], priority: ['p1'] }
    h.matrices = { priority: { 'low|low': 'critical' } }
    const issues = await fresh()
    expect(ofKind(issues, 'matrix_invalid_cells')).toEqual([
      { kind: 'matrix_invalid_cells', severity: 'error', where: '/settings/domain-matrices', params: { matrix: 'priority', count: '1' } },
    ])
    // The cell exists, so it is not also reported as missing.
    expect(ofKind(issues, 'matrix_missing_cells').filter((i) => i.params['matrix'] === 'priority')).toEqual([])
  })
})

describe('vocabulary labels precedence', () => {
  it('the tenant\'s own copy wins even when the shipped row comes after it', async () => {
    const full = JSON.stringify({ low: { it: 'Bassa', en: 'Low' } })
    h.enumRows = [
      { name: 'severity', owner: 'c-one', values: ['low'], labels: full },
      // The shipped copy has no labels: if it overwrote the tenant's, a warning would appear.
      { name: 'severity', owner: 'system', values: ['low', 'high'], labels: null },
    ]
    const issues = await fresh()
    const labelIssues = issues.filter((i) => i.kind.startsWith('values_') || i.kind.includes('label'))
    expect(labelIssues).toEqual([])

    // Control: the shipped copy alone IS reported, so the silence above comes from precedence.
    h.enumRows = [h.enumRows[1]!]
    expect(ofKind(await fresh(), 'value_labels_missing')).toHaveLength(1)
  })
})

describe('the per-tenant cache', () => {
  it('serves a tenant from cache until that tenant is invalidated, without touching the others', async () => {
    await configurationIssues('t1')
    await configurationIssues('t2')
    expect(h.schemaReads).toBe(2)

    await configurationIssues('t1')
    expect(h.schemaReads).toBe(2)

    invalidateConfigurationIssues('t1')
    await configurationIssues('t1')
    await configurationIssues('t2')
    // Only t1 was recomputed.
    expect(h.schemaReads).toBe(3)
  })
})
