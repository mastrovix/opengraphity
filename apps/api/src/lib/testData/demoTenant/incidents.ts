/**
 * THE DEMO TENANT'S INCIDENTS: THREE YEARS OF THEM (23 Sep 2026).
 *
 * Each incident is lived the way the app is used:
 *  - opened by the service desk on a CI of the CMDB (channel `agent`), or by
 *    an employee from the portal (channel `portal`, no CI, a category);
 *  - with a CI it is born assigned to the CI's support group — the form
 *    prefills it (the owner's rule of 23 Sep 2026) — and stays «New», in the
 *    group's queue, until a person of the group takes it: that is the SLA
 *    response, minutes for a P1 (D63). From the portal, the service desk of
 *    the requester's region assigns it, which moves it to "Assigned";
 *  - worked: "In Progress", sometimes "On Hold" waiting for someone,
 *    sometimes escalated, sometimes handed over to another team;
 *  - resolved with a root cause, and closed by the step deadline 72 hours
 *    later — the app's own timer; a few are reopened first, by the requester
 *    or by the team, and resolved again (D51);
 *  - or resolved by a change: then it waits in progress until the change is
 *    closed, and the app resolves it ("Resolved by change CHG…").
 *
 * The timings aim at the SLA the incident falls under (the tenant's
 * policies): most are answered and resolved in time, some are not — as in
 * any service desk. 20% are still open today, most of them recent.
 */
import type { Rng } from './random.js'
import { DAY, HOUR, MINUTE } from './clock.js'
import { arrivalInstants, stillOpen } from './arrivals.js'
import type { PlannedCI, CILabel } from './cmdb.js'
import type { PlannedTeam } from './people.js'
import { INCIDENT_STORIES, PENDING_NOTES, REQUESTER_COMMENTS, WORK_COMMENTS, fill, type IncidentStory } from './ticketTexts.js'
import { DEMO_RATIOS } from './options.js'
import { plannedResolveDeadline, simulateSla, type SlaStatusRow } from './slaSim.js'
import { AUTOMATION_ACTOR, MONITORING_ACTOR, TicketTrail } from './trail.js'
import type { BornIncident } from './monitoring.js'
import type { World } from './world.js'
import { COUNTRY_REGION } from './names.js'

export type IncidentOpenState = 'new' | 'assigned' | 'in_progress' | 'pending' | 'escalated'

export interface IncidentSkeleton {
  id: string
  createdAtMs: number
  channel: 'agent' | 'portal'
  creatorId: string
  /** null for the incidents the monitoring engine opens: it does not set one. */
  category: IncidentStory['category'] | null
  story: IncidentStory
  /** The way the reporter wrote it (one of the story's titles). */
  titleTemplate: string
  ciIds: string[]
  teamId: string
  impact: string
  urgency: string
  severity: string
  /** null = the incident is done (resolved or closed) today. */
  openState: IncidentOpenState | null
  /** Set when the monitoring engine opened it from an alarm (see monitoring.ts). */
  born?: BornIncident
}

/** A change that resolves the incident, planned by the changes. */
export interface ResolvingChange {
  changeId: string
  code: string
  createdAtMs: number
  closedAtMs: number
  /** The person whose action closed the change: the automatic move is signed by them. */
  closerId: string
  creatorId: string
}

export interface SimulatedIncident {
  skeleton: IncidentSkeleton
  trail: TicketTrail
  title: string
  description: string
  sla: SlaStatusRow | null
  watchers: Array<{ userId: string; atMs: number }>
  resolvingChange: ResolvingChange | null
}

/** Which CI kinds an incident of the CMDB is opened on, and how often. */
const CI_KIND_WEIGHTS: ReadonlyArray<readonly [CILabel, number]> = [
  ['Server', 40], ['Application', 34], ['Database', 12], ['DatabaseInstance', 9], ['Certificate', 5],
]

function pickStory(rng: Rng, stories: readonly IncidentStory[]): IncidentStory {
  return rng.weighted(stories.map((s) => [s, s.weight] as const))
}

/** The service desk of a person's region, if the tenant has one; otherwise any desk. */
function deskOf(rng: Rng, desks: readonly PlannedTeam[], region: string): PlannedTeam {
  return desks.find((d) => d.region === region) ?? rng.pick(desks)
}

