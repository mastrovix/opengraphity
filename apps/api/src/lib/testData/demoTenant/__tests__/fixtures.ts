/**
 * A small demo world for the tests: the factory workflows of a tenant (the
 * same steps, categories and transitions `demo-opengrafo` has), the factory
 * matrices, and people, CMDB and configuration planned at a small size.
 * Pure: no database.
 */
import { Rng } from '../random.js'
import { DemoClock } from '../clock.js'
import { DEFAULT_DEMO_COUNTS, type DemoCounts } from '../options.js'
import { planPeople } from '../people.js'
import { planCMDB } from '../cmdb.js'
import { planConfig } from '../config.js'
import { World, type PriorityRules } from '../world.js'
import type { LiveDefinition, LiveStep, TicketWorkflows, WorkflowEntity } from '../workflowModel.js'
import type { TrailContext } from '../trail.js'
import { systemTextIn } from '../../../systemText.js'

export const NOW = Date.parse('2026-09-23T10:00:00.000Z')

type StepSpec = [name: string, category: string, type: 'start' | 'standard' | 'end', terminal: boolean, open: boolean, purpose: string | null, slaPause?: 'resolve']

function def(id: string, name: string, entityType: WorkflowEntity, category: string | null, steps: StepSpec[], transitions: Array<[string, string, string, string | null]>): LiveDefinition {
  const map = new Map<string, LiveStep>()
  steps.forEach(([n, cat, type, terminal, open, purpose, pause], i) => map.set(n, {
    id: `${id}-${n}`, name: n, label: n.split('_').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' '), labels: null,
    category: cat, type, isInitial: type === 'start', isTerminal: terminal, isOpen: open, stepOrder: i + 1, purpose, slaPause: pause ?? null,
  }))
  return {
    id, name, entityType, category, version: 1, steps: map, initialStep: [...map.values()].find((s) => s.type === 'start')!,
    transitions: transitions.map(([from, to, trigger, condition]) => ({ from, to, trigger, condition })),
  }
}

const incidentSteps: StepSpec[] = [
  ['new', 'active', 'start', false, true, null], ['assigned', 'active', 'standard', false, true, null],
  ['in_progress', 'active', 'standard', false, true, null], ['pending', 'waiting', 'standard', false, true, null, 'resolve'],
  ['escalated', 'escalated', 'standard', false, true, null], ['resolved', 'resolved', 'standard', true, false, null],
  ['closed', 'closed', 'end', true, false, null],
]
const incidentMoves: Array<[string, string, string, string | null]> = [
  ['new', 'assigned', 'manual', null], ['assigned', 'in_progress', 'manual', null], ['in_progress', 'resolved', 'manual', 'rootCause != null'],
  ['in_progress', 'escalated', 'sla_breach', null], ['in_progress', 'escalated', 'manual', null], ['in_progress', 'pending', 'manual', null],
  ['pending', 'in_progress', 'manual', null], ['resolved', 'in_progress', 'manual', null], ['resolved', 'closed', 'timer', null],
  // D51: «Confirm resolution», the manual close beside the timer (migration 20261008_1010).
  ['resolved', 'closed', 'manual', null],
  ['escalated', 'in_progress', 'manual', null], ['escalated', 'resolved', 'manual', 'rootCause != null'],
]

export const DEFINITIONS: LiveDefinition[] = [
  def('wd-inc', 'Incident Management', 'incident', null, incidentSteps, incidentMoves),
  def('wd-sec', 'Incident — Security', 'incident', 'security', [...incidentSteps.slice(0, 2), ['security_review', 'active', 'standard', false, true, 'review'], ...incidentSteps.slice(2)],
    [...incidentMoves.filter((m) => !(m[0] === 'assigned' && m[1] === 'in_progress')), ['assigned', 'security_review', 'manual', null],
      ['security_review', 'in_progress', 'manual', null], ['security_review', 'assigned', 'manual', null]]),
  def('wd-prb', 'Problem Management', 'problem', null, [
    ['new', 'active', 'start', false, true, null], ['under_investigation', 'active', 'standard', false, true, 'investigation'],
    ['known_error', 'active', 'standard', false, true, 'known_error'], ['change_requested', 'active', 'standard', false, true, 'change_requested'],
    ['change_in_progress', 'active', 'standard', false, true, 'change_in_progress'], ['resolved', 'resolved', 'standard', true, false, null],
    ['deferred', 'active', 'standard', false, true, null], ['rejected', 'failed', 'end', true, false, null], ['closed', 'closed', 'end', true, false, null],
  ], [
    ['change_in_progress', 'resolved', 'automatic', null], ['change_in_progress', 'under_investigation', 'automatic', null],
    ['change_requested', 'change_in_progress', 'automatic', null], ['change_requested', 'under_investigation', 'automatic', null],
    ['new', 'under_investigation', 'manual', null], ['deferred', 'under_investigation', 'manual', null], ['under_investigation', 'rejected', 'manual', null],
    ['under_investigation', 'change_requested', 'manual', 'has_linked_change'], ['under_investigation', 'deferred', 'manual', null],
    ['under_investigation', 'known_error', 'manual', null], ['resolved', 'under_investigation', 'manual', null], ['resolved', 'closed', 'manual', null],
    ['known_error', 'resolved', 'manual', null], ['known_error', 'change_requested', 'manual', 'has_linked_change'],
  ]),
  def('wd-chg', 'Change RFC Process', 'change', null, [
    ['assessment', 'active', 'start', false, true, 'assessment'], ['approval', 'waiting', 'standard', false, true, 'approval'],
    ['scheduled', 'waiting', 'standard', false, true, 'scheduled'], ['deployment', 'active', 'standard', false, true, 'implementation'],
    ['review', 'active', 'standard', false, true, 'review'], ['closed', 'closed', 'end', true, false, null],
  ], [
    ['assessment', 'approval', 'automatic', 'all_assessments_complete'], ['review', 'closed', 'automatic', 'all_reviews_confirmed'],
    ['scheduled', 'deployment', 'manual', null], ['approval', 'assessment', 'manual', null], ['approval', 'scheduled', 'manual', null],
    ['deployment', 'review', 'automatic', 'all_deployments_complete'],
  ]),
  def('wd-sr', 'Service Request Fulfillment', 'service_request', null, [
    ['submitted', 'active', 'start', false, true, null], ['approval', 'waiting', 'standard', false, true, 'approval'],
    ['in_progress', 'active', 'standard', false, true, null], ['fulfilled', 'resolved', 'standard', false, false, null],
    ['closed', 'closed', 'end', true, false, null], ['rejected', 'failed', 'end', true, false, null],
  ], [
    ['approval', 'rejected', 'manual', null], ['approval', 'in_progress', 'manual', null], ['fulfilled', 'closed', 'manual', null],
    ['in_progress', 'fulfilled', 'manual', null], ['submitted', 'in_progress', 'manual', null], ['submitted', 'approval', 'manual', null],
  ]),
]

