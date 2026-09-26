/**
 * What every operational remedy shares (26 Sep 2026): the limits, the day of
 * an episode, the rule «never twice on the same cause without a person» and
 * the shape of a proposal. The remedies themselves are in
 * `operationsRemedies.ts` (failed jobs, the verification pass) and
 * `operationsGraphRemedies.ts` (alarms, service maps, CI health, workflows).
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import type { ProposalToWrite } from './proposals.js'
import type { ProposalEvidenceRef } from '@opengraphity/types'

export const OPERATIONS_LIMITS = {
  /** Failed jobs retried by one accepted proposal, at most. */
  retryMax: 20,
  /** Items (alarms, CIs, tickets) one accepted proposal acts on, at most: the rest waits for the next night. */
  batchMax: 20,
  /** Service maps proposed per night, at most: each is a proposal of its own. */
  mapsMax: 10,
  /** How long after the remedy the verification looks again: time for the work to run. */
  verifyAfterMs: 2 * 60_000,
  /** After a remedy that did not hold, no remedy for that cause for this long. */
  holdDays: 7,
  /**
   * How much longer than the periodic pass's own threshold an alarm has to stay
   * stuck before a person is asked: the pass runs every 5 minutes and repairs
   * these by itself, so still stuck 45 minutes later means nine passes failed.
   */
  alarmsBeyondPassMinutes: 45,
  /** A CI whose health disagrees with its alarms, with no alarm news for this long: the recompute was lost. */
  ciHealthQuietMinutes: 15,
  /** A live service map not synchronized for this long: two safety passes (30 minutes each) missed it. */
  mapSyncLateMinutes: 60,
  /** A missing CI still in a live map this long after the last synchronization. */
  mapMissingCIMinutes: 15,
  /** A wait step whose timer expired this long ago: the timer job was lost (the only «late» a workflow can be). */
  timerGraceMinutes: 15,
} as const

/** Who acted, in the histories the remedies write: nobody clicked on the ticket, an admin accepted a proposal. */
export const REMEDY_ACTOR = 'system:operations-remedy'

export function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export interface VerificationOutcome {
  verification: 'resolved' | 'unresolved'
  detail:       Record<string, unknown>
}

/**
 * Did a remedy for this cause fail its verification in the last week?
 *
 * Read from the proposals themselves — their `cause` — so the rule survives
 * restarts and needs no bookkeeping of its own.
 */
export async function remedyDidNotHold(tenantId: string, cause: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - OPERATIONS_LIMITS.holdDays * 86_400_000).toISOString()
  const session = getSession(undefined, 'READ')
  try {
    const row = await runQueryOne<{ n: number }>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId, area: 'operations', verification: 'unresolved'})
      WHERE p.cause = $cause AND p.verified_at >= $since
      RETURN count(p) AS n
    `, { tenantId, cause, since })
    return Number(row?.n ?? 0) > 0
  } finally {
    await session.close()
  }
}

/**
 * The proposal of one cause: the remedy, or — if a remedy for this cause did
 * not hold this week — the same finding to be READ, with its own kind
 * (`<kind>NotHeld`) and no action. One per cause per day (the day is in the scope).
 */
export async function operationsProposal(input: {
  tenantId: string
  cause:    string
  kind:     string
  params:   Record<string, string>
  n:        number
  refs?:    ProposalEvidenceRef[]
  action:   { type: string; params: Record<string, unknown> }
  now:      Date
}): Promise<ProposalToWrite> {
  const held = await remedyDidNotHold(input.tenantId, input.cause, input.now)
  return {
    tenantId: input.tenantId,
    area:     'operations',
    kind:     held ? `${input.kind}NotHeld` : input.kind,
    params:   { ...input.params, cause: input.cause },
    scope:    `${input.cause}:${dayOf(input.now)}`,
    evidence: { n: input.n, windowDays: 1, refs: input.refs ?? [] },
    cause:    input.cause,
    action:   held ? null : input.action,
  }
}

/** A list of ids from the parameters of an action: strings only, no repeats, `batchMax` at most. */
export function idsParam(params: Record<string, unknown>, name: string): string[] {
  const raw = params[name]
  if (!Array.isArray(raw)) return []
  const ids = raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
  return [...new Set(ids)].slice(0, OPERATIONS_LIMITS.batchMax)
}
