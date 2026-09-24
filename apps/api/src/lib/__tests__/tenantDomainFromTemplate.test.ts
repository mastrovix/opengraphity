/**
 * The domain of a new tenant, from the installation's TENANT_URL_TEMPLATE
 * (review of 23 Sep 2026: it was the literal «opengrafo.com»).
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))

const { tenantDomainFromTemplate } = await import('../tenantLifecycle.js')

describe('tenantDomainFromTemplate', () => {
  it.each([
    ['https://{slug}.acme-itsm.example', 'acme-itsm.example'],
    ['http://{slug}.localhost', 'localhost'],
    ['https://{slug}.Ops.Example.com/', 'ops.example.com'],
    ['http://{slug}.localhost:8080', 'localhost'],
  ])('%s → %s', (template, domain) => {
    expect(tenantDomainFromTemplate(template)).toBe(domain)
  })

  it('a missing template, or one not of the form <scheme>://{slug}.<domain>, is said', () => {
    expect(() => tenantDomainFromTemplate(undefined)).toThrow(/is not configured/)
    expect(() => tenantDomainFromTemplate('  ')).toThrow(/is not configured/)
    expect(() => tenantDomainFromTemplate('https://itsm.example/{slug}')).toThrow(/is not of the form/)
    expect(() => tenantDomainFromTemplate('https://portal.{slug}.example')).toThrow(/is not of the form/)
  })
})
