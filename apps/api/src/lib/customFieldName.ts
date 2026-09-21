/**
 * Il NOME di un campo personalizzato di un ticket (verifica «Cosa resta
 * cablato», ondata 4). Il nome diventa la proprietà sul ticket: un campo del
 * cliente chiamato `change_type` o `number` scriverebbe sopra un dato del
 * prodotto, da ogni canale. Si rifiuta alla creazione del campo, con quattro
 * controlli: la forma, i nomi riservati, i campi che l'API espone già per quel
 * tipo e le proprietà che i ticket del cliente portano già (dati storici come
 * `legacy_category`).
 */
import type { Session } from 'neo4j-driver'
import { GraphQLObjectType } from 'graphql'
import { CUSTOM_FIELD_NAME_RE, customFieldNameReserved, isTicketCustomFieldEntityType } from '@opengraphity/types'
import { ValidationError } from './errors.js'
import { TICKET_LABELS } from './ticketCustomFields.js'

const toSnake = (s: string): string => s.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`)

export async function assertCustomFieldName(session: Session, tenantId: string, entityType: string, name: string): Promise<void> {
  if (!isTicketCustomFieldEntityType(entityType)) return
  if (!CUSTOM_FIELD_NAME_RE.test(name)) {
    throw new ValidationError(
      `The field name "${name}" must use lowercase letters, digits and underscores (2 to 40 characters, starting with a letter).`,
      { key: 'errors.customField.nameFormat', params: { name } },
    )
  }
  const label = TICKET_LABELS[entityType]
  const { getSchemaForTenant } = await import('./schemaCache.js')
  const type = (await getSchemaForTenant(tenantId)).getType(label)
  const apiFields = type instanceof GraphQLObjectType ? Object.keys(type.getFields()).map(toSnake) : []
  if (customFieldNameReserved(name, entityType) || apiFields.includes(name)) {
    throw new ValidationError(
      `"${name}" is already a field of ${entityType} in the product: choose another name for your field.`,
      { key: 'errors.customField.nameTaken', params: { name, entityType } },
    )
  }
  const inUse = await session.executeRead((tx) => tx.run(
    `MATCH (e:${label} {tenant_id: $tenantId}) WHERE e[$name] IS NOT NULL RETURN count(e) AS n LIMIT 1`, { tenantId, name },
  ))
  if (Number(inUse.records[0]?.get('n') ?? 0) > 0) {
    throw new ValidationError(
      `Some ${entityType} tickets already carry a value called "${name}": choose another name, so your field does not show old data.`,
      { key: 'errors.customField.nameInData', params: { name, entityType } },
    )
  }
}
