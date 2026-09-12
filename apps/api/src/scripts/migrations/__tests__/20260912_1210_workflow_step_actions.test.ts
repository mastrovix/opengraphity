/**
 * Migrazione 20260912_1210_workflow_step_actions (personalizzazioni, ondata 0,
 * B0-5): riallinea le azioni dei passi al vocabolario del motore. Dal vivo
 * l'unico caso è `create_notification` su `security_review` di «Incident —
 * Security» (c-one), che il seed scrive come `publish_event`. Qualunque altro
 * tipo fuori vocabolario FERMA la migrazione; i passi già coerenti non si
 * toccano; idempotente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { workflowStepActions } from '../20260912_1210_workflow_step_actions.js'
import { MIGRATIONS } from '../index.js'

interface StepRow {
  id: string; stepName: string; tenantId: string; defName: string; entityType: string
  enterActions: unknown; exitActions: unknown
}

function fakeSession(rows: StepRow[]) {
  const writes: Array<{ cypher: string; params: Record<string, unknown> }> = []
  return {
    writes,
    run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      if (cypher.includes('MATCH (wd:WorkflowDefinition)-[:HAS_STEP]->(s:WorkflowStep)')) {
        return { records: rows.map((r) => ({ get: (k: keyof StepRow) => r[k] })) }
      }
      writes.push({ cypher, params })
      return { records: [] }
    }),
  }
}

const LIVE_DRIFT: StepRow = {
  id: 's-security-review', stepName: 'security_review', tenantId: 'c-one',
  defName: 'Incident — Security', entityType: 'incident',
  enterActions: JSON.stringify([{ type: 'create_notification', params: { channel: 'in_app', message: 'Incident in security review' } }]),
  exitActions: '[]',
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260912_1210_workflow_step_actions', () => {
  it('è registrata, con id nel formato YYYYMMDD_HHMM_name e senza autocommit', () => {
    expect(MIGRATIONS.map((m) => m.id)).toContain('20260912_1210_workflow_step_actions')
    expect(workflowStepActions.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(workflowStepActions.autocommit).toBeUndefined()
  })

  it('il caso vivo: create_notification → publish_event con l\'evento che scrive il seed', async () => {
    const s = fakeSession([LIVE_DRIFT])
    await workflowStepActions.up(s as never)

    expect(s.writes).toHaveLength(1)
    expect(s.writes[0]!.params['id']).toBe('s-security-review')
    expect(JSON.parse(s.writes[0]!.params['enterActions'] as string)).toEqual([
      { type: 'publish_event', params: { event: 'incident.security_review' } },
    ])
    // `exit_actions` non è toccato: coalesce lascia il valore esistente
    expect(s.writes[0]!.params['exitActions']).toBeNull()
  })

  it('i passi con azioni del vocabolario non vengono toccati', async () => {
    const s = fakeSession([{
      id: 's-resolved', stepName: 'resolved', tenantId: 'c-one', defName: 'Incident Management', entityType: 'incident',
      enterActions: JSON.stringify([{ type: 'sla_stop', params: { sla_type: 'resolve' } }, { type: 'schedule_job', params: { job: 'auto_close', delay_hours: '72' } }]),
      exitActions: JSON.stringify([{ type: 'cancel_job', params: { job: 'auto_close' } }]),
    }])
    await workflowStepActions.up(s as never)
    expect(s.writes).toEqual([])
  })

  it('idempotente: dopo la traduzione non resta nulla da fare', async () => {
    const s = fakeSession([{
      ...LIVE_DRIFT,
      enterActions: JSON.stringify([{ type: 'publish_event', params: { event: 'incident.security_review' } }]),
    }])
    await workflowStepActions.up(s as never)
    expect(s.writes).toEqual([])
  })

  it('un ALTRO tipo fuori vocabolario ferma la migrazione nominando tenant, definizione, passo e tipo', async () => {
    const s = fakeSession([{
      ...LIVE_DRIFT,
      enterActions: JSON.stringify([{ type: 'teleport', params: {} }]),
    }])
    await expect(workflowStepActions.up(s as never)).rejects
      .toThrow(/c-one\/Incident — Security\/security_review enter_actions: azione di tipo "teleport"/)
    expect(s.writes).toEqual([])
  })

  it('un JSON corrotto ferma la migrazione nominando il passo', async () => {
    const s = fakeSession([{ ...LIVE_DRIFT, enterActions: '[{non json' }])
    await expect(workflowStepActions.up(s as never)).rejects
      .toThrow(/c-one\/Incident — Security\/security_review enter_actions is corrupt JSON/)
    expect(s.writes).toEqual([])
  })

  it('traduce anche fra le exit_actions, e solo l\'azione colpita', async () => {
    const s = fakeSession([{
      ...LIVE_DRIFT,
      enterActions: '[]',
      exitActions: JSON.stringify([
        { type: 'sla_resume', params: { sla_type: 'resolve' } },
        { type: 'create_notification', params: { channel: 'email' } },
      ]),
    }])
    await workflowStepActions.up(s as never)
    expect(JSON.parse(s.writes[0]!.params['exitActions'] as string)).toEqual([
      { type: 'sla_resume', params: { sla_type: 'resolve' } },
      { type: 'publish_event', params: { event: 'incident.security_review' } },
    ])
    expect(s.writes[0]!.params['enterActions']).toBeNull()
  })
})
