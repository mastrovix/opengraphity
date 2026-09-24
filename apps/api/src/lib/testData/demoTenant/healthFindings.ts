/**
 * CMDB HEALTH, FED ON PURPOSE (owner, 24 Sep 2026): «alcuni CI devono fare
 * in modo di alimentare la CMDB Health, non più di 50 tra tutte le
 * casistiche».
 *
 * The plan is otherwise clean: with the starting chains (migrations 1080, 1090)
 * every check of CMDB Health reads zero on it. Here a few CIs get one defect
 * each, as it happens in a real CMDB — a backup server nobody flagged, a
 * database whose instance was lost, a relation someone drew by hand that no
 * chain admits, a server without an owner, a certificate installed nowhere,
 * an application with nothing below it, a certificate past its date still in
 * use, a server registered twice, a certificate with no serial. How many of
 * each is the owner's choice (`DEMO_RATIOS.healthFindings`); what each card
 * then reads is `expectedHealthCards`, and verify.ts checks the real cards
 * against it.
 *
 * Each planted CI is marked (`healthFinding`) so that no ticket picks it
 * (World.runningCI): its defect stays the only story it tells. Each is chosen
 * so that it breaks nothing else — a server left unflagged carries no
 * certificate, the application emptied of CIs shares its servers and its
 * databases with others — and when there are not enough candidates the plan
 * stops and says so, rather than planting fewer than asked.
 */
import type { Rng } from './random.js'
import type { DemoClock } from './clock.js'
import { DAY } from './clock.js'
import type { CMDBPlan, PlannedCI, PlannedCIRelation } from './cmdb.js'
import { SERVER_ROLE_MIX } from './names.js'
import { DEMO_RATIOS } from './options.js'

export type HealthFindingCounts = { readonly [K in keyof typeof DEMO_RATIOS.healthFindings]: number }

/** What each card of CMDB Health reads when these are planted and nothing else is wrong. */
export function expectedHealthCards(f: HealthFindingCounts): Record<string, number> {
  return {
    // A certificate with no relation is also outside every chain.
    chain_orphan: f.unflaggedInfrastructure + f.unrelatedCertificates,
    // An application with no CI below it also lacks the server its chain requires.
    chain_incomplete: f.databasesWithoutInstance + f.applicationsWithoutCis,
    relation_not_admitted: f.relationsNotAdmitted,
    missing_owner_group: f.withoutOwner,
    missing_support_group: f.withoutSupport,
    certificate_unrelated: f.unrelatedCertificates,
    application_without_cis: f.applicationsWithoutCis,
    certificate_expired_in_use: f.expiredInUse,
    // Both CIs of a pair are listed.
    duplicate_name: f.duplicatePairs * 2,
    required_field_empty: f.requiredFieldEmpty,
  }
}

const running = (ci: PlannedCI): boolean => ci.status === 'active' || ci.status === 'maintenance'
const groupOf = (s: PlannedCI): string | undefined => SERVER_ROLE_MIX.find(([role]) => role === s.role)?.[2]

class Planter {
  private readonly taken = new Set<string>()

  constructor(private readonly rng: Rng, readonly plan: CMDBPlan) {}

  from(ci: PlannedCI): PlannedCIRelation[] { return this.plan.relations.filter((r) => r.fromId === ci.id) }
  to(ci: PlannedCI): PlannedCIRelation[] { return this.plan.relations.filter((r) => r.toId === ci.id) }

  /** `n` CIs of the pool not planted yet, or a refusal that names what was missing. */
  pick(pool: readonly PlannedCI[], n: number, what: string): PlannedCI[] {
    const free = this.rng.shuffle(pool.filter((c) => !this.taken.has(c.id))).slice(0, n)
    if (free.length < n) throw new Error(`healthFindings: ${String(n)} ${what} asked, ${String(free.length)} can be planted`)
    return free
  }

  mark(ci: PlannedCI, check: string): void {
    ci.healthFinding = check
    this.taken.add(ci.id)
  }

  /** Taken without being marked: the other end of a planted defect, which tickets may still use. */
  hold(ci: PlannedCI): void { this.taken.add(ci.id) }

