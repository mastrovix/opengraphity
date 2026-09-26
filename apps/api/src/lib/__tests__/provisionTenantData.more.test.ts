/**
 * The final self-check of tenant provisioning: fail only for what it could fix.
 *
 * Why it matters: provisioning is not atomic, so after seeding it re-reads the
 * tenant. A gap provisioning itself should have closed (no dashboard, no
 * workflow) means an interrupted run: the caller must hear it, with the list,
 * or the tenant looks created and the first `createIncident` dies. But the
 * gaps only a person can close (teams, change manager, assessment questions)
 * must NOT fail it — an error that always appears and cannot be fixed by
 * running again teaches everyone to ignore errors. Those come back as
 * `gapsLeft` for the admin banner.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@opengraphity/workflow', () => ({
  seedWorkflowForTenant:        vi.fn(async () => 'def-inc'),
  seedProblemWorkflowForTenant: vi.fn(async () => 'def-prb'),
  seedKBWorkflowForTenant:      vi.fn(async () => 'def-kb'),
  seedWorkflowDefinition:       vi.fn(async () => ({ created: false, definitionId: 'def-x' })),
}))
vi.mock('../seedNotificationRules.js', () => ({ seedNotificationRules: vi.fn(async () => ({ created: 0, skipped: 35 })) }))
vi.mock('../roles.js', () => ({ seedFactoryRoles: vi.fn(async () => []) }))
vi.mock('../domainMatrixSeed.js', () => ({ seedDomainMatrices: vi.fn(async () => []) }))
vi.mock('../portalSeverityOptions.js', () => ({ seedPortalSeverityOptions: vi.fn(async () => ({ seeded: null })) }))
// The OpenGrafo CI (26 Sep 2026) has its own tests (opengrafoSystemCI.test.ts): here it is there, owned by someone.
const sistema = vi.hoisted(() => ({ ci: { ciId: 'ci-og', ownerTeamId: 't-adm', ownerMembers: 1 } as { ciId: string; ownerTeamId: string | null; ownerMembers: number } | null }))
vi.mock('../opengrafoSystemCI.js', () => ({
  ensureOpenGrafoSystemCI: vi.fn(async () => ({ teamCreated: false, members: 0, ciCreated: false })),
  openGrafoSystemCI: vi.fn(async () => sistema.ci),
}))
vi.mock('../tenantLanguage.js', () => ({ seedDefaultLanguage: vi.fn(async () => ({ seeded: null })) }))

const { provisionTenantData } = await import('../provisionTenantData.js')

const COMPLETE: Record<string, unknown> = {
  roleKeys:       ['admin', 'operator', 'viewer', 'end_user'],
  userRoles:      ['admin'],
  dashboards:     1,
  rules:          35,
  matrices:       2,
  questions:      4,
  teams:          2,
  changeManagers: 1,
  entityTypes:    ['incident', 'problem', 'kb_article', 'change', 'service_request'],
}

/** A session whose dashboard MERGE returns nothing and whose gap read returns `tenant`. */
function session(tenant: Record<string, unknown>) {
  return {
    run: vi.fn(async (cypher: string) => cypher.includes('collect(ro.key) AS roleKeys')
      ? { records: [{ get: (k: string) => tenant[k] }] }
      : { records: [] }),
  }
}

describe('provisionTenantData — the closing self-check', () => {
  it('fails, listing every gap it should have closed, and says running again completes it', async () => {
    const s = session({ ...COMPLETE, dashboards: 0, entityTypes: ['incident'], teams: 0 })
    const err = await provisionTenantData(s as never, 'half').catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('Tenant half provisioned only in part: no dashboard; no active workflow for: problem, kb_article, change, service_request.')
    expect(err.message).toContain('run it again to complete it')
    // A person's gap is not part of the failure: re-running cannot create teams.
    expect(err.message).not.toContain('no teams')
  })

  it('succeeds with only person-owned gaps, and returns them as gapsLeft', async () => {
    const s = session({ ...COMPLETE, teams: 0, questions: 0 })
    const out = await provisionTenantData(s as never, 'fresh')
    expect(out.gapsLeft).toEqual([{ kind: 'no_assessment_questions' }, { kind: 'no_teams' }])
    // No dashboard row came back from the MERGE: reported as "not created now", not guessed.
    expect(out.dashboardCreated).toBe(false)
    expect(out.workflows.slice(3)).toEqual([
      { name: 'Change RFC Process', created: false },
      { name: 'Service Request Fulfillment', created: false },
    ])
  })

  it('reports a missing change manager as a person-owned gap when teams exist', async () => {
    const out = await provisionTenantData(session({ ...COMPLETE, changeManagers: 0 }) as never, 'no-cm')
    expect(out.gapsLeft).toEqual([{ kind: 'no_change_manager' }])
  })
})
