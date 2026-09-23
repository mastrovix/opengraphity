/**
 * Migration 20261008_1010: the incident workflows with the factory 72-hour
 * close get a manual «Confirm resolution» (tour of 23 Sep 2026, D51).
 *
 * What matters: only incident workflows, only where the timer still takes
 * «resolved» to «closed» and no manual move exists (a workflow the customer
 * redesigned is kept), the move written as the seed writes it, and a line for
 * each workflow changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { INCIDENT_CONFIRM_RESOLUTION } from '@opengraphity/workflow'

const { incidentConfirmResolution } = await import('../20261008_1010_incident_confirm_resolution.js')
const { MIGRATIONS } = await import('../index.js')

let lines: string[] = []
beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
})

describe('20261008_1010_incident_confirm_resolution', () => {
  it('is registered right after 20261007_1060', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20261008_1010_incident_confirm_resolution'))
      .toBe(ids.indexOf('20261007_1060_request_rejected_failed') + 1)
  })

  it('adds the manual move only beside the factory timer, as the seed writes it, and names each workflow', async () => {
    const rows = [{ tenant: 'c-one', definition: 'Incident Management', fromStep: 'resolved', toStep: 'closed' }]
    const run = vi.fn(async (_cypher: string) => ({ records: rows.map((r) => ({ get: (k: string) => r[k as keyof typeof r] })) }))
    await incidentConfirmResolution.up({ run } as never)
    const q = String(run.mock.calls[0]![0])
    expect(q).toContain("MATCH (wd:WorkflowDefinition {entity_type: 'incident'})-[:HAS_STEP]->(r:WorkflowStep {category: 'resolved'})")
    expect(q).toContain("MATCH (r)-[:TRANSITIONS_TO {trigger: 'timer'}]->(c:WorkflowStep {category: 'closed'})")
    expect(q).toContain("NOT (r)-[:TRANSITIONS_TO {trigger: 'manual'}]->(c)")
    // The same move the factory seed has: id, label and Italian label.
    expect(q).toContain(`id: wd.id + '-${INCIDENT_CONFIRM_RESOLUTION.id}'`)
    expect(q).toContain(`label: '${INCIDENT_CONFIRM_RESOLUTION.label}'`)
    expect(q).toContain(`labels: '${JSON.stringify(INCIDENT_CONFIRM_RESOLUTION.labels)}'`)
    expect(q).toContain("trigger: 'manual'")
    expect(lines).toContain('[20261008_1010_incident_confirm_resolution] c-one / "Incident Management" / resolved → closed: «Confirm resolution» added')
    expect(lines.at(-1)).toBe('[20261008_1010_incident_confirm_resolution] 1 workflows can now be closed by the requester\'s confirmation')
  })
})
