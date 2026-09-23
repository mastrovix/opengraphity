/**
 * THE DEMO TENANT'S CHANGES, WHERE THE TICKET TESTS DO NOT GO (23 Sep 2026).
 *
 * `tickets.test.ts` walks six hundred independent changes of a small world:
 * the open ones by age, the phases of a closed one, the scores, the conflicts
 * of the open ones, the audit of every move. This file pins what that walk
 * never meets:
 *
 *  - the changes asked BY an incident or a problem (the owner's 10% that
 *    resolve a ticket): planned first and counted in the total, on the
 *    ticket's CI, with the fix the story names (D19) or a change of the CI's
 *    own kind (D32), never pulled into a conflict (the problem follows the
 *    moment its change was asked for), created from the problem — so the
 *    mutation registry writes nothing — or with the incident in the input;
 *  - the release window at the edge of the day: a run just after midnight,
 *    when the evening slot drawn for a change in review is still running;
 *  - the conflicts the CAB sees in the window NOW (changes in deployment),
 *    and on a small estate where the changes already share their CI;
 *  - the guards that keep a change in the step it was planned to stop at:
 *    the app moves a change on by itself when its last assessment, plan,
 *    deployment or validation is done, so one still in assessment or in
 *    deployment keeps one of them open;
 *  - the tenant's own workflow: a customised one without the automatic move
 *    stops the generator on the change, naming it (no silent fallbacks).
 *
 * Not reachable, so not tested (read with the branch counts of changes.ts):
 * the fallback of `openTargetFor` for a change older than every band (since
 * D33 no open change is older than 90 days, and the bands cover 0 to 90);
 * `size < 2` in `groupConflicts` (the loop runs only while two are left); a
 * group member created less than an hour before its new window (members are
 * of the anchor's class: in deployment at least six days old, in review at
 * least eight, the others with windows from the next day on — only a run
 * between 00:30 and 02:00 in Rome, with an emergency anchor at local
 * midnight and a change raised in the last three hours, could get there;
 * the small estate below pins what that guard promises); a completion
 * earlier than the previous one (the work runs sorted by time); and a
 * question without an answer when a task is scored (a task is completed
 * minutes after its last answer).
 *
 * No database: `@opengraphity/neo4j` is mocked — the trail imports the
 * writer of the reference data, which imports the driver.
 */
import { describe, it, expect, vi } from 'vitest'
import { finestreSiSovrappongono } from '@opengraphity/types'
import { Rng } from '../random.js'
import { DemoClock, DAY, HOUR, MINUTE } from '../clock.js'
import { World } from '../world.js'
import {
  planChangeSkeletons, simulateChange,
  type ChangeLink, type ChangePlanInput, type ChangeSkeleton, type ChangeTarget, type SimulatedChange,
} from '../changes.js'
import { CHANGE_STORIES, changeStoryByKey, type ChangeStory } from '../ticketTexts.js'
import type { CILabel, PlannedCI } from '../cmdb.js'
import type { LiveDefinition, TicketWorkflows } from '../workflowModel.js'
import { NOW, PRIORITY, WORKFLOWS, smallWorld, trailContext } from './fixtures.js'

vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), runQueryOne: vi.fn(), getSession: vi.fn() }))

const w = smallWorld()

type Planned = Omit<ChangeSkeleton, 'code'>
type Asked = ChangePlanInput['linked'][number]

/** The oldest running CI of a kind: it existed for every change of the period. */
function veteran(label: CILabel): PlannedCI {
  return w.cmdb.byLabel[label].filter((c) => c.status === 'active').sort((a, b) => a.createdAtMs - b.createdAtMs)[0]!
}

