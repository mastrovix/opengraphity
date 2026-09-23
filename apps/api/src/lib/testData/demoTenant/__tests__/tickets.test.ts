/**
 * The simulated tickets of the demo tenant: incidents, problems and changes
 * walked through the factory workflows, in a small world.
 *
 * Why these checks matter: the owner of the product asked that the workflows
 * be walked "as one would using the app". Every move of every simulated
 * ticket is checked against the definition when it is made (`assertMove`
 * throws otherwise), so simulating hundreds of tickets without an error IS
 * the proof that no history the app could not produce is written. On top of
 * that: the shares the owner fixed (the open ones by kind, 10% of changes resolving a
 * ticket, at least 15% of changes in conflict), the timings (history rows
 * consecutive, nothing in the future, the 72-hour close only when due) and
 * the traces each move leaves (comment and audit).
 */
import { describe, it, expect } from 'vitest'
import { finestreSiSovrappongono } from '@opengraphity/types'
import { Rng } from '../random.js'
import { DAY, HOUR, MINUTE } from '../clock.js'
import { TicketTrail } from '../trail.js'
import { planIncidentSkeletons, simulateIncident, type SimulatedIncident } from '../incidents.js'
import { planProblemSkeletons, simulateProblem } from '../problems.js'
import { planChangeSkeletons, simulateChange, type ChangeSkeleton, type SimulatedChange } from '../changes.js'
import { liveRequest, requestStateAt, requestTimeline } from '../serviceRequests.js'
import { fulfilmentTeamFor } from '../catalogSetup.js'
import { DEMO_CATALOG } from '../catalogContent.js'
import { CHANGE_STORIES } from '../ticketTexts.js'
import { planKnowledgeBase, AI_SINCE_DAYS } from '../knowledgeBase.js'
import { DEMO_RATIOS } from '../options.js'
import { NOW, smallWorld, SMALL, WORKFLOWS } from './fixtures.js'

const w = smallWorld()
const rng = new Rng('tickets-test')

function consecutive(executions: ReadonlyArray<{ entered_at: string; exited_at?: string; from_step?: string; duration_ms?: unknown }>): boolean {
  // The real rows (not the zero-length reassignment rows): each one ends when the next one starts.
  const real = executions.filter((e) => e.from_step !== undefined || e === executions[0])
  for (let i = 0; i + 1 < real.length; i++) if (real[i]!.exited_at !== real[i + 1]!.entered_at) return false
  return real[real.length - 1]!.exited_at === undefined
}

