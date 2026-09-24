/**
 * Wave 7 · B2 (review of 23 Sep 2026, architecture#4): the outbox of the
 * domain events (apps/api/src/lib/outbox.ts).
 *
 *  - OutboxEvent.id unique: an event is written once — the one recorded in
 *    its change's transaction is not written again when it is published;
 *  - (tenant_id, pending): the repeater's pass reads the pending events of
 *    one tenant every 30 s;
 *  - sent_at: the nightly purge of what was sent a week ago.
 *
 * Declared in packages/neo4j/src/init.ts (the single source of the schema);
 * created here with the same form, for a database that already exists. No
 * data to change: the outbox starts empty. Idempotent (`IF NOT EXISTS`).
 */
import type { Migration } from '@opengraphity/neo4j'

export const outboxEvents: Migration = {
  id:          '20261010_1010_outbox_events',
  description: 'Wave 7 · B2: the outbox of the domain events (unique id, pending and sent indexes)',

  async up(session) {
    await session.run('CREATE CONSTRAINT outbox_event_id_unique IF NOT EXISTS FOR (o:OutboxEvent) REQUIRE o.id IS UNIQUE')
    await session.run('CREATE INDEX outbox_event_tenant_pending IF NOT EXISTS FOR (o:OutboxEvent) ON (o.tenant_id, o.pending)')
    await session.run('CREATE INDEX outbox_event_sent_at IF NOT EXISTS FOR (o:OutboxEvent) ON (o.sent_at)')
    await session.run('CALL db.awaitIndexes(300)')
    console.log('  outbox: 1 constraint and 2 indexes checked')
  },
  // Schema commands do not run in the marker's transaction: Neo4j refuses them.
  autocommit: true,
}
