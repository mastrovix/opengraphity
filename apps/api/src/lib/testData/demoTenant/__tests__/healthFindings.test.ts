/**
 * CMDB HEALTH, FED ON PURPOSE (owner, 24 Sep 2026): «alcuni CI devono fare in
 * modo di alimentare la CMDB Health, non più di 50 tra tutte le casistiche».
 *
 * What these pin:
 *  - with the starting chains (migrations 1080 and 1090) the plan is clean: every card
 *    of CMDB Health reads zero on it;
 *  - planted, each card reads exactly what `expectedHealthCards` says, and
 *    all of them together no more than 50;
 *  - each defect has its shape and breaks nothing else, each planted CI is
 *    marked once and no ticket picks it;
 *  - with too few candidates the plan stops and says which, rather than
 *    planting fewer than asked;
 *  - how many is the tenant's size: the full demo plants the owner's numbers,
 *    a smaller one in proportion and at least one per check, and the two
 *    integration tenants take theirs (the CI of 24 Sep 2026 stopped there).
 * «Outside every chain» and «incomplete» come from the product's own walk of
 * the chains (cmdbChains/evaluate.ts), run over the plan; the other cards are
 * computed here as services/cmdbHealth.ts computes them.
 */
import { describe, it, expect } from 'vitest'
import { Rng } from '../random.js'
import { DemoClock, DAY } from '../clock.js'
import { DEFAULT_DEMO_COUNTS, DEMO_RATIOS, scaledDemoCounts } from '../options.js'
import { planPeople } from '../people.js'
import { planCMDB, type CMDBPlan, type PlannedCI, type PlannedCIRelation } from '../cmdb.js'
import { expectedHealthCards, healthFindingsFor, plantHealthFindings } from '../healthFindings.js'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import { STARTING_CHAINS as CMDB_STARTING_CHAINS } from '../../../cmdbStartingChains.js'
import { evaluateChains } from '../../../../services/cmdbChains/evaluate.js'
import { admittedRelationKeys, type CmdbChain } from '../../../../services/cmdbChains/model.js'
import { NOW, SMALL, smallWorld } from './fixtures.js'
import { INTEGRATION_SCALE, TENANT_A, TENANT_B } from '../../../../__integration__/tenants.js'
import { planChangeSkeletons } from '../changes.js'
import { planIncidentSkeletons } from '../incidents.js'

const LABEL: Record<string, string> = {
  application: 'Application', business_application: 'BusinessApplication', business_capability: 'BusinessCapability', server: 'Server',
  database: 'Database', database_instance: 'DatabaseInstance', certificate: 'Certificate', dynamic_ci_group: 'DynamicCIGroup',
}
const RETIRED = new Set(['inactive', 'decommissioned', 'expired', 'revoked'])
const live = (ci: PlannedCI): boolean => !RETIRED.has(ci.status)

/**
 * A session over the plan: it answers the three queries of the walk of the
 * chains (cmdbChains/evaluate.ts) from the plan's CIs and relations, so the
 * product's own rule decides «outside every chain» and «incomplete».
 */
function planSession(plan: CMDBPlan) {
  const from = new Map<string, PlannedCIRelation[]>()
  const to = new Map<string, PlannedCIRelation[]>()
  for (const r of plan.relations) {
    from.set(r.fromId, [...(from.get(r.fromId) ?? []), r])
    to.set(r.toId, [...(to.get(r.toId) ?? []), r])
  }
  const record = (o: Record<string, unknown>) => ({ keys: Object.keys(o), get: (k: string) => o[k] })
  return {
    run: async (cypher: string, p: Record<string, unknown>) => {
      const retired = p['retired'] as string[]
      const rows: Array<Record<string, unknown>> = []
      if (cypher.includes('UNWIND $ids')) {
        const outgoing = cypher.includes(')-[r]->(c')
        for (const pid of p['ids'] as string[]) {
          for (const r of (outgoing ? from.get(pid) : to.get(pid)) ?? []) {
            const child = plan.byId.get(outgoing ? r.toId : r.fromId)!
            if (r.type === p['relationType'] && child.label === p['label']) rows.push({ parent: pid, child: child.id, inService: !retired.includes(child.status) })
          }
        }
      } else {
        for (const c of plan.cis) if (c.label === p['label']) rows.push({ id: c.id, inService: !retired.includes(c.status) })
      }
      return { records: rows.map(record) }
    },
  }
}

const CHAINS: CmdbChain[] = CMDB_STARTING_CHAINS.map((c) => ({ id: c.name, name: c.name, kind: c.kind as CmdbChain['kind'], nodes: c.nodes, createdAt: null, updatedAt: null }))
const TYPES = Object.entries(LABEL).map(([name, neo4jLabel]) => ({ name, neo4jLabel })) as unknown as CITypeWithDefinitions[]

