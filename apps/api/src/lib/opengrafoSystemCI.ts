/**
 * OPENGRAFO IS A CI OF EVERY TENANT (26 Sep 2026, the owner).
 *
 * Trying the operational remedies on the demo tenant, a Problem opened on a
 * remedy that did not hold went into investigation with no CI and no team:
 * the rule «notify the owning team» found no one and failed. The owner:
 * «devi comunque creare un CI "Opengrafo"», a SYSTEM CI, of the type
 * `platform` (both chain families — «così si può usare per altri
 * componenti»), owned by «il team degli amministratori».
 *
 * So every tenant has:
 *  - the team «OpenGrafo Administrators», born with the tenant's users who
 *    have the admin role. After that it is the organization's team like any
 *    other: members change from its page; an admin appointed later is not
 *    added by itself;
 *  - the CI «OpenGrafo», of type Platform, owned by that team. The product
 *    finds it by `system_key`, never by name, and it cannot be deleted or
 *    renamed; its description, groups and relations are the organization's.
 *
 * Idempotent and additive: what exists is left as it is — a team whose
 * members someone changed, a CI whose Owner Group someone moved.
 */
import type { Queryable } from '@opengraphity/neo4j'
import { ValidationError } from './errors.js'
import { TEAM_TYPE_VOCABULARY } from './teamVocabularies.js'

/** The product's handles on the two nodes: stable, unlike the names an admin may change. */
export const OPENGRAFO_CI_KEY = 'opengrafo'
export const OPENGRAFO_ADMINS_TEAM_KEY = 'opengrafo_admins'

export const OPENGRAFO_CI_NAME = 'OpenGrafo'
export const OPENGRAFO_ADMINS_TEAM_NAME = 'OpenGrafo Administrators'
/** The CI type (`scope: base`, shipped by the metamodel seed and migration 20261012_1010). */
export const PLATFORM_LABEL = 'Platform'

/** The role whose users the team is born with. */
const ADMIN_ROLE = 'admin'
/** The team type the Owner Group of a CI has, if the tenant's vocabulary still has it. */
const OWNER_TEAM_TYPE = 'owner'

function num(v: unknown): number {
  return typeof v === 'object' && v !== null && 'toNumber' in v ? (v as { toNumber: () => number }).toNumber() : Number(v ?? 0)
}

export interface OpenGrafoSystemCIResult {
  teamCreated: boolean
  members:     number
  ciCreated:   boolean
}

/**
 * Creates the team and the CI where they are missing. The CI's status and
 * environment come from the tenant's Dictionary, as for any new CI; the chain
 * is Infrastructure — a Platform CI has both families and nothing above it
 * yet, which is what the chain calculator decides for such a CI.
 */
