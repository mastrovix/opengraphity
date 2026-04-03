import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../context.js'
import { logger } from './logger.js'

export async function audit(
  ctx: GraphQLContext,
  action: string,
  entityType: string,
  entityId: string,
  details?: Record<string, unknown>,
  ipAddress?: string,
): Promise<void> {
  logger.debug({ action, entityType, entityId, tenantId: ctx.tenantId, userId: ctx.userId }, '[audit] writing entry')
  const session = getSession(undefined, 'WRITE')
  try {
    const now = new Date().toISOString()
    await session.executeWrite((tx) =>
      tx.run(`
        CREATE (a:AuditEntry {
          id:          $id,
          tenant_id:   $tenantId,
          user_id:     $userId,
          user_email:  $userEmail,
          action:      $action,
          entity_type: $entityType,
          entity_id:   $entityId,
          details:     $details,
          ip_address:  $ipAddress,
          created_at:  $createdAt
        })
      `, {
        id:          uuidv4(),
        tenantId:    ctx.tenantId,
        userId:      ctx.userId,
        userEmail:   ctx.userEmail,
        action,
        entityType,
        entityId,
        details:     details ? JSON.stringify(details) : null,
        ipAddress:   ipAddress ?? null,
        createdAt:   now,
      }),
    )
    logger.debug({ action, entityType, entityId }, '[audit] entry written OK')
  } catch (err) {
    // Audit failure MUST NOT propagate to the caller
    logger.warn({ err, action, entityType, entityId, tenantId: ctx.tenantId }, '[audit] write failed')
  } finally {
    await session.close()
  }
}
