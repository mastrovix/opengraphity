/**
 * THE DEMO TENANT'S PROBLEMS (23 Sep 2026).
 *
 * A problem is opened by a support engineer on a CI that keeps failing, with
 * the incidents it caused (`CAUSED_BY`). Then, as the app runs it:
 *  - investigated, documented as a known error (workaround and root cause are
 *    written with "Edit": `updateProblem`), resolved and closed;
 *  - or investigated until a change is requested for it: the RFC created from
 *    the problem links it (`RESOLVED_BY`, automatic) and moves it to "Change
 *    requested"; the change's deployment moves it to "Change in progress", the
 *    change's closure resolves it (the app writes the root cause "Change in
 *    step "closed"" then) — and a person closes it;
 *  - or deferred for a while, or rejected.
 * Team and person are assigned right after the creation; for problems the app
 * writes no history row or comment for that, only the team history and the
 * Audit Log.
 *
 * One cause, told once (tour of 23 Sep 2026): the story of a problem names
 * the incidents that are its evidence (D19) — a problem is opened on a CI that
 * had those incidents, and only they are linked — and the change that removes
 * the cause; the root cause and the workaround are written before that change
 * is requested (D18); the problem is filed under its category (D20); and a
 * problem still waiting for its change asked for it weeks ago, not months (D33).
 */
import type { Rng } from './random.js'
import { arrivalInstants, stillOpen } from './arrivals.js'
import { DEMO_RATIOS } from './options.js'
import { DAY, HOUR, MINUTE } from './clock.js'
import type { PlannedCI } from './cmdb.js'
import { PROBLEM_STORIES, WORK_COMMENTS, fill, type ProblemStory } from './ticketTexts.js'
import { plannedResolveDeadline, simulateSla, type SlaStatusRow } from './slaSim.js'
import { auditableArgs } from '../../../graphql/auditMutationsPlugin.js'
import { TicketTrail } from './trail.js'
import type { World } from './world.js'
import type { IncidentSkeleton } from './incidents.js'
import type { ChangeMilestones, ChangeTarget } from './changes.js'

export type ProblemPath = 'known_error' | 'change' | 'deferred_then_fixed' | 'rejected'
export type ProblemOpenState = 'new' | 'under_investigation' | 'known_error' | 'change_requested' | 'change_in_progress' | 'deferred'

export interface ProblemSkeleton {
  id: string
  createdAtMs: number
  ciId: string
  /** The incidents that are its evidence: on the CI, of the story's symptoms, before it. */
  incidentIds: string[]
  creatorId: string
  teamId: string
  impact: string
  urgency: string
  priority: string
  story: ProblemStory
  path: ProblemPath
  openState: ProblemOpenState | null
  /** For the `change` path: when the RFC is raised from the problem. */
  changeAtMs: number | null
  changeTarget: ChangeTarget | null
}

export interface SimulatedProblem {
  skeleton: ProblemSkeleton
  trail: TicketTrail
  title: string
  description: string
  workaround: string | null
  sla: SlaStatusRow | null
  watchers: Array<{ userId: string; atMs: number }>
  changeId: string | null
  changeLinkedAtMs: number | null
}

/** The CIs a problem can be about, with their incidents (oldest first). */
function incidentsByCI(incidents: readonly IncidentSkeleton[]): Map<string, IncidentSkeleton[]> {
  const byCI = new Map<string, IncidentSkeleton[]>()
  for (const inc of incidents) {
    const ci = inc.ciIds[0]
    if (!ci) continue
    const list = byCI.get(ci)
    if (list) list.push(inc)
    else byCI.set(ci, [inc])
  }
  return byCI
}

/** A story of this CI's kind whose symptoms it had before `beforeMs`, with that evidence; null if none fits. */
function storyWithEvidence(rng: Rng, label: PlannedCI['label'], evidence: readonly IncidentSkeleton[], beforeMs: number): { story: ProblemStory; incidents: IncidentSkeleton[] } | null {
  const fits = rng.shuffle(PROBLEM_STORIES[label])
    .map((story) => ({ story, incidents: evidence.filter((e) => e.createdAtMs < beforeMs - HOUR && story.symptoms.includes(e.story.id)) }))
    .filter((x) => x.incidents.length > 0)
  return fits[0] ?? null
}

