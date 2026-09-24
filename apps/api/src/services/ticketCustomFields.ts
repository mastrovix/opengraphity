/**
 * The write of the custom fields of a ticket (wave 7 · C1): moved from the
 * resolver, which the REST API called. The rules of the step (visible,
 * editable), the required fields of the customer on the resulting state,
 * `ticket.updated` and the audit only when a value really changed.
 */
import { runQueryOne } from '@opengraphity/neo4j'
import { isTicketCustomFieldEntityType } from '@opengraphity/types'
import type { GraphQLContext } from '../context.js'
import { withSession, type Props } from '../lib/db.js'
import { NotFoundError, ValidationError } from '../lib/errors.js'
import { audit } from '../lib/audit.js'
import { publishTicketUpdated } from '../lib/ticketUpdated.js'
import { validateRequiredFields } from '../lib/validateRequiredFields.js'
import {
  TICKET_LABELS, customFieldDefs, customFieldValues, loadTicketProps, resolveCustomFieldWrites,
  type CustomFieldInput, type CustomFieldValue,
} from '../lib/ticketCustomFields.js'
import { ticketStepContext } from '../lib/customFieldSteps.js'

export async function writeTicketCustomFields(
  type: string,
  id: string,
  values: CustomFieldInput[],
  ctx: GraphQLContext,
): Promise<CustomFieldValue[]> {
  if (!isTicketCustomFieldEntityType(type)) {
    throw new ValidationError(`"${type}" has no custom fields.`, { key: 'errors.customField.entityType', params: { entityType: type } })
  }
  const entityType = type
  const label = TICKET_LABELS[entityType]
  return withSession(async (session) => {
    const current = await loadTicketProps(session, ctx.tenantId, entityType, id)
    if (!current) throw new NotFoundError(label, id)
    const defs = await customFieldDefs(session, ctx.tenantId, entityType)
    const stepContext = await ticketStepContext(session, ctx.tenantId, id)
    const patch = await resolveCustomFieldWrites(ctx.tenantId, entityType, defs, values, { current, stepContext })
    // Le regole di obbligatorietà del cliente valgono anche togliendo un valore.
    await validateRequiredFields(session, { entityType, fieldValues: { ...current, ...patch }, tenantId: ctx.tenantId })
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (e:${label} {id: $id, tenant_id: $tenantId})
      SET e += $patch, e.updated_at = $now
      RETURN properties(e) AS props
    `, { id: id, tenantId: ctx.tenantId, patch, now: new Date().toISOString() })
    if (!row) throw new NotFoundError(label, id)

    const changed = Object.keys(patch).filter((k) => String(current[k] ?? '') !== String(row.props[k] ?? ''))
    if (changed.length > 0) {
      await publishTicketUpdated(ctx, entityType, id, current, row.props)
      void audit(ctx, 'ticket.custom_fields_updated', label, id, {
        fields: Object.fromEntries(changed.map((k) => [k, { from: current[k] ?? null, to: row.props[k] ?? null }])),
      })
    }
    return customFieldValues(defs, row.props, { stepContext })
  }, true)
}
