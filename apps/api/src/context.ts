import jwt from 'jsonwebtoken'
import type express from 'express'

const JWT_SECRET =
  process.env['JWT_SECRET'] ?? 'opengraphity_dev_secret_change_in_production'

export interface GraphQLContext {
  tenantId:  string
  userId:    string
  userEmail: string
  role:      'admin' | 'operator' | 'viewer'
}

interface JWTPayload {
  tenant_id: string
  user_id:   string
  email:     string
  role:      'admin' | 'operator' | 'viewer'
}

export function buildContext(req: express.Request): GraphQLContext {
  const auth = req.headers.authorization

  if (!auth?.startsWith('Bearer ')) {
    throw new Error('Unauthorized')
  }

  const token = auth.slice(7)

  try {
    const payload = jwt.verify(token, JWT_SECRET) as JWTPayload
    return {
      tenantId:  payload.tenant_id,
      userId:    payload.user_id,
      userEmail: payload.email,
      role:      payload.role,
    }
  } catch {
    throw new Error('Invalid token')
  }
}
