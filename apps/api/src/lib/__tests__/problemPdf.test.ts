import { describe, it, expect } from 'vitest'
import { buildProblemPdf, type ProblemDossier, type PdfMeta } from '../problemPdf.js'

const META: PdfMeta = {
  generatedAt: '2026-07-17T10:00:00.000Z',
  generatedBy: 'test@example.com',
  tenantId:    'c-one',
}

function minimalDossier(): ProblemDossier {
  return {
    problem: {
      id:            'prb-1',
      number:        '',
      title:         'Minimal problem',
      description:   null,
      priority:      '',
      status:        '',
      rootCause:     null,
      workaround:    null,
      affectedUsers: null,
      createdAt:     null,
      updatedAt:     null,
      resolvedAt:    null,
      closedAt:      null,
    },
    createdBy:        null,
    assignee:         null,
    team:             null,
    affectedCIs:      [],
    relatedIncidents: [],
    relatedChanges:   [],
    workflowHistory:  [],
    comments:         [],
    attachments:      [],
  }
}

function fullDossier(): ProblemDossier {
  return {
    problem: {
      id:            'prb-2',
      number:        'PRB00000007',
      title:         'Recurring timeouts on checkout flow',
      description:   'Users experience intermittent timeouts.\nSecond line of description.',
      priority:      'high',
      status:        'root_cause_analysis',
      rootCause:     'Connection pool exhaustion under peak load',
      workaround:    'Restart the pool every 6 hours via cron',
      affectedUsers: 1250,
      createdAt:     '2026-06-01T08:00:00.000Z',
      updatedAt:     '2026-07-10T09:30:00.000Z',
      resolvedAt:    null,
      closedAt:      null,
    },
    createdBy: { name: 'Luca Verdi',   email: 'luca@example.com' },
    assignee:  { name: 'Mario Rossi',  email: 'mario.rossi@example.com' },
    team:      { name: 'Platform Team' },
    affectedCIs: [
      { name: 'checkout-svc',  type: 'application', environment: 'production', status: 'active' },
      { name: 'pg-primary-01', type: 'database',    environment: null,         status: null },
    ],
    relatedIncidents: [
      { number: 'INC00000042', title: 'Checkout timeout spike', status: 'resolved' },
      { number: '',            title: 'Legacy incident without number', status: 'closed' },
    ],
    relatedChanges: [
      { code: 'CHG00000123', title: 'Increase pool size', status: 'deployment' },
    ],
    workflowHistory: [
      { stepName: 'new',                 enteredAt: '2026-06-01T08:00:00.000Z', exitedAt: '2026-06-02T08:00:00.000Z', durationMs: 86_400_000, triggeredBy: 'luca',  triggerType: 'manual', notes: null },
      { stepName: 'root_cause_analysis', enteredAt: '2026-06-02T08:00:00.000Z', exitedAt: null,                        durationMs: null,       triggeredBy: 'mario', triggerType: 'manual', notes: 'Investigating pool metrics.' },
    ],
    comments: [
      {
        author:    'Mario Rossi',
        type:      'manual',
        createdAt: '2026-06-03T08:30:00.000Z',
        text:      'Pool saturation confirmed from Grafana.\nSecond line of the comment, long enough to wrap across the rendered page width of the A4 audit report.',
      },
      { author: null, type: 'system', createdAt: null, text: 'Automatic note from workflow engine.' },
    ],
    attachments: [
      { filename: 'pool-metrics.png', sizeBytes: 345_678, uploadedBy: 'Mario Rossi', uploadedAt: '2026-06-03T10:00:00.000Z' },
      { filename: 'rca-draft.docx',   sizeBytes: 45_120,  uploadedBy: null,          uploadedAt: null },
    ],
  }
}

describe('buildProblemPdf', () => {
  it('produces a valid PDF buffer (starts with %PDF-)', async () => {
    const buf = await buildProblemPdf(fullDossier(), META)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(1000)
  })

  it('does not throw with null fields and empty lists', async () => {
    const buf = await buildProblemPdf(minimalDossier(), META)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })

  it('smoke: many comments force page breaks and end with EOF marker', async () => {
    const dossier = fullDossier()
    for (let i = 0; i < 40; i++) {
      dossier.comments.push({
        author:    `User ${i}`,
        type:      i % 2 === 0 ? 'manual' : 'system',
        createdAt: '2026-06-10T12:00:00.000Z',
        text:      `Comment number ${i} with several lines.\nLine two of comment ${i}.\nLine three, intentionally long so the paragraph wraps over multiple rendered lines in the generated audit report document.`,
      })
    }
    const buf = await buildProblemPdf(dossier, META)
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    const tail = buf.subarray(-64).toString('ascii')
    expect(tail).toContain('%%EOF')
    const baseBuf = await buildProblemPdf(fullDossier(), META)
    expect(buf.length).toBeGreaterThan(baseBuf.length)
  })
})
