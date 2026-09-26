/**
 * THE DEMO TENANT'S CHANGES (23 Sep 2026).
 *
 * A change is lived as the app runs it (change resolvers, read line by line):
 * created with its CIs — one owner assessment, one support assessment and one
 * deploy plan per CI, each assigned to the CI's team; a standard change, being
 * pre-approved, only the plan — then assessed (the
 * questions answered, the scores by the app's formula, the risk and the
 * priority from the tenant's matrices), planned (a release window per CI),
 * approved (the change-manager team and each owner team; a standard change
 * is pre-approved and moves on by itself), deployed inside its window,
 * validated, reviewed and closed. Every automatic move is the app's: the
 * history row says `system`, the comment and the audit are signed by the
 * person whose action caused it.
 *
 * Asked by the owner of the product:
 *  - 20% of the changes still open, in every open step;
 *  - 10% linked as the resolution of an incident or a problem — the problem
 *    follows the change (change requested → in progress → resolved), the
 *    incident is resolved when the change closes;
 *  - at least 15% of the changes in CONFLICT: by the app's rule
 *    (lib/changeDeployConflicts.ts), two changes conflict when they release
 *    on the same CI in overlapping release windows and the other one is not
 *    concluded. Open changes are grouped two or three on a shared CI with
 *    overlapping windows, which is what the CAB then sees.
 */
import type { Rng } from './random.js'
import { DAY, HOUR, MINUTE } from './clock.js'
import { arrivalInstants, stillOpen } from './arrivals.js'
import { DEMO_RATIOS } from './options.js'
import type { PlannedCI } from './cmdb.js'
import { CHANGE_STORIES, fill, type ChangeStory } from './ticketTexts.js'
import { auditableArgs, auditEntityId, auditEntityType } from '../../../graphql/auditMutationsPlugin.js'
import { SYSTEM_ACTOR, TicketTrail, type Actor } from './trail.js'
import type { World } from './world.js'
import type { PlannedQuestion } from './config.js'

export type ChangeType = 'standard' | 'normal' | 'emergency'
export type ChangeTarget = 'closed' | 'assessment' | 'approval' | 'scheduled' | 'deployment' | 'review'

export interface ChangeLink { kind: 'incident' | 'problem'; ticketId: string }

export interface ChangeSkeleton {
  id: string
  code: string
  createdAtMs: number
  type: ChangeType
  ciIds: string[]
  requesterId: string
  ownerId: string
  target: ChangeTarget
  story: ChangeStory
  link: ChangeLink | null
  /** The release window planned for every CI of the change. */
  releaseStartMs: number
  releaseEndMs: number
  conflictGroup: number | null
}

export interface ChangeMilestones {
  code: string
  createdAtMs: number
  deploymentAtMs: number | null
  deploymentActorId: string | null
  closedAtMs: number | null
  closerId: string | null
}

export interface ChangeAuditRow {
  id: string
  timestamp: string
  action: string
  detail: string
  detail_key?: string
  detail_params?: string
  byUserId: string | null
}

export interface TaskRow {
  label: 'AssessmentTask' | 'DeployPlanTask' | 'ValidationTest' | 'DeploymentTask' | 'ReviewTask'
  rel: 'HAS_ASSESSMENT' | 'HAS_DEPLOY_PLAN' | 'HAS_VALIDATION' | 'HAS_DEPLOYMENT' | 'HAS_REVIEW'
  createdAtMs: number
  props: Record<string, unknown>
  teamId: string | null
  /** COMPLETED_BY / TESTED_BY / DEPLOYED_BY / REVIEWED_BY. */
  doneBy: { rel: string; userId: string } | null
  /**
   * ASSIGNED_TO: who holds the task. As in the product (G30), the team member
   * who starts the work — the first answer, the saved plan — takes the task
   * nobody holds, and keeps it once it is completed.
   */
  assigneeId: string | null
  /** The team-history segment of a task assigned to a team (assessment, plan). */
  segmentId: string
}

export interface ResponseRow { taskId: string; id: string; answeredAtMs: number; questionId: string; optionId: string; userId: string }
export interface ApprovalRow { props: Record<string, unknown> }

export interface SimulatedChange {
  skeleton: ChangeSkeleton
  trail: TicketTrail
  props: Record<string, unknown>
  affects: Array<{ ciId: string; props: Record<string, unknown> }>
  tasks: TaskRow[]
  responses: ResponseRow[]
  approvals: ApprovalRow[]
  approvedById: string | null
  changeAudits: ChangeAuditRow[]
  watchers: Array<{ userId: string; atMs: number }>
  milestones: ChangeMilestones
}

// ── Planning ─────────────────────────────────────────────────────────────────


/**
 * The first maintenance slot at or after `fromMs`: evenings for normal
 * changes, working hours for standard ones, any time for emergencies. The
 * slot of that day may have gone already — then it is the same slot a day
 * later: a window never opens before the moment it was asked from.
 */
function slotAt(rng: Rng, w: World, fromMs: number, type: ChangeType): { start: number; end: number } {
  const base = new Date(fromMs)
  base.setUTCHours(0, 0, 0, 0)
  const localHour = type === 'standard' ? rng.int(8, 15) : type === 'emergency' ? rng.int(0, 23) : rng.pick([18, 19, 20, 21])
  // Europe/Rome is UTC+1/+2: the UTC hour is one or two less; the tenant zone decides.
  const slotOn = (dayMs: number, minute: number): number => dayMs + (localHour - (w.clock.local(dayMs + 12 * HOUR).hour - 12)) * HOUR + minute
  const minute = rng.pick([0, 30]) * MINUTE
  let day = base.getTime()
  let start = slotOn(day, minute)
  while (start < fromMs) {
    day += DAY
    start = slotOn(day, minute)
  }
  const end = start + rng.pick([1, 2, 2, 3, 4]) * HOUR
  return { start, end }
}

