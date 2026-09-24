/**
 * Base URL used in every outbound link (emails, Slack/Teams cards).
 *
 * The localhost default is a dev convenience only: in production a missing
 * APP_URL would silently send users links to http://localhost:5173 — that is
 * a config error. It is raised when a link is BUILT, not at import: the
 * workers import this package without ever building a link, and an import-time
 * throw put them in a restart loop. The API still fails at boot without it
 * (`validateConfig('api')`, key `appUrl`).
 */
export function appUrl(): string {
  const raw = process.env['APP_URL']
  if (raw) return raw
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('[notifications] APP_URL is not set in production — outbound links would point to localhost')
  }
  return 'http://localhost:5173'
}

/**
 * The base URL of ONE tenant's app, for the links sent to its people.
 *
 * Review of 23 Sep 2026: every link used the one process-wide APP_URL, and
 * the tenant is chosen by subdomain — on an installation with several
 * tenants a «View details» opened the wrong tenant, or none. With
 * `TENANT_URL_TEMPLATE` (`https://{slug}.example.com`, the same template the
 * platform console shows) the link is the tenant's own; without it the
 * installation has one address, APP_URL, as before.
 */
export function tenantAppUrl(tenantId: string): string {
  const template = process.env['TENANT_URL_TEMPLATE']?.trim()
  if (template) return template.split('{slug}').join(tenantId).replace(/\/+$/, '')
  return appUrl()
}
