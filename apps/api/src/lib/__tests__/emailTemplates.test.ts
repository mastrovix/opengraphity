/**
 * C-13: every user-controlled value is HTML-escaped in the email markup.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { escapeHtml } from '@opengraphity/notifications'
import * as t from '../emailTemplates.js'

const XSS = `<script>alert("x")</script> & <a href='https://evil'>link</a>`

describe('escapeHtml', () => {
  it('escapa & < > " \'', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(42)).toBe('42')
  })
})

describe('emailTemplates', () => {
  beforeAll(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T10:00:00Z'))
    process.env['APP_URL'] = 'https://app.example.test'
  })
  afterAll(() => {
    vi.useRealTimers()
    delete process.env['APP_URL']
  })

  const noRawScript = (html: string) => {
    expect(html).not.toContain('<script>')
    expect(html).not.toContain("<a href='https://evil'>")
    expect(html).toContain('&lt;script&gt;')
  }

  it('incidentCreated escapa titolo, categoria, descrizione e tenant', () => {
    const { html } = t.incidentCreated({ id: 'i1', title: XSS, severity: 'high', category: XSS, description: XSS }, XSS)
    noRawScript(html)
    expect(html).toContain('/incidents/i1')
  })

  it('incidentAssigned / incidentResolved / incidentEscalated / changeApprovalRequested', () => {
    noRawScript(t.incidentAssigned({ id: 'i', title: XSS, severity: XSS, assignedBy: XSS }, 'T').html)
    noRawScript(t.incidentResolved({ id: 'i', title: XSS, resolvedBy: XSS, rootCause: XSS }, 'T').html)
    noRawScript(t.incidentEscalated({ id: 'i', title: XSS, severity: 'critical' }, 'T').html)
    noRawScript(t.changeApprovalRequested({ id: 'c', title: XSS, type: XSS, description: XSS }, 'T').html)
  })

  it('commentAdded / mentionNotification escapano excerpt e autore', () => {
    noRawScript(t.commentAdded({ entityType: 'incident', entityTitle: XSS, entityId: 'x', authorName: XSS, excerpt: XSS }, 'T').html)
    noRawScript(t.mentionNotification({ entityType: 'change', entityTitle: XSS, entityId: 'x', mentionerName: XSS, excerpt: XSS }, 'T').html)
  })

  it('slaBreach / watcherNotification escapano tipo SLA ed event', () => {
    noRawScript(t.slaBreach({ entityType: 'problem', entityTitle: XSS, entityId: 'p', slaType: XSS }, 'T').html)
    noRawScript(t.watcherNotification({ entityType: 'incident', entityTitle: XSS, entityId: 'i', event: XSS }, 'T').html)
  })

  it('digestDaily escapa gli eventi recenti', () => {
    const { html } = t.digestDaily({ openIncidents: 1, resolvedToday: 2, ongoingChanges: 3, slaBreaches: 4, recentEvents: [XSS] }, 'T')
    noRawScript(html)
  })

  it('gli id finiscono URL-encoded nei link', () => {
    const { html } = t.incidentCreated({ id: 'a b/../c', title: 't', severity: 'low' }, 'T')
    expect(html).toContain('/incidents/a%20b%2F..%2Fc')
  })

  it('snapshot di incidentCreated (layout stabile)', () => {
    const { html, subject } = t.incidentCreated({ id: 'inc-1', title: 'Disk <full>', severity: 'high', description: 'a & b' }, 'ACME')
    expect(subject).toBe('[ACME] Nuovo incident: Disk <full>')
    expect(html).toMatchSnapshot()
  })
})