/** Where an open problem stands, by its age: a young one is new or under investigation, an old one a known error or deferred. */
function problemOpenState(rng: Rng, open: boolean, ageDays: number): ProblemOpenState | null {
  if (!open) return null
  return ageDays < 5 ? rng.weighted<ProblemOpenState>([['new', 35], ['under_investigation', 65]])
    : ageDays < 45 ? rng.weighted<ProblemOpenState>([['under_investigation', 70], ['known_error', 30]])
    : rng.weighted<ProblemOpenState>([['under_investigation', 25], ['known_error', 45], ['deferred', 30]])
}

export function planProblemSkeletons(
  rng: Rng, w: World, count: number, incidents: readonly IncidentSkeleton[],
  /** Exactly this many problems get a change: closed ones and ones whose change is still open. */
  withChange: { closed: number; open: number },
): ProblemSkeleton[] {
  // Incidents on the same CI are the evidence of a problem.
  const byCI = incidentsByCI(incidents)
  const cis = [...byCI.keys()].filter((id) => PROBLEM_STORIES[w.cmdb.byId.get(id)!.label].length > 0)
  if (count > 0 && cis.length === 0) {
    throw new Error(`Demo tenant: no CI has incidents to be the evidence of a problem, and ${String(count)} problems were asked`)
  }
  const out: ProblemSkeleton[] = []
  const usedCI = new Map<string, number>()
  /*
   * Gli arrivi seguono la stessa curva dei mesi degli altri ticket, e «ancora
   * aperto» dipende dall'ETÀ: un problem vive più a lungo di un incident —
   * l'indagine dura — quindi la metà vita è di quattro mesi.
   */
  const arrivals = arrivalInstants(rng, w.clock, count, w.clock.startMs + 20 * DAY, w.clock.nowMs - 2 * HOUR)
  const opens = stillOpen(rng, arrivals, w.clock.nowMs, DEMO_RATIOS.lifetimes.problem)
  for (let i = 0; i < count; i++) {
    const created = arrivals[i]!
    // A CI that had the symptoms of one of its stories before the problem was
    // opened; a CI gets at most three problems over the years (D19).
    type Found = { ciId: string; story: ProblemStory; incidents: IncidentSkeleton[] }
    const tryCI = (ciId: string): Found | null => {
      if ((usedCI.get(ciId) ?? 0) >= 3) return null
      const fit = storyWithEvidence(rng, w.cmdb.byId.get(ciId)!.label, byCI.get(ciId)!, created)
      return fit ? { ciId, ...fit } : null
    }
    let found: Found | null = null
    for (let k = 0; k < 40 && !found; k++) found = tryCI(rng.pick(cis))
    /*
     * Forty random tries miss on the first weeks, when few incidents exist:
     * the problem was DROPPED without a word, and the tenant had 795 of the
     * 800 asked (24 Sep 2026). Every candidate now, in a random order; none
     * at all is a tenant that cannot hold its problems, and it says so.
     */
    if (!found) for (const ciId of rng.shuffle(cis)) { found = tryCI(ciId); if (found) break }
    if (!found) {
      throw new Error(`Demo tenant: no CI had the symptoms of a problem before ${new Date(created).toISOString()} (problem ${String(i + 1)} of ${String(count)}): more incidents are needed for the problems asked`)
    }
    usedCI.set(found.ciId, (usedCI.get(found.ciId) ?? 0) + 1)
    const ci = w.cmdb.byId.get(found.ciId)!
    const incidentIds = found.incidents.slice(-rng.int(1, 5)).map((e) => e.id)
    const impact = rng.weighted([['low', 25], ['medium', 45], ['high', 30]])
    const urgency = rng.weighted([['low', 35], ['medium', 45], ['high', 20]])
    let path: ProblemPath = rng.weighted([['known_error', 80], ['deferred_then_fixed', 9], ['rejected', 11]])
    const ageDays = (w.clock.nowMs - created) / DAY
    const openState = problemOpenState(rng, opens[i]!, ageDays)
    // La strada deve poter passare dal punto in cui il problem è fermo: uno
    // che oggi è un «errore noto» non può essere su una strada che finisce
    // col rifiuto, perché quel passo non esiste su quella strada.
    if (openState === 'known_error') path = 'known_error'
    else if (openState === 'deferred') path = 'deferred_then_fixed'
    // Un problem CHIUSO che è passato da un rinvio ha bisogno di spazio: il
    // rinvio dura settimane, e se il problem è nato da poco quella storia
    // finirebbe dopo oggi. Senza spazio, niente rinvio.
    else if (openState === null && path === 'deferred_then_fixed' && ageDays < 60) path = 'known_error'
    const creatorId = w.memberOf(rng, ci.supportTeamId!, created).id
    out.push({
      id: rng.uuid(), createdAtMs: created, ciId: found.ciId, incidentIds, creatorId,
      teamId: ci.supportTeamId!, impact, urgency, priority: w.priority.derive(impact, urgency), story: found.story, path, openState,
      changeAtMs: null, changeTarget: null,
    })
  }
  assignChanges(rng, w, out, withChange)
  return out.sort((a, b) => a.createdAtMs - b.createdAtMs)
}

