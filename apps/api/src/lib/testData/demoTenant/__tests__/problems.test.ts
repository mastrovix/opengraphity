/**
 * THE PROBLEMS OF THE DEMO TENANT, WHERE THEY STAND TODAY (tour of 23 Sep 2026).
 *
 * tickets.test.ts plans the problems and walks the oldest ones — all closed —
 * through the factory workflow, and one through its change. What problems.ts
 * is for beyond that is pinned here, on skeletons built to stand exactly where
 * a case needs them:
 *
 *  - an open problem stops where it stands and stays there: New, with its
 *    team and person written only in the team history and the Audit Log (the
 *    app writes no history row or comment for them); under investigation; a
 *    known error, its workaround and cause written with «Edit»; deferred; or
 *    waiting for its change — «Change requested» until the change deploys,
 *    «Change in progress» until it closes, the cause written first (D18);
 *  - the paths are the owner's: a closed problem went through a deferral only
 *    if it had room for it (two months), and the open ones with a change are
 *    counted, not ordered — the closed ones carry what the open ones cannot;
 *  - no silent fallbacks: the change path without its change, and changes
 *    left unassigned while problems could carry them, stop the generator;
 *  - a problem no SLA policy covers has no SLA, and is still planned.
 *
 * Pure: the graph driver is replaced by a stub, nothing is written anywhere.
 */
import { describe, it, expect, vi } from 'vitest'
import { Rng } from '../random.js'
import { DAY, MINUTE } from '../clock.js'
import { planIncidentSkeletons } from '../incidents.js'
import { planProblemSkeletons, simulateProblem, type ProblemSkeleton, type SimulatedProblem } from '../problems.js'
import type { ChangeMilestones } from '../changes.js'
import type { World } from '../world.js'
import { WORK_COMMENTS } from '../ticketTexts.js'
import { NOW, SMALL, smallWorld } from './fixtures.js'

// trail.ts → writeReference.ts, and problems.ts → the audit plugin, import the graph driver, which would try to connect at import.
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), runQueryOne: vi.fn(), getSession: vi.fn() }))

const w = smallWorld('problems')
/** Where a problem's simulation stops writing: ten minutes before now. */
const CAP = NOW - 10 * MINUTE
const LOW = { impact: 'low', urgency: 'low', priority: 'low' } as const
const iso = (ms: number): string => new Date(ms).toISOString()
const steps = (sim: SimulatedProblem): string[] => sim.trail.moves.map((m) => m.step.name)

/** The same world with some of its parts replaced: the tenant a case needs (its methods read `this`, so they see the parts). */
function worldWith(parts: Partial<World>): World {
  return Object.assign(Object.create(w) as World, parts)
}

const incidents = planIncidentSkeletons(new Rng('problems/incidents'), w, SMALL.incidents)
const PLAN_SEED = 'problems/plan'
/** Planned without any change: what the problems are before `assignChanges` gives some of them one. */
const planned = planProblemSkeletons(new Rng(PLAN_SEED), w, 200, incidents, { closed: 0, open: 0 })
const KNOWN = planned.find((p) => p.path === 'known_error' && p.openState === null && p.createdAtMs < NOW - 200 * DAY)!
const eligibleOpen = planned.filter((p) => p.openState !== null && p.openState !== 'new' && p.createdAtMs < NOW - 8 * DAY)
const eligibleClosed = planned.filter((p) => p.openState === null && p.createdAtMs < NOW - 90 * DAY)

/** The draw of the path always says «deferred, then fixed»: what the rules make of it is what gets pinned. */
class DeferEveryPath extends Rng {
  override weighted<T>(entries: readonly (readonly [T, number])[]): T {
    return entries.some(([value]) => value === 'deferred_then_fixed') ? 'deferred_then_fixed' as unknown as T : super.weighted(entries)
  }
}

