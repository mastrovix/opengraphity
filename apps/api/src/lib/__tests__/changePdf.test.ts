import { describe, it, expect } from 'vitest'
import { buildChangePdf, type ChangeDossier, type PdfMeta } from '../changePdf.js'

const META: PdfMeta = {
  generatedAt: '2026-07-17T10:00:00.000Z',
  generatedBy: 'test@example.com',
  tenantId:    'c-one',
}

function minimalDossier(): ChangeDossier {
  return {
    change: {
      id:                 'chg-1',
      code:               '',
      title:              'Minimal change',
      description:        null,
      aggregateRiskScore: null,
      approvalRoute:      null,
      approvalStatus:     null,
      approvalAt:         null,
      createdAt:          null,
      updatedAt:          null,
    },
    phase:           null,
    requester:       null,
    changeOwner:     null,
    affectedCIs:     [],
    workflowHistory: [],
    auditTrail:      [],
    attachments:     [],
  }
}

function fullDossier(): ChangeDossier {
  return {
    change: {
      id:                 'chg-2',
      code:               'CHG00000123',
      title:              'Upgrade payment gateway to v3',
      description:        'Roll out the new payment gateway.\nSecond line of description.',
      aggregateRiskScore: 72,
      approvalRoute:      'cab',
      approvalStatus:     'approved',
      approvalAt:         '2026-07-05T14:00:00.000Z',
      createdAt:          '2026-07-01T08:00:00.000Z',
      updatedAt:          '2026-07-10T09:30:00.000Z',
    },
    phase:       'deployment',
    requester:   { name: 'Mario Rossi',  email: 'mario.rossi@example.com' },
    changeOwner: { name: 'Anna Bianchi', email: 'anna@example.com' },
    affectedCIs: [
      {
        name:        'payment-api',
        type:        'application',
        environment: 'production',
        riskScore:   72,
        ciPhase:     'deployment',
        assessmentOwner:   { code: 'AT-001', status: 'completed',   score: 40,  result: null,     completedAt: '2026-07-02T10:00:00.000Z' },
        assessmentSupport: { code: 'AT-002', status: 'completed',   score: 72,  result: null,     completedAt: '2026-07-02T11:00:00.000Z' },
        deployPlan:        { code: 'DP-001', status: 'completed',   score: null, result: null,    completedAt: '2026-07-04T09:00:00.000Z' },
        validation:        { code: 'VT-001', status: 'completed',   score: null, result: 'pass',  completedAt: '2026-07-08T10:00:00.000Z' },
        deployment:        { code: 'DT-001', status: 'in_progress', score: null, result: null,    completedAt: null },
        review:            null,
      },
      {
        name:        'pg-primary-01',
        type:        'database',
        environment: null,
        riskScore:   null,
        ciPhase:     'assessment',
        assessmentOwner:   { code: 'AT-003', status: 'pending', score: null, result: null, completedAt: null },
        assessmentSupport: null,
        deployPlan:        null,
        validation:        null,
        deployment:        null,
        review:            null,
      },
      // CI with no tasks at all
      {
        name: 'edge-lb', type: 'load_balancer', environment: 'production',
        riskScore: null, ciPhase: null,
        assessmentOwner: null, assessmentSupport: null, deployPlan: null,
        validation: null, deployment: null, review: null,
      },
    ],
    workflowHistory: [
      { stepName: 'draft',      enteredAt: '2026-07-01T08:00:00.000Z', exitedAt: '2026-07-01T09:00:00.000Z', durationMs: 3_600_000, triggeredBy: 'mario.rossi', triggerType: 'manual', notes: null },
      { stepName: 'assessment', enteredAt: '2026-07-01T09:00:00.000Z', exitedAt: '2026-07-03T09:00:00.000Z', durationMs: 172_800_000, triggeredBy: 'system',    triggerType: 'auto',   notes: 'All assessments completed.' },
      { stepName: 'deployment', enteredAt: '2026-07-06T09:00:00.000Z', exitedAt: null,                        durationMs: null,        triggeredBy: 'anna',      triggerType: 'manual', notes: null },
    ],
    auditTrail: [
      { timestamp: '2026-07-01T08:00:00.000Z', action: 'change_created',   detail: null,                         actor: 'Mario Rossi' },
      { timestamp: '2026-07-05T14:00:00.000Z', action: 'change_approved',  detail: 'CAB approval, quorum 5/5',   actor: 'Anna Bianchi' },
      { timestamp: '2026-07-06T09:00:00.000Z', action: 'phase_transition', detail: 'cab -> deployment',          actor: null },
    ],
    attachments: [
      { filename: 'rollback-plan.pdf', sizeBytes: 1_234_567, uploadedBy: 'Mario Rossi', uploadedAt: '2026-07-03T10:00:00.000Z' },
      { filename: 'cab-minutes.docx',  sizeBytes: 45_120,    uploadedBy: null,          uploadedAt: null },
    ],
  }
}

describe('buildChangePdf', () => {
  it('produces a valid PDF buffer (starts with %PDF-)', async () => {
    const buf = await buildChangePdf(fullDossier(), META)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(1000)
  })

  it('does not throw with null fields and empty lists', async () => {
    const buf = await buildChangePdf(minimalDossier(), META)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })

  it('smoke: many CIs and audit entries force page breaks and end with EOF marker', async () => {
    const dossier = fullDossier()
    for (let i = 0; i < 25; i++) {
      dossier.affectedCIs.push({
        name:        `ci-bulk-${i}`,
        type:        'server',
        environment: 'production',
        riskScore:   (i * 7) % 100,
        ciPhase:     'assessment',
        assessmentOwner:   { code: `AT-B${i}A`, status: 'completed', score: 30, result: null, completedAt: '2026-07-02T10:00:00.000Z' },
        assessmentSupport: { code: `AT-B${i}B`, status: 'completed', score: 55, result: null, completedAt: '2026-07-02T11:00:00.000Z' },
        deployPlan:        { code: `DP-B${i}`,  status: 'pending',   score: null, result: null, completedAt: null },
        validation:        null,
        deployment:        null,
        review:            null,
      })
      dossier.auditTrail.push({
        timestamp: '2026-07-07T12:00:00.000Z',
        action:    `bulk_action_${i}`,
        detail:    `Detail line for bulk audit entry ${i}, intentionally long enough to wrap over multiple rendered lines in the generated report.`,
        actor:     `User ${i}`,
      })
    }
    const buf = await buildChangePdf(dossier, META)
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    const tail = buf.subarray(-64).toString('ascii')
    expect(tail).toContain('%%EOF')
    const baseBuf = await buildChangePdf(fullDossier(), META)
    expect(buf.length).toBeGreaterThan(baseBuf.length)
  })
})