/*
 * LA STRADA DELLA CHANGE, per quanti ce ne stanno davvero (22 set 2026).
 *
 * Prima si chiedeva un numero fisso di problem APERTI con una change in
 * corso — il 20% di quelli collegati — e con 800 problem in tutto gli
 * aperti sono venticinque: la generazione si è fermata su «not enough
 * problems for 400 changes». È la stessa lezione delle percentuali: gli
 * aperti non si ordinano, si contano. Quindi si prende quello che c'è fra
 * gli aperti e il resto lo portano i chiusi, che sono tanti.
 *
 * D33 (23 Sep 2026): the RFC of a problem still open was raised a few days
 * after the problem — months ago for an old one, so its change sat in
 * approval for eight months. A problem waiting for its change asked for it
 * in the last two months.
 */
function assignChanges(rng: Rng, w: World, out: ProblemSkeleton[], withChange: { closed: number; open: number }): void {
  const eligibleOpen = out.filter((p) => p.openState !== null && p.openState !== 'new' && p.createdAtMs < w.clock.nowMs - 8 * DAY)
  const eligibleClosed = out.filter((p) => p.openState === null && p.createdAtMs < w.clock.nowMs - 90 * DAY)
  const wantOpen = Math.min(withChange.open, eligibleOpen.length)
  const wantClosed = Math.min(withChange.closed + (withChange.open - wantOpen), eligibleClosed.length)
  const openOnes = rng.sample(eligibleOpen, wantOpen)
  const closedOnes = rng.sample(eligibleClosed, wantClosed)
  if (closedOnes.length + openOnes.length < Math.min(withChange.closed + withChange.open, eligibleClosed.length + eligibleOpen.length)) {
    throw new Error(`planProblemSkeletons: only ${String(closedOnes.length + openOnes.length)} problems can carry a change, ${String(withChange.closed + withChange.open)} asked`)
  }
  for (const p of openOnes) p.openState = rng.pick<ProblemOpenState>(['change_requested', 'change_in_progress'])
  for (const p of [...closedOnes, ...openOnes]) {
    p.path = 'change'
    p.changeTarget = p.openState === 'change_requested' ? rng.pick<ChangeTarget>(['assessment', 'approval', 'scheduled'])
      : p.openState === 'change_in_progress' ? rng.pick<ChangeTarget>(['deployment', 'review'])
      : 'closed'
    p.changeAtMs = p.changeTarget === 'closed'
      ? p.createdAtMs + rng.int(2, 10) * DAY
      : Math.min(Math.max(p.createdAtMs + 2 * DAY, w.clock.nowMs - rng.int(5, 60) * DAY), w.clock.nowMs - 3 * DAY)
  }
}