/** Creation instants over the period, a little busier each year (the company grows). */
export function planIncidentSkeletons(rng: Rng, w: World, count: number): IncidentSkeleton[] {
  const serviceDesk = w.supportTeams.filter((t) => t.area === 'Service Desk')
  const deskTeams = serviceDesk.length ? serviceDesk : w.supportTeams
  const out: IncidentSkeleton[] = []
  /*
   * Gli arrivi PRIMA, e poi chi è ancora aperto: la curva dei mesi è quella
   * degli arrivi e non cambia di una riga se il 20% è aperto o il 5%. Un
   * incident aperto è quasi sempre recente (metà vita: 45 giorni), ma qualcuno
   * più vecchio resta: è il fondo di coda che ogni service desk ha.
   */
  const createdAt = arrivalInstants(rng, w.clock, count, w.clock.startMs + 5 * DAY, w.clock.nowMs - 2 * HOUR)
  const opens = stillOpen(rng, createdAt, w.clock.nowMs, DEMO_RATIOS.lifetimes.incident)
  for (let i = 0; i < count; i++) {
    const createdAtMs = createdAt[i]!
    const portal = rng.chance(0.25)
    let story: IncidentStory
    let ciIds: string[] = []
    let teamId: string
    let creatorId: string
    if (portal) {
      story = pickStory(rng, INCIDENT_STORIES.portal)
      const requester = w.someone(rng, w.endUsers, createdAtMs)
      creatorId = requester.id
      // The desk of the requester's region takes it (D57: its calendar, its policy).
      teamId = deskOf(rng, deskTeams, COUNTRY_REGION[requester.country]).id
    } else {
      const kind = rng.weighted(CI_KIND_WEIGHTS)
      const ci = w.runningCI(rng, w.cmdb.byLabel[kind], createdAtMs) ?? w.runningCI(rng, w.cmdb.byLabel.Server, createdAtMs)
      if (!ci) throw new Error('planIncidentSkeletons: no running CI at the time of the incident')
      story = pickStory(rng, INCIDENT_STORIES[ci.label])
      ciIds = [ci.id]
      // Sometimes a second CI is affected: an application running on the failing server.
      if (ci.label === 'Server' && rng.chance(0.15)) {
        const apps = w.appsOnServer(ci.id).map((id) => w.cmdb.byId.get(id)!)
          .filter((a) => a.createdAtMs <= createdAtMs && (a.status === 'active' || a.status === 'maintenance'))
        if (apps.length) ciIds.push(rng.pick(apps).id)
      }
      // The form prefills the CI's support group; now and then the desk picks another team of the same tower.
      teamId = ci.supportTeamId!
      const tower = w.teamsById.get(teamId)!.area
      if (rng.chance(0.03)) teamId = rng.pick(w.supportTeams.filter((t) => t.area === tower)).id
      creatorId = w.memberOf(rng, rng.pick(deskTeams).id, createdAtMs).id
    }
    const { impact, urgency, severity } = incidentPriority(rng, w, portal)
    out.push({
      id: rng.uuid(), createdAtMs, channel: portal ? 'portal' : 'agent', creatorId, category: story.category, story,
      titleTemplate: rng.pick(story.titles), ciIds, teamId, impact, urgency, severity,
      openState: openStateByAge(rng, opens[i]!, (w.clock.nowMs - createdAtMs) / DAY),
    })
  }
  return out.sort((a, b) => a.createdAtMs - b.createdAtMs)
}

/** Impact, urgency and priority as the people who open it set them. */
function incidentPriority(rng: Rng, w: World, portal: boolean): { impact: string; urgency: string; severity: string } {
  if (portal) {
    const severity = rng.weighted([['low', 45], ['medium', 38], ['high', 14], ['critical', 3]])
    return { ...w.priority.invert(severity), severity }
  }
  const impact = rng.weighted([['low', 40], ['medium', 42], ['high', 18]])
  const urgency = rng.weighted([['low', 35], ['medium', 45], ['high', 20]])
  return { impact, urgency, severity: w.priority.derive(impact, urgency) }
}

/*
 * Dove si è fermato, secondo l'ETÀ: uno di stamattina è ancora `new`, uno
 * di due mesi fa non lo è — sarà in attesa di qualcuno o scalato. È la
 * stessa cosa che si vede in un elenco vero ordinato per data.
 */
function openStateByAge(rng: Rng, open: boolean, ageDays: number): IncidentOpenState | null {
  if (!open) return null
  return ageDays < 2 ? rng.weighted<IncidentOpenState>([['new', 25], ['assigned', 35], ['in_progress', 40]])
    : ageDays < 10 ? rng.weighted<IncidentOpenState>([['assigned', 10], ['in_progress', 60], ['pending', 20], ['escalated', 10]])
    : rng.weighted<IncidentOpenState>([['in_progress', 30], ['pending', 55], ['escalated', 15]])
}

