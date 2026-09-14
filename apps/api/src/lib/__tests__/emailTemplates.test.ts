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

  const EN = { language: 'en' as const, timeZone: 'UTC' }
  const IT = { language: 'it' as const, timeZone: 'UTC' }

  it('mentionNotification escapa excerpt e autore', () => {
    noRawScript(t.mentionNotification({ entityType: 'change', entityTitle: XSS, entityId: 'x', mentionerName: XSS, excerpt: XSS }, 'T', EN).html)
  })

  it('watcherNotification escapa l\'evento', () => {
    noRawScript(t.watcherNotification({ entityType: 'incident', entityTitle: XSS, entityId: 'i', event: XSS }, 'T', EN).html)
  })

  it('digestDaily escapa gli eventi recenti', () => {
    const { html } = t.digestDaily({ openIncidents: 1, resolvedToday: 2, ongoingChanges: 3, slaBreaches: 4, recentEvents: [XSS] }, 'T', EN)
    noRawScript(html)
  })

  it('gli id finiscono URL-encoded nei link', () => {
    const { html } = t.watcherNotification({ entityType: 'incident', entityTitle: 't', entityId: 'a b/../c', event: 'e' }, 'T', EN)
    expect(html).toContain('/incidents/a%20b%2F..%2Fc')
  })

  /**
   * Revisione del 14 set 2026 · CO-2: le e-mail di menzione, di osservazione e
   * il digest erano in italiano fisso per ogni cliente. Ora nella sua lingua.
   */
  it('le e-mail parlano la lingua del cliente', () => {
    const p = { entityType: 'incident', entityTitle: 'DB down', entityId: 'i1', mentionerName: 'Bob', excerpt: 'x' }
    expect(t.mentionNotification(p, 'ACME', EN).subject).toBe('[ACME] Bob mentioned you in incident DB down')
    expect(t.mentionNotification(p, 'ACME', IT).subject).toBe('[ACME] Bob ti ha menzionato in incident DB down')
    expect(t.mentionNotification(p, 'ACME', EN).html).toContain('Go to the comment')
    expect(t.digestDaily({ openIncidents: 0, resolvedToday: 0, ongoingChanges: 0, slaBreaches: 0, recentEvents: [] }, 'ACME', EN).html).toContain('No recent events')
    expect(t.digestDaily({ openIncidents: 0, resolvedToday: 0, ongoingChanges: 0, slaBreaches: 0, recentEvents: [] }, 'ACME', EN).subject).toBe('[ACME] Daily IT digest')
    const w = t.watcherNotification({ entityType: 'problem', entityTitle: 'P', entityId: 'p1', event: 'e' }, 'ACME', IT)
    expect(w.subject).toBe('[ACME] Aggiornamento su problem P')
    expect(w.html).toContain('/problems/p1')
  })

  it('il testo tradotto non ha italiano cablato nel modulo', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../emailTemplates.ts', import.meta.url), 'utf8')
    for (const it of ['ti ha menzionato', 'Aggiornamento', 'Riepilogo giornaliero', 'Vai al', 'Nessun evento']) expect(src).not.toContain(it)
  })
})
