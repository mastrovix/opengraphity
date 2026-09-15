/**
 * I CAMPI PERSONALIZZATI DEI TICKET, sull'API (verifica «Cosa resta cablato»,
 * ondata 4).
 *
 * Un campo del cliente è un `CIFieldDefinition` del tenant (`is_system: false`)
 * su uno dei tipi ITIL — incident, problem, change, service_request — e il suo
 * valore è una proprietà del ticket con lo stesso nome. Qui c'è l'unica strada
 * da cui passano, da qualunque canale (pagine, REST, import, portale):
 *
 *  - `customFieldDefs`: i campi del cliente per quel tipo, in ordine;
 *  - `customFieldValues`: i valori di un ticket, nella forma che l'API espone;
 *  - `resolveCustomFieldWrites`: da `[{name, value}]` alle proprietà da
 *    scrivere, dopo aver controllato che il campo esista, il tipo, il
 *    vocabolario, l'obbligo, lo script di validazione e — dal portale — che il
 *    campo sia visibile all'utente finale.
 *
 * Non ripiega: un campo sconosciuto o un valore fuori vocabolario è un errore
 * con la sua chiave, non un valore scartato in silenzio.
 */
import type { Session } from 'neo4j-driver'
import { CUSTOM_FIELD_NAME_RE, isTicketCustomFieldEntityType, type TicketCustomFieldEntityType } from '@opengraphity/types'
import { ValidationError } from './errors.js'
import { loadITILTypes } from './itilTypes.js'
import { assertStepFieldValue, type StepFieldMeta } from './stepFieldWrites.js'
import { runValidationScript } from './metamodelScript.js'

export const TICKET_LABELS: Readonly<Record<TicketCustomFieldEntityType, string>> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'ServiceRequest',
}

export interface CustomFieldDef {
  name:             string
  label:            string
  fieldType:        string
  required:         boolean
  enumValues:       string[]
  enumTypeName:     string | null
  validationScript: string | null
  visibleToEndUser: boolean
  order:            number
}

/** Il valore di un campo, come lo espone l'API: sempre testo (o null), con quello che serve a mostrarlo. */
export interface CustomFieldValue {
  name:             string
  label:            string
  fieldType:        string
  value:            string | null
  enumValues:       string[]
  enumTypeName:     string | null
  required:         boolean
  visibleToEndUser: boolean
}

export interface CustomFieldInput { name: string; value: string | null }

/** `[{name, value}]` → `{name: value}`, per le regole di obbligatorietà che leggono i valori per nome. */
export function customFieldValueMap(inputs: readonly CustomFieldInput[] | null | undefined): Record<string, unknown> {
  return Object.fromEntries((inputs ?? []).map((i) => [i.name, i.value]))
}

