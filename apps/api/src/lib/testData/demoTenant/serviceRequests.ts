/**
 * THE DEMO TENANT'S SERVICE REQUESTS (23 Sep 2026).
 *
 * Requests come from the 50 catalog models, most of them from the portal by
 * an employee, some raised by the service desk on someone's behalf. The
 * answers to the form are plausible for each field, and they are turned
 * into the request's properties by the app's own `resolveFormWrites` — the
 * same checks (visibility, required fields, vocabularies, references that
 * must exist) and the same conversions (dates, numbers, lists) as a real
 * submission.
 *
 * Then, as the app runs them (tour of 23 Sep 2026):
 *  - the request is born assigned to the FULFILMENT GROUP of its model (D56,
 *    `assignFulfilmentGroup`); a model done on site (a laptop, a desk move)
 *    is dispatched by the group to the team of the requester's region;
 *  - a model that needs an approval goes to "Approval" and is approved (or,
 *    sometimes, rejected); a member of the team takes it, fulfils it and
 *    closes it;
 *  - HOW LONG it takes is the model's own (`fulfilHours`: an account unlock
 *    in two hours, a penetration test in three days), and whether it is still
 *    open today follows from that (D1: ~125 open, median ~16 hours; a few
 *    stuck waiting for a supplier or an approver, never beyond 30 days).
 */
import type { Session } from 'neo4j-driver'
import type { Rng } from './random.js'
import { DAY, HOUR, MINUTE } from './clock.js'
import { arrivalInstants } from './arrivals.js'
import type { BuiltCatalog, BuiltCatalogItem } from './catalogSetup.js'
import { formDefinition } from './catalogSetup.js'
import { DEMO_VOCABULARIES, vocabularyValues, type DemoFieldSpec } from './catalogContent.js'
import { REQUESTER_COMMENTS, WORK_COMMENTS } from './ticketTexts.js'
import { simulateSla, type SlaStatusRow } from './slaSim.js'
import { TicketTrail } from './trail.js'
import type { World } from './world.js'
import type { CILabel, PlannedCI } from './cmdb.js'
import type { PlannedTeam, PlannedUser } from './people.js'
import { COUNTRY_REGION } from './names.js'
import { formAnswerMap, formFields, parseCatalogForm, resolveFormWrites, visibleFormItems, type FormAnswerInput, type FormFieldDef, type FormWriteResult } from '../../catalogForm.js'
import type { CatalogFormDefinition } from '@opengraphity/types'

export type RequestOpenState = 'submitted' | 'approval' | 'in_progress' | 'fulfilled'

export interface SimulatedRequest {
  id: string
  item: BuiltCatalogItem
  trail: TicketTrail
  createdAtMs: number
  creatorId: string
  title: string
  description: string
  priority: string
  category: string
  requiresApproval: boolean
  form: FormWriteResult
  sla: SlaStatusRow | null
  watchers: Array<{ userId: string; atMs: number }>
}

const VOCABULARY_VALUES = new Map(DEMO_VOCABULARIES.map((v) => [v.name, vocabularyValues(v)]))

function iso(ms: number): string { return new Date(ms).toISOString() }
function localDate(ms: number): string { return iso(ms).slice(0, 10) }
function localDateTime(ms: number): string { return iso(ms).slice(0, 16) }

/** A requester's answer to one field, in the shape the portal sends. */
function answer(rng: Rng, w: World, f: DemoFieldSpec, name: string, atMs: number, systemValues: Map<string, readonly string[]>, requester: PlannedUser): FormAnswerInput | null {
  const a = f.answer ?? {}
  // D30: people ask for their own office, most of the time.
  if (f.vocabulary === 'office_site' && requester.site !== 'Remote' && rng.chance(0.85)) return { name, value: requester.site }
  switch (f.type) {
    case 'text': case 'textarea': {
      const samples = (a.samples ?? []).filter((x) => x !== '')
      if (!samples.length) return f.required ? { name, value: 'See the description.' } : null
      return { name, value: rng.pick(samples) }
    }
    case 'number': return { name, value: String(rng.int(a.min ?? 1, a.max ?? 10)) }
    case 'boolean': return { name, value: rng.chance(a.yes ?? 0.5) ? 'true' : 'false' }
    case 'date': {
      const [lo, hi] = a.daysAhead ?? [1, 30]
      return { name, value: localDate(atMs + rng.int(lo, hi) * DAY) }
    }
    case 'datetime': {
      const [lo, hi] = a.daysAhead ?? [1, 10]
      return { name, value: localDateTime(atMs + rng.int(lo, hi) * DAY + rng.int(8, 17) * HOUR) }
    }
    case 'enum': {
      const values = a.values ?? VOCABULARY_VALUES.get(f.vocabulary!) ?? systemValues.get(f.vocabulary!) ?? []
      return values.length ? { name, value: rng.pick(values) } : null
    }
    case 'multi_enum': {
      const values = VOCABULARY_VALUES.get(f.vocabulary!) ?? systemValues.get(f.vocabulary!) ?? []
      return { name, values: rng.sample(values, rng.int(1, Math.min(3, values.length))) }
    }
    case 'ref_ci': {
      const ci = w.runningCI(rng, ciPool(w, f), atMs)
      return ci ? { name, refIds: [ci.id] } : null
    }
    case 'ref_user': return null // staff only: the portal does not offer it
    case 'table': {
      const [lo, hi] = a.rows ?? [1, 3]
      const rows = Array.from({ length: rng.int(lo, hi) }, () => Object.fromEntries((f.table ?? []).map((c) => [c.name,
        c.type === 'number' ? String(rng.int(1, c.name.includes('price') ? 900 : 5))
          : c.type === 'boolean' ? String(rng.chance(0.5))
          : rng.pick(a.samples ?? ['Item'])])))
      return { name, rows }
    }
    case 'note': return null
  }
}