describe('planning the problems', () => {
  it('a closed problem younger than two months never went through a deferral: without room for it, it is a known error', () => {
    const all = planProblemSkeletons(new DeferEveryPath('problems/deferred'), w, 300, incidents, { closed: 0, open: 0 })
    const age = (p: ProblemSkeleton): number => (NOW - p.createdAtMs) / DAY
    const young = all.filter((p) => p.openState === null && age(p) < 60)
    const old = all.filter((p) => p.openState === null && age(p) >= 60)
    expect(young.length).toBeGreaterThan(0)
    expect(old.length).toBeGreaterThan(0)
    for (const p of young) expect(p.path).toBe('known_error')
    for (const p of old) expect(p.path).toBe('deferred_then_fixed')
    // Open: a known error today is on the known-error path; the others keep the deferral they are living.
    for (const p of all.filter((x) => x.openState !== null)) expect(p.path).toBe(p.openState === 'known_error' ? 'known_error' : 'deferred_then_fixed')

    // The histories they tell: the young ones never waited; the old ones came back from the deferral and closed before now.
    for (const p of young) expect(steps(simulateProblem(new Rng(`young/${p.id}`), w, p, null))).toEqual(['under_investigation', 'known_error', 'resolved', 'closed'])
    for (const p of old.slice(0, 40)) {
      const sim = simulateProblem(new Rng(`old/${p.id}`), w, p, null)
      expect(steps(sim)).toEqual(['under_investigation', 'deferred', 'under_investigation', 'known_error', 'resolved', 'closed'])
      expect(sim.trail.lastEventMs).toBeLessThanOrEqual(CAP)
    }
  })

  it('the open ones with a change are counted, not ordered: when too few can have one, the closed ones carry the rest', () => {
    expect(eligibleOpen.length).toBeGreaterThan(0)
    const plan = planProblemSkeletons(new Rng(PLAN_SEED), w, 200, incidents, { closed: 10, open: eligibleOpen.length + 5 })
    const withChange = plan.filter((p) => p.path === 'change')
    expect(withChange).toHaveLength(eligibleOpen.length + 15)
    const open = withChange.filter((p) => p.openState !== null)
    // Every open problem that can wait for a change waits for one: in approval or earlier, or in the release.
    expect(open.map((p) => p.id).sort()).toEqual(eligibleOpen.map((p) => p.id).sort())
    for (const p of open) {
      expect(p.changeTarget).toSatisfy((t: string) => (p.openState === 'change_requested' ? ['assessment', 'approval', 'scheduled'] : ['deployment', 'review']).includes(t))
    }
    for (const p of withChange.filter((x) => x.openState === null)) {
      expect(p.changeTarget).toBe('closed')
      expect(p.createdAtMs).toBeLessThan(NOW - 90 * DAY)
    }
  })

  it('more changes asked than the closed problems can carry: all of them get one when no open problem is left out, and the caller counts', () => {
    // Every open problem that can have a change has one: the planner gives what it can (generate.ts counts it and gives the rest to incidents).
    const plan = planProblemSkeletons(new Rng(PLAN_SEED), w, 200, incidents, { closed: 10_000, open: eligibleOpen.length })
    expect(plan.filter((p) => p.path === 'change')).toHaveLength(eligibleClosed.length + eligibleOpen.length)
    // Open problems left without one while the closed ones ran out: the planner stops and says how many it gave.
    expect(() => planProblemSkeletons(new Rng(PLAN_SEED), w, 200, incidents, { closed: 10_000, open: 0 }))
      .toThrow(`planProblemSkeletons: only ${String(eligibleClosed.length)} problems can carry a change, 10000 asked`)
  })
})

