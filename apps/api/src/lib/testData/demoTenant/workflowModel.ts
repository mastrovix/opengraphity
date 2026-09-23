/**
 * THE TENANT'S OWN WORKFLOWS, AS THE GENERATOR WALKS THEM (23 Sep 2026).
 *
 * The owner of the product: "the workflows must be walked normally, as one
 * would using the app". So the generator does not carry its own copy of the
 * steps: it reads the definitions the tenant has — the ones a customer may
 * have changed in the designer — and every move a simulated ticket makes is
 * checked here against them: the transition must exist from the current step,
 * with that trigger, and its condition must hold (a resolution needs a root
 * cause, a problem goes to "change requested" only with a linked change).
 * A move the definition does not allow stops the generator with the ticket
 * and the move, instead of writing a history the app could never have made.
 */
import type { Queryable } from '@opengraphity/neo4j'
import { runQuery } from '@opengraphity/neo4j'

export type WorkflowEntity = 'incident' | 'problem' | 'change' | 'service_request' | 'kb_article'
export type TriggerType = 'manual' | 'automatic' | 'timer' | 'sla_breach'

export interface LiveStep {
  id: string
  name: string
  label: string
  labels: string | null
  category: string | null
  type: string | null
  isInitial: boolean
  isTerminal: boolean
  isOpen: boolean
  stepOrder: number | null
  purpose: string | null
  /** The SLA pause this step's enter actions ask for (`sla_pause`), if any. */
  slaPause: 'resolve' | 'response' | 'both' | null
}

export interface LiveTransition {
  from: string
  to: string
  trigger: string
  condition: string | null
}

export interface LiveDefinition {
  id: string
  name: string
  entityType: WorkflowEntity
  category: string | null
  version: number
  steps: Map<string, LiveStep>
  transitions: LiveTransition[]
  initialStep: LiveStep
}

export interface TicketWorkflows {
  /** The definition a new ticket gets: category match first, then the one without category. */
  forTicket(entityType: WorkflowEntity, category: string | null): LiveDefinition
  byId(id: string): LiveDefinition
  all: LiveDefinition[]
}

/** What the conditions of the tenant's transitions need to know about the ticket. */
export interface ConditionFacts {
  rootCause?: string | null
  hasLinkedChange?: boolean
  allAssessmentsComplete?: boolean
  allDeploymentsComplete?: boolean
  allReviewsConfirmed?: boolean
}

export class WorkflowRuleError extends Error {}

/** The conditions the shipped definitions use; an unknown one stops the generator. */
export function conditionHolds(condition: string | null, facts: ConditionFacts): boolean {
  if (!condition) return true
  switch (condition.trim()) {
    case 'rootCause != null': return typeof facts.rootCause === 'string' && facts.rootCause.trim() !== ''
    case 'has_linked_change': return facts.hasLinkedChange === true
    case 'all_assessments_complete': return facts.allAssessmentsComplete === true
    case 'all_deployments_complete': return facts.allDeploymentsComplete === true
    case 'all_reviews_confirmed': return facts.allReviewsConfirmed === true
    default: throw new WorkflowRuleError(`Unknown transition condition "${condition}": the generator does not know how to satisfy it`)
  }
}

/**
 * Checks one move against the definition. `trigger` must be the trigger of
 * the transition as declared (a manual move is not an automatic one), with
 * one exception the app itself makes: assigning an incident from its initial
 * step moves it along a MANUAL transition with trigger type `automatic`
 * (incidentService.assignIncidentToTeam).
 */
export function assertMove(
  def: LiveDefinition, from: string, to: string, trigger: TriggerType, facts: ConditionFacts, where: string,
  opts: { automaticOnManual?: boolean } = {},
): LiveStep {
  const t = def.transitions.find((x) => x.from === from && x.to === to
    && (x.trigger === trigger || (opts.automaticOnManual === true && trigger === 'automatic' && x.trigger === 'manual')))
  if (!t) {
    const allowed = def.transitions.filter((x) => x.from === from).map((x) => `${x.to} (${x.trigger})`).join(', ')
    throw new WorkflowRuleError(`${where}: "${def.name}" has no ${trigger} transition ${from} → ${to} (allowed: ${allowed || 'none'})`)
  }
  if (!conditionHolds(t.condition, facts)) {
    throw new WorkflowRuleError(`${where}: the condition "${t.condition ?? ''}" of ${from} → ${to} does not hold`)
  }
  const step = def.steps.get(to)
  if (!step) throw new WorkflowRuleError(`${where}: step "${to}" is missing from "${def.name}"`)
  return step
}