export interface RequestPlanContext {
  session: Session
  tenantId: string
  catalog: BuiltCatalog
  systemValues: Map<string, readonly string[]>
}

const CI_LABEL_OF: Record<string, CILabel> = {
  application: 'Application', business_application: 'BusinessApplication', server: 'Server',
  database_instance: 'DatabaseInstance', database: 'Database',
}

/** The CIs a `ref_ci` field can point at. */
function ciPool(w: World, f: DemoFieldSpec): PlannedCI[] {
  return (f.refTypes ?? ['application']).flatMap((t) => w.cmdb.byLabel[CI_LABEL_OF[t]!] ?? [])
}

/**
 * WHEN A MODEL COULD FIRST BE ASKED FOR.
 *
 * A model with a required "which application?" field could not be submitted
 * before the company had an application: the person filling the form picks
 * one from a list, and an empty list means no request. In the tenant's first
 * weeks the CMDB is still filling up — the first running application appears
 * around the fortieth day, because it waits for its servers and its business
 * application — and a request dated before that stopped the generator with
 * «The field "Application" is required», which is the app telling the truth.
 * So each model carries the instant from which it can be chosen.
 */
function availableFrom(w: World, item: BuiltCatalogItem): number {
  let from = w.clock.startMs
  for (const f of item.fields) {
    if (f.spec.type !== 'ref_ci' || !f.spec.required) continue
    const pool = ciPool(w, f.spec).filter((c) => c.status === 'active' || c.status === 'maintenance')
    if (!pool.length) throw new Error(`demo catalog "${item.spec.name}": the field "${f.spec.label}" points at CIs the tenant has none of`)
    from = Math.max(from, Math.min(...pool.map((c) => c.createdAtMs)))
  }
  return from
}

/**
 * WHEN THINGS HAPPEN TO ONE REQUEST, from its model's typical duration.
 * `fulfilledAtMs` is where the life ends; a stuck request (0.6%) waits for
 * weeks, but never 30 days (D1).
 */
export interface RequestTimeline {
  approvalAtMs: number | null
  decisionAtMs: number | null
  rejected: boolean
  startAtMs: number
  fulfilledAtMs: number
  closedAtMs: number
}

export const REQUEST_STUCK_SHARE = 0.006
const MAX_REQUEST_LIFE = 29 * DAY

export function requestTimeline(rng: Rng, spec: BuiltCatalogItem['spec'], createdAtMs: number): RequestTimeline {
  const stuck = rng.chance(REQUEST_STUCK_SHARE)
  const life = Math.max(20 * MINUTE, Math.min(MAX_REQUEST_LIFE,
    stuck ? rng.logNormal(12 * DAY, 0.6) : rng.logNormal(spec.fulfilHours * HOUR, 0.5)))
  const fulfilledAtMs = createdAtMs + Math.round(life)
  let approvalAtMs: number | null = null
  let decisionAtMs: number | null = null
  let rejected = false
  let startAtMs: number
  if (spec.requiresApproval) {
    approvalAtMs = createdAtMs + Math.round(Math.min(rng.int(10, 180) * MINUTE, 0.1 * life))
    decisionAtMs = createdAtMs + Math.round(life * rng.float(0.25, 0.55))
    rejected = rng.chance(0.08)
    startAtMs = decisionAtMs
  } else {
    startAtMs = createdAtMs + Math.round(Math.min(rng.int(10, 240) * MINUTE, 0.3 * life))
  }
  const closedAtMs = fulfilledAtMs + Math.round(Math.min(72 * HOUR, rng.logNormal(8 * HOUR, 0.8)))
  return { approvalAtMs, decisionAtMs, rejected, startAtMs, fulfilledAtMs, closedAtMs }
}