/** A fraction of the time to a deadline: most tickets well inside it, a tail late. */
function towards(rng: Rng, fromMs: number, deadlineMs: number, median: number, spread: number): number {
  const span = Math.max(5 * MINUTE, deadlineMs - fromMs)
  return fromMs + Math.max(MINUTE, Math.round(span * rng.logNormal(median, spread)))
}

/**
 * How long a person of the team takes to pick it up (D63): minutes for a P1
 * and a P2 — the on-call engineer is paged — and a share of the response
 * target for the others.
 */
function pickUpAt(rng: Rng, s: IncidentSkeleton, responseBy: number): number {
  if (s.severity === 'critical') return s.createdAtMs + Math.round(rng.logNormal(4 * MINUTE, 0.6))
  if (s.severity === 'high') return s.createdAtMs + Math.round(rng.logNormal(10 * MINUTE, 0.7))
  return towards(rng, s.createdAtMs, responseBy, 0.3, 0.7)
}

/**
 * THE FIRST HOURS: the team, then the person who takes it.
 *
 * With a CI (the form): born in the group, a zero-length row on «New» and
 * one note (`assignIncidentToTeam` at creation, D12); then the person — the
 * assignment from the first step moves it to «Assigned», which is the SLA
 * response. From the portal: the desk assigns its team, which moves it on,
 * then a person of the desk.
 */
function firstHours(rng: Rng, w: World, s: IncidentSkeleton, trail: TicketTrail, responseBy: number, cap: number): { assignee: { id: string; name: string } | null; t: number } {
  const def = trail.def
  const team = w.teamsById.get(s.teamId)!
  const creator = w.actor(s.creatorId)
  const assignedStep = firstAssignmentStep(def)
  const teamNote = w.trail.text('incident.assignedTeam', { team: team.name })
  if (s.channel === 'agent') {
    const at = Math.min(s.createdAtMs + rng.int(2, 8) * 1000, cap)
    trail.setTeam(at, team.id, w.isMember)
    trail.zeroLengthRow(at, creator, teamNote)
    trail.systemComment(at, creator, teamNote)
    if (s.openState === 'new') return { assignee: null, t: at }
    const t = Math.max(Math.min(pickUpAt(rng, s, responseBy), cap), trail.lastEventMs)
    const assignee = w.memberOf(rng, team.id, t)
    const by = w.actor(rng.chance(0.7) ? assignee.id : team.managerId)
    trail.setUser(t, assignee.id)
    trail.transition(assignedStep, t, by, 'automatic', w.trail.text('incident.assignedUser', { user: assignee.name }), { automaticOnManual: true })
    trail.audit(t, by, 'incident.assigned_user', { userId: assignee.id, to: assignee.name, from: null })
    return { assignee, t }
  }
  if (s.openState === 'new') return { assignee: null, t: s.createdAtMs }
  const at = Math.min(pickUpAt(rng, s, responseBy), cap)
  const assigner = w.actor(w.memberOf(rng, team.id, at).id)
  trail.setTeam(at, team.id, w.isMember)
  trail.transition(assignedStep, at, assigner, 'automatic', teamNote, { automaticOnManual: true })
  trail.audit(at, assigner, 'incident.assigned_team', { teamId: team.id, to: team.name, from: null })
  const assignee = w.memberOf(rng, team.id, at)
  const t = Math.min(at + Math.round(rng.logNormal(12, 0.9) * MINUTE), cap)
  const by = w.actor(rng.chance(0.7) ? assignee.id : team.managerId)
  // Past the first step: a row and a note with the same sentence (D11), no transition.
  const note = w.trail.text('incident.assignedUser', { user: assignee.name })
  trail.setUser(t, assignee.id)
  trail.zeroLengthRow(t, by, note)
  trail.systemComment(t, by, note)
  trail.audit(t, by, 'incident.assigned_user', { userId: assignee.id, to: assignee.name, from: null })
  return { assignee, t }
}