function slaPauseOf(enterActions: unknown): LiveStep['slaPause'] {
  if (typeof enterActions !== 'string' || enterActions.trim() === '') return null
  const actions = JSON.parse(enterActions) as Array<{ type?: string; params?: { sla_type?: string } }>
  const pause = actions.find((a) => a.type === 'sla_pause')
  if (!pause) return null
  const t = pause.params?.sla_type
  return t === 'resolve' || t === 'response' ? t : 'both'
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  return typeof v === 'number' ? v : Number(v)
}

export async function loadTicketWorkflows(session: Queryable, tenantId: string): Promise<TicketWorkflows> {
  const defs = await runQuery<{ d: Record<string, unknown>; steps: Array<Record<string, unknown>>; transitions: Array<Record<string, unknown>> }>(session, `
    MATCH (d:WorkflowDefinition {tenant_id: $tenantId, active: true})
    WHERE d.entity_type IN ['incident', 'problem', 'change', 'service_request', 'kb_article']
    OPTIONAL MATCH (d)-[:HAS_STEP]->(s:WorkflowStep)
    WITH d, collect(properties(s)) AS steps
    OPTIONAL MATCH (d)-[:HAS_STEP]->(a:WorkflowStep)-[t:TRANSITIONS_TO]->(b:WorkflowStep)
    RETURN properties(d) AS d, steps,
           collect(CASE WHEN t IS NULL THEN null ELSE {from: a.name, to: b.name, trigger: t.trigger, condition: t.condition} END) AS transitions
  `, { tenantId })
  const all: LiveDefinition[] = defs.map(({ d, steps, transitions }) => {
    const stepMap = new Map<string, LiveStep>()
    for (const s of steps) {
      stepMap.set(s['name'] as string, {
        id: s['id'] as string,
        name: s['name'] as string,
        label: (s['label'] as string | null) ?? (s['name'] as string),
        labels: (s['labels'] as string | null) ?? null,
        category: (s['category'] as string | null) ?? null,
        type: (s['type'] as string | null) ?? null,
        isInitial: s['is_initial'] === true || s['type'] === 'start',
        isTerminal: s['is_terminal'] === true || s['type'] === 'end',
        isOpen: s['is_open'] !== false,
        stepOrder: toNumber(s['step_order']),
        purpose: (s['purpose'] as string | null) ?? null,
        slaPause: slaPauseOf(s['enter_actions']),
      })
    }
    const initial = [...stepMap.values()].find((s) => s.type === 'start') ?? [...stepMap.values()].find((s) => s.isInitial)
    if (!initial) throw new WorkflowRuleError(`Workflow "${String(d['name'])}" has no initial step`)
    return {
      id: d['id'] as string,
      name: d['name'] as string,
      entityType: d['entity_type'] as WorkflowEntity,
      category: (d['category'] as string | null) ?? null,
      version: toNumber(d['version']) ?? 1,
      steps: stepMap,
      transitions: transitions.filter((t): t is Record<string, unknown> => t !== null).map((t) => ({
        from: t['from'] as string, to: t['to'] as string, trigger: t['trigger'] as string, condition: (t['condition'] as string | null) ?? null,
      })),
      initialStep: initial,
    }
  })

  const forTicket = (entityType: WorkflowEntity, category: string | null): LiveDefinition => {
    // The engine's choice (engine.ts initialStepSelection): the category's own
    // definition first, then the one with no category; ties to the highest version.
    const candidates = all.filter((d) => d.entityType === entityType)
    const pick = (list: LiveDefinition[]) => [...list].sort((a, b) => b.version - a.version)[0]
    const chosen = (category ? pick(candidates.filter((d) => d.category === category)) : undefined)
      ?? pick(candidates.filter((d) => d.category === null))
    if (!chosen) throw new WorkflowRuleError(`The tenant has no active "${entityType}" workflow`)
    return chosen
  }
  const byIdMap = new Map(all.map((d) => [d.id, d]))
  return {
    all,
    forTicket,
    byId: (id) => {
      const d = byIdMap.get(id)
      if (!d) throw new WorkflowRuleError(`Workflow definition ${id} not found`)
      return d
    },
  }
}