describe('incidents', () => {
  const skeletons = planIncidentSkeletons(rng.fork('inc'), w, SMALL.incidents)
  const sims: SimulatedIncident[] = skeletons.map((s) => simulateIncident(rng.fork(`inc/${s.id}`), w, s, null))

  it('the open ones are the ones whose life is not over: few, and mostly recent', () => {
    /*
     * Non una percentuale: gli aperti escono dalle DURATE (legge di Little,
     * vedi `options.lifetimes`). Qui si controlla l'ordine di grandezza — con
     * incident che si chiudono in ore, gli aperti sono l'uno per cento scarso
     * — e che siano quasi tutti recenti.
     */
    const stillOpenOnes = skeletons.filter((s) => s.openState !== null)
    const life = DEMO_RATIOS.lifetimes.incident
    const meanDays = (1 - life.stuckShare) * (life.medianHours / 24) * Math.exp(life.spread ** 2 / 2)
      + life.stuckShare * life.stuckMedianDays * Math.exp(0.85 ** 2 / 2)
    const expected = (SMALL.incidents / (3 * 365)) * meanDays
    expect(stillOpenOnes.length).toBeGreaterThan(expected * 0.4)
    expect(stillOpenOnes.length).toBeLessThan(expected * 2.5)
    const open = sims.filter((s) => !s.trail.current.isTerminal)
    expect(open).toHaveLength(stillOpenOnes.length)
    for (const s of open) expect(s.skeleton.openState).toBe(s.trail.current.name === 'in_progress' ? s.skeleton.openState : s.trail.current.name)
  })

  it('every history row is consecutive, nothing happens after now, and the ticket follows its step', () => {
    for (const s of sims) {
      expect(consecutive(s.trail.executions)).toBe(true)
      expect(s.trail.lastEventMs).toBeLessThanOrEqual(NOW)
      expect(s.trail.lastEventMs).toBeGreaterThanOrEqual(s.skeleton.createdAtMs)
      if (s.trail.current.category === 'resolved' || s.trail.current.name === 'closed') {
        expect(s.trail.resolvedAtMs).not.toBeNull()
        expect(s.trail.rootCause).toBeTruthy()
      }
    }
  })

  it('with a CI: born in the support group, still «New»; the person who takes it moves it to «Assigned» (the response)', () => {
    const agent = sims.filter((s) => s.skeleton.channel === 'agent')
    expect(agent.length).toBeGreaterThan(0)
    for (const s of agent) {
      const routed = s.trail.executions[1]!
      // assignIncidentToTeam at creation: a zero-length row on «New», and the same sentence as the one note
      expect(routed).toMatchObject({ step_name: 'new', notes: `Assigned to team ${w.teamsById.get(s.skeleton.teamId)!.name}` })
      expect(routed.entered_at).toBe(routed.exited_at)
      expect(Date.parse(routed.entered_at) - s.skeleton.createdAtMs).toBeLessThan(10_000)
      expect(s.trail.comments[0]!.text).toBe(routed.notes)
      if (!s.trail.moves.length) continue
      const taken = s.trail.executions[2]!
      expect(taken).toMatchObject({ step_name: 'assigned', from_step: 'new', trigger_type: 'automatic' })
      expect(taken.notes).toMatch(/^Assigned to /)
      expect(s.trail.comments.some((c) => c.text === `Workflow: Assigned — ${taken.notes!}`)).toBe(true)
    }
  })

  it('P1s are taken in minutes (D63), and the portal is assigned by the desk of the requester\'s region', () => {
    for (const s of sims.filter((x) => x.skeleton.channel === 'agent' && x.skeleton.severity === 'critical' && x.trail.moves.length)) {
      expect(s.trail.moves[0]!.atMs - s.skeleton.createdAtMs).toBeLessThan(45 * MINUTE)
    }
    for (const s of sims.filter((x) => x.skeleton.channel === 'portal' && x.trail.moves.length)) {
      const first = s.trail.executions[1]!
      expect(first).toMatchObject({ step_name: 'assigned', from_step: 'new', trigger_type: 'automatic' })
      expect(first.notes).toBe(`Assigned to team ${w.teamsById.get(s.skeleton.teamId)!.name}`)
      expect(w.teamsById.get(s.skeleton.teamId)!.area).toBe('Service Desk')
    }
  })

  it('a few are reopened before the timer closes them, and resolved again (D51)', () => {
    const reopened = sims.filter((s) => s.trail.executions.filter((e) => e.step_name === 'resolved').length > 1)
    expect(reopened.length).toBeGreaterThan(0)
    for (const s of reopened) {
      const back = s.trail.executions.find((e) => e.from_step === 'resolved' && e.step_name === 'in_progress')!
      expect(back.notes).toBeTruthy()
      // SL-3: the SLA was reopened and says when
      expect(s.sla?.reopened_at).toBe(back.entered_at)
    }
  })

  it('security incidents pass the security review; the others never see that step', () => {
    for (const s of sims) {
      const passed = s.trail.moves.some((m) => m.step.name === 'security_review')
      if (s.trail.moves.some((m) => m.step.name === 'in_progress')) expect(passed).toBe(s.skeleton.category === 'security')
    }
  })

  it('the 72-hour close happens only when due, by the step deadline, signed by the automation', () => {
    for (const s of sims) {
      const closed = s.trail.executions.find((e) => e.step_name === 'closed')
      if (!closed || closed.trigger_type === 'manual') continue
      // From the last resolution (a reopened incident was resolved twice).
      const resolved = [...s.trail.executions].reverse().find((e) => e.step_name === 'resolved')!
      const waited = Date.parse(closed.entered_at) - Date.parse(resolved.entered_at)
      expect(waited).toBeGreaterThanOrEqual(72 * HOUR)
      expect(waited).toBeLessThan(72 * HOUR + 60_000)
      expect(closed).toMatchObject({ trigger_type: 'timer', triggered_by: 'step_deadline' })
      expect(resolved.deadline_outcome).toBe('moved')
      expect(s.trail.audits.some((a) => a.action === 'workflow.step_deadline_moved' && a.user_id === 'automation')).toBe(true)
    }
    // Resolved in the last 72 hours: still resolved, waiting for the timer.
    expect(sims.some((s) => s.trail.current.name === 'resolved')).toBe(true)
  })

  /*
   * D51 (tour of 23 Sep 2026): every resolved incident waited exactly 72
   * hours for the timer. Now the requester confirms from the portal, or the
   * desk on the caller's word — sooner, and only by a person.
   */
  it('D51: some resolved incidents are confirmed and closed sooner, by the requester from the portal or by the desk', () => {
    const confirmed = sims.filter((s) => s.trail.executions.some((e) => e.step_name === 'closed' && e.trigger_type === 'manual'))
    const timer = sims.filter((s) => s.trail.executions.some((e) => e.step_name === 'closed' && e.trigger_type === 'timer'))
    expect(confirmed.length).toBeGreaterThan(0)
    expect(timer.length).toBeGreaterThan(0)
    for (const s of confirmed) {
      const closed = s.trail.executions.find((e) => e.step_name === 'closed')!
      const resolved = [...s.trail.executions].reverse().find((e) => e.step_name === 'resolved')!
      const waited = Date.parse(closed.entered_at) - Date.parse(resolved.entered_at)
      expect(waited).toBeGreaterThan(0)
      expect(waited).toBeLessThan(72 * HOUR)
      expect(s.skeleton.creatorId).not.toBe('monitoring')
      if (s.skeleton.channel === 'portal') {
        expect(closed.triggered_by).toBe(s.skeleton.creatorId)
        expect(s.trail.audits.some((a) => a.action === 'portal.ticket.resolution_confirmed' && a.user_id === s.skeleton.creatorId)).toBe(true)
      }
      // Nobody moved the step by its deadline: it had nothing left to close.
      expect(s.trail.audits.some((a) => a.action === 'workflow.step_deadline_moved')).toBe(false)
    }
  })

  it('every move leaves its comment and its step_entered audit row', () => {
    for (const s of sims.slice(0, 200)) {
      expect(s.trail.audits.filter((a) => a.action === 'incident.step_entered')).toHaveLength(s.trail.moves.length)
      expect(s.trail.comments.filter((c) => c.text.startsWith('Workflow: '))).toHaveLength(s.trail.moves.length)
    }
  })

  it('an assignee is always a member of the team the incident is with', () => {
    for (const s of sims) if (s.trail.assigneeId && s.trail.teamId) expect(w.isMember(s.trail.assigneeId, s.trail.teamId)).toBe(true)
  })

  it('most SLAs are met and some are breached, and every incident has one', () => {
    expect(sims.every((s) => s.sla !== null)).toBe(true)
    const concluded = sims.filter((s) => s.sla!.resolved_at !== null)
    const met = concluded.filter((s) => s.sla!.resolve_met).length / concluded.length
    expect(met).toBeGreaterThan(0.8)
    expect(met).toBeLessThan(0.99)
  })

  it('an incident resolved by a change waits in progress and is resolved by the app when the change closes', () => {
    const s = skeletons.find((x) => x.openState === null && x.channel === 'agent' && x.createdAtMs < NOW - 90 * 24 * HOUR)!
    const closedAt = s.createdAtMs + 10 * 24 * HOUR
    const sim = simulateIncident(rng.fork('linked'), w, s, { changeId: 'c1', code: 'CHG00000042', createdAtMs: s.createdAtMs + 6 * HOUR, closedAtMs: closedAt, closerId: w.operators[0]!.id, creatorId: w.operators[0]!.id })
    const resolved = sim.trail.executions.find((e) => e.step_name === 'resolved')!
    expect(resolved).toMatchObject({ entered_at: new Date(closedAt).toISOString(), trigger_type: 'automatic', notes: 'Resolved by change CHG00000042' })
    expect(sim.trail.rootCause).toBe('Resolved by change CHG00000042')
  })
})