export function simulateIncident(
  rng: Rng, w: World, s: IncidentSkeleton, resolvingChange: ResolvingChange | null,
): SimulatedIncident {
  if (s.born) return simulateMonitoringIncident(rng, w, s, s.born)
  const def = w.workflows.forTicket('incident', s.category)
  const trail = new TicketTrail(w.trail, 'incident', s.id, def, s.createdAtMs)
  const creator = w.actor(s.creatorId)
  const ci: PlannedCI | undefined = s.ciIds[0] ? w.cmdb.byId.get(s.ciIds[0]) : undefined
  const title = fill(s.titleTemplate, ci?.name ?? '')
  const description = fill(s.story.description, ci?.name ?? '')
  trail.audit(s.createdAtMs, creator, s.channel === 'portal' ? 'portal.ticket.created' : 'incident.created')
  const watchers = [{ userId: creator.id, atMs: s.createdAtMs }]

  const deadlines = plannedResolveDeadline(w.config.slaPolicies, w.sla,
    { entityType: 'incident', priority: s.severity, category: s.category, teamId: s.teamId, createdAtMs: s.createdAtMs })
  const responseBy = deadlines?.responseMs ?? s.createdAtMs + 4 * HOUR
  const resolveBy = deadlines?.resolveMs ?? s.createdAtMs + 2 * DAY
  const cap = w.clock.nowMs - 5 * MINUTE
  const done = s.openState === null
  const stopAt = (state: IncidentOpenState): boolean => s.openState === state

  // ── The team and the person ────────────────────────────────────────────────
  const first = firstHours(rng, w, s, trail, responseBy, cap)
  if (!first.assignee) return finish()
  let assignee = first.assignee
  let t = first.t
  if (stopAt('assigned')) return finish()

  // Security incidents pass the security review first.
  if (def.steps.has('security_review') && def.transitions.some((x) => x.from === trail.current.name && x.to === 'security_review')) {
    t = Math.min(t + Math.round(rng.logNormal(20, 0.7) * MINUTE), cap)
    trail.transition('security_review', t, w.actor(assignee.id), 'manual', null)
  }
  t = Math.min(t + Math.round(rng.logNormal(10, 0.8) * MINUTE), cap)
  trail.transition('in_progress', Math.max(t, trail.lastEventMs), w.actor(assignee.id), 'manual', null)
  t = trail.lastEventMs
  if (stopAt('in_progress') && rng.chance(0.6)) return finish()

  // ── The work: plan the resolution, then put the detours before it ─────────
  const planned = resolvingChange
    ? resolvingChange.closedAtMs
    : Math.max(t + 10 * MINUTE, towards(rng, s.createdAtMs, resolveBy, 0.42, 0.55))
  let end = done ? Math.min(planned, cap) : cap
  const detours: Array<'pending' | 'escalate' | 'reassign' | 'comment'> = []
  if (rng.chance(0.24) || stopAt('pending')) detours.push('pending')
  if (rng.chance(0.07) || stopAt('escalated')) detours.push('escalate')
  if (rng.chance(0.12)) detours.push('reassign')
  for (let i = rng.int(0, 3); i > 0; i--) detours.push('comment')
  const ordered = rng.shuffle(detours)
  // An open incident waiting or escalated ends in that state: its detour goes last.
  if (s.openState === 'pending') { ordered.splice(ordered.indexOf('pending'), 1); ordered.push('pending') }
  if (s.openState === 'escalated') { ordered.splice(ordered.indexOf('escalate'), 1); ordered.push('escalate') }

  for (const [i, d] of ordered.entries()) {
    const slot = t + Math.round((end - t) * ((i + 1) / (ordered.length + 2)))
    if (slot <= t) continue
    // The open incident's own state is its last detour, and it stays there.
    const lastOpen = !done && i === ordered.length - 1
      && ((d === 'pending' && s.openState === 'pending') || (d === 'escalate' && s.openState === 'escalated'))
    if (d === 'pending') {
      t = slot
      trail.transition('pending', t, w.actor(assignee.id), 'manual', rng.pick(PENDING_NOTES))
      if (lastOpen) return finish()
      const wait = Math.round(rng.logNormal(6, 1) * HOUR)
      // The SLA pauses while waiting: the resolution moves by the wait (not past a change's close).
      if (done && !resolvingChange) end = Math.min(end + wait, cap)
      t = Math.min(t + wait, end - MINUTE)
      trail.transition('in_progress', Math.max(t, trail.lastEventMs), w.actor(assignee.id), 'manual', null)
      t = trail.lastEventMs
    } else if (d === 'escalate') {
      t = slot
      trail.transition('escalated', t, w.actor(assignee.id), 'manual', null)
      if (lastOpen) return finish()
      t = Math.min(t + Math.round(rng.logNormal(2, 0.6) * HOUR), end - MINUTE)
      trail.transition('in_progress', Math.max(t, trail.lastEventMs), w.actor(assignee.id), 'manual', null)
      t = trail.lastEventMs
    } else if (d === 'reassign') {
      assignee = reassign(rng, w, trail, slot, assignee, end)
      t = trail.lastEventMs
    } else {
      t = slot
      const byRequester = s.channel === 'portal' && rng.chance(0.4)
      const author = byRequester ? creator : w.actor(assignee.id)
      const id = trail.personComment(t, author, rng.pick(byRequester ? REQUESTER_COMMENTS : WORK_COMMENTS), !byRequester && rng.chance(0.7))
      trail.audit(t, author, 'comment.added', { commentId: id, isInternal: trail.comments[trail.comments.length - 1]!.is_internal })
    }
  }
  if (!done) return finish()
  resolveAndClose(rng, w, s, trail, Math.max(end, trail.lastEventMs + MINUTE), assignee, resolvingChange)
  return finish()

  function finish(): SimulatedIncident {
    const sla = simulateSla(w.config.slaPolicies, w.sla, w.clock.nowMs, {
      entityType: 'incident', priority: s.severity, category: s.category, teamId: trail.teamId,
      createdAtMs: s.createdAtMs, moves: trail.moves,
    })
    return { skeleton: s, trail, title, description, sla, watchers, resolvingChange }
  }
}

