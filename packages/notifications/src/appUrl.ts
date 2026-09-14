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