/** The cards of CMDB Health over a plan, with the starting chains. */
async function cardsOf(plan: CMDBPlan): Promise<Record<string, number>> {
  const out = (id: string) => plan.relations.filter((r) => r.fromId === id)
  const inn = (id: string) => plan.relations.filter((r) => r.toId === id)
  const walk = await evaluateChains(planSession(plan) as never, 't', CHAINS, TYPES, [...RETIRED])
  const admitted = admittedRelationKeys(CHAINS, TYPES)
  const drawn = new Set(walk.drawnLabels)
  const inService = plan.cis.filter(live)
  const names = new Map<string, number>()
  for (const c of inService) names.set(`${c.label}|${c.name.trim().toLowerCase()}`, (names.get(`${c.label}|${c.name.trim().toLowerCase()}`) ?? 0) + 1)
  const neighbours = (id: string) => [...out(id).map((r) => r.toId), ...inn(id).map((r) => r.fromId)]
  return {
    chain_orphan: inService.filter((c) => drawn.has(c.label) && !c.isInfrastructure && !walk.reached.has(c.id)).length,
    chain_incomplete: walk.incomplete.size,
    relation_not_admitted: plan.relations.filter((r) => live(plan.byId.get(r.fromId)!) && live(plan.byId.get(r.toId)!)
      && !admitted.has(`${plan.byId.get(r.fromId)!.label}|${r.type}|${plan.byId.get(r.toId)!.label}`)).length,
    missing_owner_group: inService.filter((c) => !c.ownerTeamId).length,
    missing_support_group: inService.filter((c) => c.label !== 'BusinessCapability' && !c.supportTeamId).length,
    certificate_unrelated: inService.filter((c) => c.label === 'Certificate' && !neighbours(c.id).length).length,
    application_without_cis: inService.filter((c) => ['Application', 'BusinessApplication', 'BusinessCapability'].includes(c.label) && !out(c.id).length).length,
    certificate_expired_in_use: plan.byLabel.Certificate.filter((c) => Date.parse(c.fields['expires_at']!) < NOW && neighbours(c.id).some((o) => live(plan.byId.get(o)!))).length,
    duplicate_name: [...names.values()].filter((k) => k > 1).reduce((a, k) => a + k, 0),
    required_field_empty: inService.filter((c) => c.label === 'Certificate' && ['serial_number', 'expires_at', 'certificate_type'].some((f) => !c.fields[f])).length,
  }
}

const clock = new DemoClock(NOW, 3, 'Europe/Rome')
const planned = (seed: string): CMDBPlan => {
  const rng = new Rng(seed)
  return planCMDB(rng.fork('cmdb'), clock, SMALL, planPeople(rng.fork('people'), clock, SMALL))
}
const zeros = Object.fromEntries(Object.keys(expectedHealthCards(DEMO_RATIOS.healthFindings)).map((k) => [k, 0]))

describe('the plan with the starting chains', () => {
  it('is clean: every card of CMDB Health reads zero on it, on more than one seed', async () => {
    for (const seed of ['health-a', 'health-b', 'health-c']) expect(await cardsOf(planned(seed)), seed).toEqual(zeros)
  })
})

