/**
 * THE INCIDENTS OF THE DEMO TENANT, WHERE THEY STAND TODAY (tour of 23 Sep 2026).
 *
 * tickets.test.ts walks fifteen hundred planned incidents through the factory
 * workflow and monitoring.test.ts the ones the engine opens from an alarm.
 * Both see mostly CLOSED incidents: an incident lives hours, and on any day
 * only a handful are open. What incidents.ts is for beyond that is pinned
 * here, on skeletons built to stand exactly where a case needs them:
 *
 *  - an open incident stops where its AGE puts it, and stays THERE: New in the
 *    group's queue (from the portal, with no team until the desk assigns it),
 *    Assigned, In Progress, On Hold with its SLA paused, Escalated — and
 *    nothing is ever written after now;
 *  - the service desk falls back to the tenant's support teams, a CI that is
 *    not running is never the subject of an incident, and a workflow the
 *    generator cannot walk stops it with its name: no silent fallbacks;
 *  - D11: «Reassigned» only when someone still had it;
 *  - D51: the confirmation comes from a person, before the 72-hour timer and
 *    never after now, and only where the workflow has the manual close;
 *  - the monitoring engine: the incident of an alarm still firing is open,
 *    the one resolved in the last 72 hours is still resolved, and the walk to
 *    «resolved» is the one `findAutoResolvePath` takes (at most four steps).
 *
 * Pure: the graph driver is replaced by a stub, nothing is written anywhere.
 */
import { describe, it, expect, vi } from 'vitest'
import { Rng } from '../random.js'
import { DAY, HOUR, MINUTE } from '../clock.js'
import {
  planIncidentSkeletons, simulateIncident, bornIncidentSkeleton, CONFIRM_SHARE,
  type IncidentSkeleton, type ResolvingChange, type SimulatedIncident,
} from '../incidents.js'
import type { BornIncident } from '../monitoring.js'
import type { CMDBPlan, PlannedCI } from '../cmdb.js'
import type { PlannedTeam } from '../people.js'
import type { World } from '../world.js'
import type { LiveDefinition, LiveStep, TicketWorkflows } from '../workflowModel.js'
import { WORK_COMMENTS } from '../ticketTexts.js'
import { COUNTRY_REGION } from '../names.js'
import { DEFINITIONS, NOW, WORKFLOWS, smallWorld } from './fixtures.js'

// trail.ts → writeReference.ts imports the graph driver, which would try to connect at import.
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), runQueryOne: vi.fn(), getSession: vi.fn() }))

const w = smallWorld('incidents')
/** Where a simulation stops writing: five minutes before now. */
const CAP = NOW - 5 * MINUTE
const LOW = { impact: 'low', urgency: 'low', severity: 'low' } as const
const CRITICAL = { impact: 'high', urgency: 'high', severity: 'critical' }

/** The same world with some of its parts replaced: the tenant a case needs (its methods read `this`, so they see the parts). */
function worldWith(parts: Partial<World>): World {
  return Object.assign(Object.create(w) as World, parts)
}

function workflowsOf(defs: LiveDefinition[]): TicketWorkflows {
  return {
    all: defs,
    forTicket: (entityType, category) => defs.find((d) => d.entityType === entityType && d.category === category)
      ?? defs.find((d) => d.entityType === entityType && d.category === null)!,
    byId: (id) => defs.find((d) => d.id === id)!,
  }
}

const INCIDENT = WORKFLOWS.forTicket('incident', null)
const stepOf = (name: string): LiveStep => INCIDENT.steps.get(name)!

/** A customer's copy of the factory incident workflow (the designer lets them change it). */
function customised(name: string, steps: LiveStep[], transitions: LiveDefinition['transitions']): LiveDefinition {
  const map = new Map(steps.map((s) => [s.name, s]))
  return { ...INCIDENT, id: `wd-${name}`, name, steps: map, initialStep: map.get('new')!, transitions }
}

/** Many lives of one skeleton: the same incident, lived with different draws. */
function lives(label: string, s: IncidentSkeleton, n: number, world: World = w, change: ResolvingChange | null = null): SimulatedIncident[] {
  return Array.from({ length: n }, (_, i) => simulateIncident(new Rng(`${label}/${String(i)}`), world, s, change))
}

