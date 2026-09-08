/**
 * Admin-only "reopen" mutations: revert a completed task back to an open state.
 * La logica vive in taskKinds.ts (reopenTask): qui solo il binding GraphQL.
 */
import type { GraphQLContext } from '../../../context.js'
import { reopenTask } from './taskKinds.js'

export const reopenAssessmentTask = (_: unknown, a: { taskId: string; reason: string }, ctx: GraphQLContext) => reopenTask('assessment',  a.taskId, a.reason, ctx)
export const reopenDeployPlanTask = (_: unknown, a: { taskId: string; reason: string }, ctx: GraphQLContext) => reopenTask('deploy-plan', a.taskId, a.reason, ctx)
export const reopenValidationTest = (_: unknown, a: { id: string; reason: string },     ctx: GraphQLContext) => reopenTask('validation',  a.id,     a.reason, ctx)
export const reopenDeploymentTask = (_: unknown, a: { id: string; reason: string },     ctx: GraphQLContext) => reopenTask('deployment',  a.id,     a.reason, ctx)
export const reopenReviewTask     = (_: unknown, a: { id: string; reason: string },     ctx: GraphQLContext) => reopenTask('review',      a.id,     a.reason, ctx)