describe('planted', () => {
  const plan = planned('health-a')
  plantHealthFindings(new Rng('health-a').fork('health-findings'), clock, plan)
  const f = DEMO_RATIOS.healthFindings
  const marked = (check: string) => plan.cis.filter((c) => c.healthFinding === check)

  it('each card reads exactly what was planted, and all of them together no more than 50', async () => {
    const expected = expectedHealthCards(f)
    expect(await cardsOf(plan)).toEqual(expected)
    expect(Object.values(expected).reduce((a, n) => a + n, 0)).toBeLessThanOrEqual(50)
  })

  it('each defect has its shape', () => {
    for (const s of marked('chain_orphan')) expect([s.label, s.isInfrastructure, s.role && ['mon', 'bkp', 'ad', 'jmp'].includes(s.role)]).toEqual(['Server', false, true])
    for (const db of marked('chain_incomplete')) {
      expect(db.label).toBe('Database')
      expect(plan.databaseInstance.has(db.id)).toBe(false)
      expect(plan.relations.some((r) => r.fromId === db.id && plan.byId.get(r.toId)!.label === 'DatabaseInstance')).toBe(false)
    }
    for (const db of marked('relation_not_admitted')) expect(plan.relations.filter((r) => r.fromId === db.id && r.type === 'USES_CERTIFICATE')).toHaveLength(1)
    for (const s of marked('missing_owner_group')) expect(s.ownerTeamId).toBeNull()
    for (const s of marked('missing_support_group')) expect(s.supportTeamId).toBeNull()
    for (const c of marked('certificate_unrelated')) expect(plan.relations.some((r) => r.fromId === c.id || r.toId === c.id)).toBe(false)
    for (const a of marked('application_without_cis')) {
      expect(a.environment).not.toBe('production')
      expect(plan.relations.some((r) => r.fromId === a.id)).toBe(false)
      expect(plan.appServers.get(a.id)).toEqual([])
    }
    for (const c of marked('certificate_expired_in_use')) {
      expect(c.status).toBe('active')
      expect(Date.parse(c.fields['expires_at']!)).toBeLessThan(NOW - 2 * DAY)
    }
    for (const s of marked('duplicate_name')) expect(plan.byLabel.Server.filter((o) => o.name === s.name)).toHaveLength(2)
    for (const c of marked('required_field_empty')) expect(c.fields['serial_number']).toBeUndefined()
  })

  it('as many planted as asked, each CI once', () => {
    expect([
      marked('chain_orphan').length, marked('chain_incomplete').length, marked('relation_not_admitted').length,
      marked('missing_owner_group').length, marked('missing_support_group').length, marked('certificate_unrelated').length,
      marked('application_without_cis').length, marked('certificate_expired_in_use').length, marked('duplicate_name').length, marked('required_field_empty').length,
    ]).toEqual([
      f.unflaggedInfrastructure, f.databasesWithoutInstance, f.relationsNotAdmitted, f.withoutOwner, f.withoutSupport,
      f.unrelatedCertificates, f.applicationsWithoutCis, f.expiredInUse, f.duplicatePairs, f.requiredFieldEmpty,
    ])
  })

  it('with too few candidates the plan stops and says which, rather than planting fewer', () => {
    expect(() => plantHealthFindings(new Rng('x'), clock, planned('health-b'), { ...f, applicationsWithoutCis: 10_000 }))
      .toThrow(/healthFindings: 10000 applications sharing all they stand on asked, \d+ can be planted/)
  })
})

describe('how many, for the size of the tenant', () => {
  it('the full demo plants exactly the owner\'s numbers; a smaller one in proportion, never fewer than one per check', () => {
    expect(healthFindingsFor(DEFAULT_DEMO_COUNTS)).toEqual(DEMO_RATIOS.healthFindings)
    expect(Object.values(healthFindingsFor(scaledDemoCounts(0.5))).every((n) => n >= 1)).toBe(true)
    expect(Object.values(healthFindingsFor(scaledDemoCounts(INTEGRATION_SCALE)))).toEqual(Object.values(DEMO_RATIOS.healthFindings).map(() => 1))
  })

  it('the two integration tenants take theirs (the CI of 24 Sep 2026: 3 applications without CIs asked, 2 possible)', () => {
    const counts = scaledDemoCounts(INTEGRATION_SCALE)
    // A plan per attempt: a refused planting leaves the CIs it had marked.
    const plan = (seed: string): CMDBPlan => {
      const rng = new Rng(seed)
      return planCMDB(rng.fork('cmdb'), clock, counts, planPeople(rng.fork('people'), clock, counts))
    }
    for (const t of [TENANT_A, TENANT_B]) {
      expect(() => plantHealthFindings(new Rng(t.seed).fork('health-findings'), clock, plan(t.seed), DEMO_RATIOS.healthFindings), t.id).toThrow(/can be planted/)
      expect(() => plantHealthFindings(new Rng(t.seed).fork('health-findings'), clock, plan(t.seed), healthFindingsFor(counts)), t.id).not.toThrow()
    }
  })
})

describe('no ticket names a planted CI', () => {
  // The run of 24 Sep 2026 stopped on «World.memberOf: unknown team null»: a change took the servers
  // of its application, one of them planted without its group. Every way a ticket names a CI passes over them.
  it('changes — with the CIs related to their first — and incidents — with the application on the failing server — never name one', () => {
    const w = smallWorld('health-tickets-planted', { planted: true })
    const planted = new Set(w.cmdb.cis.filter((c) => c.healthFinding).map((c) => c.id))
    expect(planted.size).toBeGreaterThan(0)
    const changes = planChangeSkeletons(new Rng('planted-changes'), w, { count: 600, linked: [] })
    const incidents = planIncidentSkeletons(new Rng('planted-incidents'), w, 600)
    for (const t of [...changes, ...incidents]) for (const id of t.ciIds) expect(planted.has(id), id).toBe(false)
  })


  it('World.runningCI passes over them, and finds nothing when only they are left', () => {
    const w = smallWorld('health-tickets')
    const servers = w.cmdb.byLabel.Server.filter((s) => s.status === 'active').slice(0, 5)
    for (const s of servers.slice(0, 4)) s.healthFinding = 'missing_owner_group'
    for (let i = 0; i < 20; i++) expect(w.runningCI(new Rng(`pick-${String(i)}`), servers, NOW)).toBe(servers[4])
    expect(w.runningCI(new Rng('none'), servers.slice(0, 4), NOW)).toBeNull()
  })
})
