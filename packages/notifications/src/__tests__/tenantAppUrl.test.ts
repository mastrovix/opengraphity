/**
 * The links sent to a tenant's people open THAT tenant (review of 23 Sep 2026):
 * every link used the one APP_URL, and on a multi-tenant installation it
 * opened the wrong tenant, or none.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { tenantAppUrl } from '../appUrl.js'
import { formatSlackIncident } from '../formatters.js'
import { renderNotificationEmail } from '../dispatcher.js'

afterEach(() => { vi.unstubAllEnvs() })

describe('tenantAppUrl', () => {
  it('with TENANT_URL_TEMPLATE the link is the tenant\'s own', () => {
    vi.stubEnv('TENANT_URL_TEMPLATE', 'https://{slug}.itsm.example/')
    vi.stubEnv('APP_URL', 'https://itsm.example')
    expect(tenantAppUrl('c-two')).toBe('https://c-two.itsm.example')
  })

  it('without it the installation has one address, APP_URL', () => {
    vi.stubEnv('TENANT_URL_TEMPLATE', '')
    vi.stubEnv('APP_URL', 'https://itsm.example')
    expect(tenantAppUrl('c-two')).toBe('https://itsm.example')
  })

  it('an incident card and an email of tenant c-two link to c-two', () => {
    vi.stubEnv('TENANT_URL_TEMPLATE', 'https://{slug}.itsm.example')
    const locale = { language: 'en', timezone: 'UTC' } as never
    const blocks = JSON.stringify(formatSlackIncident('assigned', { id: 'inc-1', title: 'T', severity: 'high', status: 'new', tenantId: 'c-two' }, locale))
    expect(blocks).toContain('https://c-two.itsm.example/incidents/inc-1')
    const html = renderNotificationEmail('c-two', { id: 'n1', type: 'x', title: 'T', message: 'M', severity: 'info', entity_id: 'inc-1', entity_type: 'incident', timestamp: '2026-09-23T10:00:00Z', read: false }, locale)
    expect(html).toContain('https://c-two.itsm.example/incidents/inc-1')
  })
})