const planned = planIncidentSkeletons(new Rng('incidents/plan'), w, 600)
/** A closed incident of the kind asked, old enough for every timer to have fired, not a security one (that workflow has its review). */
function closedOne(channel: 'agent' | 'portal'): IncidentSkeleton {
  const s = planned.find((x) => x.channel === channel && x.openState === null && x.category !== 'security'
    && x.createdAtMs < NOW - 200 * DAY && (channel === 'portal' || w.teamsById.get(x.teamId)!.area !== 'Service Desk'))
  if (!s) throw new Error(`the small world planned no closed ${channel} incident`)
  return s
}
const AGENT = closedOne('agent')
const PORTAL = closedOne('portal')

describe('planning the incidents', () => {
  it('without a Service Desk tower the support teams play the desk: a portal incident goes to one of the requester\'s region (D57)', () => {
    // The customer's towers are its own: none is called «Service Desk».
    const towers = w.supportTeams.map((t) => (t.area === 'Service Desk' ? { ...t, area: 'End User Support' } : t))
    const noDesk = worldWith({ supportTeams: towers, teamsById: new Map([...w.teamsById, ...towers.map((t) => [t.id, t] as const)]) })
    const plan = planIncidentSkeletons(new Rng('no-desk'), noDesk, 300)
    const support = new Set(towers.map((t) => t.id))
    const portal = plan.filter((s) => s.channel === 'portal')
    expect(portal.length).toBeGreaterThan(30)
    let regional = 0
    for (const s of portal) {
      expect(support.has(s.teamId)).toBe(true)
      const region = COUNTRY_REGION[w.usersById.get(s.creatorId)!.country]
      if (towers.some((t) => t.region === region)) {
        expect(noDesk.teamsById.get(s.teamId)!.region).toBe(region)
        regional++
      }
    }
    expect(regional).toBeGreaterThan(0)
    // The one who opens an incident on a CI is a person of one of those teams.
    for (const s of plan.filter((x) => x.channel === 'agent')) {
      expect(towers.some((t) => w.isMember(s.creatorId, t.id))).toBe(true)
    }
  })

  it('an incident is opened only on a running CI: a kind with none falls back on a running server, and with none at all the planner stops', () => {
    const stopped = (list: readonly PlannedCI[]): PlannedCI[] => list.map((c) => ({ ...c, status: 'decommissioned' }))
    const byLabel = Object.fromEntries(Object.entries(w.cmdb.byLabel).map(([label, list]) => [label, stopped(list)])) as CMDBPlan['byLabel']
    // One server still running, there from the start.
    const server = { ...w.cmdb.byLabel.Server.find((c) => c.status === 'active')!, createdAtMs: w.clock.startMs }
    const oneServer = worldWith({ cmdb: { ...w.cmdb, byLabel: { ...byLabel, Server: byLabel.Server.map((c) => (c.id === server.id ? server : c)) } } })
    const plan = planIncidentSkeletons(new Rng('one-server'), oneServer, 60)
    const agent = plan.filter((s) => s.channel === 'agent')
    expect(agent.length).toBeGreaterThan(20)
    for (const s of agent) expect(s.ciIds[0]).toBe(server.id)

    const nothingRuns = worldWith({ cmdb: { ...w.cmdb, byLabel } })
    expect(() => planIncidentSkeletons(new Rng('no-running-ci'), nothingRuns, 40))
      .toThrow('planIncidentSkeletons: no running CI at the time of the incident')
  })

  it('an open incident stands where its age puts it: New only in its first two days, never merely Assigned after ten', () => {
    /*
     * «Uno di stamattina è ancora `new`, uno di due mesi fa non lo è — sarà in
     * attesa di qualcuno o scalato»: what one sees in a real list sorted by
     * date. Thirty thousand arrivals give the old open ones too (the stuck tail).
     */
    const plan = planIncidentSkeletons(new Rng('ages'), w, 30_000)
    const open = plan.filter((s) => s.openState !== null)
    const age = (s: IncidentSkeleton): number => (NOW - s.createdAtMs) / DAY
    const young = open.filter((s) => age(s) < 2)
    const middle = open.filter((s) => age(s) >= 2 && age(s) < 10)
    const old = open.filter((s) => age(s) >= 10)
    expect(young.length).toBeGreaterThan(0)
    expect(middle.length).toBeGreaterThan(0)
    expect(old.length).toBeGreaterThan(0)
    for (const s of young) expect(['new', 'assigned', 'in_progress']).toContain(s.openState)
    for (const s of middle) expect(['assigned', 'in_progress', 'pending', 'escalated']).toContain(s.openState)
    for (const s of old) expect(['in_progress', 'pending', 'escalated']).toContain(s.openState)
    expect(young.some((s) => s.openState === 'new')).toBe(true)
    expect(old.some((s) => s.openState !== 'in_progress')).toBe(true)
  })
})

