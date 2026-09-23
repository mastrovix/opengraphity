/**
 * ONE TICKET'S LIFE, WRITTEN THE WAY THE APP WRITES IT (23 Sep 2026).
 *
 * `TicketTrail` repeats what the workflow engine and the ticket services do
 * when a person acts. The simulated tickets of tickets.test.ts walk the
 * factory workflows; what they never do is pinned here, against what
 * packages/workflow/src/engine.ts writes:
 *
 *  - time only goes forward: an event before the previous one fails loud
 *    (the generator must never write a history the app could not have);
 *  - a request or a change is COMPLETED the first time it reaches an end,
 *    and a second end does not move that date (`coalesce(completed_at, now)`);
 *  - leaving a resolved step for an open one clears the resolution, and the
 *    root cause only for an incident — in a problem the cause is the analysis
 *    itself and stays;
 *  - a step without a label is named by its name in the workflow note;
 *  - the team history the OLA pages read (`setTicketTeam`): setting the team
 *    it already has opens no second segment and closes nothing; an assignee
 *    who is not in the new team is removed;
 *  - the workflow instance node says where the ticket is: active while it
 *    moves, completed at an end, updated at the last move.
 */
import { describe, it, expect, vi } from 'vitest'
import { TicketTrail } from '../trail.js'
import type { LiveDefinition, LiveStep } from '../workflowModel.js'
import { HOUR, MINUTE } from '../clock.js'
import { NOW, WORKFLOWS, trailContext } from './fixtures.js'

// trail.ts writes its audit rows with writeReference.ts, and the fixtures' world uses @opengraphity/sla: both reach Neo4j at import.
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), runQueryOne: vi.fn(), getSession: vi.fn(), writeSession: vi.fn() }))

const T0 = NOW - 30 * 24 * HOUR
const PERSON = { id: 'u-1', email: 'anna.rossi@example.com', name: 'Anna Rossi' }

function liveDef(entityType: LiveDefinition['entityType'], steps: Array<Partial<LiveStep> & { name: string }>, moves: Array<[string, string]>): LiveDefinition {
  const map = new Map<string, LiveStep>(steps.map((s, i) => [s.name, {
    id: `st-${s.name}`, label: s.name, labels: null, category: 'active', type: i === 0 ? 'start' : 'standard', isInitial: i === 0,
    isTerminal: false, isOpen: true, stepOrder: i + 1, purpose: null, slaPause: null, ...s,
  }]))
  return {
    id: `wd-${entityType}-custom`, name: `Custom ${entityType}`, entityType, category: null, version: 1, steps: map,
    initialStep: map.get(steps[0]!.name)!, transitions: moves.map(([from, to]) => ({ from, to, trigger: 'manual', condition: null })),
  }
}

/** A tenant's own request workflow, where a closed request can be reopened (the designer allows it). */
const REOPENABLE_REQUEST = liveDef('service_request', [
  { name: 'submitted' }, { name: 'in_progress' }, { name: 'closed', category: 'closed', isTerminal: true, isOpen: false },
], [['submitted', 'in_progress'], ['in_progress', 'closed'], ['closed', 'in_progress']])

describe('time only goes forward', () => {
  it('an event before the previous one fails loud, naming the ticket and both instants', () => {
    const trail = new TicketTrail(trailContext('order'), 'incident', 'inc-1', WORKFLOWS.forTicket('incident', null), T0)
    trail.transition('assigned', T0 + HOUR, PERSON, 'manual', null)
    expect(() => trail.personComment(T0 + HOUR - MINUTE, PERSON, 'Too early', false))
      .toThrow(`incident inc-1: "comment" at ${new Date(T0 + HOUR - MINUTE).toISOString()} is before the previous event (${new Date(T0 + HOUR).toISOString()})`)
    expect(() => trail.transition('in_progress', T0, PERSON, 'manual', null)).toThrow(/"→ in_progress" at .* is before the previous event/)
    // At the same instant is not before.
    expect(() => trail.setUser(T0 + HOUR, PERSON.id)).not.toThrow()
  })
})

