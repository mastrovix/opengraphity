/**
 * The shared queues the tenants left behind (23 Sep 2026).
 *
 * Every queue that holds a tenant's work is now that tenant's
 * (`<base>@<tenant>`). The queues the tenants used to share (`sla-jobs`,
 * `workflow-jobs`, …) are worked by nobody: whatever is left in them —
 * timers, recurring jobs, history — would stay in Redis for ever. The owner
 * chose not to migrate it: the demo is regenerated from scratch.
 *
 * A shared queue that still has workers connected is never dropped: a process
 * still runs the code from before the tenant queues, and those are its live
 * jobs.
 */

/** What the dropping needs of a BullMQ queue (a narrow view, for the tests). */
export interface RetiredQueue {
  getJobCounts(...types: JobState[]): Promise<Record<string, number>>
  getJobSchedulersCount(): Promise<number>
  getWorkersCount(): Promise<number>
  obliterate(opts: { force: boolean }): Promise<void>
  close(): Promise<void>
}

export const JOB_STATES = ['waiting', 'prioritized', 'delayed', 'active', 'failed', 'completed', 'waiting-children'] as const
export type JobState = (typeof JOB_STATES)[number]

export type SharedQueueOutcome = 'would-drop' | 'dropped' | 'still-worked'

export interface SharedQueueReport {
  readonly base: string
  readonly jobs: Readonly<Record<JobState, number>>
  readonly schedulers: number
  readonly workers: number
  readonly outcome: SharedQueueOutcome
}

export interface DropSharedQueuesDeps {
  /** The tenant queue bases of lib/queueRegistry.ts. */
  readonly bases: readonly string[]
  /** Whether Redis still holds keys of the shared queue `base`. */
  exists(base: string): Promise<boolean>
  open(base: string): RetiredQueue
  /** False: only say what would go. */
  readonly apply: boolean
}

/** Reads (and, with `apply`, drops) every shared queue still in Redis. */
export async function dropSharedQueues(deps: DropSharedQueuesDeps): Promise<SharedQueueReport[]> {
  const reports: SharedQueueReport[] = []
  for (const base of deps.bases) {
    if (!(await deps.exists(base))) continue
    const queue = deps.open(base)
    try {
      const counts = await queue.getJobCounts(...JOB_STATES)
      const jobs = Object.fromEntries(JOB_STATES.map((s) => [s, counts[s] ?? 0])) as Record<JobState, number>
      const schedulers = await queue.getJobSchedulersCount()
      const workers = await queue.getWorkersCount()
      let outcome: SharedQueueOutcome = 'would-drop'
      if (workers > 0) outcome = 'still-worked'
      else if (deps.apply) {
        await queue.obliterate({ force: true })
        outcome = 'dropped'
      }
      reports.push({ base, jobs, schedulers, workers, outcome })
    } finally {
      await queue.close()
    }
  }
  return reports
}

/** One line per queue, for the terminal. */
export function formatSharedQueueReport(r: SharedQueueReport): string {
  const jobs = JOB_STATES.filter((s) => r.jobs[s] > 0).map((s) => `${s} ${String(r.jobs[s])}`).join(', ') || 'no jobs'
  const what = r.outcome === 'still-worked'
    ? `NOT dropped: ${String(r.workers)} worker(s) still connected — a process still runs the code from before the tenant queues`
    : r.outcome === 'dropped' ? 'dropped' : 'would be dropped'
  return `${r.base.padEnd(26)} ${jobs}; ${String(r.schedulers)} scheduler(s) — ${what}`
}
