/**
 * A-07 / A-17: payload_template rendering escapes values for a JSON string
 * context, and job ids are deterministic per (webhook, event).
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), getSession: vi.fn() }))
vi.mock('bullmq', () => ({ Worker: vi.fn(), Queue: vi.fn() }))

import { renderPayloadTemplate, deliveryJobId } from '../webhookDeliveryWorker.js'

describe('renderPayloadTemplate', () => {
  const tpl = '{"title": "{{title}}", "sev": "{{entity.severity}}", "n": "{{number}}", "missing": "{{nope.deeper}}"}'

  it('substitutes nested paths and yields valid JSON', () => {
    const out = renderPayloadTemplate(tpl, { title: 'Disk full', number: 42, entity: { severity: 'high' } })
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed).toEqual({ title: 'Disk full', sev: 'high', n: '42', missing: '' })
  })

  it('escapes quotes/backslashes/newlines so a title cannot inject fields (A-17)', () => {
    const evil = 'x", "role": "admin", "y": "\\ \n end'
    const out = renderPayloadTemplate('{"title": "{{title}}"}', { title: evil })
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['title'])
    expect(parsed['title']).toBe(evil)
  })

  it('serialises objects/arrays as escaped JSON text', () => {
    const out = renderPayloadTemplate('{"tags": "{{tags}}"}', { tags: ['a', 'b"c'] })
    expect(JSON.parse(out)).toEqual({ tags: '["a","b\\"c"]' })
  })

  it('renders null/undefined as empty string', () => {
    expect(renderPayloadTemplate('"{{a}}|{{b}}"', { a: null })).toBe('"|"')
  })

  it('handles unicode line separators (valid JSON output)', () => {
    const out = renderPayloadTemplate('{"t": "{{t}}"}', { t: 'a b' })
    expect(JSON.parse(out)).toEqual({ t: 'a b' })
  })
})

describe('deliveryJobId', () => {
  it('is wh-<webhookId>-<eventId> when an event id is given', () => {
    expect(deliveryJobId('w1', 'incident.created', { id: 'x' }, 'ev-123')).toBe('wh-w1-ev-123')
  })

  it('falls back to a stable payload hash (same event twice ⇒ same id)', () => {
    const a = deliveryJobId('w1', 'incident.created', { id: 'x', title: 't' })
    const b = deliveryJobId('w1', 'incident.created', { id: 'x', title: 't' })
    const c = deliveryJobId('w1', 'incident.updated', { id: 'x', title: 't' })
    const d = deliveryJobId('w2', 'incident.created', { id: 'x', title: 't' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
    expect(a).toMatch(/^wh-w1-[0-9a-f]{32}$/)
  })
})
