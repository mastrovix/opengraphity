import { describe, it, expect } from 'vitest'
import { buildIncidentPdf, type IncidentDossier, type PdfMeta } from '../incidentPdf.js'

const META: PdfMeta = {
  generatedAt: '2026-07-17T10:00:00.000Z',
  generatedBy: 'test@example.com',
  tenantId:    'c-one',
}

function minimalDossier(): IncidentDossier {
  return {
    incident: {
      id:          'inc-1',
      number:      '',
      title:       'Minimal incident',
      description: null,
      severity:    '',
      status:      '',
      category:    null,
      createdAt:   null,
      updatedAt:   null,
      resolvedAt:  null,
      rootCause:   null,
    },
    assignee:        null,
    team:            null,
    watchers:        [],
    slaStatus:       null,
    affectedCIs:     [],
    workflowHistory: [],
    comments:        [],
    attachments:     [],
  }
}

function fullDossier(): IncidentDossier {
  return {
    incident: {
      id:          'inc-2',
      number:      'INC00000042',
      title:       'Database outage on payment cluster',
      description: 'Full outage of the primary payment database.\nSecond line of description.',
      severity:    'critical',
      status:      'resolved',
      category:    'database',
      createdAt:   '2026-07-01T08:00:00.000Z',
      updatedAt:   '2026-07-02T09:30:00.000Z',
      resolvedAt:  '2026-07-02T09:00:00.000Z',
      rootCause:   'Disk saturation on primary node',
    },
    assignee: { name: 'Mario Rossi', email: 'mario.rossi@example.com' },
    team:     { name: 'DBA Team' },
    watchers: [
      { name: 'Anna Bianchi', email: 'anna@example.com' },
      { name: '',             email: 'watcher2@example.com' },
    ],
    slaStatus: {
      responseDeadline: '2026-07-01T09:00:00.000Z',
      resolveDeadline:  '2026-07-01T16:00:00.000Z',
      responseMet:      true,
      resolveMet:       false,
      breached:         true,
    },
    affectedCIs: [
      { name: 'pg-primary-01', type: 'database',  environment: 'production', status: 'active' },
      { name: 'payment-api',   type: 'application', environment: null,       status: null },
    ],
    workflowHistory: [
      { stepName: 'new',         enteredAt: '2026-07-01T08:00:00.000Z', exitedAt: '2026-07-01T08:10:00.000Z', durationMs: 600_000,    triggeredBy: 'system',        triggerType: 'auto',   notes: null },
      { stepName: 'in_progress', enteredAt: '2026-07-01T08:10:00.000Z', exitedAt: '2026-07-02T09:00:00.000Z', durationMs: 89_400_000, triggeredBy: 'mario.rossi',   triggerType: 'manual', notes: 'Escalated to DBA on-call.' },
      { stepName: 'resolved',    enteredAt: '2026-07-02T09:00:00.000Z', exitedAt: null,                        durationMs: null,       triggeredBy: 'mario.rossi',   triggerType: 'manual', notes: 'Root cause identified and fixed.' },
    ],
    comments: [
      {
        author:    'Anna Bianchi',
        createdAt: '2026-07-01T08:30:00.000Z',
        text:      'First diagnostics show disk pressure.\nSecond line of the comment.\n\nThird paragraph after a blank line, long enough to wrap across the page width when the PDF text engine lays it out on an A4 page with standard margins.',
      },
      { author: null, createdAt: null, text: 'Comment from a deleted user.' },
    ],
    attachments: [
      { filename: 'postmortem.pdf',   sizeBytes: 2_345_678, uploadedBy: 'Mario Rossi', uploadedAt: '2026-07-02T10:00:00.000Z' },
      { filename: 'disk-metrics.png', sizeBytes: 45_120,    uploadedBy: null,          uploadedAt: null },
    ],
  }
}

describe('buildIncidentPdf', () => {
  it('produces a valid PDF buffer (starts with %PDF-)', async () => {
    const buf = await buildIncidentPdf(fullDossier(), META)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(1000)
  })

  it('does not throw with null fields and empty lists', async () => {
    const buf = await buildIncidentPdf(minimalDossier(), META)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })

  it('smoke: full dossier with multiline comments renders and ends with EOF marker', async () => {
    const dossier = fullDossier()
    // stress: many comments to force page breaks + footer on every page
    for (let i = 0; i < 40; i++) {
      dossier.comments.push({
        author:    `User ${i}`,
        createdAt: '2026-07-03T12:00:00.000Z',
        text:      `Comment number ${i} with several lines.\nLine two of comment ${i}.\nLine three, intentionally long so the paragraph wraps over multiple rendered lines in the generated audit report document.`,
      })
    }
    const buf = await buildIncidentPdf(dossier, META)
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    // %%EOF marker near the end of the file
    const tail = buf.subarray(-64).toString('ascii')
    expect(tail).toContain('%%EOF')
    // Multi-page: a PDF with 40+ comments must be larger than the base one
    const baseBuf = await buildIncidentPdf(fullDossier(), META)
    expect(buf.length).toBeGreaterThan(baseBuf.length)
  })
})