/** The CIs a change is about: one to three of the same application stack. */
function pickCIs(rng: Rng, w: World, atMs: number, primary?: PlannedCI): PlannedCI[] {
  const labels = ['Server', 'Application', 'Database', 'DatabaseInstance', 'Certificate'] as const
  const first = primary ?? w.runningCI(rng, w.cmdb.byLabel[rng.weighted(labels.map((l, i) => [l, [40, 30, 14, 10, 6][i]!] as const))], atMs)
    ?? w.runningCI(rng, w.cmdb.byLabel.Server, atMs)!
  const out = [first]
  if (rng.chance(0.3)) {
    const related = first.label === 'Application' ? (w.cmdb.appServers.get(first.id) ?? [])
      : first.label === 'Database' ? [w.cmdb.databaseInstance.get(first.id)!].filter(Boolean)
      : first.label === 'Server' ? w.appsOnServer(first.id) : []
    const candidates = related.map((id) => w.cmdb.byId.get(id)!).filter((c) => w.usableCI(c, atMs))
    out.push(...rng.sample(candidates, rng.int(1, 2)))
  }
  return [...new Map(out.map((c) => [c.id, c])).values()].slice(0, 3)
}

/** D32: a change is about its own first CI, and told with a story of that CI's kind — a kind with none has no change to tell. */
function storyFor(rng: Rng, ci: PlannedCI): ChangeStory {
  const stories = CHANGE_STORIES[ci.label]
  if (!stories.length) throw new Error(`planChangeSkeletons: no change story for a ${ci.label} (${ci.name}): a change is told with a story of its own CI's kind (D32)`)
  return rng.pick(stories)
}

function typeOf(rng: Rng): ChangeType {
  return rng.weighted<ChangeType>([['standard', 45], ['normal', 45], ['emergency', 10]])
}

/** How long before the release a change is raised, by type. */
function leadTime(rng: Rng, type: ChangeType): number {
  return type === 'emergency' ? rng.int(4, 20) * HOUR : type === 'standard' ? rng.int(2, 6) * DAY : rng.int(6, 18) * DAY
}

export interface ChangePlanInput {
  count: number
  /** Changes asked by incidents and problems: they are planned first and count in `count`. */
  linked: Array<{ link: ChangeLink; createdAtMs: number; ci: PlannedCI; target: ChangeTarget; requesterId: string
    /** The change that removes the cause the ticket found (D19); otherwise one of the CI's kind. */
    story?: ChangeStory }>
}

export function planChangeSkeletons(rng: Rng, w: World, input: ChangePlanInput): Omit<ChangeSkeleton, 'code'>[] {
  const out: Omit<ChangeSkeleton, 'code'>[] = []
  const owner = (ci: PlannedCI) => w.teamsById.get(ci.ownerTeamId!)!.managerId

  for (const l of input.linked) {
    const type: ChangeType = rng.chance(0.85) ? 'normal' : 'emergency'
    const cis = pickCIs(rng, w, l.createdAtMs, l.ci)
    const r = releaseFor(rng, w, type, l.createdAtMs, l.target)
    out.push({ id: rng.uuid(), createdAtMs: l.createdAtMs, type, ciIds: cis.map((c) => c.id), requesterId: l.requesterId,
      ownerId: owner(cis[0]!), target: l.target, story: l.story ?? storyFor(rng, cis[0]!), link: l.link,
      releaseStartMs: r.start, releaseEndMs: r.end, conflictGroup: null })
  }

  const independent = Math.max(0, input.count - input.linked.length)
  /*
   * LE DATE VENGONO PRIMA DELLO STATO (22 set 2026).
   *
   * Prima era il contrario: si sceglieva «questa resta in approvazione» e poi
   * le si dava una data di pochi giorni fa, perché lo stato «ci stesse». Con
   * tremila change aperte su quindicimila, il grafico delle change al mese
   * mostrava trentasei mesi attorno a 350 e un muro a 2907 sull'ultimo.
   * Adesso gli arrivi seguono la curva dei mesi, si sceglie quali sono ancora
   * aperte in base all'ETÀ (metà vita due mesi: una change vive più di un
   * incident), e il PASSO dove si sono fermate lo decide l'età: quella di
   * stamattina è in valutazione o in deployment, quella di tre mesi fa è
   * ferma in approvazione o in attesa della sua finestra.
   */
  const arrivals = arrivalInstants(rng, w.clock, independent, w.clock.startMs + 20 * DAY, w.clock.nowMs - 2 * HOUR)
  const opens = stillOpen(rng, arrivals, w.clock.nowMs, DEMO_RATIOS.lifetimes.change)
  for (let i = 0; i < independent; i++) {
    const created = arrivals[i]!
    const ageDays = (w.clock.nowMs - created) / DAY
    // Una change nata poche ore fa non può essere già chiusa: valutazione,
    // approvazione, finestra e revisione non ci stanno in un pomeriggio.
    const open = opens[i]! && ageDays <= MAX_OPEN_CHANGE_DAYS
    const target: ChangeTarget = !open && ageDays >= 1.5 ? 'closed' : openTargetFor(rng, ageDays)
    let type = typeOf(rng)
    if (target === 'approval' && type === 'standard') type = 'normal'
    const cis = pickCIs(rng, w, created)
    const supportTeam = cis[0]!.supportTeamId!
    const r = releaseFor(rng, w, type, created, target)
    out.push({ id: rng.uuid(), createdAtMs: created, type, ciIds: cis.map((c) => c.id),
      requesterId: w.memberOf(rng, supportTeam, created).id, ownerId: owner(cis[0]!), target,
      story: storyFor(rng, cis[0]!), link: null, releaseStartMs: r.start, releaseEndMs: r.end, conflictGroup: null })
  }
  groupConflicts(rng, w, out)
  return out
}