DEFINITIONS.push(def('wd-kb', 'KB Article Lifecycle', 'kb_article', null, [
  ['draft', 'draft', 'start', false, true, null], ['pending_review', 'waiting', 'standard', false, true, null],
  ['published', 'published', 'standard', false, true, null], ['archived', 'closed', 'end', true, false, null],
], [
  ['draft', 'pending_review', 'manual', null], ['pending_review', 'published', 'manual', null], ['pending_review', 'draft', 'manual', null],
  ['published', 'archived', 'manual', null], ['draft', 'archived', 'manual', null], ['published', 'draft', 'manual', null],
]))

export const WORKFLOWS: TicketWorkflows = {
  all: DEFINITIONS,
  forTicket: (entityType, category) =>
    DEFINITIONS.find((d) => d.entityType === entityType && d.category === category)
      ?? DEFINITIONS.find((d) => d.entityType === entityType && d.category === null)!,
  byId: (id) => DEFINITIONS.find((d) => d.id === id)!,
}

/** The factory matrices (domainMatrix.ts seeds) and risk bands. */
export const PRIORITY: PriorityRules = {
  derive: (i, u) => ({ 'high|high': 'critical', 'high|medium': 'high', 'high|low': 'medium', 'medium|high': 'high', 'medium|medium': 'medium',
    'medium|low': 'low', 'low|high': 'medium', 'low|medium': 'low', 'low|low': 'low' } as Record<string, string>)[`${i}|${u}`]!,
  invert: (p) => ({ critical: { impact: 'high', urgency: 'high' }, high: { impact: 'high', urgency: 'medium' }, medium: { impact: 'medium', urgency: 'medium' }, low: { impact: 'low', urgency: 'low' } } as Record<string, { impact: string; urgency: string }>)[p]!,
  changePriority: (t, b) => ({ 'emergency|high': 'critical', 'emergency|medium': 'high', 'emergency|low': 'high', 'normal|high': 'high', 'normal|medium': 'medium',
    'normal|low': 'low', 'standard|high': 'medium', 'standard|medium': 'low', 'standard|low': 'low' } as Record<string, string>)[`${t}|${b}`]!,
  changeInitialPriority: (t) => ({ emergency: 'high', normal: 'medium', standard: 'low' } as Record<string, string>)[t]!,
  riskBand: (s) => (s <= 30 ? 'low' : s <= 60 ? 'medium' : 'high'),
  environmentRisk: (e) => ({ production: 3, staging: 1 } as Record<string, number>)[e] ?? 0,
  environmentWeight: 5,
}

export function trailContext(seed = 'trail'): TrailContext {
  return {
    rng: new Rng(seed),
    text: (key, params = {}) => systemTextIn('en', key as Parameters<typeof systemTextIn>[1], params),
    stepFacts: (entity, step) => ({ step_name: step, entity }),
    instant: (ms) => new Date(ms).toISOString(),
  }
}

export const SMALL: DemoCounts = {
  ...DEFAULT_DEMO_COUNTS,
  users: 400, ownerTeams: 20, supportTeams: 40, businessApplications: 60, applications: 90, capabilities: 90, servers: 400,
  databaseInstances: 60, databases: 90, certificates: 90, incidents: 1500, problems: 300, changes: 600, serviceRequests: 300,
}

export function smallWorld(seed = 'demo-test'): World {
  const clock = new DemoClock(NOW, 3, 'Europe/Rome')
  const rng = new Rng(seed)
  const people = planPeople(rng.fork('people'), clock, SMALL)
  const cmdb = planCMDB(rng.fork('cmdb'), clock, SMALL, people)
  const config = planConfig(rng.fork('config'), clock, people)
  return new World(rng.fork('world'), clock, people, cmdb, config, WORKFLOWS, PRIORITY, trailContext(), 'Europe/Rome')
}