  drop(match: (r: PlannedCIRelation) => boolean): void {
    const keep = this.plan.relations.filter((r) => !match(r))
    this.plan.relations.length = 0
    this.plan.relations.push(...keep)
  }
}

/** A backup, monitoring, jump or directory server nobody flagged as infrastructure: outside every chain. */
function unflaggedInfrastructure(p: Planter, n: number): void {
  const pool = p.plan.byLabel.Server.filter((s) => s.isInfrastructure && running(s) && !p.to(s).length)
  for (const s of p.pick(pool, n, 'infrastructure servers with no certificate')) {
    s.isInfrastructure = false
    p.mark(s, 'chain_orphan')
  }
}

/** A database whose link to its instance was lost; the instance keeps another database in service. */
function databasesWithoutInstance(p: Planter, n: number): void {
  const liveOn = new Map<string, number>()
  for (const db of p.plan.byLabel.Database) {
    const inst = p.plan.databaseInstance.get(db.id)
    if (inst && running(db)) liveOn.set(inst, (liveOn.get(inst) ?? 0) + 1)
  }
  // At most one per instance, so the instance keeps a database in service.
  const perInstance = new Map<string, PlannedCI>()
  for (const db of p.plan.byLabel.Database) {
    const inst = p.plan.databaseInstance.get(db.id)
    if (inst && running(db) && (liveOn.get(inst) ?? 0) >= 2 && !perInstance.has(inst)) perInstance.set(inst, db)
  }
  for (const db of p.pick([...perInstance.values()], n, 'databases sharing their instance')) {
    const inst = p.plan.databaseInstance.get(db.id)!
    p.drop((r) => r.fromId === db.id && r.type === 'DEPENDS_ON' && r.toId === inst)
    p.plan.databaseInstance.delete(db.id)
    p.mark(db, 'chain_incomplete')
  }
}

/** A database using a certificate: the metamodel allows it, no chain admits it. */
function relationsNotAdmitted(p: Planter, n: number): void {
  const certs = p.plan.byLabel.Certificate.filter((c) => c.status === 'active' && !c.isInfrastructure && !p.to(c).length && p.from(c).length === 1)
  const dbs = p.pick(p.plan.byLabel.Database.filter((d) => running(d) && p.plan.databaseInstance.has(d.id)), n, 'databases in service')
  const chosen = p.pick(certs, n, 'certificates installed on one CI')
  dbs.forEach((db, i) => {
    p.plan.relations.push({ fromId: db.id, type: 'USES_CERTIFICATE', toId: chosen[i]!.id })
    p.mark(db, 'relation_not_admitted')
    p.hold(chosen[i]!)
  })
}

function withoutGroup(p: Planter, n: number, group: 'ownerTeamId' | 'supportTeamId', check: string): void {
  const pool = p.plan.byLabel.Server.filter((s) => running(s) && groupOf(s) === 'app')
  for (const s of p.pick(pool, n, 'application servers in service')) {
    s[group] = null
    p.mark(s, check)
  }
}

/** A certificate whose one installation was lost: related to nothing, so also outside every chain. */
function unrelatedCertificates(p: Planter, n: number): void {
  const pool = p.plan.byLabel.Certificate.filter((c) => c.status === 'active' && !c.isInfrastructure && !p.to(c).length && p.from(c).length === 1)
  for (const c of p.pick(pool, n, 'certificates installed on one CI')) {
    p.drop((r) => r.fromId === c.id)
    p.mark(c, 'certificate_unrelated')
  }
}

/**
 * An application with nothing below it: no server, no database, no
 * certificate. Chosen outside production (no service map walks it) among
 * those whose servers and databases other applications also use, and whose
 * business applications have another application on a server — so nothing
 * else is left without a chain, and nothing else follows none.
 */