/** `n` tickets asking for a change on `ci`, as generate.ts passes them (the requester is of the CI's support team). */
function ask(kind: ChangeLink['kind'], n: number, ci: PlannedCI, target: ChangeTarget, createdAtMs: number, story?: ChangeStory): Asked[] {
  const rng = new Rng(`requesters/${kind}/${ci.id}/${target}`)
  return Array.from({ length: n }, (_, i) => ({
    link: { kind, ticketId: `${kind}-${ci.label}-${String(i)}` }, createdAtMs, ci, target,
    requesterId: w.memberOf(rng, ci.supportTeamId!, createdAtMs).id,
    ...(story ? { story } : {}),
  }))
}

/** A world like the fixture's, with another clock, CMDB or workflows. */
function worldWith(parts: { clock?: DemoClock; cmdb?: World['cmdb']; workflows?: TicketWorkflows }): World {
  return new World(new Rng('variant'), parts.clock ?? w.clock, w.people, parts.cmdb ?? w.cmdb, w.config,
    parts.workflows ?? WORKFLOWS, PRIORITY, trailContext(), 'Europe/Rome')
}

function simulate(s: ChangeSkeleton, seed: string, world: World = w): SimulatedChange {
  let n = 0
  return simulateChange(new Rng(seed), world, s, w.config.questions, () => `TASK${String(++n).padStart(8, '0')}`)
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** Conflict groups of a plan, by group number. */
function groupsOf(plans: readonly Planned[]): Planned[][] {
  const out = new Map<number, Planned[]>()
  for (const p of plans) if (p.conflictGroup !== null) out.set(p.conflictGroup, [...(out.get(p.conflictGroup) ?? []), p])
  return [...out.values()]
}

const windowOf = (p: Planned) => ({ start: iso(p.releaseStartMs), end: iso(p.releaseEndMs) })

describe('changes asked by an incident or a problem (the 10% that resolve a ticket)', () => {
  const server = veteran('Server')
  const app = veteran('Application')
  const db = veteran('Database')
  const asked = [
    ...ask('problem', 30, server, 'closed', NOW - 200 * DAY, changeStoryByKey('srv.capacity')),
    // An incident whose story names no fix: the change is one of the CI's kind.
    ...ask('incident', 30, app, 'closed', NOW - 150 * DAY),
    ...ask('problem', 20, db, 'approval', NOW - 20 * DAY, changeStoryByKey('db.index')),
  ]
  const plans = planChangeSkeletons(new Rng('resolving'), w, { count: 600, linked: asked })
  const resolving = plans.slice(0, asked.length)

  it('they are planned first and count in the total: 80 asked of 600, the other 520 independent', () => {
    expect(plans).toHaveLength(600)
    expect(resolving.map((p) => p.link)).toEqual(asked.map((l) => l.link))
    expect(plans.slice(asked.length).every((p) => p.link === null)).toBe(true)
  })

  it('more tickets asking than changes to plan: every ticket still gets its change, and none is independent', () => {
    const few = planChangeSkeletons(new Rng('few'), w, { count: 10, linked: asked.slice(0, 25) })
    expect(few).toHaveLength(25)
    expect(few.map((p) => p.link)).toEqual(asked.slice(0, 25).map((l) => l.link))
  })

  it("a resolving change is about the ticket's CI, raised when and by whom the ticket asked, and owned by the CI's owner team", () => {
    asked.forEach((l, i) => {
      const p = resolving[i]!
      expect(p.ciIds[0]).toBe(l.ci.id)
      expect(new Set(p.ciIds).size).toBe(p.ciIds.length)
      expect(p.ciIds.length).toBeLessThanOrEqual(3)
      expect(p).toMatchObject({ createdAtMs: l.createdAtMs, requesterId: l.requesterId, target: l.target, link: l.link })
      expect(p.ownerId).toBe(w.teamsById.get(l.ci.ownerTeamId!)!.managerId)
    })
  })

  it("D19: the change a problem asks for is the fix its story names; with no known fix it is a change of the CI's own kind (D32)", () => {
    asked.forEach((l, i) => {
      if (l.story) expect(resolving[i]!.story).toBe(l.story)
      else expect(CHANGE_STORIES[l.ci.label].map((s) => s.id)).toContain(resolving[i]!.story.id)
    })
    // Without a fix, the stories of the kind vary: not one change for every incident.
    expect(new Set(resolving.filter((_, i) => !asked[i]!.story).map((p) => p.story.id)).size).toBeGreaterThan(1)
  })

  it('a resolving change is never a pre-approved standard one: mostly normal, an emergency now and then', () => {
    const types = resolving.map((p) => p.type)
    expect(types.every((t) => t === 'normal' || t === 'emergency')).toBe(true)
    const emergencies = types.filter((t) => t === 'emergency').length / types.length
    expect(emergencies).toBeGreaterThan(0.05)
    expect(emergencies).toBeLessThan(0.3)
  })

  it('a resolving change keeps the moment its ticket asked for it: never pulled into a conflict, which moves windows and dates', () => {
    // The twenty still in approval would be candidates by their step: they are left out by their origin.
    for (const p of resolving) expect(p.conflictGroup).toBeNull()
    expect(plans.slice(asked.length).some((p) => p.conflictGroup !== null)).toBe(true)
  })

  it("a change resolving a problem is created from the problem: the problem's move is its trace, the registry writes no createChange", () => {
    const s: ChangeSkeleton = { ...resolving[0]!, code: 'CHG00000101' }
    const sim = simulate(s, 'from-problem')
    expect(sim.changeAudits[0]).toMatchObject({ action: 'change_created', byUserId: s.requesterId, timestamp: iso(s.createdAtMs) })
    expect(sim.trail.audits.some((a) => a.action === 'mutation.createChange')).toBe(false)
    expect(sim.trail.current.name).toBe('closed')
  })

  it('a change resolving an incident is created with the incident in its input, and the registry writes that call; an independent one names no ticket', () => {
    const input = (s: ChangeSkeleton): Record<string, unknown> => {
      const row = simulate(s, `create/${s.id}`).trail.audits.find((a) => a.action === 'mutation.createChange')!
      expect(row).toMatchObject({ user_id: s.requesterId, entity_type: 'Change', entity_id: s.id, created_at: iso(s.createdAtMs) })
      const details = JSON.parse(row.details!) as { args: { input: Record<string, unknown> }; source: string }
      expect(details.source).toBe('audit-registry')
      expect(details.args.input).toMatchObject({ changeType: s.type, affectedCIIds: s.ciIds, changeOwner: s.ownerId })
      return details.args.input
    }
    const fromIncident = { ...resolving[30]!, code: 'CHG00000131' }
    expect(fromIncident.link!.kind).toBe('incident')
    const withIncident = input(fromIncident)
    expect(withIncident['incidentId']).toBe(fromIncident.link!.ticketId)
    expect(withIncident).not.toHaveProperty('problemId')
    const independent = input({ ...plans[asked.length]!, code: 'CHG00000181' })
    expect(independent).not.toHaveProperty('incidentId')
    expect(independent).not.toHaveProperty('problemId')
  })
})

describe('the CIs and the story of a change', () => {
  it('an application the CMDB hosts on no server makes changes about itself alone; a hosted one brings its servers along now and then', () => {
    const app = veteran('Application')
    const hosts = new Set(w.cmdb.appServers.get(app.id))
    const onApp = ask('incident', 40, app, 'closed', NOW - 100 * DAY)
    const saas = worldWith({ cmdb: { ...w.cmdb, appServers: new Map([...w.cmdb.appServers].filter(([id]) => id !== app.id)) } })
    const alone = planChangeSkeletons(new Rng('stack'), saas, { count: 40, linked: onApp })
    for (const p of alone) expect(p.ciIds).toEqual([app.id])
    const stack = planChangeSkeletons(new Rng('stack'), w, { count: 40, linked: onApp })
    const withServers = stack.filter((p) => p.ciIds.length > 1)
    expect(withServers.length).toBeGreaterThan(0)
    for (const p of withServers) for (const id of p.ciIds.slice(1)) expect(hosts.has(id)).toBe(true)
  })

  // Found by this test (23 Sep 2026), fixed: a CI kind with no change
  // stories of its own (BusinessApplication, BusinessCapability) silently
  // borrowed a SERVER story — «Monthly OS patching of <business
  // application>», the very D32 defect — instead of stopping the plan (the
  // owner's rule: no silent fallbacks). It was latent: the generator asks
  // changes only for incidents and problems, never on those kinds. The plan
  // now stops, naming the kind (changes.ts, `storyFor`).
  it('D32: a change asked on a CI kind without change stories (a business application) fails loud instead of borrowing a server story', () => {
    const ba = veteran('BusinessApplication')
    expect(CHANGE_STORIES.BusinessApplication).toEqual([])
    expect(() => planChangeSkeletons(new Rng('business-application'), w, { count: 1, linked: ask('incident', 1, ba, 'closed', NOW - 100 * DAY) }))
      .toThrow(`planChangeSkeletons: no change story for a BusinessApplication (${ba.name}): a change is told with a story of its own CI's kind (D32)`)
    // With the story its ticket names, the change is told with that one.
    const [told] = planChangeSkeletons(new Rng('business-application'), w, { count: 1, linked: ask('incident', 1, ba, 'closed', NOW - 100 * DAY, changeStoryByKey('app.release')) })
    expect(told!.story.id).toBe('app.release')
  })
})

describe('the release window of a change in review', () => {
  it('is behind it, an hour ago at the latest: in a run just after midnight the evening slot still running becomes the evening before', () => {
    // 02:10 in Rome: yesterday evening's slot of an emergency or late normal
    // change ends after "an hour ago". The minute of the run tells the moved
    // window from a drawn slot, which starts on the hour or the half hour.
    const clock = new DemoClock(Date.parse('2026-09-24T00:10:00.000Z'), 3, 'Europe/Rome')
    const night = worldWith({ clock })
    const plans = planChangeSkeletons(new Rng('midnight'), night, { count: 1000, linked: ask('problem', 1000, veteran('Server'), 'review', clock.nowMs - 20 * DAY) })
    for (const p of plans) expect(p.releaseEndMs).toBeLessThanOrEqual(clock.nowMs - HOUR)
    const moved = plans.filter((p) => p.releaseStartMs === clock.nowMs - 30 * HOUR)
    expect(moved.length).toBeGreaterThan(0)
    for (const p of moved) expect(p.releaseEndMs).toBe(clock.nowMs - 27 * HOUR)
    // …and the change lived through it: deployed in that window, now in review.
    const s = { ...moved[0]!, code: 'CHG00000201' }
    const sim = simulate(s, 'midnight/sim', night)
    expect(sim.trail.current.name).toBe('review')
    expect(sim.milestones.deploymentAtMs!).toBeGreaterThanOrEqual(s.releaseStartMs)
    expect(sim.milestones.deploymentAtMs!).toBeLessThanOrEqual(s.releaseEndMs)
    expect(sim.trail.lastEventMs).toBeLessThanOrEqual(clock.nowMs)
  })

  // Found by this test (23 Sep 2026), fixed: the window of a change in
  // review was drawn in the last one to five days whatever its creation —
  // `releaseFor` ignored `created` there — and `slotAt` could open a slot
  // earlier in the day it was asked from. A problem asks for its change as
  // late as five days ago (problems.ts, `assignChanges`), so a resolving
  // change could get a release window BEFORE it was raised; the simulation
  // then deployed after that window and — the validation cut at the window's
  // end and pushed to the last event — recorded the validation BEFORE the
  // deployment it validates (8 of 300 here). The window now opens at least
  // two hours after the change was raised, and a slot never before the
  // moment it is asked from (changes.ts, `slotAt` and `releaseFor`).
  it('a change a problem asked for five days ago, now in review, was released in a window after it was raised and validated after it was deployed', () => {
    const plans = planChangeSkeletons(new Rng('review/young'), w, { count: 300, linked: ask('problem', 300, veteran('Server'), 'review', NOW - 5 * DAY) })
    const wrong: string[] = []
    plans.forEach((p, i) => {
      const s: ChangeSkeleton = { ...p, code: `CHG${String(i + 1).padStart(8, '0')}` }
      if (s.releaseStartMs < s.createdAtMs + 2 * HOUR) wrong.push(`${s.code}: window from ${iso(s.releaseStartMs)}, raised ${iso(s.createdAtMs)}`)
      const sim = simulate(s, `review/young/${s.id}`)
      for (const ci of s.ciIds) {
        const deployed = sim.tasks.find((t) => t.label === 'DeploymentTask' && t.props['ci_id'] === ci)!.props['deployed_at'] as string
        const tested = sim.tasks.find((t) => t.label === 'ValidationTest' && t.props['ci_id'] === ci)!.props['tested_at'] as string
        if (Date.parse(tested) < Date.parse(deployed)) wrong.push(`${s.code}: validated at ${tested}, deployed at ${deployed}`)
      }
    })
    expect(wrong).toEqual([])
  })
})

describe('no release window opens before its change was raised', () => {
  it('whatever the step the change stops at: a closed emergency raised in the evening is released later, not that morning', () => {
    const plans = planChangeSkeletons(new Rng('windows/all'), w, { count: 3000, linked: [] })
    const late = plans.filter((p) => p.releaseStartMs < p.createdAtMs)
    expect(late.map((p) => `${p.target}/${p.type}: raised ${iso(p.createdAtMs)}, window from ${iso(p.releaseStartMs)}`)).toEqual([])
    // A change still ahead opens its window from tomorrow on.
    for (const p of plans.filter((x) => ['assessment', 'approval', 'scheduled'].includes(x.target))) expect(p.releaseStartMs).toBeGreaterThan(NOW)
  })

  it('a change raised an hour ago cannot be in review: there is no room for its release before now, and the plan stops', () => {
    expect(() => planChangeSkeletons(new Rng('review/too-young'), w, { count: 1, linked: ask('problem', 1, veteran('Server'), 'review', NOW - HOUR) }))
      .toThrow(`planChangeSkeletons: a change raised at ${iso(NOW - HOUR)} has no room for a release before now: it cannot be in review`)
  })
})

describe('conflicts the CAB sees', () => {
  it('in the window NOW: changes in deployment grouped on a shared CI are all inside their windows, which overlap, and stay in deployment', () => {
    // A group in deployment is rare (a tenth of the open changes, grouped only
    // when their class comes before the quota is reached): the first plan that has one.
    let found: Planned[] = []
    for (let k = 0; k < 60 && !found.length; k++) {
      found = planChangeSkeletons(new Rng(`dep-${String(k)}`), w, { count: 600, linked: [] })
        .filter((p) => p.conflictGroup !== null && p.target === 'deployment')
    }
    expect(found.length).toBeGreaterThanOrEqual(2)
    for (const p of found) {
      expect(p.releaseStartMs).toBeLessThanOrEqual(NOW - 10 * MINUTE)
      expect(p.releaseEndMs).toBeGreaterThanOrEqual(NOW + 20 * MINUTE)
    }
    for (const g of groupsOf(found)) {
      expect(g.length).toBeGreaterThanOrEqual(2)
      expect(g[0]!.ciIds.some((id) => g.every((m) => m.ciIds.includes(id)))).toBe(true)
      for (const a of g) for (const b of g) expect(finestreSiSovrappongono(windowOf(a), windowOf(b))).toBe(true)
    }
    found.forEach((p, i) => {
      const sim = simulate({ ...p, code: `CHG${String(401 + i).padStart(8, '0')}` }, `dep/${p.id}`)
      expect(sim.trail.current.name).toBe('deployment')
      expect(sim.milestones.deploymentAtMs!).toBeGreaterThanOrEqual(p.releaseStartMs)
      expect(sim.trail.lastEventMs).toBeLessThanOrEqual(NOW)
    })
  })

  it('on a small estate the open changes pile up on the same CI: the shared CI is named once, never pushes the change\'s own CI out of first place (D32), and no change is raised after its window', () => {
    // Five CIs to change, one of each kind: the conflicts land on CIs the changes already name.
    const byLabel = { ...w.cmdb.byLabel }
    for (const label of ['Server', 'Application', 'Database', 'DatabaseInstance', 'Certificate'] as const) byLabel[label] = [veteran(label)]
    const estate = worldWith({ cmdb: { ...w.cmdb, byLabel } })
    const plans = planChangeSkeletons(new Rng('estate-plan'), estate, { count: 600, linked: [] })
    const groups = groupsOf(plans)
    expect(groups.length).toBeGreaterThanOrEqual(2)
    // Some groups are of changes already on the same first CI: nothing is added to them.
    expect(groups.some((g) => new Set(g.map((m) => m.ciIds[0])).size < g.length)).toBe(true)
    for (const p of plans) {
      expect(new Set(p.ciIds).size).toBe(p.ciIds.length)
      expect(p.ciIds.length).toBeLessThanOrEqual(3)
      expect(CHANGE_STORIES[w.cmdb.byId.get(p.ciIds[0]!)!.label].map((s) => s.id)).toContain(p.story.id)
    }
    const classOf = (p: Planned): string => (p.target === 'deployment' ? 'now' : p.target === 'review' ? 'past' : 'ahead')
    for (const g of groups) {
      expect(g.length === 2 || g.length === 3).toBe(true)
      expect(new Set(g.map(classOf)).size).toBe(1)
      expect(g.every((m) => m.target !== 'closed' && m.link === null)).toBe(true)
      expect(g[0]!.ciIds.some((id) => g.every((m) => m.ciIds.includes(id)))).toBe(true)
      for (const a of g) for (const b of g) expect(finestreSiSovrappongono(windowOf(a), windowOf(b))).toBe(true)
      for (const m of g) expect(m.createdAtMs).toBeLessThanOrEqual(m.releaseStartMs - HOUR)
    }
  })
})

describe('a change stays in the step it was planned to stop at', () => {
  // A normal change on one CI, raised twelve days ago: three finishers (owner, support, plan).
  const planned = planChangeSkeletons(new Rng('base'), w, { count: 200, linked: [] })
    .find((p) => p.target === 'closed' && p.type === 'normal' && p.ciIds.length === 1)!
  const base: ChangeSkeleton = { ...planned, code: 'CHG00000300', createdAtMs: NOW - 12 * DAY, conflictGroup: null }
  const ahead = { releaseStartMs: NOW + 8 * DAY, releaseEndMs: NOW + 8 * DAY + 2 * HOUR }

  it('D3: a change still in assessment keeps an assessment or its plan open — the last one done would move it to approval — and its status says so', () => {
    for (let k = 0; k < 30; k++) {
      const sim = simulate({ ...base, ...ahead, target: 'assessment', conflictGroup: 7 }, `assessment/${String(k)}`)
      expect(sim.trail.current.name).toBe('assessment')
      expect(sim.trail.moves).toHaveLength(0)
      expect(sim.props['status']).toBe('assessment')
      expect(sim.approvals).toHaveLength(0)
      const finishers = sim.tasks.filter((t) => t.label === 'AssessmentTask' || t.label === 'DeployPlanTask')
      expect(finishers).toHaveLength(3)
      expect(finishers.some((t) => t.props['status'] !== 'completed')).toBe(true)
      expect(sim.trail.lastEventMs).toBeLessThanOrEqual(NOW)
    }
  })

  it('a change in assessment has its deploy plan saved when it is in a conflict (the CAB sees its window), and only sometimes otherwise', () => {
    const planOf = (sim: SimulatedChange) => sim.tasks.find((t) => t.label === 'DeployPlanTask')!
    for (let k = 0; k < 20; k++) {
      const sim = simulate({ ...base, ...ahead, target: 'assessment', conflictGroup: 7 }, `plan/${String(k)}`)
      const steps = JSON.parse(planOf(sim).props['steps'] as string) as Array<{ releaseWindow: { start: string; end: string } }>
      expect(steps.length).toBeGreaterThan(0)
      for (const st of steps) expect(st.releaseWindow).toEqual({ start: iso(ahead.releaseStartMs), end: iso(ahead.releaseEndMs) })
    }
    let saved = 0
    let notYet = 0
    for (let k = 0; k < 20; k++) {
      const sim = simulate({ ...base, ...ahead, target: 'assessment', conflictGroup: null }, `plan/${String(k)}`)
      const plan = planOf(sim)
      if (plan.props['steps'] !== '[]') { saved++; continue }
      notYet++
      // Not saved: pending, no window, and nobody wrote about it.
      expect(plan.props['status']).toBe('pending')
      expect(plan.props['window_start']).toBeUndefined()
      expect(plan.doneBy).toBeNull()
      expect(sim.changeAudits.some((a) => a.action === 'deploy_plan_saved')).toBe(false)
      expect(sim.trail.audits.some((a) => a.action === 'mutation.saveDeployPlan')).toBe(false)
    }
    expect(saved).toBeGreaterThan(0)
    expect(notYet).toBeGreaterThan(0)
  })

  it('a change still in deployment keeps a deployment or a validation open — the last one done would move it to review — and its window was opened by whom the app allows', () => {
    let validationStillOpen = 0
    for (let k = 0; k < 40; k++) {
      const type = k % 2 ? 'standard' : 'normal'
      const s: ChangeSkeleton = { ...base, type, target: 'deployment', releaseStartMs: NOW - 2 * HOUR, releaseEndMs: NOW + 2 * HOUR }
      const sim = simulate(s, `deployment/${String(k)}`)
      expect(sim.trail.current.name).toBe('deployment')
      expect(sim.props['service_window']).toBe(true)
      const work = sim.tasks.filter((t) => t.label === 'DeploymentTask' || t.label === 'ValidationTest')
      expect(work).toHaveLength(2)
      expect(work.some((t) => t.props['status'] !== 'completed')).toBe(true)
      expect(sim.tasks.some((t) => t.label === 'ReviewTask')).toBe(false)
      if (work.find((t) => t.label === 'DeploymentTask')!.props['status'] === 'completed') validationStillOpen++
      // A pre-approved standard change is open to any change writer: its requester enters the window.
      // Any other type needs `approval.override`, which only administrators have.
      if (type === 'standard') expect(sim.milestones.deploymentActorId).toBe(s.requesterId)
      else expect(w.usersById.get(sim.milestones.deploymentActorId!)!.role).toBe('admin')
      expect(sim.milestones.deploymentAtMs).toBe(s.releaseStartMs)
      expect(sim.trail.lastEventMs).toBeLessThanOrEqual(NOW)
    }
    expect(validationStillOpen).toBeGreaterThan(0)
  })

  it("a tenant whose change workflow has no automatic move to approval stops the generator on the change that completes its assessments, naming it", () => {
    const def = WORKFLOWS.forTicket('change', null)
    const custom: LiveDefinition = { ...def, transitions: def.transitions.filter((t) => !(t.from === 'assessment' && t.to === 'approval')) }
    const customised = worldWith({ workflows: { ...WORKFLOWS, forTicket: (entity, category) => (entity === 'change' ? custom : WORKFLOWS.forTicket(entity, category)) } })
    const s: ChangeSkeleton = { ...base, target: 'closed', releaseStartMs: NOW - 4 * DAY, releaseEndMs: NOW - 4 * DAY + 2 * HOUR }
    expect(() => simulate(s, 'customised', customised))
      .toThrow(`change ${s.id}: "Change RFC Process" has no automatic transition assessment → approval (allowed: none)`)
  })
})