describe('changes', () => {
  const plans = planChangeSkeletons(rng.fork('chg'), w, { count: SMALL.changes, linked: [] }).sort((a, b) => a.createdAtMs - b.createdAtMs)
  const skeletons: ChangeSkeleton[] = plans.map((p, i) => ({ ...p, code: `CHG${String(i + 1).padStart(8, '0')}` }))
  let task = 0
  const sims: SimulatedChange[] = skeletons.map((s) => simulateChange(rng.fork(`chg/${s.id}`), w, s, w.config.questions, () => `TASK${String(++task).padStart(8, '0')}`))

  it('the open ones are those whose life is not over, spread over every open step', () => {
    const open = sims.filter((s) => s.trail.current.name !== 'closed')
    expect(open.length).toBeGreaterThan(skeletons.length * 0.01)
    expect(open.length).toBeLessThan(skeletons.length * 0.12)
    // Ogni passo aperto è uno dei cinque; su un tenant piccolo non è detto
    // che si vedano tutti (una change in deployment adesso è un caso raro).
    const steps = new Set(open.map((s) => s.trail.current.name))
    for (const step of steps) expect(['assessment', 'approval', 'scheduled', 'deployment', 'review']).toContain(step)
    expect(steps.size).toBeGreaterThanOrEqual(3)
    for (const s of sims) expect(s.trail.current.name).toBe(s.skeleton.target)
  })

  it('a closed change went through every phase, with completed tasks and its approvals', () => {
    for (const s of sims.filter((x) => x.skeleton.target === 'closed')) {
      expect(s.trail.moves.map((m) => m.step.name)).toEqual(['approval', 'scheduled', 'deployment', 'review', 'closed'])
      for (const t of s.tasks) expect(t.props['status']).toBe('completed')
      expect(s.props['completed_at']).toBeTruthy()
      if (s.skeleton.type === 'standard') {
        expect(s.approvals).toHaveLength(0)
        expect(s.trail.executions.find((e) => e.step_name === 'scheduled')).toMatchObject({ trigger_type: 'automatic', triggered_by: 'system', notes: 'Standard: pre-approved' })
      } else {
        expect(s.approvals.every((a) => a.props['status'] === 'approved')).toBe(true)
        expect(s.approvals.filter((a) => a.props['kind'] === 'change_manager')).toHaveLength(1)
        expect(s.trail.executions.find((e) => e.step_name === 'scheduled')).toMatchObject({ trigger_type: 'manual', notes: 'Approvals complete' })
      }
      // The release happens inside the planned window.
      const dep = Date.parse(s.trail.executions.find((e) => e.step_name === 'deployment')!.entered_at)
      expect(dep).toBeGreaterThanOrEqual(s.skeleton.releaseStartMs)
    }
  })

  it('scores follow the app formula: risk = mean of the two scores, aggregate = max, priority from the matrix', () => {
    for (const s of sims.filter((x) => x.props['aggregate_risk_score'] !== undefined)) {
      const risks = s.affects.map((a) => a.props['risk_score'] as number)
      expect(s.props['aggregate_risk_score']).toBe(Math.max(...risks))
      expect(s.props['priority']).toBe(w.priority.changePriority(s.skeleton.type, w.priority.riskBand(Math.max(...risks))))
      for (const a of s.affects) {
        const owner = s.tasks.find((t) => t.props['ci_id'] === a.ciId && t.props['responder_role'] === 'owner')!.props['score'] as number
        const support = s.tasks.find((t) => t.props['ci_id'] === a.ciId && t.props['responder_role'] === 'support')!.props['score'] as number
        expect(a.props['risk_score']).toBe(Math.round((owner + support) / 2))
      }
    }
  })

  it('at least 15% of the OPEN changes conflict by the app rule: same CI, overlapping windows, the other one alive', () => {
    const plansByCI = new Map<string, Array<{ change: string; open: boolean; w: { start: string; end: string } }>>()
    for (const s of sims) {
      for (const t of s.tasks.filter((x) => x.label === 'DeployPlanTask' && x.props['steps'] !== '[]')) {
        const steps = JSON.parse(t.props['steps'] as string) as Array<{ releaseWindow: { start: string; end: string } }>
        const list = plansByCI.get(t.props['ci_id'] as string) ?? []
        for (const st of steps) list.push({ change: s.skeleton.id, open: s.trail.current.name !== 'closed', w: st.releaseWindow })
        plansByCI.set(t.props['ci_id'] as string, list)
      }
    }
    const conflicting = new Set<string>()
    for (const list of plansByCI.values()) {
      for (const a of list) for (const b of list) {
        if (a.change !== b.change && b.open && finestreSiSovrappongono(a.w, b.w)) conflicting.add(a.change)
      }
    }
    // Sulle aperte: due change concluse non confliggono mai (regola del prodotto).
    const openOnes = sims.filter((s) => s.trail.current.name !== 'closed').length
    expect(conflicting.size / Math.max(1, openOnes)).toBeGreaterThanOrEqual(0.15)
  })

  it('a change closed after a short life keeps its window in the past', () => {
    /*
     * Il difetto del 22 set 2026: con le durate vere una change standard può
     * chiudersi in tre giorni, e «creazione + tempo di preparazione» finiva
     * dopo adesso — rilascio nel futuro e chiusura prima del proprio
     * deployment. Qui si simulano le change più giovani fra le chiuse.
     */
    const closedOnes = skeletons.filter((s) => s.target === 'closed')
    for (const s of closedOnes) expect(s.releaseEndMs).toBeLessThanOrEqual(NOW)
    // Le più giovani sono quelle dove la finestra rischia di finire nel futuro.
    const young = [...closedOnes].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 40)
    for (const s of young) {
      expect(s.releaseEndMs).toBeLessThanOrEqual(NOW)
      const sim = simulateChange(rng.fork(`young/${s.id}`), w, s, w.config.questions, () => 'TASK00000001')
      expect(sim.trail.current.name).toBe('closed')
      expect(consecutive(sim.trail.executions)).toBe(true)
    }
  })

  it('every move of the change leaves its comment and audit, and the automatic ones say "system"', () => {
    for (const s of sims.slice(0, 100)) {
      expect(s.trail.audits.filter((a) => a.action === 'change.step_entered')).toHaveLength(s.trail.moves.length)
      for (const e of s.trail.executions.filter((x) => x.trigger_type === 'automatic')) expect(e.triggered_by).toBe('system')
      expect(s.changeAudits[0]).toMatchObject({ action: 'change_created', detail_key: 'changeCreated' })
    }
  })
})

