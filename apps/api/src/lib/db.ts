/**
 * THE DATABASE ACCESS OF THE API, FOR EVERY LAYER (review of 23 Sep 2026,
 * architecture#6 — wave 7 · C1).
 *
 * `withSession` and the query helpers lived in `graphql/resolvers/ci-utils.ts`,
 * so twenty-three modules of lib, services, jobs, REST and workflow imported
 * a resolver file to reach the database: the layers pointed the wrong way,
 * and their tests simulated a resolver file by its path. They live here now;
 * `ci-utils` re-exports them for the resolvers.
 */
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'

export type Props = Record<string, unknown>

/** Runs `fn` on a session of its own (read, or write when asked), closed whatever happens. */
export async function withSession<T>(fn: (s: ReturnType<typeof getSession>) => Promise<T>, write = false): Promise<T> {
  const session = getSession(undefined, write ? 'WRITE' : 'READ')
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

export { runQuery, runQueryOne, getSession }