export function simulateProblem(
  rng: Rng, w: World, s: ProblemSkeleton, change: (ChangeMilestones & { id: string; requesterId: string }) | null,
): SimulatedProblem {
  const def = w.workflows.forTicket('problem', null)
  const trail = new TicketTrail(w.trail, 'problem', s.id, def, s.createdAtMs)
  const ci: PlannedCI = w.cmdb.byId.get(s.ciId)!
  const creator = w.actor(s.creatorId)
  const team = w.teamsById.get(s.teamId)!
  const now = w.clock.nowMs
  const title = fill(s.story.title, ci.name)
  const description = fill(s.story.description, ci.name)
  let workaround: string | null = null
  trail.audit(s.createdAtMs, creator, 'problem.created')
  const watchers = [{ userId: creator.id, atMs: s.createdAtMs }]

  const deadlines = plannedResolveDeadline(w.config.slaPolicies, w.sla,
    { entityType: 'problem', priority: s.priority, category: null, teamId: s.teamId, createdAtMs: s.createdAtMs })
  const resolveBy = deadlines?.resolveMs ?? s.createdAtMs + 20 * DAY
  const cap = now - 10 * MINUTE

  // Team and person, right away (no history row, no comment: only the Audit Log).
  let t = Math.min(s.createdAtMs + rng.int(5, 90) * MINUTE, cap)
  trail.setTeam(t, team.id, w.isMember)
  trail.audit(t, creator, 'mutation.assignProblemToTeam',
    { args: auditableArgs({ problemId: s.id, teamId: team.id }), source: 'audit-registry' })
  const assignee = w.memberOf(rng, team.id, t)
  t = Math.min(t + rng.int(5, 120) * MINUTE, cap)
  trail.setUser(t, assignee.id)
  trail.audit(t, creator, 'problem.assigned_user', { userId: assignee.id })
  if (s.openState === 'new') return finish()

  const me = w.actor(assignee.id)
  // With a change to come, the investigation starts before the RFC is raised from the problem.
  const investigateBy = change ? change.createdAtMs - 30 * MINUTE : cap
  t = Math.min(t + Math.round(rng.logNormal(1, 0.8) * DAY), cap, Math.max(t, investigateBy - HOUR))
  trail.transition('under_investigation', t, me, 'manual', null)
  if (rng.chance(0.5) && t + 2 * HOUR < investigateBy) {
    t = Math.min(t + rng.int(2, 48) * HOUR, cap, investigateBy)
    const id = trail.personComment(t, me, workNote(rng), true)
    trail.audit(t, me, 'comment.added', { commentId: id, isInternal: true })
  }
  if (s.openState === 'under_investigation') return finish()

  const end = s.openState ? cap : Math.min(Math.max(t + DAY, resolveBy - rng.int(1, 10) * DAY), cap)

  if (s.path === 'rejected') {
    t = Math.max(Math.min(t + rng.int(1, 10) * DAY, end), trail.lastEventMs + MINUTE)
    trail.transition('rejected', t, me, 'manual', 'Not a problem: the incidents had different causes.')
    return finish()
  }

  if (s.path === 'deferred_then_fixed' || s.openState === 'deferred') {
    t = Math.max(Math.min(t + rng.int(1, 5) * DAY, end), trail.lastEventMs + MINUTE)
    trail.transition('deferred', t, me, 'manual', 'Deferred until the platform upgrade planned next quarter.')
    if (s.openState === 'deferred') return finish()
    t = Math.max(Math.min(t + rng.int(10, 40) * DAY, cap), trail.lastEventMs + MINUTE)
    trail.transition('under_investigation', t, me, 'manual', null)
  }

  if (s.path === 'change') {
    if (!change) throw new Error(`problem ${s.id}: the change path needs its change`)
    workaround = s.story.workaround
    const rfcAt = followChange(rng, w, s, trail, me, change, cap)
    return finish(change.id, rfcAt)
  }

  // Known error: workaround and root cause written with "Edit", then resolved and closed.
  // Every step starts after the last event (a deferral may have moved the work past `end`).
  /*
   * ADESSO È IL MURO, anche dopo un rinvio (22 set 2026).
   *
   * Un problem rinviato e poi ripreso riparte da dove l'ha lasciato, e qui il
   * limite era «la fine prevista, o tre giorni dopo l'ultimo evento» — senza
   * guardare oggi. Su 800 problem ne è uscito uno chiuso il 25 settembre,
   * tre giorni nel futuro, e la verifica l'ha preso: «PRB00000788: dates out
   * of order». La fine di una storia non può stare oltre il momento in cui la
   * si racconta.
   */
  const limit = Math.min(cap, s.openState ? cap : Math.max(end, trail.lastEventMs + 3 * DAY))
  // Il minuto di distanza fra un passo e l'altro non può sfondare il muro:
  // se non c'è più spazio, i passi si stringono su quello che resta.
  const next = (gapMs: number, upTo = limit): number =>
    Math.min(cap, Math.max(Math.min(trail.lastEventMs + gapMs, upTo), trail.lastEventMs + MINUTE))
  t = next(rng.int(1, 10) * DAY)
  trail.transition('known_error', t, me, 'manual', null)
  t = next(rng.int(10, 240) * MINUTE)
  workaround = s.story.workaround
  trail.rootCause = s.story.rootCause
  trail.updatedAtMs = t
  trail.lastEventMs = t
  trail.audit(t, me, 'problem.updated')
  if (s.openState === 'known_error') return finish()
  t = next(rng.int(2, 20) * DAY)
  trail.transition('resolved', t, me, 'manual', null)
  t = next(rng.int(1, 10) * DAY, cap)
  trail.transition('closed', t, me, 'manual', null)
  return finish()

  function finish(changeId: string | null = null, changeLinkedAtMs: number | null = null): SimulatedProblem {
    const sla = simulateSla(w.config.slaPolicies, w.sla, now, {
      entityType: 'problem', priority: s.priority, category: null, teamId: trail.teamId, createdAtMs: s.createdAtMs, moves: trail.moves,
    })
    return { skeleton: s, trail, title, description, workaround, sla, watchers, changeId, changeLinkedAtMs }
  }
}

