import type express from 'express'
import { GraphQLError } from 'graphql'
import { resolveAuth, type GraphQLContext } from './auth/resolveAuth.js'

// The context shape lives with the resolver in auth/resolveAuth.ts; re-exported
// here so the many `import type { GraphQLContext } from '../context.js'` keep working.
export type { GraphQLContext, Role } from './auth/resolveAuth.js'

export async function buildContext(req: express.Request): Promise<GraphQLContext> {
  const auth = req.headers.authorization

  if (!auth?.startsWith('Bearer ')) {
    throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHORIZED' } })
  }

  return resolveAuth(auth.slice(7), req)
}