/** Where the request stands at `nowMs` (null: concluded). */
export function requestStateAt(t: RequestTimeline, nowMs: number): RequestOpenState | null {
  const firstMove = t.approvalAtMs ?? t.startAtMs
  if (nowMs < firstMove) return 'submitted'
  if (t.decisionAtMs !== null && nowMs < t.decisionAtMs) return 'approval'
  if (t.rejected) return null
  if (nowMs < t.fulfilledAtMs) return 'in_progress'
  if (nowMs < t.closedAtMs) return 'fulfilled'
  return null
}

/** The support team of the requester's region in the group's tower, if the group dispatches (D56). */
function dispatchTeam(w: World, group: PlannedTeam, requester: PlannedUser): PlannedTeam | null {
  const region = COUNTRY_REGION[requester.country]
  return w.supportTeams.find((t) => t.area === group.area && t.region === region && t.id !== group.id) ?? null
}

export interface RequestPeople { creatorId: string; requester: PlannedUser; endUser: boolean }

/** The answers of the form, through the app's own conversion and checks. */
async function answerForm(
  rng: Rng, w: World, pc: RequestPlanContext, item: BuiltCatalogItem, def: CatalogFormDefinition,
  library: Map<string, FormFieldDef>, createdAtMs: number, who: RequestPeople,
): Promise<FormWriteResult> {
  const inputs: FormAnswerInput[] = []
  for (const f of item.fields) {
    if (who.endUser && f.spec.agentOnly) continue
    const a = answer(rng, w, f.spec, f.name, createdAtMs, pc.systemValues, who.requester)
    if (a) inputs.push(a)
  }
  // Answers to fields a condition hides are not sent (the portal does not show them).
  const visible = new Set(visibleNames(def, inputs, who.endUser))
  return resolveFormWrites(pc.session, pc.tenantId, def, library, inputs.filter((i) => visible.has(i.name)), { endUser: who.endUser, userId: who.creatorId })
}

/** The life of one request on its trail: team, approval, the person, fulfilment, closure. */
export function liveRequest(rng: Rng, w: World, trail: TicketTrail, item: BuiltCatalogItem, who: RequestPeople, tl: RequestTimeline): void {
  const now = w.clock.nowMs
  const cap = now - 5 * MINUTE
  const state = requestStateAt(tl, now)
  const creator = w.actor(who.creatorId)
  const at = (ms: number): number => Math.max(Math.min(ms, cap), trail.lastEventMs)
  // Born in the fulfilment group (requestService.assignFulfilmentGroup): the team, and one internal note.
  const group = w.teamsById.get(item.fulfilmentTeamId)!
  let t = at(trail.createdAtMs + rng.int(1, 5) * 1000)
  trail.setTeam(t, group.id, w.isMember)
  // `writeTicketComment`: internal, and the request's `updated_at` moves with it.
  trail.personComment(t, creator, w.trail.text('request.fulfilmentTeam', { team: group.name, item: item.spec.name }), true)
  let team = group
  // Done on site: the group dispatches it to the team of the requester's region.
  const local = item.spec.local ? dispatchTeam(w, group, who.requester) : null
  if (local && rng.chance(0.6)) {
    t = at(trail.createdAtMs + Math.min(rng.int(5, 90) * MINUTE, 0.2 * (tl.fulfilledAtMs - trail.createdAtMs)))
    const dispatcher = w.actor(w.memberOf(rng, group.id, t).id)
    trail.setTeam(t, local.id, w.isMember)
    trail.personComment(t, dispatcher, w.trail.text('request.reassignedTeam', { team: local.name }), true)
    trail.audit(t, dispatcher, 'request.assigned_team', { teamId: local.id, to: local.name, from: group.name })
    team = local
  }
  if (state === 'submitted') return
  if (tl.approvalAtMs !== null) {
    trail.transition('approval', at(tl.approvalAtMs), w.actor(w.memberOf(rng, team.id, tl.approvalAtMs).id), 'manual', null)
    if (state === 'approval') return
    const approver = w.actor(team.managerId)
    if (tl.rejected) {
      trail.transition('rejected', at(tl.decisionAtMs!), approver, 'manual', rng.pick([
        'Not justified for the current role.', 'Covered by an existing licence.', 'Please use the standard model from the catalog.',
      ]))
      return
    }
    trail.transition('in_progress', at(tl.decisionAtMs!), approver, 'manual', null)
  }
  const operator = w.memberOf(rng, team.id, tl.startAtMs)
  const op = w.actor(operator.id)
  if (tl.approvalAtMs === null) trail.transition('in_progress', at(tl.startAtMs), op, 'manual', null)
  // The person who fulfils it: a member of the request's team (assertUserInAssignedTeam).
  trail.setUser(at(trail.lastEventMs + rng.int(1, 20) * MINUTE), operator.id)
  trail.audit(trail.lastEventMs, op, 'request.assigned')
  if (rng.chance(0.3)) {
    const byRequester = rng.chance(0.5)
    const author = byRequester ? w.actor(who.requester.id) : op
    const when = at(trail.lastEventMs + Math.round((tl.fulfilledAtMs - trail.lastEventMs) * rng.float(0.2, 0.7)))
    const cid = trail.personComment(when, author, rng.pick(byRequester ? REQUESTER_COMMENTS : WORK_COMMENTS), !byRequester && rng.chance(0.5))
    trail.audit(when, author, byRequester ? 'portal.comment.added' : 'comment.added',
      byRequester ? undefined : { commentId: cid, isInternal: trail.comments[trail.comments.length - 1]!.is_internal })
  }
  if (state === 'in_progress') return
  trail.transition('fulfilled', at(tl.fulfilledAtMs), op, 'manual', null)
  if (state === 'fulfilled') return
  trail.transition('closed', at(tl.closedAtMs), op, 'manual', null)
}