/** Handed over to another support team: the person who had it is detached if not a member, and a member of the new team takes it. */
function reassign(rng: Rng, w: World, trail: TicketTrail, at: number, assignee: { id: string; name: string }, end: number): { id: string; name: string } {
  const other = rng.pick(w.supportTeams.filter((x) => x.id !== trail.teamId))
  const actor = w.actor(assignee.id)
  const from = w.teamsById.get(trail.teamId!)!.name
  const { removedAssignee } = trail.setTeam(at, other.id, w.isMember)
  if (removedAssignee) {
    const removed = w.usersById.get(removedAssignee)!
    trail.systemComment(at, actor, w.trail.text('incident.unassignedOnTeamChange', { user: removed.name, team: other.name }))
  }
  const note = w.trail.text('incident.reassignedTeam', { team: other.name })
  trail.zeroLengthRow(at, actor, note)
  trail.systemComment(at, actor, note)
  trail.audit(at, actor, 'incident.assigned_team', { teamId: other.id, to: other.name, from })
  if (removedAssignee) trail.audit(at, actor, 'incident.unassigned_user', { userId: null, to: null, from: w.usersById.get(removedAssignee)!.name, reason: 'team_changed' })
  const next = w.memberOf(rng, other.id, at)
  const when = Math.max(Math.min(at + Math.round(rng.logNormal(20, 0.8) * MINUTE), end - MINUTE), trail.lastEventMs)
  // D11: «Reassigned» only when someone still had it.
  const personNote = w.trail.text(removedAssignee ? 'incident.assignedUser' : 'incident.reassignedUser', { user: next.name })
  trail.setUser(when, next.id)
  trail.zeroLengthRow(when, w.actor(next.id), personNote)
  trail.systemComment(when, w.actor(next.id), personNote)
  trail.audit(when, w.actor(next.id), 'incident.assigned_user', { userId: next.id, to: next.name, from: removedAssignee ? null : assignee.name })
  return next
}

/** The share of resolved incidents reopened before the timer closes them (D51). */
export const REOPEN_SHARE = 0.04

/**
 * THE CONFIRMATION (tour of 23 Sep 2026, D51). Of the resolved incidents,
 * the requester confirms from the portal (`confirmTicketResolution`) about
 * half of those they opened there; the desk closes on the caller's word a
 * quarter of those it opened for someone. The rest wait for the timer, and
 * the ones the monitoring opened always do — nobody answers for an alarm.
 * Only where the workflow has the manual move (migration 20261008_1010).
 */
export const CONFIRM_SHARE: Readonly<Record<'portal' | 'agent', number>> = { portal: 0.55, agent: 0.25 }

/**
 * When the confirmation comes: a few working hours after the resolution,
 * some the next day. Null when it would come after the timer or after now —
 * then the timer closes it, or it is still resolved.
 */
function confirmationAt(rng: Rng, w: World, resolvedAt: number): number | null {
  const at = resolvedAt + Math.round(rng.logNormal(5 * HOUR, 0.9))
  const inWork = w.clock.workInstant(rng, at, at + 10 * HOUR)
  return inWork < resolvedAt + 71 * HOUR && inWork < w.clock.nowMs - MINUTE ? Math.max(inWork, resolvedAt + MINUTE) : null
}

