/**
 * WHO STARTS THE WORK HOLDS THE TASK (G30, 24 Sep 2026 tour).
 *
 * Answering the first assessment question or saving the first deploy plan
 * moves a change task to in-progress. Until now nobody became its assignee:
 * «My tasks» then showed a task in progress for weeks with nobody on it, and
 * «Take it» offered to the team a task somebody was already working on.
 *
 * The rule: if nobody holds the task and the actor belongs to the task's team,
 * the actor becomes its assignee. A task already held keeps its holder — a
 * colleague answering one question does not take it away. An actor outside the
 * task's team (an administrator helping out) does not take it either: the task
 * stays with the team, as an explicit assignment would require.
 *
 * Appended to the write that sets the status, in the same statement, so the
 * status and the holder never disagree. Needs `$userId` and `$tenantId`.
 */
export function takeTaskOnStartCypher(alias: string): string {
  return `
      WITH ${alias}
      OPTIONAL MATCH (${alias})-[held:ASSIGNED_TO]->(:User)
      WITH ${alias}, count(held) AS holders
      OPTIONAL MATCH (${alias})-[:ASSIGNED_TO_TEAM]->(:Team)<-[:MEMBER_OF]-(starter:User {id: $userId, tenant_id: $tenantId})
      WITH ${alias}, holders, head(collect(starter)) AS starter
      FOREACH (_ IN CASE WHEN holders = 0 AND starter IS NOT NULL THEN [1] ELSE [] END |
        CREATE (${alias})-[:ASSIGNED_TO]->(starter)
      )`
}
