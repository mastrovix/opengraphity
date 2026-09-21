/**
 * «Crea senza SLA»: l'accettazione che toglie un ticket dagli avvisi di
 * configurazione.
 *
 * La dà chi crea il ticket dal form dello staff, dopo aver visto che nessuna
 * policy SLA lo copre. Un utente del portale non vede quell'avviso e non
 * decide la configurazione SLA: se la mandasse, nasconderebbe all'admin un
 * buco di copertura. Si rifiuta, invece di ignorarla in silenzio.
 */
import { ForbiddenError } from './errors.js'
import type { GraphQLContext } from '../context.js'
import { isPortalOnly } from './permissions.js'

export function assertMayAcknowledgeNoSla(ctx: Pick<GraphQLContext, 'permissions'>, acknowledgeNoSla: boolean | null | undefined): void {
  if (acknowledgeNoSla === true && isPortalOnly(ctx)) {
    throw new ForbiddenError('Only staff can create a ticket acknowledging that no SLA policy covers it', { key: 'errors.sla.acknowledgeStaffOnly' })
  }
}