/** I campi del cliente per un tipo di ticket, in ordine. */
export async function customFieldDefs(session: Session, tenantId: string, entityType: TicketCustomFieldEntityType): Promise<CustomFieldDef[]> {
  const types = await loadITILTypes(session, tenantId)
  const type = types.find((t) => t.name === entityType)
  return (type?.fields ?? [])
    .filter((f) => f.isSystem !== true)
    .map((f) => ({
      name: String(f.name), label: String(f.label ?? f.name), fieldType: String(f.fieldType ?? 'string'),
      required: f.required === true, enumValues: (f.enumValues ?? []) as string[],
      enumTypeName: (f.enumTypeName ?? null) as string | null,
      validationScript: (f.validationScript ?? null) as string | null,
      visibleToEndUser: f.visibleToEndUser === true,
      order: Number(f.order ?? 0),
    }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

function asText(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  return String(raw)
}

/** I valori del ticket per i campi del cliente; `onlyVisibleToEndUser` per il portale. */
export function customFieldValues(defs: readonly CustomFieldDef[], props: Record<string, unknown>, opts: { onlyVisibleToEndUser?: boolean } = {}): CustomFieldValue[] {
  return defs
    .filter((d) => !opts.onlyVisibleToEndUser || d.visibleToEndUser)
    .map((d) => ({
      name: d.name, label: d.label, fieldType: d.fieldType, value: asText(props[d.name]),
      enumValues: d.enumValues, enumTypeName: d.enumTypeName, required: d.required, visibleToEndUser: d.visibleToEndUser,
    }))
}

/**
 * Le proprietà da scrivere per i valori mandati. `current` sono le proprietà del
 * ticket (null in creazione): serve all'obbligo in modifica e allo script, che
 * vede il ticket intero. In creazione un campo obbligatorio non mandato è un
 * errore; in modifica lo è solo svuotarlo.
 */
export async function resolveCustomFieldWrites(
  tenantId: string,
  entityType: TicketCustomFieldEntityType,
  defs: readonly CustomFieldDef[],
  inputs: readonly CustomFieldInput[] | null | undefined,
  opts: { current: Record<string, unknown> | null; endUser?: boolean },
): Promise<Record<string, unknown>> {
  const list = inputs ?? []
  const byName = new Map(defs.map((d) => [d.name, d]))
  const metas = new Map<string, StepFieldMeta>(defs.map((d) => [d.name, { name: d.name, fieldType: d.fieldType, enumValues: d.enumValues, enumTypeName: d.enumTypeName }]))
  const out: Record<string, unknown> = {}
  const seen = new Set<string>()

  for (const input of list) {
    const def = byName.get(input.name)
    if (!def) {
      throw new ValidationError(`"${input.name}" is not a custom field of ${entityType}.`,
        { key: 'errors.customField.unknown', params: { field: input.name, entityType } })
    }
    if (opts.endUser && !def.visibleToEndUser) {
      throw new ValidationError(`The field "${def.label}" is not offered to end users.`,
        { key: 'errors.customField.notForEndUser', params: { field: def.label } })
    }
    if (seen.has(def.name)) {
      throw new ValidationError(`The field "${def.label}" is sent twice.`, { key: 'errors.customField.duplicate', params: { field: def.label } })
    }
    seen.add(def.name)
    if (input.value == null || String(input.value).trim() === '') {
      out[def.name] = null
      continue
    }
    out[def.name] = assertStepFieldValue(metas, entityType, def.name, input.value, `«${def.label}»`, { allowTemplate: false })
  }

  const merged = { ...(opts.current ?? {}), ...out }
  const creating = opts.current === null
  const missing = defs
    .filter((d) => d.required && (!opts.endUser || d.visibleToEndUser))
    .filter((d) => (creating || d.name in out) && (merged[d.name] == null || merged[d.name] === ''))
  if (missing.length > 0) {
    throw new ValidationError(`Required fields without a value: ${missing.map((d) => d.label).join(', ')}.`,
      { key: 'errors.customField.required', params: { fields: missing.map((d) => d.label).join(', ') } })
  }

  for (const [name, value] of Object.entries(out)) {
    const def = byName.get(name)!
    if (!def.validationScript || value == null) continue
    const error = await runValidationScript(def.validationScript, { input: merged, value }, `${entityType}.${name}.validation_script`, tenantId, 'tenant')
    if (error) {
      throw new ValidationError(`«${def.label}»: ${error}`, { key: 'errors.customField.script', params: { field: def.label, error } })
    }
  }
  return out
}

/** I campi (e i valori) di un ticket, letti dal grafo: per chi non ha le proprietà a portata di mano. */
export async function loadTicketProps(session: Session, tenantId: string, entityType: TicketCustomFieldEntityType, id: string): Promise<Record<string, unknown> | null> {
  const res = await session.executeRead((tx) => tx.run(
    `MATCH (e:${TICKET_LABELS[entityType]} {id: $id, tenant_id: $tenantId}) RETURN properties(e) AS props`, { id, tenantId },
  ))
  return (res.records[0]?.get('props') ?? null) as Record<string, unknown> | null
}

// ── REST v1 ───────────────────────────────────────────────────────────────────

/**
 * In REST i campi del cliente viaggiano come oggetto `customFields: {nome: valore}`,
 * nelle richieste e nelle risposte. `undefined` = chiave assente (il canale non
 * li manda); un valore che non è testo, numero, sì/no o null è un errore.
 */
export function parseRestCustomFields(body: Record<string, unknown>): CustomFieldInput[] | undefined {
  const raw = body['customFields']
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('customFields must be an object {fieldName: value}', { key: 'errors.customField.restShape' })
  }
  return Object.entries(raw as Record<string, unknown>).map(([name, value]) => {
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new ValidationError(`customFields.${name} must be a string, a number, a boolean or null`, { key: 'errors.customField.restShape' })
    }
    return { name, value: value === null ? null : String(value) }
  })
}

/** I valori del ticket per REST: `{nome: valore}`, con i campi senza valore a null. */
export function restCustomFieldValues(defs: readonly CustomFieldDef[], props: Record<string, unknown>): Record<string, string | null> {
  return Object.fromEntries(customFieldValues(defs, props).map((v) => [v.name, v.value]))
}

/**
 * I valori di un campo personalizzato sui ticket del tenant: quanti sono e un
 * campione (numero → valore) per l'Audit Log. Giro UI del 15 set 2026 · U-28:
 * la cancellazione del campo lasciava i valori sui ticket, e un campo ricreato
 * con lo stesso nome li ritrovava (o non si poteva ricreare affatto).
 */
export const FIELD_VALUE_SAMPLE = 50

function ticketFieldTarget(entityType: string, name: string): { label: string; property: string } {
  if (!isTicketCustomFieldEntityType(entityType)) throw new ValidationError(`"${entityType}" is not a ticket type with custom fields`)
  // Il nome finisce in una REMOVE: la forma del campo (la stessa della creazione) è la porta.
  if (!CUSTOM_FIELD_NAME_RE.test(name)) throw new Error(`Custom field name "${name}" does not match the field name rule: refusing to use it as a property`)
  return { label: TICKET_LABELS[entityType], property: name }
}

export async function ticketFieldValues(
  session: Session, tenantId: string, entityType: string, name: string,
): Promise<{ count: number; sample: Record<string, string> }> {
  const { label } = ticketFieldTarget(entityType, name)
  const res = await session.executeRead((tx) => tx.run(`
    MATCH (e:${label} {tenant_id: $tenantId}) WHERE e[$name] IS NOT NULL
    WITH e ORDER BY e.number
    WITH collect({number: coalesce(e.number, e.code, e.id), value: toString(e[$name])}) AS rows
    RETURN size(rows) AS count, rows[0..$limit] AS sample
  `, { tenantId, name, limit: FIELD_VALUE_SAMPLE }))
  const rec = res.records[0]
  const sample = (rec?.get('sample') as Array<{ number: string; value: string }> | undefined) ?? []
  return { count: Number(rec?.get('count') ?? 0), sample: Object.fromEntries(sample.map((r) => [String(r.number), r.value])) }
}

/** Toglie i valori del campo da tutti i ticket del tenant, nella transazione del chiamante. Restituisce quanti ne ha tolti. */
export async function removeTicketFieldValues(
  tx: { run: (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> },
  tenantId: string, entityType: string, name: string,
): Promise<number> {
  const { label, property } = ticketFieldTarget(entityType, name)
  const res = await tx.run(`
    MATCH (e:${label} {tenant_id: $tenantId}) WHERE e[$name] IS NOT NULL
    REMOVE e.\`${property}\`
    RETURN count(e) AS removed
  `, { tenantId, name })
  return Number(res.records[0]?.get('removed') ?? 0)
}
