/**
 * C-09 / C-14 / C-17 pure helpers: cron due-window, KPI summary fail-loud,
 * tenant-local digest hour + idempotency key, versioned embedding job ids.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('bullmq', () => ({ Worker: vi.fn(), Queue: vi.fn() }))
vi.mock('ioredis', () => ({ Redis: vi.fn() }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('@opengraphity/notifications', () => ({ sendSlackMessage: vi.fn(), sseManager: { sendToTenant: vi.fn() }, sendEmail: vi.fn() }))
vi.mock('../../lib/reportExecutor.js', () => ({ executeReportSection: vi.fn() }))
vi.mock('../../services/embeddings.js', () => ({ getEmbedder: vi.fn(), vectorIndexName: vi.fn(), incidentEmbeddingText: vi.fn(), kbEmbeddingText: vi.fn() }))
const logError = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { error: logError, info: vi.fn(), warn: vi.fn(), child: () => ({ error: logError, info: vi.fn(), warn: vi.fn() }) },
}))

const { previousDueAt, buildSlackSummary } = await import('../reportScheduler.js')
const { localHourAndDate, digestMarkerKey, resolveTenantTimezone } = await import('../emailDigestWorker.js')
const { embeddingJobId } = await import('../embeddingWorker.js')

describe('previousDueAt (C-09)', () => {
  it('ritorna il tick precedente se entro la finestra di recupero, altrimenti null', () => {
    const now = new Date('2026-09-08T08:03:00Z')
    expect(previousDueAt('0 8 * * *', now, 'UTC')?.toISOString()).toBe('2026-09-08T08:00:00.000Z')   // 3 min late: still due
    expect(previousDueAt('0 8 * * *', new Date('2026-09-08T08:30:00Z'), 'UTC')).toBeNull()             // 30 min late: skipped
    expect(previousDueAt('*/5 * * * *', new Date('2026-09-08T08:04:30Z'), 'UTC')?.toISOString()).toBe('2026-09-08T08:00:00.000Z')
  })
  it('lancia su cron invalido (mai un disable silenzioso)', () => {
    expect(() => previousDueAt('not a cron', new Date())).toThrow()
  })
})

describe('buildSlackSummary (C-09)', () => {
  it('conta e logga le KPI malformate invece di ingoiarle', () => {
    logError.mockClear()
    const { blocks, malformedKpi } = buildSlackSummary('Weekly', 'tpl-1', [
      { title: 'Open', chartType: 'kpi', data: '{"value": 12, "label": "x"}' },
      { title: 'Broken', chartType: 'kpi', data: 'not json' },
      { title: 'NoValue', chartType: 'kpi', data: '{"label": "y"}' },
      { title: 'Bar', chartType: 'bar', data: '[]' },
    ])
    expect(malformedKpi).toBe(2)
    expect(logError).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(blocks)).toContain('*Open*')
    expect(JSON.stringify(blocks)).toContain('2 sezione/i KPI non leggibili')
  })
})

describe('email digest helpers (C-14)', () => {
  it('localHourAndDate usa il fuso del tenant', () => {
    const at = new Date('2026-09-08T06:30:00Z')
    expect(localHourAndDate(at, 'Europe/Rome')).toEqual({ hour: 8, date: '2026-09-08' })
    expect(localHourAndDate(at, 'UTC')).toEqual({ hour: 6, date: '2026-09-08' })
    expect(localHourAndDate(new Date('2026-09-08T23:30:00Z'), 'Asia/Tokyo')).toEqual({ hour: 8, date: '2026-09-09' })
  })
  it('digestMarkerKey è per tenant e data locale', () => {
    expect(digestMarkerKey('t1', '2026-09-08')).toBe('digest:t1:2026-09-08')
  })
  it('resolveTenantTimezone: valido → usato; assente → UTC; invalido → errore', () => {
    expect(resolveTenantTimezone({ id: 'a', timezone: 'Europe/Rome' })).toBe('Europe/Rome')
    expect(resolveTenantTimezone({ id: 'b', timezone: null })).toBe('UTC')
    expect(() => resolveTenantTimezone({ id: 'c', timezone: 'Mars/Olympus' })).toThrow(/invalid timezone/)
  })
})

describe('embeddingJobId (C-17)', () => {
  it('include la versione (updatedAt) così una modifica dopo un job fallito non viene deduplicata', () => {
    const a = embeddingJobId({ entityType: 'incident', entityId: 'i1', tenantId: 't', updatedAt: '2026-09-08T10:00:00.000Z' })
    const b = embeddingJobId({ entityType: 'incident', entityId: 'i1', tenantId: 't', updatedAt: '2026-09-08T10:05:00.000Z' })
    expect(a).toBe('embed-incident-i1-1789207200000'.replace('1789207200000', String(Date.parse('2026-09-08T10:00:00.000Z'))))
    expect(a).not.toBe(b)
    expect(embeddingJobId({ entityType: 'kb_article', entityId: 'k', tenantId: 't' }, 123)).toBe('embed-kb_article-k-123')
    expect(() => embeddingJobId({ entityType: 'incident', entityId: 'i', tenantId: 't', updatedAt: 'garbage' })).toThrow(/invalid updatedAt/)
  })
})
