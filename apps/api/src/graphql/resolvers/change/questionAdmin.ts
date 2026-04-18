import { v4 as uuidv4 } from 'uuid'
import { withSession, runQuery, runQueryOne, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
import { mapAssessmentQuestion, mapAnswerOption } from './mappers.js'

type OptionInput = { label: string; score: number; sortOrder: number }

async function loadQuestionWithOptions(session: ReturnType<typeof import('../ci-utils.js').getSession>, id: string, tenantId: string) {
  const q = await runQueryOne<{ props: Props }>(session, `
    MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
    RETURN properties(q) AS props
  `, { id, tenantId })
  if (!q) return null
  const opts = await runQuery<{ props: Props }>(session, `
    MATCH (q:AssessmentQuestion {id: $id})-[:HAS_OPTION]->(o:AnswerOption)
    RETURN properties(o) AS props ORDER BY o.sort_order
  `, { id })
  return {
    ...mapAssessmentQuestion(q.props),
    options: opts.map(o => mapAnswerOption(o.props)),
  }
}

export async function createAssessmentQuestion(
  _: unknown,
  args: { input: { text: string; category: string; isCore: boolean; options: OptionInput[] } },
  ctx: GraphQLContext,
) {
  const { text, category, isCore, options } = args.input
  if (category !== 'functional' && category !== 'technical') {
    throw new Error('category deve essere "functional" o "technical"')
  }
  if (!options || options.length === 0) {
    throw new Error('Una domanda deve avere almeno una opzione')
  }
  const id = uuidv4()
  const now = new Date().toISOString()
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      CREATE (q:AssessmentQuestion {
        id: $id, tenant_id: $tenantId, text: $text, category: $category,
        is_core: $isCore, is_active: true, created_at: $now
      })
      WITH q
      UNWIND $options AS opt
      CREATE (o:AnswerOption {
        id: randomUUID(), label: opt.label, score: opt.score, sort_order: opt.sortOrder
      })
      CREATE (q)-[:HAS_OPTION]->(o)
    `, { id, tenantId: ctx.tenantId, text, category, isCore, now, options }))

    if (isCore) {
      await session.executeWrite((tx) => tx.run(`
        MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
        MATCH (ct:CITypeDefinition {active: true, scope: 'base'})
        MERGE (ct)-[rel:HAS_QUESTION]->(q)
          ON CREATE SET rel.weight = 1, rel.sort_order = 0
      `, { id, tenantId: ctx.tenantId }))
    }

    logger.info({ questionId: id, isCore }, '[questionAdmin] question created')
    return loadQuestionWithOptions(session, id, ctx.tenantId)
  }, true)
}

export async function updateAssessmentQuestion(
  _: unknown,
  args: { id: string; input: { text?: string; category?: string; isCore?: boolean; isActive?: boolean; options?: OptionInput[] } },
  ctx: GraphQLContext,
) {
  const { id } = args
  const { text, category, isCore, isActive, options } = args.input
  if (category && category !== 'functional' && category !== 'technical') {
    throw new Error('category deve essere "functional" o "technical"')
  }
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
      SET q.text     = coalesce($text, q.text),
          q.category = coalesce($category, q.category),
          q.is_core  = coalesce($isCore, q.is_core),
          q.is_active = coalesce($isActive, q.is_active)
    `, { id, tenantId: ctx.tenantId, text: text ?? null, category: category ?? null,
         isCore: isCore ?? null, isActive: isActive ?? null }))

    if (options !== undefined) {
      await session.executeWrite((tx) => tx.run(`
        MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})-[:HAS_OPTION]->(o:AnswerOption)
        DETACH DELETE o
      `, { id, tenantId: ctx.tenantId }))
      await session.executeWrite((tx) => tx.run(`
        MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
        UNWIND $options AS opt
        CREATE (o:AnswerOption {
          id: randomUUID(), label: opt.label, score: opt.score, sort_order: opt.sortOrder
        })
        CREATE (q)-[:HAS_OPTION]->(o)
      `, { id, tenantId: ctx.tenantId, options }))
    }

    return loadQuestionWithOptions(session, id, ctx.tenantId)
  }, true)
}

export async function deleteAssessmentQuestion(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const used = await runQueryOne<{ count: unknown }>(session, `
      MATCH (:AssessmentResponse)-[:ANSWERS]->(q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
      RETURN count(*) AS count
    `, { id: args.id, tenantId: ctx.tenantId })
    const usedCount = used ? Number(used.count) : 0
    if (usedCount > 0) {
      logger.error({ questionId: args.id, usedCount }, '[questionAdmin] impossibile eliminare: in uso')
      throw new Error('Impossibile eliminare: la domanda ha risposte associate')
    }
    await session.executeWrite((tx) => tx.run(`
      MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (q)-[:HAS_OPTION]->(o:AnswerOption)
      DETACH DELETE o, q
    `, { id: args.id, tenantId: ctx.tenantId }))
    return true
  }, true)
}

export async function assignQuestionToCIType(
  _: unknown,
  args: { questionId: string; ciTypeId: string; weight: number; sortOrder: number },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (ct:CITypeDefinition {id: $ciTypeId})
      MATCH (q:AssessmentQuestion {id: $questionId, tenant_id: $tenantId})
      MERGE (ct)-[rel:HAS_QUESTION]->(q)
      SET rel.weight = $weight, rel.sort_order = $sortOrder
    `, { ciTypeId: args.ciTypeId, questionId: args.questionId, weight: args.weight,
         sortOrder: args.sortOrder, tenantId: ctx.tenantId }))
    return true
  }, true)
}

export async function removeQuestionFromCIType(
  _: unknown,
  args: { questionId: string; ciTypeId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (ct:CITypeDefinition {id: $ciTypeId})-[rel:HAS_QUESTION]->(q:AssessmentQuestion {id: $questionId, tenant_id: $tenantId})
      DELETE rel
    `, { ciTypeId: args.ciTypeId, questionId: args.questionId, tenantId: ctx.tenantId }))
    return true
  }, true)
}

export async function setQuestionCore(_: unknown, args: { questionId: string; isCore: boolean }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
      SET q.is_core = $isCore
    `, { id: args.questionId, tenantId: ctx.tenantId, isCore: args.isCore }))

    if (args.isCore) {
      // Attach to all active CITypes that don't yet have the relationship
      await session.executeWrite((tx) => tx.run(`
        MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
        MATCH (ct:CITypeDefinition {active: true, scope: 'base'})
        WHERE NOT (ct)-[:HAS_QUESTION]->(q)
        MERGE (ct)-[rel:HAS_QUESTION]->(q)
          ON CREATE SET rel.weight = 1, rel.sort_order = 0
      `, { id: args.questionId, tenantId: ctx.tenantId }))
    } else {
      // Detach from all CITypeDefinitions
      await session.executeWrite((tx) => tx.run(`
        MATCH (:CITypeDefinition)-[rel:HAS_QUESTION]->(q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
        DELETE rel
      `, { id: args.questionId, tenantId: ctx.tenantId }))
    }

    return loadQuestionWithOptions(session, args.questionId, ctx.tenantId)
  }, true)
}