describe('the ticket follows the step, as the workflow engine writes it', () => {
  it('a request is completed the first time it reaches an end; closed again after a reopening, the date does not move', () => {
    const trail = new TicketTrail(trailContext('complete'), 'service_request', 'sr-1', REOPENABLE_REQUEST, T0)
    trail.transition('in_progress', T0 + HOUR, PERSON, 'manual', null)
    trail.transition('closed', T0 + 2 * HOUR, PERSON, 'manual', null)
    expect(trail.completedAtMs).toBe(T0 + 2 * HOUR)
    trail.transition('in_progress', T0 + 3 * HOUR, PERSON, 'manual', 'The requester asked for one more thing')
    trail.transition('closed', T0 + 5 * HOUR, PERSON, 'manual', null)
    expect(trail.completedAtMs).toBe(T0 + 2 * HOUR)
    expect(trail.resolvedAtMs).toBeNull()
  })

  it('an incident reopened loses its resolution and its root cause', () => {
    const trail = new TicketTrail(trailContext('inc-reopen'), 'incident', 'inc-2', WORKFLOWS.forTicket('incident', null), T0)
    trail.transition('assigned', T0 + HOUR, PERSON, 'manual', null)
    trail.transition('in_progress', T0 + 2 * HOUR, PERSON, 'manual', null)
    trail.transition('resolved', T0 + 3 * HOUR, PERSON, 'manual', 'The spooler hung; it was restarted.')
    expect([trail.resolvedAtMs, trail.rootCause]).toEqual([T0 + 3 * HOUR, 'The spooler hung; it was restarted.'])
    trail.transition('in_progress', T0 + 4 * HOUR, PERSON, 'manual', 'It happened again')
    expect([trail.resolvedAtMs, trail.rootCause]).toEqual([null, null])
  })

  it('a problem reopened loses its resolution but keeps its root cause: the cause is the analysis itself', () => {
    const trail = new TicketTrail(trailContext('prb-reopen'), 'problem', 'prb-1', WORKFLOWS.forTicket('problem', null), T0)
    trail.transition('under_investigation', T0 + HOUR, PERSON, 'manual', null)
    trail.transition('known_error', T0 + 2 * HOUR, PERSON, 'manual', null)
    trail.transition('resolved', T0 + 3 * HOUR, PERSON, 'manual', 'A leak in the monitoring agent.')
    trail.transition('under_investigation', T0 + 4 * HOUR, PERSON, 'manual', 'Seen again after the fix')
    expect(trail.resolvedAtMs).toBeNull()
    expect(trail.rootCause).toBe('A leak in the monitoring agent.')
  })

  it('a step without a label is named by its name in the workflow note', () => {
    const def = liveDef('incident', [{ name: 'new' }, { name: 'triage', label: '' }], [['new', 'triage']])
    const trail = new TicketTrail(trailContext('label'), 'incident', 'inc-3', def, T0)
    trail.transition('triage', T0 + HOUR, PERSON, 'manual', null)
    expect(trail.comments.map((c) => c.text)).toEqual(['Workflow: triage'])
  })
})

describe('the team history the OLA pages read', () => {
  const members: Record<string, string[]> = { 'team-a': ['u-1', 'u-2'], 'team-b': ['u-3'] }
  const isMember = (u: string, t: string) => members[t]?.includes(u) === true

  it('setting the team it already has opens no second segment and closes nothing', () => {
    const trail = new TicketTrail(trailContext('team'), 'incident', 'inc-4', WORKFLOWS.forTicket('incident', null), T0)
    trail.setTeam(T0, 'team-a', isMember)
    trail.setTeam(T0 + HOUR, 'team-a', isMember)
    expect(trail.segments).toHaveLength(1)
    expect(trail.segments[0]).toMatchObject({ team_id: 'team-a', started_at: new Date(T0).toISOString() })
    expect(trail.segments[0]!.ended_at).toBeUndefined()
    // Handed to another team: the first segment ends there, and one opens for the new team — once.
    trail.setTeam(T0 + 2 * HOUR, 'team-b', isMember)
    trail.setTeam(T0 + 3 * HOUR, 'team-b', isMember)
    expect(trail.segments.map((s) => [s.team_id, s.ended_at ?? null])).toEqual([['team-a', new Date(T0 + 2 * HOUR).toISOString()], ['team-b', null]])
    expect(trail.teamId).toBe('team-b')
  })

  it('an assignee who is not in the new team is removed; one who is stays', () => {
    const trail = new TicketTrail(trailContext('assignee'), 'incident', 'inc-5', WORKFLOWS.forTicket('incident', null), T0)
    trail.setTeam(T0, 'team-a', isMember)
    trail.setUser(T0 + MINUTE, 'u-2')
    expect(trail.setTeam(T0 + HOUR, 'team-a', isMember)).toEqual({ removedAssignee: null })
    expect(trail.setTeam(T0 + 2 * HOUR, 'team-b', isMember)).toEqual({ removedAssignee: 'u-2' })
    expect(trail.assigneeId).toBeNull()
    expect(trail.setTeam(T0 + 3 * HOUR, 'team-a', isMember)).toEqual({ removedAssignee: null })
  })
})

describe('the workflow instance node', () => {
  it('is active at its first step, updated when it was created', () => {
    const trail = new TicketTrail(trailContext('instance'), 'service_request', 'sr-2', REOPENABLE_REQUEST, T0)
    expect(trail.instanceProps()).toEqual({
      id: trail.instanceId, definition_id: REOPENABLE_REQUEST.id, entity_id: 'sr-2', entity_type: 'service_request',
      current_step: 'submitted', status: 'active', created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString(),
    })
  })

  it('is completed at an end, updated at the last move — not at a later comment', () => {
    const trail = new TicketTrail(trailContext('instance-end'), 'service_request', 'sr-3', REOPENABLE_REQUEST, T0)
    trail.transition('in_progress', T0 + HOUR, PERSON, 'manual', null)
    trail.transition('closed', T0 + 2 * HOUR, PERSON, 'manual', null)
    trail.personComment(T0 + 5 * HOUR, PERSON, 'Thanks!', false)
    expect(trail.instanceProps()).toMatchObject({ current_step: 'closed', status: 'completed', updated_at: new Date(T0 + 2 * HOUR).toISOString() })
  })
})