export async function ensureOpenGrafoSystemCI(session: Queryable, tenantId: string, now: string = new Date().toISOString()): Promise<OpenGrafoSystemCIResult> {
  const voc = await session.run(`
    MATCH (e:EnumTypeDefinition {name: 'ci_status'}) WHERE e.tenant_id IN [$tenantId, 'system']
    WITH e ORDER BY CASE WHEN e.tenant_id = $tenantId THEN 0 ELSE 1 END LIMIT 1
    WITH coalesce(e.default_value, e.values[0]) AS status
    OPTIONAL MATCH (a:EnumTypeDefinition {name: 'environment'}) WHERE a.tenant_id IN [$tenantId, 'system']
    WITH status, a ORDER BY CASE WHEN a.tenant_id = $tenantId THEN 0 ELSE 1 END LIMIT 1
    OPTIONAL MATCH (tt:EnumTypeDefinition {name: $teamTypeVocabulary}) WHERE tt.tenant_id IN [$tenantId, 'system']
    WITH status, a, tt ORDER BY CASE WHEN tt.tenant_id = $tenantId THEN 0 ELSE 1 END LIMIT 1
    RETURN status, a.default_value AS environment, $ownerType IN coalesce(tt.values, []) AS ownerTypeKnown
  `, { tenantId, teamTypeVocabulary: TEAM_TYPE_VOCABULARY, ownerType: OWNER_TEAM_TYPE })
  const status = voc.records[0]?.get('status') as string | null
  if (!status) {
    throw new Error(`The "ci_status" Dictionary of tenant ${tenantId} is empty: there is no status to create the OpenGrafo CI with. Add a value and run again.`)
  }
  const environment = (voc.records[0]?.get('environment') as string | null) ?? null
  const teamType = voc.records[0]?.get('ownerTypeKnown') === true ? OWNER_TEAM_TYPE : null

  const team = await session.run(`
    OPTIONAL MATCH (old:Team {tenant_id: $tenantId, system_key: $teamKey})
    WITH old IS NULL AS missing
    MERGE (t:Team {tenant_id: $tenantId, system_key: $teamKey})
      ON CREATE SET t.id = randomUUID(), t.name = $teamName, t.type = $teamType, t.sourcing = 'internal',
                    t.description = 'The administrators of OpenGrafo in this organization: they own the OpenGrafo CI and receive the problems of its remedies.',
                    t.is_system = true, t.created_at = $now, t.updated_at = $now
    RETURN t.id AS id, missing
  `, { tenantId, teamKey: OPENGRAFO_ADMINS_TEAM_KEY, teamName: OPENGRAFO_ADMINS_TEAM_NAME, teamType, now })
  const teamId = team.records[0]!.get('id') as string
  const teamCreated = team.records[0]!.get('missing') === true

  let members = 0
  if (teamCreated) {
    const m = await session.run(`
      MATCH (t:Team {tenant_id: $tenantId, id: $teamId})
      MATCH (u:User {tenant_id: $tenantId, role: $adminRole})
      MERGE (u)-[:MEMBER_OF]->(t)
      RETURN count(u) AS n
    `, { tenantId, teamId, adminRole: ADMIN_ROLE })
    members = num(m.records[0]?.get('n'))
  }

  const ci = await session.run(`
    OPTIONAL MATCH (old:ConfigurationItem {tenant_id: $tenantId, system_key: $ciKey})
    WITH old IS NULL AS missing
    MERGE (ci:ConfigurationItem {tenant_id: $tenantId, system_key: $ciKey})
      ON CREATE SET ci:Platform, ci.id = randomUUID(), ci.name = $ciName, ci.name_key = toLower($ciName),
                    ci.status = $status, ci.environment = $environment, ci.chain = 'Infrastructure',
                    ci.description = 'OpenGrafo itself: the product this organization runs its IT service management on. The problems of its remedies are opened on this CI.',
                    ci.is_system = true, ci.created_at = $now, ci.updated_at = $now
    WITH ci, missing
    MATCH (t:Team {tenant_id: $tenantId, system_key: $teamKey})
    FOREACH (_ IN CASE WHEN missing THEN [1] ELSE [] END | MERGE (ci)-[:OWNED_BY]->(t))
    RETURN missing
  `, { tenantId, ciKey: OPENGRAFO_CI_KEY, ciName: OPENGRAFO_CI_NAME, status, environment, teamKey: OPENGRAFO_ADMINS_TEAM_KEY, now })
  const ciCreated = ci.records[0]?.get('missing') === true

  return { teamCreated, members, ciCreated }
}

/** The OpenGrafo CI of a tenant and the team that owns it now (null: none). */
export async function openGrafoSystemCI(session: Queryable, tenantId: string): Promise<{ ciId: string; ownerTeamId: string | null; ownerMembers: number } | null> {
  const r = await session.run(`
    MATCH (ci:ConfigurationItem {tenant_id: $tenantId, system_key: $ciKey})
    OPTIONAL MATCH (ci)-[:OWNED_BY]->(t:Team {tenant_id: $tenantId})
    OPTIONAL MATCH (u:User {tenant_id: $tenantId})-[:MEMBER_OF]->(t)
    RETURN ci.id AS ciId, t.id AS teamId, count(u) AS members
    LIMIT 1
  `, { tenantId, ciKey: OPENGRAFO_CI_KEY })
  const rec = r.records[0]
  if (!rec) return null
  return { ciId: rec.get('ciId') as string, ownerTeamId: (rec.get('teamId') as string | null) ?? null, ownerMembers: num(rec.get('members')) }
}

/**
 * A system CI is the product's: it is not deleted, and its name is not
 * changed (the product finds it by key, but people and alarms by name).
 */
export function assertSystemCIChange(props: Record<string, unknown>, change: 'delete' | { name?: unknown }): void {
  if (props['is_system'] !== true) return
  if (change === 'delete') {
    throw new ValidationError(`CI "${String(props['name'])}" is a system CI: it cannot be deleted`, { key: 'errors.ci.systemCINotDeletable', params: { name: String(props['name']) } })
  }
  if (change.name !== undefined && change.name !== props['name']) {
    throw new ValidationError(`CI "${String(props['name'])}" is a system CI: it cannot be renamed`, { key: 'errors.ci.systemCINotRenamable', params: { name: String(props['name']) } })
  }
}