describe('an open incident stops where it stands today', () => {
  it('still New: with a CI it is already in the support group\'s queue; from the portal it has no team until the desk assigns it', () => {
    const at = NOW - 3 * HOUR
    const agent = simulateIncident(new Rng('new/agent'), w, { ...AGENT, ...LOW, openState: 'new', createdAtMs: at }, null)
    expect(agent.trail.current.name).toBe('new')
    expect(agent.trail.teamId).toBe(AGENT.teamId)
    expect(agent.trail.assigneeId).toBeNull()
    expect(agent.trail.moves).toHaveLength(0)

    const portal = simulateIncident(new Rng('new/portal'), w, { ...PORTAL, ...LOW, openState: 'new', createdAtMs: at }, null)
    expect(portal.trail.current.name).toBe('new')
    expect(portal.trail.teamId).toBeNull()
    expect(portal.trail.assigneeId).toBeNull()
    expect(portal.trail.segments).toHaveLength(0)
    expect(portal.trail.executions).toHaveLength(1)
    expect(portal.trail.comments).toHaveLength(0)
    expect(portal.trail.audits.map((a) => a.action)).toEqual(['portal.ticket.created'])
    expect(portal.watchers).toEqual([{ userId: PORTAL.creatorId, atMs: at }])
    // Nobody has answered yet.
    expect(portal.sla!.response_met).toBe(false)
    expect(portal.sla!.resolved_at).toBeNull()
  })

  it('still Assigned: the person has it, it never went to In Progress, and the SLA has its response', () => {
    for (const [base, label] of [[AGENT, 'agent'], [PORTAL, 'portal']] as const) {
      const sim = simulateIncident(new Rng(`assigned/${label}`), w, { ...base, ...LOW, openState: 'assigned', createdAtMs: NOW - DAY }, null)
      expect(sim.trail.current.name).toBe('assigned')
      expect(sim.trail.moves.map((m) => m.step.name)).toEqual(['assigned'])
      expect(w.isMember(sim.trail.assigneeId!, sim.trail.teamId!)).toBe(true)
      expect(sim.sla!.response_met).toBe(true)
      expect(sim.sla!.resolved_at).toBeNull()
      expect(sim.trail.lastEventMs).toBeLessThanOrEqual(CAP)
    }
  })

  it('still In Progress: some were just picked up, others carry the work done so far — none is resolved', () => {
    const s: IncidentSkeleton = { ...AGENT, ...LOW, openState: 'in_progress', createdAtMs: NOW - 3 * DAY }
    const sims = lives('in-progress', s, 40)
    let justPicked = 0
    for (const sim of sims) {
      expect(sim.trail.current.name).toBe('in_progress')
      expect(sim.trail.resolvedAtMs).toBeNull()
      expect(sim.sla!.resolved_at).toBeNull()
      expect(sim.trail.lastEventMs).toBeLessThanOrEqual(CAP)
      const inProgress = sim.trail.moves.find((m) => m.step.name === 'in_progress')!
      if (sim.trail.lastEventMs === inProgress.atMs) justPicked++
    }
    expect(justPicked).toBeGreaterThan(0)
    // The others went on working: a comment, a wait that is over, a handover.
    const worked = sims.filter((x) => x.trail.comments.some((c) => WORK_COMMENTS.includes(c.text)) || x.trail.moves.length > 2 || x.trail.segments.length > 1)
    expect(worked.length).toBeGreaterThan(0)
  })

  it('waiting on someone it ends On Hold with its SLA paused; escalated it ends Escalated — that detour is the last thing that happened', () => {
    for (const state of ['pending', 'escalated'] as const) {
      const s: IncidentSkeleton = { ...AGENT, ...LOW, openState: state, createdAtMs: NOW - 6 * DAY }
      const sims = lives(`open/${state}`, s, 25)
      for (const sim of sims) {
        const last = sim.trail.moves.at(-1)!
        expect(sim.trail.current.name).toBe(state)
        expect(last.step.name).toBe(state)
        expect(sim.trail.lastEventMs).toBe(last.atMs)
        expect(last.atMs).toBeLessThanOrEqual(CAP)
        if (state === 'pending') expect(sim.sla).toMatchObject({ paused_at: new Date(last.atMs).toISOString(), paused_type: 'resolve', resolved_at: null })
      }
      // An escalated one may have waited on someone before: that wait is over, it came back to work first.
      if (state === 'escalated') {
        const waitedBefore = sims.filter((x) => x.trail.moves.some((m) => m.step.name === 'pending'))
        expect(waitedBefore.length).toBeGreaterThan(0)
        for (const sim of waitedBefore) {
          const names = sim.trail.moves.map((m) => m.step.name)
          expect(names[names.indexOf('pending') + 1]).toBe('in_progress')
        }
      }
    }
  })

  it('opened two hours ago and taken only now: no time is left for its detours, so it is In Progress — never a step after now', () => {
    /*
     * The latest arrival the planner makes is two hours before now. A P4 is
     * picked up within a share of its four-hour response target, so a good
     * part of them are taken at the wall: whatever they were going to wait
     * for, there is no minute left to write it in.
     */
    const s: IncidentSkeleton = { ...AGENT, ...LOW, openState: 'pending', createdAtMs: NOW - 2 * HOUR }
    const sims = lives('late-pickup', s, 60)
    const atTheWall = sims.filter((x) => x.trail.moves.find((m) => m.step.name === 'in_progress')!.atMs === CAP)
    expect(atTheWall.length).toBeGreaterThan(0)
    expect(atTheWall.length).toBeLessThan(sims.length)
    for (const sim of sims) expect(sim.trail.lastEventMs).toBeLessThanOrEqual(CAP)
    for (const sim of atTheWall) {
      expect(sim.trail.current.name).toBe('in_progress')
      expect(sim.trail.comments.some((c) => !c.text.startsWith('Workflow: ') && !c.text.startsWith('Assigned to'))).toBe(false)
    }
    for (const sim of sims.filter((x) => !atTheWall.includes(x))) expect(sim.trail.current.name).toBe('pending')
  })
})

