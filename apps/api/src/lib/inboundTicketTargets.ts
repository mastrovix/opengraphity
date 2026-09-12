/**
 * La guardia sui bersagli della mappa di un webhook in ingresso (D-25), in un
 * posto che leggono in due: la **configurazione** (`validateInboundConfig`, al
 * salvataggio) e la **consegna** (`rest/webhooks-inbound.ts`, al payload).
 *
 * Il vocabolario dei bersagli vive in `@opengraphity/types`
 * (`INBOUND_TICKET_FIELDS`) perché lo legge anche il web.
 */
import { inboundTicketFieldsFor } from '@opengraphity/types'
import { ValidationError } from './errors.js'

/**
 * I bersagli nominati (i valori di `fieldMapping`, le chiavi di
 * `defaultValues`, le chiavi del payload mappato) sono fra quelli che la
 * consegna scrive davvero? Un tipo di entità che non crea ticket (`event`) ha
 * la sua validazione, per connettore: qui non si dice niente.
 */
export function assertInboundTicketTargets(entityType: unknown, targets: unknown[], where: string): void {
  const allowed = inboundTicketFieldsFor(entityType)
  if (!allowed) return
  const unknownTargets = targets
    .filter((t): t is string => typeof t === 'string')
    .filter((t) => !allowed.includes(t))
  if (unknownTargets.length > 0) {
    throw new ValidationError(
      `${where}: ${unknownTargets.map((t) => JSON.stringify(t)).join(', ')} ` +
      `${unknownTargets.length === 1 ? 'is not a field' : 'are not fields'} that a "${String(entityType)}" webhook writes. ` +
      `Allowed targets: ${allowed.join(', ')}. ` +
      `A target outside this list would be accepted, applied to the payload and then dropped.`,
    )
  }
}