/** The requester (portal) or the desk (on the caller's word) confirms, if they do and the workflow has the move. */
function confirmResolution(
  rng: Rng, w: World, s: IncidentSkeleton, trail: TicketTrail, resolvedAt: number, assignee: { id: string; name: string },
): boolean {
  const canConfirm = trail.def.transitions.some((t) => t.from === 'resolved' && t.to === 'closed' && t.trigger === 'manual')
  if (!canConfirm || s.creatorId === MONITORING_ACTOR.id) return false
  const byPortal = s.channel === 'portal'
  if (!rng.chance(byPortal ? CONFIRM_SHARE.portal : CONFIRM_SHARE.agent)) return false
  const at = confirmationAt(rng, w, resolvedAt)
  if (at === null) return false
  if (byPortal) {
    trail.transition('closed', at, w.actor(s.creatorId), 'manual', w.trail.text('portal.confirmed'))
    trail.audit(at, w.actor(s.creatorId), 'portal.ticket.resolution_confirmed', { fromStep: 'resolved', toStep: 'closed' })
  } else {
    trail.transition('closed', at, w.actor(assignee.id), 'manual', 'The user confirmed on the phone that it works again.')
  }
  return true
}

/**
 * Resolved — by the person, or by the app when the change closes — then,
 * for a few, reopened (from the portal by the requester, or by the team) and
 * resolved again; then confirmed and closed by the requester or the desk
 * (D51), or else closed by the 72-hour timer of the step.
 */
function resolveAndClose(
  rng: Rng, w: World, s: IncidentSkeleton, trail: TicketTrail, resolveAt: number,
  assignee: { id: string; name: string }, resolvingChange: ResolvingChange | null,
): void {
  if (resolvingChange) {
    trail.transition('resolved', resolveAt, w.actor(resolvingChange.closerId), 'automatic',
      w.trail.text('change.resolvedByChange', { code: resolvingChange.code }),
      { triggeredBy: resolvingChange.closerId, automaticOnManual: true })
  } else {
    trail.transition('resolved', resolveAt, w.actor(assignee.id), 'manual', rng.pick(s.story.rootCauses))
  }
  let resolvedAt = resolveAt
  const reopenAt = resolveAt + rng.int(2, 48) * HOUR
  if (!resolvingChange && rng.chance(REOPEN_SHARE) && reopenAt + 3 * HOUR < w.clock.nowMs - HOUR) {
    if (s.channel === 'portal') {
      // `reopenTicket` of the portal: the requester, the portal's note, its own audit.
      trail.transition('in_progress', reopenAt, w.actor(s.creatorId), 'manual', w.trail.text('portal.reopened'))
      trail.audit(reopenAt, w.actor(s.creatorId), 'portal.ticket.reopened', { fromStep: 'resolved', toStep: 'in_progress' })
    } else {
      trail.transition('in_progress', reopenAt, w.actor(assignee.id), 'manual', 'The user reports that the problem is back.')
    }
    resolvedAt = Math.min(reopenAt + Math.round(rng.logNormal(3 * HOUR, 0.6)), w.clock.nowMs - HOUR)
    trail.transition('resolved', resolvedAt, w.actor(assignee.id), 'manual', rng.pick(s.story.rootCauses))
  }
  if (!resolvingChange && confirmResolution(rng, w, s, trail, resolvedAt, assignee)) return
  const closeDue = resolvedAt + 72 * HOUR
  if (closeDue <= w.clock.nowMs - MINUTE) {
    const swept = closeDue + rng.int(1, 59) * 1000
    trail.markDeadlineMoved('closed', swept)
    trail.transition('closed', swept, AUTOMATION_ACTOR, 'timer', null, { triggeredBy: 'step_deadline' })
    trail.audit(swept, AUTOMATION_ACTOR, 'workflow.step_deadline_moved',
      { fromStep: 'resolved', toStep: 'closed', after: 72, unit: 'hours', calendarId: null, setFields: [] })
  }
}

// ── Incidents the monitoring engine opened ──────────────────────────────────

/**
 * The skeleton of an incident born from an alarm, as `openIncidentFromEvent`
 * (services/events/grouping.ts) creates it: the alarm's title, no category,
 * impact and urgency from the policy's `severity_map`, severity from the
 * `event_severity` matrix, the alarm's CI as the only affected one, created
 * by `monitoring` through `createIncident` — whose channel is `agent`.
 */