describe('the handover and the resolution', () => {
  it('D11: handed to a team the person also works for, nobody is removed and the new person is «Reassigned»; otherwise it is «Assigned»', () => {
    // Someone who works for two support teams, alone in the first one: they are the assignee.
    const person = w.operators.find((u) => w.supportTeams.filter((t) => t.memberIds.includes(u.id)).length >= 2)!
    const [first, second] = w.supportTeams.filter((t) => t.memberIds.includes(person.id)) as [PlannedTeam, PlannedTeam]
    const alone = { ...first, memberIds: [person.id], managerId: person.id }
    const twoTeams = worldWith({ supportTeams: [alone, second], teamsById: new Map([...w.teamsById, [first.id, alone]]) })
    const kept = lives('handover/kept', { ...AGENT, teamId: first.id, openState: null }, 120, twoTeams).filter((x) => x.trail.segments.length > 1)
    expect(kept.length).toBeGreaterThan(0)
    for (const sim of kept) {
      expect(sim.trail.segments.map((g) => g.team_id)).toEqual([first.id, second.id])
      expect(sim.trail.audits.some((a) => a.action === 'incident.unassigned_user')).toBe(false)
      expect(sim.trail.comments.some((c) => c.text.includes('is no longer the assignee'))).toBe(false)
      expect(sim.trail.executions.some((e) => e.notes === `Reassigned to team ${second.name}`)).toBe(true)
      const handedTo = JSON.parse(sim.trail.audits.filter((a) => a.action === 'incident.assigned_user').at(-1)!.details!) as { userId: string; to: string; from: string | null }
      expect(handedTo.from).toBe(person.name)
      expect(w.isMember(handedTo.userId, second.id)).toBe(true)
      expect(sim.trail.executions.some((e) => e.notes === `Reassigned to ${handedTo.to}`)).toBe(true)
    }

    // The usual case: the person is not in the new team — removed, and the new one is simply «Assigned».
    const removed = lives('handover/removed', { ...AGENT, openState: null }, 120).filter((x) => x.trail.audits.some((a) => a.action === 'incident.unassigned_user'))
    expect(removed.length).toBeGreaterThan(0)
    for (const sim of removed) {
      const handedTo = JSON.parse(sim.trail.audits.filter((a) => a.action === 'incident.assigned_user').at(-1)!.details!) as { to: string; from: string | null }
      expect(handedTo.from).toBeNull()
      expect(sim.trail.executions.some((e) => e.notes === `Assigned to ${handedTo.to}`)).toBe(true)
      expect(sim.trail.comments.some((c) => c.text.includes('is no longer the assignee: not a member of team'))).toBe(true)
    }
  })

  it('resolved by a change: whatever it waited for, the app resolves it the instant the change closes — never reopened, closed by the timer', () => {
    const closedAtMs = AGENT.createdAtMs + 12 * DAY
    const change: ResolvingChange = {
      changeId: 'chg-42', code: 'CHG00000042', createdAtMs: AGENT.createdAtMs + 8 * HOUR, closedAtMs,
      closerId: w.operators[0]!.id, creatorId: w.operators[1]!.id,
    }
    const sims = lives('by-change', { ...AGENT, openState: null }, 40, w, change)
    // Some waited on someone first: the wait does not push the resolution past the change's close.
    expect(sims.some((x) => x.trail.moves.some((m) => m.step.name === 'pending'))).toBe(true)
    for (const sim of sims) {
      const resolved = sim.trail.executions.filter((e) => e.step_name === 'resolved')
      expect(resolved).toHaveLength(1)
      expect(resolved[0]).toMatchObject({ entered_at: new Date(closedAtMs).toISOString(), trigger_type: 'automatic', triggered_by: change.closerId, notes: 'Resolved by change CHG00000042' })
      expect(sim.trail.executions.find((e) => e.step_name === 'closed')).toMatchObject({ trigger_type: 'timer', triggered_by: 'step_deadline' })
      expect(sim.resolvingChange).toBe(change)
    }
  })

  it('an incident no SLA policy covers has no SLA row, and is still paced on four hours to answer and two days to resolve', () => {
    const uncovered = worldWith({ config: { ...w.config, slaPolicies: w.config.slaPolicies.filter((p) => p.entityType !== 'incident') } })
    const s: IncidentSkeleton = { ...AGENT, ...LOW, openState: null }
    const sims = lives('no-policy', s, 100, uncovered)
    for (const sim of sims) {
      expect(sim.sla).toBeNull()
      expect(sim.trail.current.name).toBe('closed')
    }
    const answered = sims.filter((x) => x.trail.moves[0]!.atMs - s.createdAtMs <= 4 * HOUR).length
    const resolvedInTwoDays = sims.filter((x) => Date.parse(x.trail.executions.find((e) => e.step_name === 'resolved')!.entered_at) - s.createdAtMs <= 2 * DAY).length
    expect(answered / sims.length).toBeGreaterThan(0.85)
    expect(resolvedInTwoDays / sims.length).toBeGreaterThan(0.75)
  })
})

