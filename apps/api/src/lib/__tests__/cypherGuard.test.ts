import { describe, it, expect } from 'vitest'
import { redactSensitiveValue, assertSafeReadOnlyCypher, stripCypherLiterals, UnsafeCypherError, MAX_CYPHER_LENGTH } from '../cypherGuard.js'

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
    ['alias reuse across MATCH', 'MATCH (i:Incident {tenant_id: $tenantId}) WITH i MATCH (i)-[:AFFECTS]->(c:ConfigurationItem) RETURN c.name'],
    ['transitively bound alias', 'MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTS]->(c:ConfigurationItem) MATCH (c)-[:DEPENDS_ON]->(d:ConfigurationItem) RETURN d.name'],
    ['OPTIONAL MATCH chained', 'MATCH (i:Incident {tenant_id: $tenantId}) OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(u:User) RETURN i.title, u.name'],
    ['MTTR example from the system prompt', `MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: 'incident'})-[:HAS_STEP]->(s:WorkflowStep)
      WHERE coalesce(s.is_initial, s.type = 'start') OR s.category = 'resolved' OR coalesce(s.is_terminal, s.type = 'end')
      RETURN s.name`],
    ['functions and aggregates', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN date(i.created_at) AS d, count(i) AS n, collect(i.title)[0..3] AS sample ORDER BY d'],
    ['CASE / IS NOT NULL with WHERE-form', 'MATCH (i:Incident) WHERE i.tenant_id = $tenantId AND i.resolved_at IS NOT NULL RETURN CASE WHEN i.severity = "high" THEN 1 ELSE 0 END AS s'],
    ['EXISTS subquery anchored', 'MATCH (i:Incident {tenant_id: $tenantId}) WHERE EXISTS { MATCH (i)-[:AFFECTS]->(:Server) } RETURN i.title'],
    ['CALL subquery', 'MATCH (i:Incident {tenant_id: $tenantId}) CALL { WITH i MATCH (i)-[:AFFECTS]->(c:ConfigurationItem) RETURN count(c) AS nc } RETURN i.title, nc'],
    ['apoc.text function', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN apoc.text.capitalize(i.title) AS t'],
    ['UNION both anchored', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.title AS t UNION MATCH (c:Change {tenant_id: $tenantId}) RETURN c.title AS t'],
    ['string containing keywords', "MATCH (i:Incident {tenant_id: $tenantId}) WHERE i.title CONTAINS 'SET DELETE CREATE' RETURN i.title"],
    ['line comment stripped', 'MATCH (i:Incident {tenant_id: $tenantId}) // comment with DELETE\nRETURN i.title'],
    ['property named like keyword', 'MATCH (c:Change {tenant_id: $tenantId}) RETURN c.scheduled_start, c.start'],
    ['label-only anchor without alias', 'MATCH (:Incident {tenant_id: $tenantId})-[:AFFECTS]->(c:ConfigurationItem) RETURN c.name'],
    ['name projected by WITH keeps its anchor', 'MATCH (i:Incident {tenant_id: $tenantId}) WITH i, count(*) AS n MATCH (i)-[:AFFECTS]->(c:ConfigurationItem) RETURN c.name, n'],
    ['name renamed by WITH keeps its anchor', 'MATCH (i:Incident {tenant_id: $tenantId}) WITH i AS inc MATCH (inc)-[:AFFECTS]->(c:ConfigurationItem) RETURN c.name'],
    ['WITH * keeps every anchor', 'MATCH (i:Incident {tenant_id: $tenantId}) WITH * MATCH (i)-[:AFFECTS]->(c:ConfigurationItem) RETURN c.name'],
    ['STARTS WITH is not a WITH clause', "MATCH (i:Incident {tenant_id: $tenantId}) WHERE i.title STARTS WITH 'DB' RETURN i.title"],
    ['list slice and index by position', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN collect(i.title)[..3] AS a, labels(i)[0] AS l'],
    ['shortestPath anchored', 'MATCH (a:Server {tenant_id: $tenantId}), (b:Server {tenant_id: $tenantId}) MATCH p = shortestPath((a)-[*..5]-(b)) RETURN length(p)'],
  ]
  it.each(ok)('accepts: %s', (_name, q) => {
    expect(() => assertSafeReadOnlyCypher(q)).not.toThrow()
  })
})

describe('assertSafeReadOnlyCypher — rejected queries', () => {
  const bad: Array<[string, string, string]> = [
    ['no tenant at all (C-02 PoC)', 'MATCH (u:User) RETURN u.email, u.tenant_id', 'not bound to the tenant'],
    ['unlabeled unanchored', 'MATCH (n) RETURN n LIMIT 10', 'not bound to the tenant'],
    // Revisione totale · D-1: quello che un report non legge mai.
    ['D-1 sensitive label', 'MATCH (w:OutboundWebhook {tenant_id: $tenantId}) RETURN w.url', 'OutboundWebhook is not readable'],
    ['D-1 unlabeled anchored node', 'MATCH (w {tenant_id: $tenantId}) RETURN w', 'every node needs a label'],
    ['D-1 unlabeled node reached by a relationship', 'MATCH (e:Event {tenant_id: $tenantId})-[:FROM_SOURCE]->(w) RETURN w.name', 'every node needs a label'],
    ['D-1 negated label', 'MATCH (w:!Incident {tenant_id: $tenantId}) RETURN w', ''],
    ['D-1 sensitive property', 'MATCH (c:ConfigurationItem {tenant_id: $tenantId}) RETURN c.secret', 'property secret'],
    ['D-1 sensitive property in a map pattern', "MATCH (c:ConfigurationItem {tenant_id: $tenantId, token: ''}) RETURN c.name", ''],
    ['D-1 dynamic property access', "MATCH (c:ConfigurationItem {tenant_id: $tenantId}) RETURN c['sec' + 'ret']", 'dynamic property access'],
    ['literal tenant id', "MATCH (u:User {tenant_id: 'other'}) RETURN u.email", 'not bound to the tenant'],
    ['second path unanchored (cartesian)', 'MATCH (i:Incident {tenant_id: $tenantId}), (u:User) RETURN u.email', 'not bound to the tenant'],
    ['second MATCH unanchored', 'MATCH (i:Incident {tenant_id: $tenantId}) WITH count(i) AS n MATCH (u:User) RETURN u.email, n', 'not bound to the tenant'],
    ['unanchored before anchor (textual order)', 'MATCH (c)-[:AFFECTS]-(x) MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTS]->(c) RETURN x', 'not bound to the tenant'],
    ['WHERE-form neutralised by OR', 'MATCH (u:User) WHERE u.tenant_id = $tenantId OR true RETURN u.email', 'OR/XOR/NOT'],
    ['WHERE-form neutralised by NOT', 'MATCH (u:User) WHERE NOT (u.tenant_id = $tenantId) RETURN u.email', 'OR/XOR/NOT'],
    // Review of 23 Sep 2026: a name keeps its anchor only in its own scope.
    ['name rebound after WITH (probe of the review)', 'MATCH (x:Incident {tenant_id: $tenantId}) WITH count(x) AS c MATCH (x:User) RETURN x.email, c', 'not bound to the tenant'],
    ['name rebound across UNION', 'MATCH (x:Incident {tenant_id: $tenantId}) RETURN x.title AS t UNION MATCH (x:User) RETURN x.email AS t', 'not bound to the tenant'],
    ['WHERE anchor on the other side of UNION', 'MATCH (x:User) RETURN x.email AS t UNION MATCH (x:Incident) WHERE x.tenant_id = $tenantId RETURN x.title AS t', 'not bound to the tenant'],
    ['WHERE-form anchor then rebound after WITH', 'MATCH (x:Incident) WHERE x.tenant_id = $tenantId WITH count(x) AS c MATCH (x:User) RETURN x.email, c', 'not bound to the tenant'],
    ['tenant predicate in RETURN is not a filter', 'MATCH (u:User) RETURN u.email, u.tenant_id = $tenantId', 'not bound to the tenant'],
    ['tenant predicate of an OPTIONAL MATCH does not filter the rows', 'MATCH (u:User) OPTIONAL MATCH (i:Incident {tenant_id: $tenantId}) WHERE u.tenant_id = $tenantId RETURN u.email', 'not bound to the tenant'],
    ['CALL body without import does not see the outer name', 'MATCH (x:Incident {tenant_id: $tenantId}) CALL { MATCH (x:User) RETURN x.email AS e } RETURN e', 'not bound to the tenant'],
    ['WITH inside a subquery expression', 'MATCH (i:Incident {tenant_id: $tenantId}) WHERE EXISTS { MATCH (i) WITH count(*) AS c MATCH (u:User) RETURN u } RETURN i', 'WITH inside a subquery'],
    ['keys computed by the query', 'MATCH (t:Team {tenant_id: $tenantId}) RETURN [k IN keys(t) | t[k]]', 'dynamic property access'],
    ['UNION second part unanchored', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.title AS t UNION MATCH (u:User) RETURN u.email AS t', 'not bound to the tenant'],
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
    ['other parameter', 'MATCH (i:Incident {tenant_id: $tenantId}) WHERE i.id = $id RETURN i', 'parameter $id'],
    ['multiple statements', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN i; MATCH (u:User) RETURN u', '";"'],
    ['backtick identifier', 'MATCH (i:`Incident` {tenant_id: $tenantId}) RETURN i', 'backtick'],
    ['backslash outside string', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.title \\u0041', 'backslash'],
    ['unterminated string', "MATCH (i:Incident {tenant_id: $tenantId}) WHERE i.title = 'x RETURN i", 'unterminated string'],
    ['inline WHERE in node pattern', 'MATCH (u:User WHERE u.tenant_id = $tenantId) RETURN u.email', 'WHERE inside'],
    ['empty', '   ', 'empty query'],
    ['too long', `MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.title ${' '.repeat(MAX_CYPHER_LENGTH)}`, 'too long'],
    ['no node pattern', 'RETURN 1 AS x', 'no node pattern'],
    ['tenant only in string literal', "MATCH (u:User) WHERE u.note = 'tenant_id: $tenantId' RETURN u.email", 'not bound to the tenant'],
    ['tenant only in comment', 'MATCH (u:User) // {tenant_id: $tenantId}\nRETURN u.email', 'not bound to the tenant'],
  ]
  it.each(bad)('rejects: %s', (_name, q, msg) => rejects(q, msg))
})

describe('redactSensitiveValue (D-1, seconda linea)', () => {
  it('un nodo con etichetta sensibile diventa [redacted]; le chiavi sensibili spariscono ovunque', () => {
    expect(redactSensitiveValue({ labels: ['OutboundWebhook'], properties: { secret: 's' } })).toBe('[redacted]')
    expect(redactSensitiveValue({ labels: ['Server'], properties: { name: 'db', token: 't' } })).toEqual({ labels: ['Server'], properties: { name: 'db' } })
    expect(redactSensitiveValue([{ headers: '{"Authorization":"x"}', title: 'ok' }])).toEqual([{ title: 'ok' }])
    expect(redactSensitiveValue('plain')).toBe('plain')
  })
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

/*
 * I REGISTRI NON SI LEGGONO CON UN REPORT (20 set 2026, ondata 3).
 *
 * Buco preesistente, trovato rileggendo il progetto «Miglioramento continuo»:
 * l'ondata 1 doveva chiuderlo e non l'ha fatto. Si chiude ADESSO, prima che
 * l'ondata 3 cominci a persistere i log del server: da quel momento in poi il
 * grafo contiene il racconto di tutto quello che succede dentro la
 * piattaforma, e `askReport` è raggiungibile da un'iniezione nel titolo di un
 * ticket.
 */
describe('i registri sono fuori portata di un report', () => {
  it.each([
    ['le voci di Audit',        'MATCH (a:AuditEntry {tenant_id: $tenantId}) RETURN a.action'],
    ['i log del browser',       'MATCH (l:LogEntry {tenant_id: $tenantId}) RETURN l.message'],
    ['i log del server',        'MATCH (l:ServerLogEntry {tenant_id: $tenantId}) RETURN l.template'],
  ])('rifiuta %s', (_nome, q) => rejects(q, 'label'))

  it.each([
    ['details', 'MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.details'],
    ['data',    'MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.data'],
  ])('rifiuta la proprietà %s anche su un nodo qualunque', (_nome, q) => rejects(q, 'property'))

  it('e la seconda linea le toglie comunque da una riga già tornata', () => {
    expect(redactSensitiveValue({ labels: ['AuditEntry'], properties: { action: 'x' } })).toBe('[redacted]')
    expect(redactSensitiveValue([{ title: 'ok', details: '{"url":"https://hook"}' }])).toEqual([{ title: 'ok' }])
  })
})
