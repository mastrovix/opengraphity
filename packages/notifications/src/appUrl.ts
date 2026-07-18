/**
 * Base URL used in every outbound link (emails, Slack/Teams cards).
 *
 * The localhost default is a dev convenience only: in production a missing
 * APP_URL would silently send users links to http://localhost:5173 — that is
 * a config error, so it fails at startup like the other production guards.
 */
const raw = process.env['APP_URL']

if (!raw && process.env['NODE_ENV'] === 'production') {
  throw new Error('[notifications] APP_URL is not set in production — outbound links would point to localhost')
}

export const APP_URL: string = raw ?? 'http://localhost:5173'