export function bornIncidentSkeleton(
  w: World, b: BornIncident, fromSeverity: { impact: string; urgency: string; severity: string },
): IncidentSkeleton {
  const ci = w.cmdb.byId.get(b.ciId)!
  const done = b.clearedAtMs !== null || b.fixedAtMs !== null
  return {
    id: b.incidentId, createdAtMs: b.firstSeenMs, channel: 'agent', creatorId: MONITORING_ACTOR.id,
    category: null,
    story: { id: 'monitoring', category: 'other', titles: [b.title], description: b.alarmDescription, rootCauses: [], weight: 0 },
    titleTemplate: b.title,
    ciIds: [b.ciId], teamId: ci.supportTeamId!,
    impact: fromSeverity.impact, urgency: fromSeverity.urgency, severity: fromSeverity.severity,
    openState: done ? null : b.takenAtMs !== null ? 'in_progress' : 'new',
    born: b,
  }
}

/** What the person wrote as the cause when they fixed it before the alarm cleared. */
function fixCause(rng: Rng, alertName: string): string {
  const by: Array<[RegExp, string[]]> = [
    [/Cpu|Load/i, ['Killed the runaway batch that was holding every core.', 'Moved the report job off the node during business hours.']],
    [/Memory/i, ['Restarted the service leaking memory and opened a problem for the leak.', 'Raised the heap after the capacity review.']],
    [/Disk|Filesystem|Tablespace/i, ['Freed space and set up the log rotation that was missing.', 'Extended the volume and moved the archive to the cold storage.']],
    [/Down|unavailable|accept/i, ['Restarted the stuck process after collecting a dump.', 'Failed over to the standby node.']],
    [/Replication|Connections|Slow|Backup/i, ['Terminated the idle sessions and fixed the pool size.', 'Rebuilt the index the new release had dropped.', 'Re-ran the backup job and fixed its schedule.']],
    [/SSL|Cert/i, ['Renewed the certificate and deployed it on every node.']],
    [/Response|Failure|budget|Latency/i, ['Rolled back the release that had doubled the latency.', 'Scaled the service out and fixed the connection pool.']],
  ]
  const hit = by.find(([re]) => re.test(alertName))
  return rng.pick(hit ? hit[1] : ['Fixed the underlying cause of the alarm.'])
}