export async function simulateRequests(
  rng: Rng, w: World, pc: RequestPlanContext, count: number,
  onRequest: (r: SimulatedRequest) => Promise<void>,
): Promise<void> {
  const library = new Map<string, FormFieldDef>((await formFields(pc.session, pc.tenantId)).map((f) => [f.name, f]))
  const defs = new Map<string, CatalogFormDefinition>(pc.catalog.items.map((it) =>
    [it.id, parseCatalogForm(JSON.stringify(formDefinition(it.spec, it.revision)), `demo catalog ${it.spec.name}`)!]))
  const weights = pc.catalog.items.map((it) => [it, it.spec.demand, availableFrom(w, it)] as const)
  const deskTeams = w.supportTeams.filter((t) => t.area === 'Service Desk')
  // The arrivals follow the curve of the months; how long each one stays open is its model's.
  const createdAt = arrivalInstants(rng, w.clock, count, w.clock.startMs + 30 * DAY, w.clock.nowMs - 30 * MINUTE)

  for (const createdAtMs of createdAt) {
    // Only the models that could be asked for on that day (see `availableFrom`).
    const item = rng.weighted(weights.filter(([, , from]) => from <= createdAtMs).map(([it, demand]) => [it, demand] as const))
    const id = rng.uuid()
    const trail = new TicketTrail(w.trail, 'service_request', id, w.workflows.forTicket('service_request', null), createdAtMs)
    const requester = w.someone(rng, w.endUsers, createdAtMs)
    // A tenth is raised by the service desk of the requester's region, on their behalf.
    const onBehalf = rng.chance(0.1)
    const regionDesk = deskTeams.find((d) => d.region === COUNTRY_REGION[requester.country]) ?? rng.pick(deskTeams.length ? deskTeams : w.supportTeams)
    const creatorId = onBehalf ? w.memberOf(rng, regionDesk.id, createdAtMs).id : requester.id
    const who: RequestPeople = { creatorId, requester, endUser: !onBehalf }
    const form = await answerForm(rng, w, pc, item, defs.get(item.id)!, library, createdAtMs, who)
    const detailsText = rng.pick(item.spec.details)
    trail.audit(createdAtMs, w.actor(creatorId), 'request.created')
    liveRequest(rng, w, trail, item, who, requestTimeline(rng, item.spec, createdAtMs))

    const sla = simulateSla(w.config.slaPolicies, w.sla, w.clock.nowMs, {
      entityType: 'service_request', priority: item.spec.priority, category: item.spec.category, teamId: trail.teamId,
      createdAtMs, moves: trail.moves,
    })
    await onRequest({
      id, item, trail, createdAtMs, creatorId, title: item.spec.name, description: detailsText,
      priority: item.spec.priority, category: item.spec.category, requiresApproval: item.spec.requiresApproval, form, sla,
      watchers: [{ userId: creatorId, atMs: createdAtMs }],
    })
  }
}

/** The fields a requester sees with these answers (the app's own rule, `visibleFormItems`). */
function visibleNames(def: CatalogFormDefinition, inputs: readonly FormAnswerInput[], endUser: boolean): string[] {
  return visibleFormItems(def, formAnswerMap(inputs), { endUser }).map((x) => x.field)
}