/** D51 (tour of 23 Sep 2026): the requester or the desk confirms the resolution; the rest wait for the timer. */
describe('the confirmation of the resolution', () => {
  it('about half of the portal incidents are confirmed by the requester and a quarter by the desk — none on a workflow without «Confirm resolution»', () => {
    // The definition as it was before migration 20261008_1010: resolved → closed by the timer only.
    const before = DEFINITIONS.map((d) => (d.entityType !== 'incident' ? d
      : { ...d, transitions: d.transitions.filter((t) => !(t.from === 'resolved' && t.to === 'closed' && t.trigger === 'manual')) }))
    const oldWorkflow = worldWith({ workflows: workflowsOf(before) })
    for (const [base, channel] of [[PORTAL, 'portal'], [AGENT, 'agent']] as const) {
      const s: IncidentSkeleton = { ...base, openState: null }
      const today = lives(`confirm/${channel}`, s, 160)
      const confirmed = today.filter((x) => x.trail.executions.some((e) => e.step_name === 'closed' && e.trigger_type === 'manual')).length
      expect(Math.abs(confirmed / today.length - CONFIRM_SHARE[channel])).toBeLessThan(0.12)
      for (const sim of lives(`confirm/${channel}`, s, 160, oldWorkflow)) {
        const closed = sim.trail.executions.filter((e) => e.step_name === 'closed')
        expect(closed).toHaveLength(1)
        expect(closed[0]).toMatchObject({ trigger_type: 'timer', triggered_by: 'step_deadline' })
      }
    }
  })

  it('a confirmation never comes after now: resolved in the last hours, the incident is still Resolved, waiting', () => {
    const s: IncidentSkeleton = { ...PORTAL, openState: null, createdAtMs: NOW - 2 * HOUR }
    for (const sim of lives('confirm-later', s, 30)) {
      expect(sim.trail.current.name).toBe('resolved')
      expect(sim.trail.executions.filter((e) => e.step_name === 'resolved')).toHaveLength(1)
      expect(sim.trail.audits.some((a) => a.action === 'portal.ticket.resolution_confirmed')).toBe(false)
      expect(sim.trail.lastEventMs).toBeLessThan(NOW)
    }
  })
})

