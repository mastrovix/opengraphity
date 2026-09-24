/**
 * WRITING WHAT THE TICKETS STAND ON: PEOPLE, CONFIGURATION, CMDB (23 Sep 2026).
 *
 * Each block writes the nodes and edges the corresponding page of the app
 * writes, and the Audit Log entries it leaves (lib/audit.ts: `team.created`,
 * `ci.created`, `ci_relationship.added`, …), dated when the thing was done in
 * the simulated past and signed by the person who did it.
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'
import type { Rng } from './random.js'
import type { DemoClock } from './clock.js'
import type { DemoWriter } from './writer.js'
import type { PeoplePlan, PlannedTeam, PlannedUser } from './people.js'
import type { ConfigPlan, PlannedOla } from './config.js'
import type { CMDBPlan } from './cmdb.js'

export type AuditRow = {
  id: string
  user_id: string
  user_email: string
  action: string
  entity_type: string
  entity_id: string
  details: string | null
  ip_address: null
  created_at: string
}

/** An Audit Log entry exactly as `audit()` writes it (ip_address is null outside a request). */
export function auditRow(
  rng: Rng, actor: Pick<PlannedUser, 'id' | 'email'>, action: string, entityType: string, entityId: string,
  atMs: number, details?: Record<string, unknown>,
): AuditRow {
  return {
    id: rng.uuid(), user_id: actor.id, user_email: actor.email, action, entity_type: entityType, entity_id: entityId,
    details: details ? JSON.stringify(details) : null, ip_address: null, created_at: new Date(atMs).toISOString(),
  }
}

export async function writePeople(w: DemoWriter, rng: Rng, clock: DemoClock, people: PeoplePlan, admin: PlannedUser): Promise<void> {
  await w.nodes(['User'], people.users.map((u) => ({
    id: u.id, email: u.email, name: u.name, role: u.role, active: true,
    created_at: clock.iso(u.createdAtMs), updated_at: clock.iso(u.createdAtMs),
  })))
  await w.nodes(['Team'], people.teams.map((t) => ({
    id: t.id, name: t.name, description: t.description, type: t.type, sourcing: t.sourcing,
    created_at: clock.iso(t.createdAtMs), updated_at: clock.iso(t.createdAtMs),
    ...(t.isChangeManager ? { is_change_manager: true } : {}),
  })))
  await w.relationships('Team', 'MANAGED_BY', 'User', people.teams.map((t) => ({ from: t.id, to: t.managerId })))
  await w.relationships('User', 'MEMBER_OF', 'Team', people.teams.flatMap((t) => t.memberIds.map((m) => ({ from: m, to: t.id }))))

  const audits: AuditRow[] = []
  for (const t of people.teams) {
    audits.push(auditRow(rng, admin, 'team.created', 'Team', t.id, t.createdAtMs))
    audits.push(auditRow(rng, admin, 'team.manager_set', 'Team', t.id, t.createdAtMs + 60_000))
    t.memberIds.forEach((_member, i) => {
      audits.push(auditRow(rng, admin, 'team.member_added', 'Team', t.id, t.createdAtMs + 120_000 + i * 1000))
    })
    if (t.isChangeManager) audits.push(auditRow(rng, admin, 'team.change_manager_set', 'Team', t.id, t.createdAtMs + 300_000))
  }
  await w.nodes(['AuditEntry'], audits)
}

/**
 * THE PERSON WHO GIVES THE DEMO WORKS IN IT (tour of 23 Sep 2026, D72).
 *
 * The administrators of the tenant — the accounts that exist before the
 * generator, the ones people log in with — belonged to no team: «My tasks»
 * was empty and the Knowledge Base showed nothing of theirs. They join the
 * support team and the owner team with the most CIs (the ones that receive
 * the most assessment and review tasks) and the Change Management Office
 * (the approvals). The edges hang off demo teams, so the clean-up removes them
 * with the teams; the accounts themselves are never touched.
 */
