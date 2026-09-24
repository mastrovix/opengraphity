/**
 * THE KNOWLEDGE BASE ON A REAL NEO4J (24 Sep 2026): what the mocks cannot say.
 *
 *  - One vote per person (tour G8): the arithmetic of `rateKBArticle` is a
 *    Cypher CASE on the vote already given — the same vote again adds
 *    nothing, the other vote moves one. A mock only sees the text.
 *  - Who an article is for (owner's decision «Pubblico per articolo»): the
 *    portal reads only the published articles for everyone; a known error is
 *    for the staff and stays out of its lists, its counts and its reads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDriver, getSession, runQuery } from '@opengraphity/neo4j'
import { closeConnection as closeEventConnection } from '@opengraphity/events'
import { rolePermissions } from '../lib/roles.js'
import { stopMetamodelBus } from '../lib/metamodelBus.js'
import { stopInAppBus } from '../lib/inAppBus.js'
import { closeAllQueues } from '../lib/bullmq.js'
import { kbArticles, kbArticleBySlug, kbCategories, rateKBArticle, updateKBArticle } from '../graphql/resolvers/knowledgeBase.js'
import type { GraphQLContext } from '../context.js'
import { assertThrowawayDatabase, TENANT_A } from './tenants.js'

let staff: GraphQLContext
let portal: GraphQLContext
let everyone: { id: string; slug: string }
let staffOnly: { id: string; slug: string }

async function one<T extends Record<string, unknown>>(cypher: string, params: Record<string, unknown>): Promise<T> {
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<T>(session, cypher, params)
    if (!rows[0]) throw new Error(`${TENANT_A.id}: nothing for ${cypher.trim().split('\n')[0]}`)
    return rows[0]
  } finally {
    await session.close()
  }
}

const PUBLISHED = `EXISTS { MATCH (a)-[:HAS_WORKFLOW]->(:WorkflowInstance)-[:CURRENT_STEP]->(:WorkflowStep {category: 'published'}) }`

beforeAll(async () => {
  await assertThrowawayDatabase()
  const admin = await one<{ id: string; email: string }>(
    `MATCH (u:User {tenant_id: $tenantId, role: 'admin'}) RETURN u.id AS id, u.email AS email ORDER BY u.created_at LIMIT 1`,
    { tenantId: TENANT_A.id })
  const endUser = await one<{ id: string; email: string }>(
    `MATCH (u:User {tenant_id: $tenantId, role: 'end_user'}) RETURN u.id AS id, u.email AS email ORDER BY u.created_at LIMIT 1`,
    { tenantId: TENANT_A.id })
  staff = { tenantId: TENANT_A.id, userId: admin.id, userEmail: admin.email, role: 'admin', permissions: await rolePermissions(TENANT_A.id, 'admin') }
  portal = { tenantId: TENANT_A.id, userId: endUser.id, userEmail: endUser.email, role: 'end_user', permissions: await rolePermissions(TENANT_A.id, 'end_user') }
  // Two published articles, one made for everyone and one for the staff through the ordinary update:
  // a small tenant may have no published known error of its own.
  const session = getSession(undefined, 'READ')
  const two = await runQuery<{ id: string; slug: string }>(session,
    `MATCH (a:KBArticle {tenant_id: $tenantId}) WHERE ${PUBLISHED} RETURN a.id AS id, a.slug AS slug ORDER BY a.id LIMIT 2`,
    { tenantId: TENANT_A.id }).finally(() => session.close())
  if (two.length < 2) throw new Error(`${TENANT_A.id} has fewer than two published articles: run the preparation first`)
  ;[everyone, staffOnly] = [two[0]!, two[1]!]
  await updateKBArticle(null, { id: everyone.id, audience: 'everyone' }, staff)
  await updateKBArticle(null, { id: staffOnly.id, audience: 'staff' }, staff)
})

afterAll(async () => {
  await closeEventConnection()
  await stopInAppBus()
  await stopMetamodelBus()
  await closeAllQueues()
  await closeDriver()
})

describe('one vote per person', () => {
  it('a first vote adds one, the same vote again nothing, the other vote moves one', async () => {
    const before = await rateKBArticle(null, { id: everyone.id, helpful: true }, staff)
    const again = await rateKBArticle(null, { id: everyone.id, helpful: true }, staff)
    expect([again.helpfulCount, again.notHelpfulCount]).toEqual([before.helpfulCount, before.notHelpfulCount])
    const moved = await rateKBArticle(null, { id: everyone.id, helpful: false }, staff)
    expect([moved.helpfulCount, moved.notHelpfulCount]).toEqual([before.helpfulCount - 1, before.notHelpfulCount + 1])
    const back = await rateKBArticle(null, { id: everyone.id, helpful: true }, staff)
    expect([back.helpfulCount, back.notHelpfulCount]).toEqual([before.helpfulCount, before.notHelpfulCount])
    const votes = await one<{ n: number }>(
      `MATCH (:User {id: $userId, tenant_id: $tenantId})-[r:RATED_KB]->(:KBArticle {id: $id}) RETURN count(r) AS n`,
      { userId: staff.userId, tenantId: TENANT_A.id, id: everyone.id })
    expect(Number(votes.n)).toBe(1)
  })
})

describe('the portal reads only the articles for everyone', () => {
  it('lists, reads by slug, counts and votes: the staff article is not there for the portal', async () => {
    const all = await kbArticles(null, { pageSize: 100 }, portal)
    expect(all.items.length).toBeGreaterThan(0)
    expect(all.items.every((a) => a.audience === 'everyone')).toBe(true)
    await expect(kbArticleBySlug(null, { slug: staffOnly.slug }, portal)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    await expect(rateKBArticle(null, { id: staffOnly.id, helpful: true }, portal)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect((await kbArticleBySlug(null, { slug: everyone.slug }, portal)).id).toBe(everyone.id)
    // The staff reads both, and counts both.
    expect((await kbArticleBySlug(null, { slug: staffOnly.slug }, staff)).audience).toBe('staff')
    const [forPortal, forStaff] = await Promise.all([kbCategories(null, {}, portal), kbCategories(null, {}, staff)])
    const total = (cs: Array<{ count: number }>) => cs.reduce((n, c) => n + c.count, 0)
    expect(total(forPortal)).toBeLessThan(total(forStaff))
  })
})
