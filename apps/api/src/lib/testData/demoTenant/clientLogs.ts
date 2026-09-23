/**
 * THE BROWSER LOGS OF THREE YEARS (22 Sep 2026).
 *
 * Every browser of the tenant posts its own errors to `/api/logs/client`, and
 * the product keeps them as `:LogEntry`: they are what an administrator finds
 * on the Logs page when somebody says "it did not work yesterday afternoon".
 * A demo tenant with three years of work and an empty Logs page would be a
 * demo of a page that does nothing.
 *
 * What is simulated: the failures a real front end reports — a request that
 * times out, a chunk that will not load after a deploy, a GraphQL error, a
 * session that expired — attached to a real person of the tenant, on a real
 * page of the app, at an hour when somebody was working. They follow the
 * same monthly curve as the tickets, so the Logs page has the same busy and
 * quiet periods as the rest of the tenant.
 *
 * Only inside the platform's retention (D65, tour of 23 Sep 2026): the logs
 * were spread over three years, and ten minutes into the tour the nightly
 * retention (services/serverLogRetention.ts, SERVER_LOG_RETENTION_DAYS)
 * deleted 5,300 of the 6,172 — the tenant is alive, and it keeps what the
 * platform keeps.
 */
import type { Rng } from './random.js'
import type { World } from './world.js'
import { arrivalInstants } from './arrivals.js'
import { DAY } from './clock.js'
import { leggiGiorniDiRetention } from '../../../services/serverLogRetention.js'

interface LogKind {
  level: 'error' | 'warn' | 'info'
  message: string
  weight: number
}

/** The pages the operators live on; the log carries the one they were on. */
const PAGES = [
  '/incidents', '/incidents/new', '/changes', '/changes/new', '/problems', '/requests', '/catalog',
  '/ci', '/ci/topology', '/dashboard', '/reports', '/tasks', '/monitoring/services', '/events', '/settings/workflow',
]

const OPERATIONS = [
  'GetIncidents', 'GetIncident', 'GetChanges', 'GetChange', 'GetProblems', 'GetServiceRequests', 'GetCIs',
  'GetDashboard', 'RunReportSection', 'GetMyTasks', 'GetServiceHealth', 'MyPendingApprovalsCount', 'GlobalSearch',
]

const KINDS: readonly LogKind[] = [
  { level: 'error', message: 'Network error: Response not successful: Received status code 504', weight: 22 },
  { level: 'error', message: 'Network error: Failed to fetch', weight: 18 },
  { level: 'error', message: 'GraphQL error: Context creation failed: token expired', weight: 12 },
  { level: 'error', message: 'ChunkLoadError: Loading chunk failed after a new version was deployed', weight: 9 },
  { level: 'error', message: 'Unhandled promise rejection: TypeError: Cannot read properties of undefined', weight: 7 },
  { level: 'error', message: 'Network error: Response not successful: Received status code 502', weight: 6 },
  { level: 'warn', message: 'Slow response: the query took more than 10 seconds', weight: 12 },
  { level: 'warn', message: 'Retrying the request after a network failure', weight: 8 },
  { level: 'warn', message: 'The session was refreshed while a form was open', weight: 4 },
  { level: 'info', message: 'The browser went offline and came back', weight: 2 },
]

export interface PlannedClientLog extends Record<string, unknown> {
  id: string
  level: string
  module: string
  message: string
  data: string
  timestamp: string
  created_at: string
}

/**
 * `count` browser logs inside the retention window. The people who appear are the
 * ones who already existed at that moment, and a spell of trouble lasts more
 * than one line: a failure that reaches the Logs page usually left five.
 */
export function planClientLogs(rng: Rng, w: World, count: number): PlannedClientLog[] {
  const weights = KINDS.map((k) => [k, k.weight] as const)
  const out: PlannedClientLog[] = []
  // Two thirds of the lines are the first of a spell, the rest follow it
  // within minutes: that is how a browser reports a bad afternoon.
  const keptFrom = Math.max(w.clock.startMs + 10 * DAY, w.clock.nowMs - (leggiGiorniDiRetention() - 1) * DAY)
  // Half as many spells as lines: at three lines a spell on average there is room to reach `count` exactly.
  const spells = arrivalInstants(rng, w.clock, Math.ceil(count / 2), keptFrom, w.clock.nowMs - 60_000)
  for (const at of spells) {
    const kind = rng.weighted(weights)
    const user = w.someone(rng, rng.chance(0.75) ? w.operators : w.endUsers, at)
    const page = rng.pick(PAGES)
    for (let k = 0, lines = rng.int(1, 5); k < lines && out.length < count; k++) {
      const when = new Date(Math.min(w.clock.nowMs - 30_000, at + k * rng.int(2, 90) * 1000)).toISOString()
      out.push({
        id: rng.uuid(),
        level: kind.level,
        module: 'frontend',
        message: kind.message,
        data: JSON.stringify({ operation: rng.pick(OPERATIONS), url: page, clientTimestamp: when, userId: user.id }),
        timestamp: when,
        created_at: when,
      })
    }
    if (out.length >= count) break
  }
  return out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
}