export async function enrolTenantAdmins(
  w: DemoWriter, session: Session, rng: Rng, people: PeoplePlan, cmdb: CMDBPlan, admin: PlannedUser,
): Promise<number> {
  const admins = await runQuery<{ id: string }>(session, `
    MATCH (u:User {tenant_id: $tenantId})
    WHERE u.demo_run_id IS NULL AND u.role = 'admin'
    RETURN u.id AS id ORDER BY u.id`, { tenantId: w.tenantId })
  if (!admins.length) return 0
  const cisOf = new Map<string, number>()
  for (const c of cmdb.cis) {
    for (const t of [c.ownerTeamId, c.supportTeamId]) if (t) cisOf.set(t, (cisOf.get(t) ?? 0) + 1)
  }
  const busiest = (type: PlannedTeam['type']): PlannedTeam => [...people.teams]
    .filter((t) => t.type === type && !t.isChangeManager)
    .sort((a, b) => (cisOf.get(b.id) ?? 0) - (cisOf.get(a.id) ?? 0) || a.name.localeCompare(b.name))[0]!
  const teams = [busiest('support'), busiest('owner'), people.changeManagerTeam]
  await w.relationships('User', 'MEMBER_OF', 'Team', admins.flatMap((a) => teams.map((t) => ({ from: a.id, to: t.id }))))
  await w.nodes(['AuditEntry'], admins.flatMap(() => teams.map((t, i) =>
    // What `setTeamMember` audits (resolvers/team.ts): the team, no details.
    auditRow(rng, admin, 'team.member_added', 'Team', t.id, t.createdAtMs + 600_000 + i * 1000))))
  return admins.length
}

export async function writeConfig(w: DemoWriter, rng: Rng, clock: DemoClock, config: ConfigPlan, admin: PlannedUser, ciTypeIds: readonly string[]): Promise<void> {
  const calAt = clock.startMs + 60 * 60_000
  await w.nodes(['ServiceCalendar'], config.calendars.map((cal, i) => ({
    id: cal.id, name: cal.name, name_key: cal.name.toLowerCase(), days: cal.days, start: cal.start, end: cal.end,
    holidays: cal.holidays, created_at: clock.iso(calAt + i * 60_000), updated_at: clock.iso(calAt + i * 60_000),
  })))
  await w.nodes(['SLAPolicyNode'], config.slaPolicies.map((p) => ({
    id: p.id, name: p.name, entity_type: p.entityType, priority: p.priority, category: p.category, team_id: p.teamId,
    // null: the policy follows the tenant's timezone (the app writes null when none is chosen).
    timezone: p.timezone,
    response_minutes: p.responseMinutes, resolve_minutes: p.resolveMinutes,
    business_hours: p.calendarId !== null, calendar_id: p.calendarId, warning_minutes: p.warningMinutes, enabled: true,
    compliance_target: p.complianceTarget, compliance_warning: p.complianceWarning,
    created_at: clock.iso(p.createdAtMs), updated_at: clock.iso(p.createdAtMs),
  })))
  // Assessment questions, "core": linked to every active CI type with their weight.
  await w.nodes(['AssessmentQuestion'], config.questions.map((q) => ({
    id: q.id, text: q.text, category: q.category, is_core: true, is_active: true, created_at: clock.iso(clock.startMs + 2 * 60 * 60_000),
  })))
  await w.children('AssessmentQuestion', 'HAS_OPTION', ['AnswerOption'], config.questions.flatMap((q) => q.options.map((o) => ({
    parent: q.id, props: { id: o.id, label: o.label, score: o.score, sort_order: o.sortOrder },
  }))))
  await writeQuestionLinks(w, config, ciTypeIds)

  await w.nodes(['AuditEntry'], config.calendars.map((cal, i) =>
    auditRow(rng, admin, 'service_calendar.created', 'ServiceCalendar', cal.id, calAt + i * 60_000, { name: cal.name })))
}

/**
 * The OLA and UC contracts. Written after the tickets (olaPlan.ts chooses
 * them on the simulated work), dated at the start like the rest of the
 * configuration.
 *
 * Written SWITCHED OFF, and switched on at the end of the run (review of 23
 * Sep 2026): the OLA sweep of the running workers reads every enabled
 * contract each minute, and in the minutes between here and the marking of
 * the past alerts (afterRun.ts) it found every open ticket past its target and
 * sent the burst of alerts the marking exists to prevent.
 */