/**
 * D33 (tour of 23 Sep 2026): changes sat in approval since January — eight
 * months. A change nobody approves in two months is rejected or withdrawn,
 * and one waiting for its window waits a quarter at most: no change is open
 * longer than this.
 */
export const MAX_OPEN_CHANGE_DAYS = 90

/**
 * DOVE PUÒ ESSERSI FERMATA UNA CHANGE DI QUELL'ETÀ.
 *
 * Non «vecchia = ferma in approvazione»: una change che sta uscendo ADESSO è
 * stata creata settimane fa, valutata, approvata e messa in calendario. Quello
 * che l'età esclude è il contrario — una change di stamattina non può essere
 * già in revisione, e una di sei mesi fa non è ancora in valutazione.
 */
const OPEN_TARGET_AGES: ReadonlyArray<readonly [Exclude<ChangeTarget, 'closed'>, minDays: number, maxDays: number, weight: number]> = [
  ['assessment', 0, 25, 20],
  ['approval', 2, 60, 25],
  ['scheduled', 4, MAX_OPEN_CHANGE_DAYS, 30],
  ['deployment', 6, MAX_OPEN_CHANGE_DAYS, 10],
  ['review', 8, MAX_OPEN_CHANGE_DAYS, 15],
]

function openTargetFor(rng: Rng, ageDays: number): Exclude<ChangeTarget, 'closed'> {
  const fit = OPEN_TARGET_AGES.filter(([, min, max]) => ageDays >= min && ageDays <= max)
  // Più vecchia di ogni fascia: è ferma dove si sta fermi, in attesa di un'approvazione o della propria finestra.
  if (!fit.length) return rng.weighted([['approval', 45], ['scheduled', 55]])
  return rng.weighted(fit.map(([target, , , weight]) => [target, weight] as const))
}

/** The release window for a change created at `created` that is now in `target`. */
function releaseFor(rng: Rng, w: World, type: ChangeType, created: number, target: ChangeTarget): { start: number; end: number } {
  const now = w.clock.nowMs
  if (target === 'deployment') {
    // In its window now.
    const start = now - rng.int(30, 150) * MINUTE
    return { start, end: Math.max(now + 30 * MINUTE, start + rng.pick([3, 4]) * HOUR) }
  }
  if (target === 'review') {
    // Behind it, an hour ago at the latest — and after the change was raised, with time for its phases (two hours, as a closed one).
    const s = slotAt(rng, w, Math.max(created + 2 * HOUR, now - rng.int(1, 5) * DAY), type)
    if (s.end < now - HOUR) return s
    const late = { start: now - 30 * HOUR, end: now - 27 * HOUR }
    if (late.start < created + 2 * HOUR) throw new Error(`planChangeSkeletons: a change raised at ${new Date(created).toISOString()} has no room for a release before now: it cannot be in review`)
    return late
  }
  if (target === 'closed') {
    /*
     * UNA CHANGE CHIUSA HA LA FINESTRA NEL PASSATO (22 set 2026).
     *
     * Prima la finestra era «creazione + tempo di preparazione», e basta. Con
     * le durate vere una change può chiudersi in tre giorni — le standard lo
     * fanno — e allora quella somma finiva DOPO adesso: il rilascio stava nel
     * futuro e la chiusura, tagliata a oggi, veniva prima del proprio
     * deployment. Il guardiano della cronologia l'ha visto e ha fermato la
     * corsa: «"→ closed" alle 19:36 del 22 è prima dell'evento precedente
     * (25 settembre)». Qui la finestra si stringe dentro la vita della
     * change, che è l'unico posto dove può stare.
     */
    const latest = now - 8 * HOUR
    const wanted = Math.min(created + leadTime(rng, type), latest)
    const s = slotAt(rng, w, Math.max(created + 2 * HOUR, wanted), type)
    if (s.end <= latest) return s
    const end = Math.max(created + 3 * HOUR, latest)
    return { start: end - 3 * HOUR, end }
  }
  // Still ahead: approval, scheduled, assessment.
  const earliest = Math.max(created + leadTime(rng, type), now + (target === 'assessment' ? 5 : 1) * DAY)
  return slotAt(rng, w, earliest + rng.int(0, 10) * DAY, type)
}

/**
 * The conflicts the owner asked for: open changes grouped two or three on a
 * shared CI, with release windows that overlap. Groups only mix changes whose
 * windows can overlap in time (all ahead, all in the window now, all past).
 */
