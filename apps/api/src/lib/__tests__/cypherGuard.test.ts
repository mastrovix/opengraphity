import { describe, it, expect } from 'vitest'
import { assertSafeReadOnlyCypher, stripCypherLiterals, UnsafeCypherError, MAX_CYPHER_LENGTH } from '../cypherGuard.js'

function rejects(query: string, messagePart?: string) {
  let thrown: unknown
  try { assertSafeReadOnlyCypher(query) } catch (e) { thrown = e }
  expect(thrown, `expected rejection for: ${query}`).toBeInstanceOf(UnsafeCypherError)
  if (messagePart) expect((thrown as Error).message).toContain(messagePart)
}

describe('assertSafeReadOnlyCypher — accepted read-only, tenant-anchored queries', () => {
  const ok: Array<[string, string]> = [
    ['inline tenant on root', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.title, i.status LIMIT 20'],
    ['inline tenant with other props', "MATCH (i:Incident {tenant_id: $tenantId, status: 'open'}) RETURN count(i) AS n"],
    ['chained node without own tenant (path anchored)', 'MATCH (i:Incident {tenant_id: $tenantId})-[:ASSIGNED_TO_TEAM]->(t:Team) RETURN t.name, count(i) AS n ORDER BY n DESC'],
    ['WHERE-form scoping', 'MATCH (i:Incident) WHERE i.tenant_id = $tenantId AND i.severity = "critical" RETURN i.title'],
    ['WHERE-form reversed', 'MATCH (i:Incident) WHERE $tenantId = i.tenant_id RETURN i.title'],
    ['alias reuse across MATCH', 'MATCH (i:Incident {tenant_id: $tenantId}) WITH i MATCH (i)-[:AFFECTS]->(c) RETURN c.name'],
    ['transitively bound alias', 'MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTS]->(c) MATCH (c)-[:DEPENDS_ON]->(d) RETURN d.name'],
    ['OPTIONAL MATCH chained', 'MATCH (i:Incident {tenant_id: $tenantId}) OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(u:User) RETURN i.title, u.name'],
    ['MTTR example from the system prompt', `MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: 'incident'})-[:HAS_STEP]->(s:WorkflowStep)
      WHERE coalesce(s.is_initial, s.type = 'start') OR s.category = 'resolved' OR coalesce(s.is_terminal, s.type = 'end')
      RETURN s.name`],
    ['functions and aggregates', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN date(i.created_at) AS d, count(i) AS n, collect(i.title)[0..3] AS sample ORDER BY d'],
    ['CASE / IS NOT NULL with WHERE-form', 'MATCH (i:Incident) WHERE i.tenant_id = $tenantId AND i.resolved_at IS NOT NULL RETURN CASE WHEN i.severity = "high" THEN 1 ELSE 0 END AS s'],
    ['EXISTS subquery anchored', 'MATCH (i:Incident {tenant_id: $tenantId}) WHERE EXISTS { MATCH (i)-[:AFFECTS]->(:Server) } RETURN i.title'],
    ['CALL subquery', 'MATCH (i:Incident {tenant_id: $tenantId}) CALL { WITH i MATCH (i)-[:AFFECTS]->(c) RETURN count(c) AS nc } RETURN i.title, nc'],
    ['apoc.text function', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN apoc.text.capitalize(i.title) AS t'],
    ['UNION both anchored', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.title AS t UNION MATCH (c:Change {tenant_id: $tenantId}) RETURN c.title AS t'],
    ['string containing keywords', "MATCH (i:Incident {tenant_id: $tenantId}) WHERE i.title CONTAINS 'SET DELETE CREATE' RETURN i.title"],
    ['line comment stripped', 'MATCH (i:Incident {tenant_id: $tenantId}) // comment with DELETE\nRETURN i.title'],
    ['property named like keyword', 'MATCH (c:Change {tenant_id: $tenantId}) RETURN c.scheduled_start, c.start'],
    ['label-only anchor without alias', 'MATCH (:Incident {tenant_id: $tenantId})-[:AFFECTS]->(c) RETURN c.name'],
    ['shortestPath anchored', 'MATCH (a:Server {tenant_id: $tenantId}), (b:Server {tenant_id: $tenantId}) MATCH p = shortestPath((a)-[*..5]-(b)) RETURN length(p)'],
  ]
  it.each(ok)('accepts: %s', (_name, q) => {
    expect(() => assertSafeReadOnlyCypher(q)).not.toThrow()
  })
})

describe('assertSafeReadOnlyCypher — rejected queries', () => {
  const bad: Array<[string, string, string]> = [
    ['no tenant at all (C-02 PoC)', 'MATCH (u:User) RETURN u.email, u.tenant_id', 'non vincolato'],
    ['unlabeled unanchored', 'MATCH (n) RETURN n LIMIT 10', 'non vincolato'],
    ['literal tenant id', "MATCH (u:User {tenant_id: 'other'}) RETURN u.email", 'non vincolato'],
    ['second path unanchored (cartesian)', 'MATCH (i:Incident {tenant_id: $tenantId}), (u:User) RETURN u.email', 'non vincolato'],
    ['second MATCH unanchored', 'MATCH (i:Incident {tenant_id: $tenantId}) WITH count(i) AS n MATCH (u:User) RETURN u.email, n', 'non vincolato'],
    ['unanchored before anchor (textual order)', 'MATCH (c)-[:AFFECTS]-(x) MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTS]->(c) RETURN x', 'non vincolato'],
    ['WHERE-form neutralised by OR', 'MATCH (u:User) WHERE u.tenant_id = $tenantId OR true RETURN u.email', 'OR/XOR/NOT'],
    ['WHERE-form neutralised by NOT', 'MATCH (u:User) WHERE NOT (u.tenant_id = $tenantId) RETURN u.email', 'OR/XOR/NOT'],
    ['UNION second part unanchored', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.title AS t UNION MATCH (u:User) RETURN u.email AS t', 'non vincolato'],
    ['CREATE', 'MATCH (i:Incident {tenant_id: $tenantId}) CREATE (x:Evil) RETURN x', 'CREATE'],
    ['MERGE', 'MERGE (u:User {tenant_id: $tenantId, email: "x"}) RETURN u', 'MERGE'],
    ['SET', 'MATCH (i:Incident {tenant_id: $tenantId}) SET i.status = "closed" RETURN i', 'SET'],
    ['DELETE', 'MATCH (i:Incident {tenant_id: $tenantId}) DETACH DELETE i', 'DETACH'],
    ['REMOVE', 'MATCH (i:Incident {tenant_id: $tenantId}) REMOVE i.title RETURN i', 'REMOVE'],
    ['lowercase write keyword', 'match (i:Incident {tenant_id: $tenantId}) set i.x = 1 return i', 'SET'],
    ['FOREACH', 'MATCH (i:Incident {tenant_id: $tenantId}) FOREACH (x IN [1] | SET i.a = x) RETURN i', 'FOREACH'],
    ['LOAD CSV', 'LOAD CSV FROM "file:///etc/passwd" AS row RETURN row', 'LOAD'],
    ['CALL db.labels', 'CALL db.labels() YIELD label RETURN label', 'db.'],
    ['CALL dbms', 'CALL dbms.security.listUsers() YIELD username RETURN username', 'dbms'],
    ['CALL apoc.cypher.run', 'MATCH (i:Incident {tenant_id: $tenantId}) CALL apoc.cypher.run("MATCH (u:User) RETURN u", {}) YIELD value RETURN value', 'apoc'],
    ['apoc.cypher function', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN apoc.cypher.runFirstColumn("MATCH (u:User) RETURN u.email", {}) AS e', 'apoc'],
    ['CALL arbitrary procedure', 'MATCH (i:Incident {tenant_id: $tenantId}) CALL custom.proc() YIELD x RETURN x', 'CALL'],
    ['SHOW', 'SHOW USERS', 'SHOW'],
    ['DROP', 'DROP INDEX foo', 'DROP'],
    [':auth', 'MATCH (a:auth) RETURN a', ':auth'],
    ['other parameter', 'MATCH (i:Incident {tenant_id: $tenantId}) WHERE i.id = $id RETURN i', 'parametro $id'],
    ['multiple statements', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN i; MATCH (u:User) RETURN u', '";"'],
    ['backtick identifier', 'MATCH (i:`Incident` {tenant_id: $tenantId}) RETURN i', 'backtick'],
    ['backslash outside string', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.title \\u0041', 'backslash'],
    ['unterminated string', "MATCH (i:Incident {tenant_id: $tenantId}) WHERE i.title = 'x RETURN i", 'non terminato'],
    ['inline WHERE in node pattern', 'MATCH (u:User WHERE u.tenant_id = $tenantId) RETURN u.email', 'WHERE dentro'],
    ['empty', '   ', 'vuota'],
    ['too long', `MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.title ${' '.repeat(MAX_CYPHER_LENGTH)}`, 'troppo lunga'],
    ['no node pattern', 'RETURN 1 AS x', 'nessun pattern'],
    ['tenant only in string literal', "MATCH (u:User) WHERE u.note = 'tenant_id: $tenantId' RETURN u.email", 'non vincolato'],
    ['tenant only in comment', 'MATCH (u:User) // {tenant_id: $tenantId}\nRETURN u.email', 'non vincolato'],
  ]
  it.each(bad)('rejects: %s', (_name, q, msg) => rejects(q, msg))
})

describe('stripCypherLiterals', () => {
  it('blanks string contents and handles escaped quotes', () => {
    expect(stripCypherLiterals(`WHERE a = 'it\\'s' AND b = "x\\"y"`)).toBe(`WHERE a = '' AND b = ""`)
  })
  it('removes comments but keeps newlines', () => {
    expect(stripCypherLiterals('RETURN 1 // c\nRETURN 2 /* x */')).toBe('RETURN 1 \nRETURN 2  ')
  })
  it('does not hide a keyword after an escaped backslash', () => {
    // 'a\\' closes the string; " DELETE n //" is outside it.
    expect(stripCypherLiterals("'a\\\\' DELETE n //")).toBe("'' DELETE n ")
  })
})
