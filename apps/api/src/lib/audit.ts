import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../context.js'
import { logger } from './logger.js'
import { noteAuditWritten, noteAuditFailed } from './auditScope.js'

export async function audit(
  ctx: GraphQLContext,
  action: string,
  entityType: string,
  entityId: string,
  details?: Record<string, unknown>,
  ipAddress?: string,
): Promise<void> {
  // Sincrono, prima di ogni await: il registro delle mutation lo legge alla
  // fine del resolver per sapere che questa mutation ha già la sua voce.
  noteAuditWritten()
  logger.debug({ action, entityType, entityId, tenantId: ctx.tenantId, userId: ctx.userId }, '[audit] writing entry')
  /*
   * `getSession()` DENTRO il try (21 set 2026).
   *
   * Stava fuori, e questa funzione e' chiamata quasi sempre come
   * `void audit(...)`: un errore qui non veniva preso dal `catch` qui sotto,
   * usciva come rejection senza padrone, e su Node 24 una rejection senza
   * padrone TERMINA il processo. Un audit che non si scrive non deve far
   * cadere ne' il chiamante ne' il server — e' scritto nel catch qui sotto,
   * ma una riga fuori dal try lo smentiva.
   */
  let session: ReturnType<typeof getSession> | undefined
  try {
    session = getSession(undefined, 'WRITE')
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
    /**
     * Un audit che non si scrive NON fa fallire il chiamante, ma non è una
     * cosa da `warn` (revisione totale · A-12): la mutation è riuscita e il
     * registro non ne ha traccia. Si segna nel perimetro della richiesta, così
     * il registro delle mutation scrive almeno la voce generica, e si logga al
     * livello di un difetto — un buco nell'Audit Log è un difetto.
     */
    noteAuditFailed()
    logger.error({ err, action, entityType, entityId, tenantId: ctx.tenantId }, '[audit] write failed: this action has no entry in the Audit Log')
  } finally {
    await session?.close()
  }
}