describe('problems', () => {
  const incidents = planIncidentSkeletons(rng.fork('p-inc'), w, SMALL.incidents)
  const skeletons = planProblemSkeletons(rng.fork('prb'), w, SMALL.problems, incidents, { closed: 16, open: 4 })

  it('exactly the problems asked get a change, and the open ones follow the lifetimes', () => {
    expect(skeletons.filter((p) => p.path === 'change')).toHaveLength(20)
    const openOnes = skeletons.filter((p) => p.openState !== null).length
    expect(openOnes).toBeGreaterThan(skeletons.length * 0.02)
    expect(openOnes).toBeLessThan(skeletons.length * 0.25)
    for (const p of skeletons) for (const id of p.incidentIds) expect(incidents.find((i) => i.id === id)!.createdAtMs).toBeLessThan(p.createdAtMs)
  })

  it('without a change: investigated, known error with workaround, resolved, closed — or deferred or rejected', () => {
    for (const s of skeletons.filter((p) => p.path !== 'change').slice(0, 120)) {
      const sim = simulateProblem(rng.fork(`prb/${s.id}`), w, s, null)
      expect(consecutive(sim.trail.executions)).toBe(true)
      if (s.openState === null) expect(['closed', 'rejected']).toContain(sim.trail.current.name)
      else expect(sim.trail.current.name).toBe(s.openState)
      expect(sim.trail.audits.some((a) => a.action === 'mutation.assignProblemToTeam')).toBe(true)
    }
  })

  it('with a change: requested, in progress when the change deploys, resolved by the app when it closes', () => {
    const s = skeletons.find((p) => p.path === 'change' && p.openState === null)!
    const m = { id: 'c1', code: 'CHG00000007', requesterId: w.operators[1]!.id, createdAtMs: s.changeAtMs!, deploymentAtMs: s.changeAtMs! + 5 * 24 * HOUR,
      deploymentActorId: w.operators[2]!.id, closedAtMs: s.changeAtMs! + 7 * 24 * HOUR, closerId: w.operators[3]!.id }
    const sim = simulateProblem(rng.fork('prb-change'), w, s, m)
    expect(sim.trail.moves.map((x) => x.step.name)).toEqual(['under_investigation', 'change_requested', 'change_in_progress', 'resolved', 'closed'])
    expect(sim.trail.executions.find((e) => e.step_name === 'change_requested')!.notes).toBe('RFC CHG00000007 created')
    expect(sim.trail.rootCause).toBe('Change in step "closed"')
    expect(sim.changeId).toBe('c1')
  })
})

