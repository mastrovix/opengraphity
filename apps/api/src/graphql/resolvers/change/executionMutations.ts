/**
 * Mutations run during the deployment / review phases:
 *   completeValidationTest, completeDeployment, completeReview.
 * La logica vive in taskKinds.ts (completeTask): qui solo il binding GraphQL.
 */
import type { GraphQLContext } from '../../../context.js'
import { completeTask } from './taskKinds.js'

export const completeValidationTest = (_: unknown, a: { changeId: string; ciId: string; result: string }, ctx: GraphQLContext) => completeTask('validation', a.changeId, a.ciId, a.result, ctx)
export const completeDeployment     = (_: unknown, a: { changeId: string; ciId: string },                 ctx: GraphQLContext) => completeTask('deployment', a.changeId, a.ciId, undefined, ctx)
export const completeReview         = (_: unknown, a: { changeId: string; ciId: string; result: string }, ctx: GraphQLContext) => completeTask('review',     a.changeId, a.ciId, a.result, ctx)