function groupConflicts(rng: Rng, w: World, changes: Array<Omit<ChangeSkeleton, 'code'>>): void {
  const candidates = changes.filter((c) => c.target !== 'closed' && c.link === null)
  /*
   * QUANTE NE METTO IN CONFLITTO, e su quale insieme (22 set 2026).
   *
   * Il proprietario ne ha chiesto «almeno il 15%». Su TUTTE le change non è
   * ottenibile senza mentire: `changeDeployConflicts` non segnala mai due
   * change concluse fra loro — sta scritto lì e ha ragione — e con le durate
   * vere le change vive sono qualche centinaio. Quindi il 15% si misura su
   * quelle APERTE, che è anche l'unica domanda che il CAB si pone: cosa deve
   * ancora uscire, e cosa si pesta i piedi. Si punta al 35%, che su un CMDB
   * condiviso è quello che si vede davvero.
   */
  const want = Math.ceil(candidates.length * 0.35)
  const classOf = (c: Omit<ChangeSkeleton, 'code'>): string =>
    c.target === 'deployment' ? 'now' : c.target === 'review' ? 'past' : 'ahead'
  const byClass = new Map<string, Array<Omit<ChangeSkeleton, 'code'>>>()
  for (const c of rng.shuffle(candidates)) {
    const k = classOf(c)
    const list = byClass.get(k) ?? []
    list.push(c)
    byClass.set(k, list)
  }
  let grouped = 0
  let group = 0
  for (const [, list] of byClass) {
    for (let i = 0; i + 1 < list.length && grouped < want; ) {
      const size = Math.min(list.length - i, rng.chance(0.3) ? 3 : 2)
      if (size < 2) break
      const members = list.slice(i, i + size)
      i += size
      const shared = members[0]!.ciIds[0]!
      const anchor = members[0]!
      for (const m of members.slice(1)) {
        // The shared CI joins the change, but not in first place: the title and
        // the story are about the change's own first CI (D32: «Monthly OS
        // patching» landed on an application when the shared one went first).
        if (!m.ciIds.includes(shared)) m.ciIds = [...m.ciIds.slice(0, 2), shared]
        // Same window, shifted by up to half an hour: they overlap.
        const shift = rng.int(-30, 30) * MINUTE
        const length = anchor.releaseEndMs - anchor.releaseStartMs
        m.releaseStartMs = anchor.releaseStartMs + shift
        // A change in deployment is inside its window now: the window has started.
        if (m.target === 'deployment') m.releaseStartMs = Math.min(m.releaseStartMs, w.clock.nowMs - 10 * MINUTE)
        m.releaseEndMs = m.releaseStartMs + length
        if (m.target === 'deployment') m.releaseEndMs = Math.max(m.releaseEndMs, w.clock.nowMs + 20 * MINUTE)
        if (m.createdAtMs > m.releaseStartMs - HOUR) m.createdAtMs = Math.max(w.clock.startMs, m.releaseStartMs - 3 * DAY)
      }
      for (const m of members) m.conflictGroup = group
      group += 1
      grouped += members.length
    }
  }
}

// ── Simulation ───────────────────────────────────────────────────────────────

interface Sim {
  rng: Rng
  w: World
  s: ChangeSkeleton
  trail: TicketTrail
  audits: ChangeAuditRow[]
  tasks: TaskRow[]
  responses: ResponseRow[]
  approvals: ApprovalRow[]
  affects: Map<string, Record<string, unknown>>
  props: Record<string, unknown>
}

function changeAudit(sim: Sim, atMs: number, action: string, detail: string, byUserId: string | null,
  i18n?: { key: string; params: Record<string, string> }): void {
  sim.audits.push({
    id: sim.rng.uuid(), timestamp: new Date(atMs).toISOString(), action, detail, byUserId,
    ...(i18n ? { detail_key: i18n.key, detail_params: JSON.stringify(i18n.params) } : {}),
  })
}

/** The Audit Log entry the mutation registry writes for a call that wrote no audit of its own. */
function registryAudit(sim: Sim, atMs: number, actor: Actor, mutation: string, returnType: string, args: Record<string, unknown>, resultId: string): void {
  sim.trail.audits.push({
    id: sim.rng.uuid(), user_id: actor.id, user_email: actor.email, action: `mutation.${mutation}`,
    entity_type: auditEntityType(mutation, { toString: () => returnType }, args),
    entity_id: auditEntityId(args, { id: resultId }, mutation),
    details: JSON.stringify({ args: auditableArgs(args), source: 'audit-registry' }), ip_address: null,
    created_at: new Date(atMs).toISOString(),
  })
}

const ROLE_LABEL: Record<'owner' | 'support', string> = { owner: 'Functional', support: 'Technical' }