/**
 * SERVICE REQUESTS (tour of 23 Sep 2026): born in the fulfilment group of
 * their model (D56), dispatched to the team of the requester's region when
 * the work is on site, worked by a member of the team, and open for as long
 * as their model takes (D1).
 */
describe('service requests', () => {
  const w = smallWorld('requests')
  const spec = DEMO_CATALOG.find((i) => i.key === 'laptop')!
  const group = fulfilmentTeamFor(w.people.teams, spec.fulfilTower)
  const item = { id: 'item-laptop', spec, revision: 1, fields: [], vocabularyIds: [], fulfilmentTeamId: group.id }

  it('the timeline stays in order and never runs past 29 days', () => {
    const rng = new Rng('timeline')
    for (let i = 0; i < 2000; i++) {
      const t = requestTimeline(rng, spec, NOW - 40 * DAY)
      expect(t.approvalAtMs!).toBeLessThanOrEqual(t.decisionAtMs!)
      expect(t.startAtMs).toBeLessThanOrEqual(t.fulfilledAtMs)
      expect(t.fulfilledAtMs).toBeLessThan(t.closedAtMs)
      expect(t.fulfilledAtMs - (NOW - 40 * DAY)).toBeLessThanOrEqual(29 * DAY)
    }
    const t = { approvalAtMs: 10, decisionAtMs: 20, rejected: false, startAtMs: 20, fulfilledAtMs: 30, closedAtMs: 40 }
    expect([5, 15, 25, 35, 45].map((now) => requestStateAt(t, now))).toEqual(['submitted', 'approval', 'in_progress', 'fulfilled', null])
    expect(requestStateAt({ ...t, rejected: true }, 25)).toBeNull()
  })

  it('born in the fulfilment group with its note; the person is of the team that has it; nothing after now', () => {
    const rng = new Rng('live')
    let dispatched = 0
    for (let i = 0; i < 300; i++) {
      const created = NOW - rng.int(1, 60) * DAY
      const requester = w.someone(rng, w.endUsers, created)
      const trail = new TicketTrail(w.trail, 'service_request', `sr-${String(i)}`, WORKFLOWS.forTicket('service_request', null), created)
      liveRequest(rng, w, trail, item, { creatorId: requester.id, requester, endUser: true }, requestTimeline(rng, spec, created))
      expect(trail.segments[0]!.team_id).toBe(group.id)
      expect(Date.parse(trail.segments[0]!.started_at) - created).toBeLessThan(10_000)
      expect(trail.comments[0]!.text).toBe(`Assigned to team ${group.name}, the fulfilment group of «New Laptop»`)
      if (trail.segments.length > 1) {
        dispatched++
        expect(w.teamsById.get(trail.segments[1]!.team_id)!.area).toBe(group.area)
      }
      if (trail.assigneeId) expect(w.isMember(trail.assigneeId, trail.teamId!)).toBe(true)
      expect(trail.lastEventMs).toBeLessThanOrEqual(NOW)
    }
    expect(dispatched).toBeGreaterThan(0)
  })
})