describe('an open problem stops where it stands today', () => {
  it('still New: its team and its person are written only in the team history and the Audit Log', () => {
    const s: ProblemSkeleton = { ...KNOWN, openState: 'new', createdAtMs: NOW - 2 * DAY }
    const sim = simulateProblem(new Rng('prb/new'), w, s, null)
    expect(sim.trail.current.name).toBe('new')
    expect(sim.trail.executions).toHaveLength(1)
    expect(sim.trail.comments).toHaveLength(0)
    expect(sim.trail.segments.map((g) => g.team_id)).toEqual([s.teamId])
    expect(w.isMember(sim.trail.assigneeId!, s.teamId)).toBe(true)
    expect(sim.trail.audits.map((a) => [a.action, a.user_id])).toEqual([
      ['problem.created', s.creatorId], ['mutation.assignProblemToTeam', s.creatorId], ['problem.assigned_user', s.creatorId],
    ])
    expect(JSON.parse(sim.trail.audits[1]!.details!)).toEqual({ args: { problemId: s.id, teamId: s.teamId }, source: 'audit-registry' })
    expect(JSON.parse(sim.trail.audits[2]!.details!)).toEqual({ userId: sim.trail.assigneeId })
    expect(sim).toMatchObject({ workaround: null, changeId: null, changeLinkedAtMs: null })
    expect(sim.sla!.response_met).toBe(false)
  })

  it('under investigation: it stops there, with at most an internal work note — no workaround and no cause yet', () => {
    const s: ProblemSkeleton = { ...KNOWN, openState: 'under_investigation', createdAtMs: NOW - 20 * DAY }
    const sims = Array.from({ length: 12 }, (_, i) => simulateProblem(new Rng(`prb/investigation/${String(i)}`), w, s, null))
    for (const sim of sims) {
      expect(steps(sim)).toEqual(['under_investigation'])
      expect(sim.workaround).toBeNull()
      expect(sim.trail.rootCause).toBeNull()
      const notes = sim.trail.comments.filter((c) => !c.text.startsWith('Workflow: '))
      expect(notes.length).toBeLessThanOrEqual(1)
      for (const n of notes) expect(n).toMatchObject({ is_internal: true, author_id: sim.trail.assigneeId, text: expect.toSatisfy((t: string) => WORK_COMMENTS.includes(t)) })
    }
    expect(sims.some((x) => x.trail.comments.length === 2)).toBe(true)
    expect(sims.some((x) => x.trail.comments.length === 1)).toBe(true)
  })

  it('an open known error: its workaround and root cause are written with «Edit» after the step, and it waits there', () => {
    const s: ProblemSkeleton = { ...KNOWN, openState: 'known_error', createdAtMs: NOW - 30 * DAY }
    for (let i = 0; i < 10; i++) {
      const sim = simulateProblem(new Rng(`prb/known/${String(i)}`), w, s, null)
      expect(steps(sim)).toEqual(['under_investigation', 'known_error'])
      expect(sim.workaround).toBe(s.story.workaround)
      expect(sim.trail.rootCause).toBe(s.story.rootCause)
      const edit = sim.trail.audits.find((a) => a.action === 'problem.updated')!
      expect(Date.parse(edit.created_at)).toBeGreaterThanOrEqual(sim.trail.moves[1]!.atMs)
      expect(Date.parse(edit.created_at)).toBe(sim.trail.updatedAtMs)
      expect(sim.trail.lastEventMs).toBeLessThanOrEqual(CAP)
      expect(sim.trail.resolvedAtMs).toBeNull()
    }
  })

  it('deferred, it waits in «Deferred»; deferred and then fixed, it comes back under investigation and is closed before now', () => {
    const deferred: ProblemSkeleton = { ...KNOWN, path: 'deferred_then_fixed', openState: 'deferred', createdAtMs: NOW - 70 * DAY }
    const waiting = simulateProblem(new Rng('prb/deferred'), w, deferred, null)
    expect(steps(waiting)).toEqual(['under_investigation', 'deferred'])
    expect(waiting.trail.executions.at(-1)!.notes).toBe('Deferred until the platform upgrade planned next quarter.')
    expect(waiting.workaround).toBeNull()

    const fixed = simulateProblem(new Rng('prb/deferred-fixed'), w, { ...deferred, openState: null, createdAtMs: NOW - 300 * DAY }, null)
    expect(steps(fixed)).toEqual(['under_investigation', 'deferred', 'under_investigation', 'known_error', 'resolved', 'closed'])
    expect(fixed.workaround).toBe(KNOWN.story.workaround)
    expect(fixed.trail.lastEventMs).toBeLessThanOrEqual(CAP)
  })

  it('waiting for its change: «Change requested» until the change deploys, «Change in progress» until it closes — the cause written first (D18)', () => {
    const changeAt = NOW - 20 * DAY
    const requester = w.operators[1]!
    const deployer = w.operators[2]!
    const base: ProblemSkeleton = { ...KNOWN, path: 'change', createdAtMs: NOW - 40 * DAY, changeAtMs: changeAt }
    const change: ChangeMilestones & { id: string; requesterId: string } = {
      id: 'chg-7', code: 'CHG00000007', requesterId: requester.id, createdAtMs: changeAt,
      deploymentAtMs: null, deploymentActorId: null, closedAtMs: null, closerId: null,
    }

    const requested = simulateProblem(new Rng('prb/change-requested'), w, { ...base, openState: 'change_requested', changeTarget: 'approval' }, change)
    expect(requested.trail.current.name).toBe('change_requested')
    expect(requested.trail.executions.at(-1)).toMatchObject({ step_name: 'change_requested', entered_at: iso(changeAt), triggered_by: requester.id, notes: 'RFC CHG00000007 created' })
    expect(requested).toMatchObject({ changeId: 'chg-7', changeLinkedAtMs: changeAt, workaround: KNOWN.story.workaround })
    expect(requested.trail.rootCause).toBe(KNOWN.story.rootCause)
    expect(Date.parse(requested.trail.audits.find((a) => a.action === 'problem.updated')!.created_at)).toBeLessThanOrEqual(changeAt)
    expect(requested.trail.resolvedAtMs).toBeNull()

    const deployedAt = changeAt + 6 * DAY
    const inProgress = simulateProblem(new Rng('prb/change-in-progress'), w, { ...base, openState: 'change_in_progress', changeTarget: 'deployment' },
      { ...change, deploymentAtMs: deployedAt, deploymentActorId: deployer.id })
    expect(steps(inProgress).slice(-2)).toEqual(['change_requested', 'change_in_progress'])
    expect(inProgress.trail.executions.at(-1)).toMatchObject({
      step_name: 'change_in_progress', entered_at: iso(deployedAt), trigger_type: 'automatic', triggered_by: deployer.id, notes: 'Change in step "deployment"',
    })
    expect(inProgress.trail.resolvedAtMs).toBeNull()
    expect(inProgress.trail.rootCause).toBe(KNOWN.story.rootCause)
  })
})