export function simulateChange(rng: Rng, w: World, s: ChangeSkeleton, questions: readonly PlannedQuestion[], taskCodes: () => string): SimulatedChange {
  const def = w.workflows.forTicket('change', null)
  const trail = new TicketTrail(w.trail, 'change', s.id, def, s.createdAtMs)
  const cis = s.ciIds.map((id) => w.cmdb.byId.get(id)!)
  const primary = cis[0]!
  const requester = w.actor(s.requesterId)
  const sim: Sim = { rng, w, s, trail, audits: [], tasks: [], responses: [], approvals: [], affects: new Map(), props: {} }
  const now = w.clock.nowMs
  const t0 = s.createdAtMs
  const initialPriority = w.priority.changeInitialPriority(s.type)
  sim.props = {
    id: s.id, code: s.code, number: s.code, title: fill(s.story.title, primary.name), why: s.story.why.replace(/\{ci\}/g, primary.name),
    what: fill(s.story.what, primary.name), change_type: s.type, priority: initialPriority,
    created_at: new Date(t0).toISOString(),
  }
  const milestones: ChangeMilestones = { code: s.code, createdAtMs: t0, deploymentAtMs: null, deploymentActorId: null, closedAtMs: null, closerId: null }

  // ── Creation: tasks per CI, in input order ─────────────────────────────────
  // A standard change is pre-approved (the tenant's factory list): the app asks
  // it only for the release plan, no functional or technical assessment (owner,
  // 25 Sep 2026), so it has no risk score and no approval route either.
  const preApproved = s.type === 'standard'
  const parts = preApproved ? ['plan'] as const : ['owner', 'support', 'plan'] as const
  const taskOf = new Map<string, { owner: TaskRow | null; support: TaskRow | null; plan: TaskRow }>()
  for (const ci of cis) {
    sim.affects.set(ci.id, { ci_phase: 'assessment' })
    const mk = (label: TaskRow['label'], rel: TaskRow['rel'], suffix: string, teamId: string, extra: Record<string, unknown>): TaskRow => ({
      label, rel, createdAtMs: t0, teamId, doneBy: null, assigneeId: null, segmentId: rng.uuid(),
      props: { id: rng.uuid(), code: taskCodes(), ci_id: ci.id, change_key: `${s.id}-${ci.id}${suffix}`, status: 'pending', created_at: new Date(t0).toISOString(), ...extra },
    })
    const owner = preApproved ? null : mk('AssessmentTask', 'HAS_ASSESSMENT', '-owner', ci.ownerTeamId!, { responder_role: 'owner' })
    const support = preApproved ? null : mk('AssessmentTask', 'HAS_ASSESSMENT', '-support', ci.supportTeamId!, { responder_role: 'support' })
    const plan = mk('DeployPlanTask', 'HAS_DEPLOY_PLAN', '-deployplan', ci.supportTeamId!, { steps: '[]' })
    if (owner && support) sim.tasks.push(owner, support)
    sim.tasks.push(plan)
    taskOf.set(ci.id, { owner, support, plan })
  }
  const watchers = [{ userId: requester.id, atMs: t0 }]
  changeAudit(sim, t0, 'change_created', `Change ${s.code} created with ${String(cis.length)} CIs`, requester.id,
    { key: 'changeCreated', params: { code: s.code, count: String(cis.length) } })
  const createArgs = { input: { title: sim.props['title'], why: sim.props['why'], what: sim.props['what'], changeOwner: s.ownerId,
    affectedCIIds: s.ciIds, changeType: s.type, ...(s.link?.kind === 'problem' ? { problemId: s.link.ticketId } : {}),
    ...(s.link?.kind === 'incident' ? { incidentId: s.link.ticketId } : {}) } }
  // A problem link moves the problem (its step audit counts), so the registry writes nothing then.
  if (s.link?.kind !== 'problem') registryAudit(sim, t0, requester, 'createChange', 'Change!', createArgs, s.id)

  // ── Assessment: answers, scores, plans ─────────────────────────────────────
  // The phases share the time up to the release: assessment in the first half,
  // approvals by 85% of it (an emergency change does it all in hours).
  const lead = Math.max(2 * HOUR, s.releaseStartMs - t0)
  const assessBy = s.target === 'assessment' ? now - 10 * MINUTE : Math.min(t0 + Math.round(lead * 0.5), now - 10 * MINUTE)
  const assessFrom = t0 + Math.min(20 * MINUTE, Math.round(lead * 0.02))
  type Work = { at: number; run: () => void }
  const work: Work[] = []
  const between = (a: number, b: number) => (b > a ? a + Math.floor(rng.next() * (b - a)) : a)
  const doneFraction = s.target === 'assessment' ? rng.float(0.2, 0.85) : 1
  // Which assessments and plans get completed. A change still in assessment
  // keeps at least one open: completing the last one makes the app move it on.
  const finishes = new Map<string, boolean>()
  for (const ci of cis) for (const part of parts) finishes.set(`${ci.id}:${part}`, rng.chance(doneFraction))
  if (s.target === 'assessment' && [...finishes.values()].every(Boolean)) finishes.set(`${rng.pick(cis).id}:${rng.pick([...parts])}`, false)
  let finishedCount = 0
  const totalFinishers = cis.length * parts.length
  let lastFinishAt = 0
  let updatedAtMs = t0
  /** Everything that sets `c.updated_at` in the app. */
  const touch = (at: number): void => { if (at > updatedAtMs) updatedAtMs = at }
  for (const ci of cis) {
    const tk = taskOf.get(ci.id)!
    for (const [role, task] of [['owner', tk.owner], ['support', tk.support]] as const) {
      if (!task) continue
      const qs = questions.filter((q) => q.category === (role === 'owner' ? 'functional' : 'technical'))
      const person = w.memberOf(rng, task.teamId!, t0)
      const start = between(assessFrom, assessBy - Math.min(HOUR, Math.round((assessBy - assessFrom) * 0.5)))
      const completes = finishes.get(`${ci.id}:${role}`)!
      const answers = completes ? qs.length : rng.int(0, qs.length - 1)
      qs.slice(0, answers).forEach((q, i) => {
        const opt = pickOption(rng, q)
        const at = start + i * 3 * MINUTE + rng.int(0, 60) * 1000
        work.push({ at, run: () => {
          sim.responses.push({ taskId: task.props['id'] as string, id: rng.uuid(), answeredAtMs: at, questionId: q.id, optionId: opt.id, userId: person.id })
          task.props['status'] = 'in-progress'
          task.assigneeId ??= person.id
          changeAudit(sim, at, 'assessment_response_submitted', `${ROLE_LABEL[role]} · ${ci.name}: "${q.text}" → ${opt.label}`, person.id,
            { key: 'responseSubmitted', params: { role, ci: ci.name, question: q.text, answer: opt.label } })
          registryAudit(sim, at, w.actor(person.id), 'submitAssessmentResponse', 'AssessmentTask!', { taskId: task.props['id'], questionId: q.id, optionId: opt.id }, task.props['id'] as string)
        } })
      })
      if (completes) {
        const at = start + qs.length * 3 * MINUTE + rng.int(2, 10) * MINUTE
        work.push({ at, run: () => {
          const score = taskScore(w, qs, sim.responses.filter((r) => r.taskId === task.props['id']), ci.environment)
          task.props['status'] = 'completed'
          task.props['score'] = score
          task.props['completed_at'] = new Date(at).toISOString()
          task.doneBy = { rel: 'COMPLETED_BY', userId: person.id }
          changeAudit(sim, at, 'assessment_task_completed', `${ROLE_LABEL[role]} · ${ci.name}: score ${String(score)}`, person.id,
            { key: 'taskScored', params: { role, ci: ci.name, score: String(score) } })
          const other = (role === 'owner' ? tk.support : tk.owner)!
          if (other.props['status'] === 'completed') {
            const risk = Math.round(((tk.owner!.props['score'] as number) + (tk.support!.props['score'] as number)) / 2)
            sim.affects.set(ci.id, { ci_phase: 'assessed', risk_score: risk })
            changeAudit(sim, at, 'ci_risk_computed', `${ci.name}: risk ${String(risk)}`, person.id, { key: 'ciRisk', params: { ci: ci.name, score: String(risk) } })
          }
          aggregateRisk(sim, at)
          touch(at)
          finish(at, w.actor(person.id), 'completeAssessmentTask', 'AssessmentTask!', { taskId: task.props['id'] }, task.props['id'] as string)
        } })
      }
    }
    // The deploy plan: saved by the support team (conflict groups always have it), then completed.
    const planner = w.memberOf(rng, tk.plan.teamId!, t0)
    const planSaved = s.target !== 'assessment' || s.conflictGroup !== null || rng.chance(0.5)
    if (planSaved) {
      const at = between(assessFrom, assessBy - Math.min(HOUR, Math.round((assessBy - assessFrom) * 0.4)))
      const steps = s.story.steps.slice(0, rng.int(1, s.story.steps.length)).map((title) => ({
        title,
        validationWindow: { start: new Date(s.releaseStartMs - 24 * HOUR).toISOString(), end: new Date(s.releaseStartMs - 22 * HOUR).toISOString() },
        releaseWindow: { start: new Date(s.releaseStartMs).toISOString(), end: new Date(s.releaseEndMs).toISOString() },
      }))
      work.push({ at, run: () => {
        tk.plan.props['steps'] = JSON.stringify(steps)
        tk.plan.props['status'] = 'in-progress'
        tk.plan.assigneeId ??= planner.id
        tk.plan.props['window_start'] = new Date(s.releaseStartMs - 24 * HOUR).toISOString()
        tk.plan.props['window_end'] = new Date(s.releaseEndMs).toISOString()
        const list = steps.map((x) => `"${x.title}"`).join(', ')
        changeAudit(sim, at, 'deploy_plan_saved', `${ci.name}: ${String(steps.length)} step — ${list}`, planner.id,
          { key: 'planSaved', params: { ci: ci.name, count: String(steps.length), steps: list } })
        registryAudit(sim, at, w.actor(planner.id), 'saveDeployPlan', 'DeployPlanTask!', { taskId: tk.plan.props['id'], steps }, tk.plan.props['id'] as string)
      } })
      if (finishes.get(`${ci.id}:plan`)!) {
        const doneAt = at + rng.int(5, 20) * MINUTE
        work.push({ at: doneAt, run: () => {
          tk.plan.props['status'] = 'completed'
          tk.plan.props['completed_at'] = new Date(doneAt).toISOString()
          tk.plan.doneBy = { rel: 'COMPLETED_BY', userId: planner.id }
          changeAudit(sim, doneAt, 'deploy_plan_completed', `${ci.name}: plan completed (${String(steps.length)} steps)`, planner.id,
            { key: 'planCompleted', params: { ci: ci.name, count: String(steps.length) } })
          aggregateRisk(sim, doneAt)
          touch(doneAt)
          finish(doneAt, w.actor(planner.id), 'completeDeployPlanTask', 'DeployPlanTask!', { taskId: tk.plan.props['id'] }, tk.plan.props['id'] as string)
        } })
      }
    }
  }

  /** A task or plan completion: the last one moves the change to approval (automatic). */
  function finish(at: number, actor: Actor, mutation: string, returnType: string, args: Record<string, unknown>, id: string): void {
    finishedCount += 1
    if (at >= lastFinishAt) lastFinishAt = at
    if (finishedCount < totalFinishers) { registryAudit(sim, at, actor, mutation, returnType, args, id); return }
    // The last completion: the automatic move happens inside this call (no registry row).
    trail.transition('approval', at, actor, 'automatic', null, { triggeredBy: 'system', facts: { allAssessmentsComplete: true } })
    enterApproval(at)
  }

  function enterApproval(at: number): void {
    if (preApproved) {
      // Pre-approved: no approvals; the app moves it on at once, as the system.
      sim.props['approval_status'] = 'approved'
      trail.transition('scheduled', at, SYSTEM_ACTOR, 'automatic', w.trail.text('change.preApproved'), { triggeredBy: 'system', automaticOnManual: true })
      return
    }
    sim.props['approval_status'] = 'pending'
    const cm = w.people.changeManagerTeam
    sim.approvals.push({ props: { id: rng.uuid(), kind: 'change_manager', team_id: cm.id, status: 'pending', created_at: new Date(at).toISOString() } })
    for (const ownerTeam of [...new Set(cis.map((c) => c.ownerTeamId!))]) {
      sim.approvals.push({ props: { id: rng.uuid(), kind: 'owner_group', team_id: ownerTeam, status: 'pending', created_at: new Date(at).toISOString() } })
    }
  }

  work.sort((a, b) => a.at - b.at)
  for (const job of work) job.run()
  if (s.target === 'assessment' || trail.current.name === 'assessment') return done()

  // ── Approvals ──────────────────────────────────────────────────────────────
  if (!preApproved) {
    const approveFrom = trail.lastEventMs
    const approveBy = Math.max(approveFrom + 10 * MINUTE, Math.min(t0 + Math.round(lead * 0.85), now - 5 * MINUTE))
    const order = rng.shuffle(sim.approvals)
    const approveAll = s.target !== 'approval'
    const approveCount = approveAll ? order.length : rng.int(0, order.length - 1)
    for (const [i, a] of order.slice(0, approveCount).entries()) {
      const at = Math.max(approveFrom + Math.round((approveBy - approveFrom) * ((i + 1) / (approveCount + 1))), trail.lastEventMs)
      const teamId = a.props['team_id'] as string
      const approver = w.memberOf(rng, teamId, at)
      const team = w.teamsById.get(teamId)!
      const note = rng.chance(0.2) ? rng.pick(['Approved: impact understood.', 'OK for the planned window.', 'Approved, keep the rollback ready.']) : null
      Object.assign(a.props, { status: 'approved', approved_by_id: approver.id, approved_by_name: approver.name, approved_at: new Date(at).toISOString(), ...(note ? { note } : {}) })
      changeAudit(sim, at, 'change_approved', note ? `${team.name}: ${note}` : team.name, approver.id)
      const last = approveAll && i === approveCount - 1
      if (!last) {
        registryAudit(sim, at, w.actor(approver.id), 'approveChangeApproval', 'Change!', { changeId: s.id, teamId, ...(note ? { note } : {}) }, s.id)
      } else {
        sim.props['approval_status'] = 'approved'
        sim.props['approval_at'] = new Date(at).toISOString()
        touch(at)
        sim.props['approvedById'] = approver.id
        trail.transition('scheduled', at, w.actor(approver.id), 'manual', w.trail.text('change.approvalsComplete'))
      }
    }
    if (s.target === 'approval') return done()
  }
  sim.props['service_window'] = true
  if (s.target === 'scheduled') return done()

  // ── Deployment: at the start of the release window ─────────────────────────
  const depAt = Math.max(s.releaseStartMs, trail.lastEventMs + MINUTE)
  // Entering the release window: pre-approved types are open to any change writer;
  // the others need `approval.override`, which only administrators have.
  const starter = s.type === 'standard' ? requester : w.actor(w.someone(rng, w.people.users.filter((u) => u.role === 'admin'), depAt).id)
  trail.transition('deployment', depAt, starter, 'manual', null)
  changeAudit(sim, depAt, 'change_step_entered', 'deployment', starter.id, { key: 'stepEntered', params: { step: 'deployment', notes: '' } })
  milestones.deploymentAtMs = depAt
  milestones.deploymentActorId = starter.id
  const byName = [...cis].sort((a, b) => a.name.localeCompare(b.name))
  const validations = new Map<string, TaskRow>()
  const deployments = new Map<string, TaskRow>()
  for (const ci of byName) {
    const vt: TaskRow = { label: 'ValidationTest', rel: 'HAS_VALIDATION', createdAtMs: depAt, teamId: null, doneBy: null, assigneeId: null, segmentId: rng.uuid(),
      props: { id: rng.uuid(), code: taskCodes(), ci_id: ci.id, change_key: `${s.id}-${ci.id}`, status: 'pending', created_at: new Date(depAt).toISOString() } }
    const dt: TaskRow = { label: 'DeploymentTask', rel: 'HAS_DEPLOYMENT', createdAtMs: depAt, teamId: null, doneBy: null, assigneeId: null, segmentId: rng.uuid(),
      props: { id: rng.uuid(), code: taskCodes(), ci_id: ci.id, change_key: `${s.id}-${ci.id}-exec`, status: 'pending', created_at: new Date(depAt).toISOString() } }
    sim.tasks.push(vt, dt)
    validations.set(ci.id, vt)
    deployments.set(ci.id, dt)
  }
  // Deploy and validate inside the window (in progress: only what happened by now).
  const windowEnd = Math.min(s.releaseEndMs, now - MINUTE)
  const steps: Array<{ at: number; kind: 'deploy' | 'validate'; ci: PlannedCI }> = []
  for (const ci of cis) {
    const d = between(depAt + 5 * MINUTE, s.releaseEndMs - 30 * MINUTE)
    steps.push({ at: d, kind: 'deploy', ci }, { at: Math.min(d + rng.int(10, 40) * MINUTE, s.releaseEndMs), kind: 'validate', ci })
  }
  steps.sort((a, b) => a.at - b.at)
  const reviewNow = s.target === 'review' || s.target === 'closed'
  const doneSteps = reviewNow ? steps : steps.filter((x) => x.at <= windowEnd && rng.chance(0.7))
  // Still in deployment: at least one task is open, or the app would have moved it to review.
  if (!reviewNow && doneSteps.length === steps.length) doneSteps.pop()
  let lastStepAt = depAt
  doneSteps.forEach((st, i) => {
    const at = Math.max(st.at, trail.lastEventMs)
    lastStepAt = at
    const lastOne = reviewNow && i === doneSteps.length - 1
    if (st.kind === 'deploy') {
      const person = w.memberOf(rng, st.ci.supportTeamId!, at)
      const task = deployments.get(st.ci.id)!
      Object.assign(task.props, { status: 'completed', deployed_at: new Date(at).toISOString() })
      task.doneBy = { rel: 'DEPLOYED_BY', userId: person.id }
      touch(at)
      changeAudit(sim, at, 'deployment_completed', `Deployment completed on ${st.ci.name}`, person.id, { key: 'taskCompleted', params: { task: 'Deployment', ci: st.ci.name } })
      if (!lastOne) registryAudit(sim, at, w.actor(person.id), 'completeDeployment', 'DeploymentTask!', { changeId: s.id, ciId: st.ci.id }, task.props['id'] as string)
      else toReview(at, w.actor(person.id))
    } else {
      const person = w.memberOf(rng, st.ci.ownerTeamId!, at)
      const task = validations.get(st.ci.id)!
      Object.assign(task.props, { status: 'completed', tested_at: new Date(at).toISOString(), result: 'pass' })
      task.doneBy = { rel: 'TESTED_BY', userId: person.id }
      touch(at)
      changeAudit(sim, at, 'validation_completed', `${st.ci.name}: pass`, person.id)
      if (!lastOne) registryAudit(sim, at, w.actor(person.id), 'completeValidationTest', 'ValidationTest!', { changeId: s.id, ciId: st.ci.id, result: 'pass' }, task.props['id'] as string)
      else toReview(at, w.actor(person.id))
    }
  })
  if (!reviewNow) return done()

  function toReview(at: number, actor: Actor): void {
    trail.transition('review', at, actor, 'automatic', null, { triggeredBy: 'system', facts: { allDeploymentsComplete: true } })
    sim.props['service_window'] = false
    for (const ci of byName) {
      sim.tasks.push({ label: 'ReviewTask', rel: 'HAS_REVIEW', createdAtMs: at, teamId: null, doneBy: null, assigneeId: null, segmentId: rng.uuid(),
        props: { id: rng.uuid(), code: taskCodes(), ci_id: ci.id, change_key: `${s.id}-${ci.id}-review`, status: 'pending', created_at: new Date(at).toISOString() } })
    }
  }

  // ── Review, then the automatic close ───────────────────────────────────────
  const reviews = sim.tasks.filter((t) => t.label === 'ReviewTask')
  const closing = s.target === 'closed'
  const reviewDone = closing ? reviews : reviews.filter(() => rng.chance(0.4)).slice(0, Math.max(0, reviews.length - 1))
  let rt = lastStepAt
  reviewDone.forEach((task, i) => {
    rt = Math.min(Math.max(rt + rng.int(1, 30) * HOUR, trail.lastEventMs), now - MINUTE)
    const ci = w.cmdb.byId.get(task.props['ci_id'] as string)!
    const person = w.memberOf(rng, ci.ownerTeamId!, rt)
    Object.assign(task.props, { status: 'completed', reviewed_at: new Date(rt).toISOString(), result: 'confirmed' })
    task.doneBy = { rel: 'REVIEWED_BY', userId: person.id }
    touch(rt)
    changeAudit(sim, rt, 'review_completed', `${ci.name}: confirmed`, person.id)
    if (closing && i === reviewDone.length - 1) {
      trail.transition('closed', rt, w.actor(person.id), 'automatic', null, { triggeredBy: 'system', facts: { allReviewsConfirmed: true } })
      milestones.closedAtMs = rt
      milestones.closerId = person.id
    } else {
      registryAudit(sim, rt, w.actor(person.id), 'completeReview', 'ReviewTask!', { changeId: s.id, ciId: ci.id, result: 'confirmed' }, task.props['id'] as string)
    }
  })
  return done()

  function done(): SimulatedChange {
    const affects = [...sim.affects.entries()].map(([ciId, props]) => ({ ciId, props }))
    const approvedById = (sim.props['approvedById'] as string | undefined) ?? null
    delete sim.props['approvedById']
    touch(trail.updatedAtMs)
    // D3: the status is the step from the creation on (createChangeRFC writes it), not only after a move.
    sim.props['status'] = trail.current.name
    if (trail.completedAtMs !== null) sim.props['completed_at'] = new Date(trail.completedAtMs).toISOString()
    sim.props['updated_at'] = new Date(updatedAtMs).toISOString()
    return { skeleton: s, trail, props: sim.props, affects, tasks: sim.tasks, responses: sim.responses, approvals: sim.approvals,
      approvedById, changeAudits: sim.audits, watchers, milestones }
  }
}

