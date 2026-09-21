/**
 * Scrittura di UN campo di un ticket da parte di un'automazione (azioni
 * `set_field`/`set_priority` di trigger e Business Rule, azione di passo
 * `update_field`) — revisione del 14 set 2026 · AU-3.
 *
 * ## Il difetto
 * Le azioni scrivevano `SET e[$field] = $value` così com'era: `set_priority`
 * scriveva `e.priority` sull'incident, che la priorità la tiene in `severity`
 * (il valore restava nel vuoto), e nessuna scrittura validava il Dizionario né
 * manteneva l'invariante «priorità = impatto × urgenza»: un'urgenza cambiata da
 * una regola lasciava la priorità vecchia.
 *
 * ## La regola
 * I campi governati dalla matrice passano da `resolvePriorityPatch`, come la
 * modifica fatta a mano:
 *  - incident: `priority`/`severity` → `severity` (e impatto/urgenza riallineati);
 *    `impact`/`urgency` → priorità ricalcolata;
 *  - problem: stessi campi, la priorità in `priority`;
 *  - service request: `priority`, validata contro il Dizionario;
 *  - change: la priorità viene da tipo × rischio e non si imposta; impatto e
 *    urgenza non esistono.
 * Ogni altro campo si scrive così com'è.
 */
import type { Session } from 'neo4j-driver'
import { runQueryOne } from '@opengraphity/neo4j'
import { ValidationError, NotFoundError } from './errors.js'
import { resolvePriorityPatch } from './priority.js'
import { assertDomainValue } from './domainMatrix.js'
import { assertStepFieldValue, stepFieldMetas } from './stepFieldWrites.js'

const LABELS: Readonly<Record<string, string>> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'ServiceRequest',
}

export const PRIORITY_FIELDS: ReadonlySet<string> = new Set(['priority', 'severity', 'impact', 'urgency'])

type Props = Record<string, unknown>

/** Le proprietà da scrivere per (tipo, campo, valore): pura rispetto al grafo, per i test. */
export async function priorityWrite(
  tenantId: string, entityType: string, field: string, value: unknown, current: Props,
): Promise<Props> {
  const text = value == null ? null : String(value)
  if (entityType === 'change') {
    throw new ValidationError(
      `A change's priority is derived from its type and risk: an automation cannot set "${field}".`,
      { key: 'errors.automation.changePriorityDerived', params: { field } },
    )
  }
  if (entityType === 'service_request') {
    if (field !== 'priority') throw new ValidationError(`A service request has no "${field}" field.`, { key: 'errors.automation.fieldNotOnEntity', params: { field, entityType } })
    return { priority: await assertDomainValue(tenantId, 'priority', text) }
  }
  const patch = field === 'impact' ? { impact: text } : field === 'urgency' ? { urgency: text } : { priority: text }
  const r = await resolvePriorityPatch(tenantId, { impact: current['impact'] as string | null, urgency: current['urgency'] as string | null }, patch)
  const priorityProp = entityType === 'incident' ? 'severity' : 'priority'
  const out: Props = {}
  if (r.severity != null) out[priorityProp] = r.severity
  if (r.impact   != null) out['impact']   = r.impact
  if (r.urgency  != null) out['urgency']  = r.urgency
  return out
}

/** Scrive il campo e ritorna le proprietà prima e dopo (per `ticket.updated`). */
export async function writeTicketField(
  session: Session, tenantId: string, entityType: string, entityId: string, field: string, value: unknown,
): Promise<{ before: Props; after: Props }> {
  const label = LABELS[entityType]
  if (!label) throw new ValidationError(`Entity type "${entityType}" has no writable fields for automations`, { key: 'errors.automation.entityNotWritable', params: { entityType } })
  const current = await runQueryOne<{ props: Props }>(session, `MATCH (e:${label} {id: $id, tenant_id: $tenantId}) RETURN properties(e) AS props`, { id: entityId, tenantId })
  if (!current) throw new NotFoundError(label, entityId)
  // Il campo e il valore passano dalla STESSA validazione dell'azione di passo
  // `update_field` (revisione totale · C-4): deve essere un campo del
  // metamodello del cliente e il valore del suo vocabolario. Prima `set_field`
  // scriveva qualunque proprietà non compresa in una lista corta di dieci
  // nomi: «deleted = true» era un soft-delete di massa da una regola,
  // «resolved_at = …» faceva risultare concluso un ticket aperto, e un valore
  // fuori Dizionario sparisce da filtri e matrici.
  const props = PRIORITY_FIELDS.has(field)
    ? await priorityWrite(tenantId, entityType, field, value, current.props)
    : { [field]: assertStepFieldValue(await stepFieldMetas(session, tenantId, entityType), entityType, field, value, `set_field ${field}`, { allowTemplate: false }) }
  const now = new Date().toISOString()
  const row = await runQueryOne<{ props: Props }>(session, `
    MATCH (e:${label} {id: $id, tenant_id: $tenantId})
    SET e += $props, e.updated_at = $now
    RETURN properties(e) AS props
  `, { id: entityId, tenantId, props, now })
  if (!row) throw new NotFoundError(label, entityId)
  return { before: current.props, after: row.props }
}
