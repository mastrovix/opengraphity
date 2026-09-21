/** Migrazione 20260930_1040_change_task_team_segments: la storia dei team anche per i task delle change. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { changeTaskTeamSegments, CHANGE_TASK_LABELS } from '../20260930_1040_change_task_team_segments.js'
import { MIGRATIONS } from '../index.js'

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260930_1040_change_task_team_segments', () => {
  it('è registrata dopo la 1030', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20260930_1040_change_task_team_segments')).toBe(ids.indexOf('20260930_1030_ticket_team_segments') + 1)
  })

  it('assessment e piano di deploy: un tratto dalla nascita del task, ricostruito, solo dove non c\'è storia', async () => {
    const cyphers: string[] = []
    const session = { run: vi.fn(async (c: string) => { cyphers.push(c); return { records: [{ get: () => 3 }] } }) }
    await changeTaskTeamSegments.up(session as never)
    expect(CHANGE_TASK_LABELS).toEqual(['AssessmentTask', 'DeployPlanTask'])
    expect(cyphers).toHaveLength(2)
    for (const c of cyphers) {
      expect(c).toContain('WHERE NOT EXISTS { (e)-[:TEAM_SEGMENT]->(:TicketTeamSegment) }')
      expect(c).toContain('started_at: coalesce(e.created_at')
      expect(c).toContain('inferred: true')
    }
  })
})