export async function writeOlaContracts(w: DemoWriter, rng: Rng, clock: DemoClock, olas: readonly PlannedOla[], admin: PlannedUser): Promise<void> {
  await w.nodes(['OLAContract'], olas.map((o) => ({
    id: o.id, type: o.type, name: o.name, description: o.description, entity_type: o.entityType,
    response_minutes: o.responseMinutes, resolve_minutes: o.resolveMinutes,
    business_hours: o.calendarId !== null, calendar_id: o.calendarId, timezone: o.timezone, party_type: o.partyType, party_name: null,
    compliance_target: o.complianceTarget, compliance_warning: o.complianceWarning,
    team_id: o.teamId, enabled: false, created_at: clock.iso(o.createdAtMs),
  })))
  await w.nodes(['AuditEntry'], olas.map((o) => auditRow(rng, admin, 'ola_contract.created', 'OLAContract', o.id, o.createdAtMs)))
}

/**
 * HAS_QUESTION from the CI types. The types are shared (`tenant_id: 'system'`),
 * so they cannot be matched by the demo tenant's id like everything else.
 */
async function writeQuestionLinks(w: DemoWriter, config: ConfigPlan, ciTypeIds: readonly string[]): Promise<void> {
  await w.questionLinks(config.questions.map((q) => ({ questionId: q.id, weight: q.weight, sortOrder: q.sortOrder })), ciTypeIds)
}

export async function writeCMDB(w: DemoWriter, rng: Rng, clock: DemoClock, cmdb: CMDBPlan, people: PeoplePlan): Promise<void> {
  const teamById = new Map(people.teams.map((t) => [t.id, t]))
  const userById = new Map(people.users.map((u) => [u.id, u]))
  for (const label of ['BusinessApplication', 'BusinessCapability', 'Server', 'DatabaseInstance', 'Application', 'Database', 'Certificate'] as const) {
    await w.nodes(['ConfigurationItem', label], cmdb.byLabel[label].map((c) => ({
      id: c.id, name: c.name, name_key: c.name.trim().toLowerCase(), status: c.status, environment: c.environment,
      description: c.description, notes: null,
      created_at: clock.iso(c.createdAtMs), updated_at: clock.iso(c.updatedAtMs),
      // The infrastructure flag of every CI (owner, 24 Sep 2026).
      is_infrastructure: c.isInfrastructure === true,
      ...c.fields,
    })))
  }
  const owned = cmdb.cis.filter((c) => c.ownerTeamId).map((c) => ({ from: c.id, to: c.ownerTeamId! }))
  const supported = cmdb.cis.filter((c) => c.supportTeamId).map((c) => ({ from: c.id, to: c.supportTeamId! }))
  await w.relationships('ConfigurationItem', 'OWNED_BY', 'Team', owned)
  await w.relationships('ConfigurationItem', 'SUPPORTED_BY', 'Team', supported)
  const byType = new Map<string, Array<{ from: string; to: string }>>()
  for (const r of cmdb.relations) {
    const list = byType.get(r.type) ?? []
    list.push({ from: r.fromId, to: r.toId })
    byType.set(r.type, list)
  }
  for (const [type, rows] of byType) await w.relationships('ConfigurationItem', type, 'ConfigurationItem', rows)

  // Who registered each CI: a member of its support team (or owner team), at its creation.
  const registrar = (teamId: string | null): PlannedUser => {
    const team = teamId ? teamById.get(teamId) : undefined
    return userById.get(team ? rng.pick(team.memberIds) : rng.pick(people.teams).managerId)!
  }
  const audits: AuditRow[] = []
  const actorOf = new Map<string, PlannedUser>()
  for (const c of cmdb.cis) {
    const actor = registrar(c.supportTeamId ?? c.ownerTeamId)
    actorOf.set(c.id, actor)
    audits.push(auditRow(rng, actor, 'ci.created', 'ConfigurationItem', c.id, c.createdAtMs))
  }
  for (const r of cmdb.relations) {
    const from = cmdb.byId.get(r.fromId)!
    const to = cmdb.byId.get(r.toId)!
    const at = Math.max(from.createdAtMs, to.createdAtMs) + 5 * 60_000
    audits.push(auditRow(rng, actorOf.get(from.id)!, 'ci_relationship.added', 'CIRelationship', r.fromId, Math.min(at, clock.nowMs),
      { targetId: r.toId, relationType: r.type }))
  }
  await w.nodes(['AuditEntry'], audits)
}
