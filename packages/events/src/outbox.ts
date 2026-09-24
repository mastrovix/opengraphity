/**
 * THE OUTBOX OF THE DOMAIN EVENTS (review of 23 Sep 2026, architecture#4 —
 * wave 7 · B2).
 *
 * An event left the process after the change it describes was committed,
 * straight to the consumers' queues. If Redis did not answer at that moment,
 * or the process stopped between the commit and the send, the event was gone:
 * no SLA for the new ticket, no notification, no webhook, and nobody who
 * could find it again.
 *
 * Now every event is written down before it is sent — a node in the graph,
 * the same store as the change — and marked when it has been sent. A
 * repeater in the process that owns the store sends again what stayed
 * unmarked; the consumers skip an event they already processed (by its id,
 * consumer.ts). For the events that cost the most when lost — a ticket born,
 * a ticket entering a step — the record is written inside the very
 * transaction of the change (`recordIn`): the event exists if and only if the
 * change does.
 *
 * The store is the app's (it knows the database); it is registered once per
 * process, like the workflow's conditions. A process without one (a script,
 * a test) sends the event straight away, as before, and says nothing about
 * it: that is the declared behaviour, not a fallback.
 */
import type { DomainEvent } from '@opengraphity/types'

export interface PublishOptions {
  /**
   * The event also goes to the tenant's outbound webhooks. The app delivers
   * them (`EventOutbox.deliverExtras`); the flag travels with the record, so
   * the repeater delivers them too.
   */
  webhooks?: boolean
}

export interface EventOutbox {
  /** Writes the event down before it is sent. An event already recorded (in its change's transaction) is left as it is. */
  record(event: DomainEvent<unknown>, options: PublishOptions): Promise<void>
  /** The same, inside the caller's write transaction (a Neo4j ManagedTransaction). */
  recordIn(tx: unknown, event: DomainEvent<unknown>, options: PublishOptions): Promise<void>
  /** What the process delivers besides the consumers' queues, before the event counts as sent. */
  deliverExtras(event: DomainEvent<unknown>, options: PublishOptions): Promise<void>
  /** The event was sent: the repeater leaves it alone. */
  markSent(event: DomainEvent<unknown>): Promise<void>
}

let outbox: EventOutbox | null = null

/** Declares the outbox of this process. To call at the start, before anything publishes. */
export function registerEventOutbox(o: EventOutbox): void {
  outbox = o
}

/** The outbox of this process, or `null` when it has none (a script, a test). */
export function currentEventOutbox(): EventOutbox | null {
  return outbox
}

/** For the tests only: forgets the registered outbox. */
export function clearEventOutbox(): void {
  outbox = null
}

/**
 * Records the event inside the caller's transaction, when the process has an
 * outbox; the event is then published after the commit with `publish`, which
 * finds it already written. Without an outbox there is nothing to write.
 */
export async function recordEventIn(tx: unknown, event: DomainEvent<unknown>, options: PublishOptions = {}): Promise<void> {
  if (outbox) await outbox.recordIn(tx, event, options)
}