/**
 * The problem that asks for its change (D18): the cause found and written
 * with «Edit» first — after a known error, for most — then the RFC raised from
 * the problem, which the app links and moves; the change's deployment and
 * closure move it on; a person closes it. Returns when the RFC was linked.
 */
function followChange(
  rng: Rng, w: World, s: ProblemSkeleton, trail: TicketTrail, me: ReturnType<World['actor']>,
  change: ChangeMilestones & { id: string; requesterId: string }, cap: number,
): number {
  const edit = Math.max(Math.min(change.createdAtMs - rng.int(1, 24) * HOUR, cap), trail.lastEventMs + MINUTE)
  if (rng.chance(0.6)) trail.transition('known_error', Math.max(edit - rng.int(10, 120) * MINUTE, trail.lastEventMs + MINUTE), me, 'manual', null)
  trail.rootCause = s.story.rootCause
  trail.updatedAtMs = Math.max(edit, trail.lastEventMs)
  trail.lastEventMs = trail.updatedAtMs
  trail.audit(trail.updatedAtMs, me, 'problem.updated')
  // The RFC raised from the problem: linked and moved by the app, signed by the change's requester.
  const rfcAt = Math.max(change.createdAtMs, trail.lastEventMs)
  const requester = w.actor(change.requesterId)
  trail.transition('change_requested', rfcAt, requester, 'manual', w.trail.text('change.rfcCreated', { code: change.code }),
    { facts: { hasLinkedChange: true } })
  trail.updatedAtMs = rfcAt
  if (change.deploymentAtMs !== null) {
    trail.transition('change_in_progress', change.deploymentAtMs, w.actor(change.deploymentActorId!), 'automatic',
      w.trail.text('change.changeInStep', { step: 'deployment' }), { triggeredBy: change.deploymentActorId!, facts: { hasLinkedChange: true } })
  }
  if (change.closedAtMs === null) return rfcAt
  const closer = w.actor(change.closerId!)
  trail.transition('resolved', change.closedAtMs, closer, 'automatic', w.trail.text('change.changeInStep', { step: 'closed' }),
    { triggeredBy: change.closerId!, facts: { hasLinkedChange: true } })
  const t = Math.max(Math.min(change.closedAtMs + rng.int(1, 7) * DAY, cap), trail.lastEventMs + MINUTE)
  trail.transition('closed', t, me, 'manual', null)
  return rfcAt
}

function workNote(rng: Rng): string {
  return rng.pick(WORK_COMMENTS)
}