function pickOption(rng: Rng, q: PlannedQuestion): PlannedQuestion['options'][number] {
  // Most changes are low or medium risk: lower scores are likelier.
  return rng.weighted(q.options.map((o) => [o, 1 / (1 + o.score * 1.4)] as const))
}

/** `calculateTaskScore` (change/scoring.ts), with the environment factor of the tenant. */
function taskScore(w: World, qs: readonly PlannedQuestion[], answers: readonly ResponseRow[], environment: string): number {
  let num = 0, den = 0
  for (const q of qs) {
    const a = answers.find((r) => r.questionId === q.id)
    const score = a ? q.options.find((o) => o.id === a.optionId)!.score : 0
    num += q.weight * score
    den += q.weight * Math.max(...q.options.map((o) => o.score))
  }
  const envScore = w.priority.environmentRisk(environment)
  num += w.priority.environmentWeight * envScore
  den += w.priority.environmentWeight * 3
  return Math.round((num / den) * 100)
}

/** `computeAggregateRisk`: once every CI has its risk, the change gets the maximum, the band and the priority. */
function aggregateRisk(sim: Sim, atMs: number): void {
  const risks = [...sim.affects.values()].map((p) => p['risk_score'] as number | undefined)
  if (risks.some((r) => r === undefined)) {
    delete sim.props['aggregate_risk_score']
    delete sim.props['approval_route']
    sim.props['priority'] = sim.w.priority.changeInitialPriority(sim.s.type)
    return
  }
  const max = Math.max(...(risks as number[]))
  const band = sim.w.priority.riskBand(max)
  sim.props['aggregate_risk_score'] = max
  sim.props['approval_route'] = band
  sim.props['priority'] = sim.w.priority.changePriority(sim.s.type, band)
  void atMs
}
