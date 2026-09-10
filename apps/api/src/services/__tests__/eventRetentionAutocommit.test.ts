/**
 * `purgeTenantResolvedEvents` usa `CALL { … } IN TRANSACTIONS`, che Neo4j
 * accetta SOLO in una transazione auto-commit (`session.run`): dentro
 * `executeWrite`/`executeRead` fallisce con "A query with 'CALL { ... } IN
 * TRANSACTIONS' can only be executed in an implicit transaction". Il vincolo è
 * implicito nel contratto di `runQuery`/`runQueryOne` di @opengraphity/neo4j
 * (revisione 2.3): questo test lo pinna sul modulo REALE, con una sessione
 * finta, così un refactor che li incapsuli in una transazione gestita rompe
 * qui invece che di notte nel job `purge_events`.
 */
import { describe, it, expect, vi } from 'vitest'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'

function fakeSession() {
  const run = vi.fn().mockResolvedValue({ records: [{ keys: ['n'], get: () => 12 }] })
  const executeWrite = vi.fn()
  const executeRead = vi.fn()
  return { run, executeWrite, executeRead }
}

describe('runQuery / runQueryOne (@opengraphity/neo4j) — auto-commit', () => {
  it('runQuery passa il Cypher a session.run (auto-commit), mai a executeWrite/executeRead', async () => {
    const s = fakeSession()
    await expect(runQuery(s as never, 'CALL { WITH e DETACH DELETE e } IN TRANSACTIONS OF 1000 ROWS RETURN count(*) AS n', { x: 1 })).resolves.toEqual([{ n: 12 }])
    expect(s.run).toHaveBeenCalledWith('CALL { WITH e DETACH DELETE e } IN TRANSACTIONS OF 1000 ROWS RETURN count(*) AS n', { x: 1 })
    expect(s.executeWrite).not.toHaveBeenCalled()
    expect(s.executeRead).not.toHaveBeenCalled()
  })

  it('runQueryOne: prima riga o null, stessa via (session.run)', async () => {
    const s = fakeSession()
    await expect(runQueryOne(s as never, 'RETURN 1 AS n')).resolves.toEqual({ n: 12 })
    s.run.mockResolvedValueOnce({ records: [] })
    await expect(runQueryOne(s as never, 'RETURN 1 AS n')).resolves.toBeNull()
    expect(s.executeWrite).not.toHaveBeenCalled()
  })
})