function applicationsWithoutCis(p: Planter, n: number): void {
  const users = new Map<string, number>()
  for (const r of p.plan.relations) if (r.type === 'HOSTED_ON' || (r.type === 'DEPENDS_ON' && p.plan.byId.get(r.toId)?.label === 'Database')) users.set(r.toId, (users.get(r.toId) ?? 0) + 1)
  // A business application follows its chain whole through another application in service on a server in service.
  const onServer = (app: PlannedCI): boolean => running(app) && p.from(app).some((r) => r.type === 'HOSTED_ON' && running(p.plan.byId.get(r.toId)!))
  const othersHold = (a: PlannedCI): boolean => p.to(a).filter((r) => r.type === 'REALIZES').every((r) =>
    p.plan.relations.some((x) => x.type === 'REALIZES' && x.fromId === r.fromId && x.toId !== a.id && onServer(p.plan.byId.get(x.toId)!)))
  const pool = p.plan.byLabel.Application.filter((a) => running(a) && a.environment !== 'production'
    && p.from(a).every((r) => r.type !== 'USES_CERTIFICATE' && (users.get(r.toId) ?? 0) >= 2)
    && !p.to(a).some((r) => r.type === 'DEPENDS_ON') && othersHold(a))
  for (const a of p.pick(pool, n, 'applications sharing all they stand on')) {
    p.drop((r) => r.fromId === a.id)
    p.plan.appServers.set(a.id, [])
    p.plan.appDatabases.delete(a.id)
    p.mark(a, 'application_without_cis')
  }
}

/** A certificate an application in service uses, past its date and still marked active. */
function expiredInUse(p: Planter, n: number, clock: DemoClock, rng: Rng): void {
  const used = new Set(p.plan.relations.filter((r) => r.type === 'USES_CERTIFICATE' && running(p.plan.byId.get(r.fromId)!)).map((r) => r.toId))
  // Issued over 90 days ago: the planted expiry, 3 to 60 days ago, comes after the issue.
  const pool = p.plan.byLabel.Certificate.filter((c) => c.status === 'active' && used.has(c.id) && c.createdAtMs < clock.nowMs - 90 * DAY)
  for (const c of p.pick(pool, n, 'certificates in use, issued over 90 days ago')) {
    c.fields['expires_at'] = new Date(clock.nowMs - rng.int(3, 60) * DAY).toISOString()
    p.mark(c, 'certificate_expired_in_use')
  }
}

/** A server registered twice: the second record takes the first one's name. */
function duplicatePairs(p: Planter, n: number): void {
  const pool = p.plan.byLabel.Server.filter((s) => running(s) && groupOf(s) === 'app')
  const both = p.pick(pool, n * 2, 'application servers in service')
  for (let i = 0; i < n; i++) {
    const [first, second] = [both[2 * i]!, both[2 * i + 1]!]
    if (second.description.startsWith(`${second.name}`)) second.description = `${first.name}${second.description.slice(second.name.length)}`
    second.name = first.name
    p.hold(first)
    p.mark(second, 'duplicate_name')
  }
}

/** A certificate without its serial number, a field its type requires. */
function requiredFieldEmpty(p: Planter, n: number): void {
  const pool = p.plan.byLabel.Certificate.filter((c) => c.status === 'active' && !c.isInfrastructure)
  for (const c of p.pick(pool, n, 'active certificates')) {
    delete c.fields['serial_number']
    p.mark(c, 'required_field_empty')
  }
}

/** Plants the defects in the plan, in place. */
export function plantHealthFindings(rng: Rng, clock: DemoClock, plan: CMDBPlan, f: HealthFindingCounts = DEMO_RATIOS.healthFindings): void {
  const p = new Planter(rng, plan)
  unflaggedInfrastructure(p, f.unflaggedInfrastructure)
  databasesWithoutInstance(p, f.databasesWithoutInstance)
  relationsNotAdmitted(p, f.relationsNotAdmitted)
  withoutGroup(p, f.withoutOwner, 'ownerTeamId', 'missing_owner_group')
  withoutGroup(p, f.withoutSupport, 'supportTeamId', 'missing_support_group')
  unrelatedCertificates(p, f.unrelatedCertificates)
  applicationsWithoutCis(p, f.applicationsWithoutCis)
  expiredInUse(p, f.expiredInUse, clock, rng)
  duplicatePairs(p, f.duplicatePairs)
  requiredFieldEmpty(p, f.requiredFieldEmpty)
}