export function simulateMonitoringIncident(rng: Rng, w: World, s: IncidentSkeleton, b: BornIncident): SimulatedIncident {
  const def = w.workflows.forTicket('incident', null)
  const trail = new TicketTrail(w.trail, 'incident', s.id, def, s.createdAtMs)
  const monitoring = MONITORING_ACTOR
  // The description the engine writes: four lines in the tenant's language,
  // the occurrences as they were when it opened (the first one), then the
  // alarm's own text.
  const first = w.trail.instant(b.firstSeenMs)
  const description = [
    w.trail.text('event.incident.title', { title: b.title }),
    w.trail.text('event.incident.resource', { resource: b.resource, kind: b.resourceKind }),
    w.trail.text('event.incident.severity', { severity: 'critical' }),
    w.trail.text('event.incident.occurrences', { count: '1', first, last: first }),
    `\n${b.alarmDescription}`,
  ].join('\n')
  trail.audit(s.createdAtMs, monitoring, 'incident.created')
  const cap = w.clock.nowMs - 5 * MINUTE

  // ── Born in the CI's support group (createIncident, the owner's rule of 23 Sep 2026) ──
  // The team, a zero-length row on «New» and one note that says why this team;
  // the incident stays in the group's queue until a person takes it.
  const team = w.teamsById.get(s.teamId)!
  const ciName = w.cmdb.byId.get(b.ciId)!.name
  const routedAt = Math.min(s.createdAtMs + rng.int(1, 3) * 1000, cap)
  const routing = w.trail.text('incident.autoAssignedTeam', { team: team.name, ci: ciName })
  trail.setTeam(routedAt, team.id, w.isMember)
  trail.zeroLengthRow(routedAt, monitoring, routing)
  trail.systemComment(routedAt, monitoring, routing)

  // ── Somebody takes it: that is the response ───────────────────────────────
  if (b.takenAtMs !== null) {
    let t = Math.max(Math.min(b.takenAtMs, cap), trail.lastEventMs)
    const taker = w.memberOf(rng, team.id, t)
    trail.setUser(t, taker.id)
    trail.transition(firstAssignmentStep(def), t, w.actor(taker.id), 'automatic',
      w.trail.text('incident.assignedUser', { user: taker.name }), { automaticOnManual: true })
    trail.audit(t, w.actor(taker.id), 'incident.assigned_user', { userId: taker.id, to: taker.name, from: null })
    t = Math.min(t + rng.int(2, 15) * MINUTE, cap)
    trail.transition('in_progress', Math.max(t, trail.lastEventMs), w.actor(taker.id), 'manual', null)
    if (b.fixedAtMs !== null) {
      // The person fixed it: they resolve it, and the alarm clears after. The
      // engine then finds the incident already resolved and does nothing.
      const at = Math.max(Math.min(b.fixedAtMs, cap), trail.lastEventMs + MINUTE)
      trail.transition('resolved', at, w.actor(taker.id), 'manual', fixCause(rng, b.title))
      return closeLater(at)
    }
  }
  if (b.clearedAtMs === null) return finish()

  // ── The alarm cleared: the engine resolves it (autoResolve.ts) ─────────────
  // The path to «resolved» through the steps a person would walk, each one a
  // transition by `monitoring` with its note and WITHOUT a comment; then the
  // resolution with the alarm as the cause; then ONE summary comment.
  const at = Math.max(Math.min(b.clearedAtMs + rng.int(5, 60) * 1000, cap), trail.lastEventMs + 1000)
  const hops: string[] = []
  let t = at
  for (const step of pathToResolved(def, trail.current.name)) {
    const label = def.steps.get(step)!.label || step
    trail.transition(step, t, monitoring, 'manual', w.trail.text('autoResolve.hop', { step: label }), { comment: false })
    hops.push(label)
    t += 1000
  }
  trail.transition('resolved', t, monitoring, 'manual', w.trail.text('autoResolve.cause', { title: b.title }), { comment: false })
  const via = hops.length ? w.trail.text('autoResolve.via', { steps: hops.join(', ') }) : ''
  trail.systemComment(t, monitoring, w.trail.text('autoResolve.resolvedComment', { title: b.title, via }))
  return closeLater(t)

  /** The same 72-hour timer close as every incident. */
  function closeLater(resolvedAt: number): SimulatedIncident {
    const closeDue = resolvedAt + 72 * HOUR
    if (closeDue <= w.clock.nowMs - MINUTE) {
      const swept = closeDue + rng.int(1, 59) * 1000
      trail.markDeadlineMoved('closed', swept)
      trail.transition('closed', swept, AUTOMATION_ACTOR, 'timer', null, { triggeredBy: 'step_deadline' })
      trail.audit(swept, AUTOMATION_ACTOR, 'workflow.step_deadline_moved',
        { fromStep: 'resolved', toStep: 'closed', after: 72, unit: 'hours', calendarId: null, setFields: [] })
    }
    return finish()
  }

  function finish(): SimulatedIncident {
    const sla = simulateSla(w.config.slaPolicies, w.sla, w.clock.nowMs, {
      entityType: 'incident', priority: s.severity, category: null, teamId: trail.teamId,
      createdAtMs: s.createdAtMs, moves: trail.moves,
    })
    return { skeleton: s, trail, title: b.title, description, sla, watchers: [], resolvingChange: null }
  }
}

/**
 * `findAutoResolvePath` of the engine: the manual steps without a condition
 * that lead from `from` to the one right before «resolved», at most four.
 */
function pathToResolved(def: import('./workflowModel.js').LiveDefinition, from: string): string[] {
  const resolved = [...def.steps.values()].find((st) => st.category === 'resolved')!.name
  if (def.transitions.some((x) => x.from === from && x.to === resolved)) return []
  const queue: Array<{ at: string; path: string[] }> = [{ at: from, path: [] }]
  const seen = new Set([from])
  while (queue.length) {
    const { at, path } = queue.shift()!
    for (const x of def.transitions.filter((y) => y.from === at && y.trigger === 'manual' && !y.condition)) {
      if (seen.has(x.to) || path.length >= 4) continue
      const next = [...path, x.to]
      if (def.transitions.some((y) => y.from === x.to && y.to === resolved)) return next
      seen.add(x.to)
      queue.push({ at: x.to, path: next })
    }
  }
  throw new Error(`Workflow "${def.name}": no path from "${from}" to "${resolved}" for the monitoring engine`)
}

/** The step the app moves an incident to on its first assignment (`assignmentAdvanceTarget`). */
function firstAssignmentStep(def: import('./workflowModel.js').LiveDefinition): string {
  const candidates = def.transitions
    .filter((x) => x.from === def.initialStep.name && x.trigger === 'manual')
    .map((x) => def.steps.get(x.to)!)
    .filter((st) => st.isOpen && !st.isTerminal)
    .sort((a, b) => ((a.stepOrder ?? Number.MAX_SAFE_INTEGER) - (b.stepOrder ?? Number.MAX_SAFE_INTEGER)) || a.name.localeCompare(b.name))
  if (!candidates[0]) throw new Error(`Workflow "${def.name}": no step to move to on the first assignment`)
  return candidates[0].name
}