/** One cause, told once (tour of 23 Sep 2026: D18, D19, D20, D32, D33). */
describe('problems and changes tell one story', () => {
  const w = smallWorld('stories')
  const rng = new Rng('stories')
  const incidents = planIncidentSkeletons(rng.fork('inc'), w, SMALL.incidents)
  const problems = planProblemSkeletons(rng.fork('prb'), w, 120, incidents, { closed: 30, open: 6 })
  const byId = new Map(incidents.map((i) => [i.id, i]))

  it('D19: every incident linked to a problem is of the story\'s symptoms, on its CI, before it', () => {
    expect(problems.length).toBeGreaterThan(60)
    for (const p of problems) {
      expect(p.incidentIds.length).toBeGreaterThan(0)
      for (const id of p.incidentIds) {
        const inc = byId.get(id)!
        expect(p.story.symptoms, `${p.story.id} ← ${inc.story.id}`).toContain(inc.story.id)
        expect(inc.ciIds[0]).toBe(p.ciId)
        expect(inc.createdAtMs).toBeLessThan(p.createdAtMs)
      }
      // the fix is a change of the problem's CI kind
      expect(CHANGE_STORIES[w.cmdb.byId.get(p.ciId)!.label].map((c) => c.id)).toContain(p.story.fix)
    }
  })

  it('D33: a problem still waiting for its change asked for it in the last two months', () => {
    for (const p of problems.filter((x) => x.path === 'change' && x.changeTarget !== 'closed')) {
      expect(NOW - p.changeAtMs!).toBeLessThanOrEqual(61 * DAY)
    }
  })

  it('D18: the cause and the workaround are on the problem before the change is asked for', () => {
    const withChange = problems.find((p) => p.path === 'change' && p.changeTarget === 'closed')!
    const changeAt = withChange.changeAtMs!
    const sim = simulateProblem(rng.fork('d18'), w, withChange, {
      code: 'CHG00000007', id: 'c7', requesterId: w.operators[0]!.id, createdAtMs: changeAt,
      deploymentAtMs: changeAt + 3 * DAY, deploymentActorId: w.operators[0]!.id, closedAtMs: changeAt + 5 * DAY, closerId: w.operators[0]!.id,
    })
    const updated = sim.trail.audits.find((a) => a.action === 'problem.updated')!
    const rfc = sim.trail.executions.find((e) => e.step_name === 'change_requested')!
    expect(Date.parse(updated.created_at)).toBeLessThanOrEqual(Date.parse(rfc.entered_at))
    expect(sim.workaround).toBe(withChange.story.workaround)
    expect(sim.trail.rootCause).toBe('Change in step "closed"')
  })

  it('D32: a change is about its own first CI — the story fits that CI\'s kind; D33: none open for more than 90 days', () => {
    const changes = planChangeSkeletons(rng.fork('chg'), w, { count: 400, linked: [] })
    for (const c of changes) {
      const primary = w.cmdb.byId.get(c.ciIds[0]!)!
      expect(CHANGE_STORIES[primary.label].map((x) => x.id), `${c.story.id} on ${primary.label}`).toContain(c.story.id)
      if (c.target !== 'closed') expect(NOW - c.createdAtMs).toBeLessThanOrEqual(90 * DAY)
      if (c.target === 'approval') expect(NOW - c.createdAtMs).toBeLessThanOrEqual(60 * DAY)
    }
  })
})