describe('the workflow the tenant has', () => {
  it('the first assignment moves the incident to the first open step by order: never a closed one, one with no order last, a tie by name', () => {
    const accepted = { ...stepOf('assigned'), id: 'accepted', name: 'accepted', label: 'Accepted' }
    const triage = { ...stepOf('assigned'), id: 'triage', name: 'triage', label: 'Triage', stepOrder: null }
    const review = { ...stepOf('assigned'), id: 'review', name: 'review', label: 'Review', stepOrder: null }
    const out = (to: string) => ({ from: 'new', to, trigger: 'manual', condition: null })
    const def = customised('Incident (four ways out of New)', [...INCIDENT.steps.values(), accepted, triage, review],
      [out('closed'), out('triage'), ...INCIDENT.transitions, out('accepted'), out('review')])
    const sim = simulateIncident(new Rng('first-step'), worldWith({ workflows: workflowsOf([def]) }), { ...AGENT, openState: 'assigned', createdAtMs: NOW - DAY }, null)
    // «accepted» and «assigned» share the order 2: the name decides; «closed» is not open; the unordered ones come last.
    expect(sim.trail.moves.map((m) => m.step.name)).toEqual(['accepted'])
    expect(sim.trail.executions[2]).toMatchObject({ from_step: 'new', step_name: 'accepted', trigger_type: 'automatic' })

    // Only unordered steps out of New: they tie, and the name decides among them too.
    const unordered = customised('Incident (unordered ways out of New)', [...INCIDENT.steps.values(), triage, review],
      [out('triage'), out('review'), ...INCIDENT.transitions.filter((t) => t.from !== 'new')])
    const first = simulateIncident(new Rng('first-step/unordered'), worldWith({ workflows: workflowsOf([unordered]) }), { ...AGENT, openState: 'assigned', createdAtMs: NOW - DAY }, null)
    expect(first.trail.moves.map((m) => m.step.name)).toEqual(['review'])
  })

  it('a workflow with no manual move out of New leaves the first assignment nowhere to go: the generator stops with its name', () => {
    const def = customised('Incident (no way out of New)', [...INCIDENT.steps.values()],
      INCIDENT.transitions.map((t) => (t.from === 'new' ? { ...t, trigger: 'automatic' } : t)))
    expect(() => simulateIncident(new Rng('no-first-step'), worldWith({ workflows: workflowsOf([def]) }), { ...AGENT, openState: null }, null))
      .toThrow('Workflow "Incident (no way out of New)": no step to move to on the first assignment')
  })
})