describe('what the generator refuses, and what it does without a policy', () => {
  it('a problem on the change path without its change stops the generator (no silent fallback)', () => {
    const s: ProblemSkeleton = { ...KNOWN, path: 'change', changeTarget: 'closed', changeAtMs: KNOWN.createdAtMs + 5 * DAY }
    expect(() => simulateProblem(new Rng('prb/no-change'), w, s, null)).toThrow(`problem ${s.id}: the change path needs its change`)
  })

  it('a problem no SLA policy covers has no SLA row, and is still resolved on a twenty-day plan — not on the policy it does not have', () => {
    const uncovered = worldWith({ config: { ...w.config, slaPolicies: w.config.slaPolicies.filter((p) => p.entityType !== 'problem') } })
    const s: ProblemSkeleton = { ...KNOWN, ...LOW, openState: null, path: 'known_error' }
    const resolvedAfter = (sim: SimulatedProblem): number => sim.trail.moves.find((m) => m.step.name === 'resolved')!.atMs - s.createdAtMs
    const withoutPolicy = Array.from({ length: 20 }, (_, i) => simulateProblem(new Rng(`prb/no-policy/${String(i)}`), uncovered, s, null))
    for (const sim of withoutPolicy) {
      expect(sim.sla).toBeNull()
      expect(sim.trail.current.name).toBe('closed')
      expect(resolvedAfter(sim)).toBeLessThanOrEqual(20 * DAY)
    }
    // With the tenant's policy (forty business days for a low one) the same draws are planned against that deadline: some go past twenty days.
    const withPolicy = Array.from({ length: 20 }, (_, i) => simulateProblem(new Rng(`prb/no-policy/${String(i)}`), w, s, null))
    expect(withPolicy.every((sim) => sim.sla !== null)).toBe(true)
    expect(withPolicy.some((sim) => resolvedAfter(sim) > 20 * DAY)).toBe(true)
  })
})

/** 24 Sep 2026: forty random tries missed on the first weeks, and 5 of 800 problems were dropped without a word. */
describe('the planned problems: as many as asked, or a clear refusal', () => {
  it('every problem asked is planned, the early ones too (every candidate CI is tried)', () => {
    expect(planned).toHaveLength(200)
    expect(planProblemSkeletons(new Rng('problems/all'), w, 300, incidents, { closed: 0, open: 0 })).toHaveLength(300)
  })

  it('with no incident to be the evidence of any problem, the plan stops and says why', () => {
    expect(() => planProblemSkeletons(new Rng('problems/none'), w, 5, [], { closed: 0, open: 0 }))
      .toThrow(/no CI has incidents to be the evidence of a problem/)
  })
})
