/** Migrazione 20260930_1030_ticket_team_segments: il tratto ricostruito per i ticket che hanno già un team. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ticketTeamSegments, TEAM_SEGMENT_LABELS } from '../20260930_1030_ticket_team_segments.js'
import { MIGRATIONS } from '../index.js'

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260930_1030_ticket_team_segments', () => {
  it('è registrata dopo la 1020', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20260930_1030_ticket_team_segments')).toBeGreaterThan(ids.indexOf('20260930_1020_change_audit_detail_keys_owner_support'))
  })

  it('per ogni tipo di ticket crea un tratto dall\'apertura, ricostruito e aperto, solo dove non c\'è storia', async () => {
    const cyphers: string[] = []
    const session = { run: vi.fn(async (c: string) => { cyphers.push(c); return { records: [{ get: () => 2 }] } }) }
    await ticketTeamSegments.up(session as never)
    expect(cyphers).toHaveLength(TEAM_SEGMENT_LABELS.length)
    for (const c of cyphers) {
      expect(c).toContain('WHERE NOT EXISTS { (e)-[:TEAM_SEGMENT]->(:TicketTeamSegment) }')
      expect(c).toContain('started_at: coalesce(e.created_at')
      expect(c).toContain('ended_at: null, inferred: true')
      expect(c).toContain('tenant_id: e.tenant_id, team_id: t.id')
    }
    // I compiti di assessment/deploy hanno un team ma non sono ticket che un OLA misura.
    expect(cyphers.join('\n')).not.toContain('AssessmentTask')
  })
})