describe('incidents the monitoring engine opened', () => {
  const server = w.cmdb.byLabel.Server.find((c) => c.status === 'active' && c.supportTeamId !== null)!
  const team = w.teamsById.get(server.supportTeamId!)!
  /** An alarm that opened an incident three hours ago and still fires, untouched: change what the case needs. */
  const born = (over: Partial<BornIncident> = {}): BornIncident => ({
    incidentId: 'inc-born-1', ciId: server.id, eventId: 'evt-1', title: 'HostHighCpuLoad', alarmDescription: 'CPU above 90% for 15 minutes.',
    resource: 'srv-host-01', resourceKind: 'hostname', count: 1, firstSeenMs: NOW - 3 * HOUR, lastSeenMs: NOW - 10 * MINUTE,
    clearedAtMs: null, takenAtMs: null, fixedAtMs: null, ...over,
  })
  const monitoringWorld = (def: LiveDefinition): World => worldWith({ workflows: workflowsOf([def]) })

  it('an alarm still firing keeps its incident open: New in the group\'s queue if nobody took it, In Progress with the one who did', () => {
    const untouched = bornIncidentSkeleton(w, born(), CRITICAL)
    expect(untouched.openState).toBe('new')
    const waiting = simulateIncident(new Rng('firing/untouched'), w, untouched, null)
    expect(waiting.trail.current.name).toBe('new')
    expect(waiting.trail.teamId).toBe(team.id)
    expect(waiting.trail.assigneeId).toBeNull()
    expect(waiting.trail.comments.map((c) => c.text)).toEqual([`Assigned to team ${team.name}, the support group of ${server.name}`])
    expect(waiting.sla!.response_met).toBe(false)

    const takenAtMs = NOW - 3 * HOUR + 6 * MINUTE
    const taken = bornIncidentSkeleton(w, born({ takenAtMs }), CRITICAL)
    expect(taken.openState).toBe('in_progress')
    const working = simulateIncident(new Rng('firing/taken'), w, taken, null)
    expect(working.trail.current.name).toBe('in_progress')
    expect(working.trail.moves[0]).toMatchObject({ atMs: takenAtMs, step: { name: 'assigned' } })
    expect(w.isMember(working.trail.assigneeId!, team.id)).toBe(true)
    expect(working.trail.resolvedAtMs).toBeNull()

    expect(bornIncidentSkeleton(w, born({ clearedAtMs: NOW - HOUR }), CRITICAL).openState).toBeNull()
  })

  it('a person who fixes the alarm writes the cause of its family; an alarm the table does not know gets a plain sentence', () => {
    const first = NOW - 10 * DAY
    const times = { firstSeenMs: first, takenAtMs: first + 7 * MINUTE, fixedAtMs: first + 2 * HOUR, clearedAtMs: first + 2 * HOUR + 3 * MINUTE }
    const cpu = simulateIncident(new Rng('fix/cpu'), w, bornIncidentSkeleton(w, born({ ...times, title: 'HostHighCpuLoad' }), CRITICAL), null)
    expect(['Killed the runaway batch that was holding every core.', 'Moved the report job off the node during business hours.']).toContain(cpu.trail.rootCause)
    const unknown = simulateIncident(new Rng('fix/unknown'), w, bornIncidentSkeleton(w, born({ ...times, title: 'KubePodCrashLooping' }), CRITICAL), null)
    expect(unknown.trail.rootCause).toBe('Fixed the underlying cause of the alarm.')
    for (const sim of [cpu, unknown]) {
      const resolved = sim.trail.executions.find((e) => e.step_name === 'resolved')!
      expect(resolved.entered_at).toBe(new Date(times.fixedAtMs).toISOString())
      expect(resolved.triggered_by).toBe(sim.trail.assigneeId)
      expect(sim.trail.current.name).toBe('closed')
    }
  })

  it('resolved in the last 72 hours — by the engine or by a person — the incident is still Resolved: the timer has not fired', () => {
    const first = NOW - 12 * HOUR
    const byEngine = simulateIncident(new Rng('recent/engine'), w, bornIncidentSkeleton(w, born({ firstSeenMs: first, clearedAtMs: NOW - 10 * HOUR }), CRITICAL), null)
    const byPerson = simulateIncident(new Rng('recent/person'), w, bornIncidentSkeleton(w, born({
      firstSeenMs: first, takenAtMs: first + 5 * MINUTE, fixedAtMs: NOW - 11 * HOUR, clearedAtMs: NOW - 11 * HOUR + 4 * MINUTE,
    }), CRITICAL), null)
    for (const sim of [byEngine, byPerson]) {
      expect(sim.trail.current.name).toBe('resolved')
      expect(sim.trail.audits.some((a) => a.action === 'workflow.step_deadline_moved')).toBe(false)
      expect(sim.sla!.resolved_at).not.toBeNull()
    }
  })

  it('the engine walks the steps a person would: a step with no label is named by its name, a step already seen is not walked again', () => {
    // The customer cleared the label of «assigned» and added a move back to the queue, listed first.
    const steps = [...INCIDENT.steps.values()].map((s) => (s.name === 'assigned' ? { ...s, label: '' } : s))
    const def = customised('Incident (back to the queue)', steps, [{ from: 'assigned', to: 'new', trigger: 'manual', condition: null }, ...INCIDENT.transitions])
    const b = born({ firstSeenMs: NOW - 20 * DAY, clearedAtMs: NOW - 20 * DAY + HOUR })
    const sim = simulateIncident(new Rng('walk/relabelled'), monitoringWorld(def), bornIncidentSkeleton(w, b, CRITICAL), null)
    expect(sim.trail.moves.map((m) => m.step.name)).toEqual(['assigned', 'in_progress', 'resolved', 'closed'])
    expect(sim.trail.executions.map((e) => e.notes).filter(Boolean)).toContain('Automatic closure by monitoring: moving to assigned')
    // Its moves leave no note each: the routing at birth, then ONE summary that names the steps it walked.
    const byEngine = sim.trail.comments.filter((c) => c.author_id === 'monitoring').map((c) => c.text)
    expect(byEngine).toHaveLength(2)
    expect(byEngine[1]).toBe(`Resolved automatically: all correlated monitoring alarms have cleared (last: ${b.title}) — through assigned, In Progress`)
  })

  it('the engine walks at most four steps to «resolved»: four it walks, five stop the generator with the workflow\'s name', () => {
    const chain = (n: number): LiveDefinition => {
      const middle = Array.from({ length: n }, (_, i) => ({ ...stepOf('in_progress'), id: `s${String(i + 1)}`, name: `s${String(i + 1)}`, label: `Stage ${String(i + 1)}`, stepOrder: i + 2 }))
      const names = ['new', ...middle.map((s) => s.name)]
      return customised(`Incident (${String(n)} stages)`, [stepOf('new'), ...middle, stepOf('resolved'), stepOf('closed')], [
        ...names.slice(1).map((to, i) => ({ from: names[i]!, to, trigger: 'manual', condition: null })),
        { from: names.at(-1)!, to: 'resolved', trigger: 'manual', condition: 'rootCause != null' },
        { from: 'resolved', to: 'closed', trigger: 'timer', condition: null },
      ])
    }
    const b = bornIncidentSkeleton(w, born({ firstSeenMs: NOW - 20 * DAY, clearedAtMs: NOW - 20 * DAY + HOUR }), CRITICAL)
    const four = simulateIncident(new Rng('walk/four'), monitoringWorld(chain(4)), b, null)
    expect(four.trail.moves.map((m) => m.step.name)).toEqual(['s1', 's2', 's3', 's4', 'resolved', 'closed'])
    expect(() => simulateIncident(new Rng('walk/five'), monitoringWorld(chain(5)), b, null))
      .toThrow('Workflow "Incident (5 stages)": no path from "new" to "resolved" for the monitoring engine')
  })
})