/** D16 (tour of 23 Sep 2026): three years of operation, and the knowledge base was empty. */
describe('the knowledge base', () => {
  const w = smallWorld('kb')
  const author = w.operators[0]!
  const known = Array.from({ length: 60 }, (_, i) => ({
    problemId: `p${String(i)}`, number: `PRB${String(i).padStart(8, '0')}`, title: `Recurring trouble ${String(i)}`, description: 'It keeps happening.',
    workaround: 'Restart it.', rootCause: 'A leak.', ciName: 'SRV_x', ciLabel: i % 2 ? 'Server' : 'Database', category: 'software',
    authorId: author.id, knownAtMs: NOW - (400 - i * 5) * DAY, incidentIds: [`i${String(i)}`],
  }))
  const articles = planKnowledgeBase(new Rng('kb'), w, known, [{ id: 'inc-vpn', storyKey: 'portal.vpn', createdAtMs: NOW - 1090 * DAY }])

  it('known errors are written up with the problem\'s number, and every portal question has its how-to', () => {
    const howTos = articles.filter((a) => ['how-to', 'faq'].includes(a.props['category'] as string))
    expect(howTos.length).toBeGreaterThanOrEqual(20)
    const ke = articles.filter((a) => (a.props['title'] as string).startsWith('Workaround: '))
    expect(ke.length).toBeGreaterThan(10)
    for (const a of ke) {
      expect(['software', 'database']).toContain(a.props['category'])
      if (a.props['version'] as number > 1) expect(a.props['body'] as string).toMatch(/Known error PRB\d{8}/)
    }
  })

  it('a published article went through review with an approved request, and people read it', () => {
    const published = articles.filter((a) => a.props['published_at'] !== null)
    expect(published.length).toBeGreaterThan(20)
    for (const a of published) {
      const approved = a.approvals.filter((r) => r['status'] === 'approved')
      expect(approved).toHaveLength(1)
      expect(approved[0]!['resolved_at']).toBe(a.props['published_at'])
      expect(a.trail.executions.some((e) => e.step_name === 'pending_review')).toBe(true)
    }
    expect(published.some((a) => (a.props['views'] as number) > 100)).toBe(true)
  })

  it('an article\'s moves leave no ticket note or step audit; its versions keep the earlier text; nothing after now', () => {
    for (const a of articles) {
      expect(a.trail.comments).toHaveLength(0)
      expect(a.trail.audits.every((x) => x.action.startsWith('kb_article.') || x.action.startsWith('approval.'))).toBe(true)
      expect(a.versions.map((v) => v['version'])).toEqual(a.versions.map((_, i) => i + 1))
      expect(a.props['version']).toBe(a.versions.length + 1)
      expect(a.trail.lastEventMs).toBeLessThanOrEqual(NOW)
      expect(a.props['status']).toBe(a.trail.current.name)
    }
    expect(articles.find((a) => a.props['title'] === 'Connect to the VPN from home')!.writtenFrom).toEqual(['inc-vpn'])
  })

  it('D52: since the AI was turned on, most known errors start as an AI draft from one incident, and the log says so', () => {
    const drafted = articles.filter((a) => a.trail.audits.some((x) => x.action === 'kb_article.drafted_by_ai'))
    const recentKnown = articles.filter((a) => (a.props['title'] as string).startsWith('Workaround: ')
      && Date.parse(a.props['created_at'] as string) >= NOW - AI_SINCE_DAYS * DAY)
    expect(drafted.length).toBeGreaterThan(recentKnown.length / 3)
    expect(drafted.length).toBeLessThan(recentKnown.length)
    for (const a of drafted) {
      expect(Date.parse(a.props['created_at'] as string)).toBeGreaterThanOrEqual(NOW - AI_SINCE_DAYS * DAY)
      expect(a.writtenFrom).toHaveLength(1)
      const entry = a.trail.audits.find((x) => x.action === 'kb_article.drafted_by_ai')!
      expect(JSON.parse(entry.details!)).toEqual({ incidentId: a.writtenFrom[0] })
      expect(entry.created_at).toBe(a.props['created_at'])
      expect(entry.user_id).toBe(a.props['author_id'])
    }
    // Before the AI there is no AI draft.
    expect(articles.filter((a) => Date.parse(a.props['created_at'] as string) < NOW - AI_SINCE_DAYS * DAY)
      .every((a) => !a.trail.audits.some((x) => x.action === 'kb_article.drafted_by_ai'))).toBe(true)
  })
})

