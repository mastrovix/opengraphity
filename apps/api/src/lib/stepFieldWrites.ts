/**
 * I CAMPI CHE UN PASSO DI WORKFLOW SCRIVE: l'azione `update_field` e i campi
 * impostati da una scadenza (verifica «Cosa resta cablato», ondata 3).
 *
 * La scelta del proprietario è «ogni campo non riservato». Quindi il campo lo
 * decide il METAMODELLO del cliente — deve esistere per quel tipo di ticket — e
 * il valore il suo vocabolario, come per la modifica fatta a mano. Le riserve
 * (motore, identità, campi derivati) stanno in `@opengraphity/types`.
 *
 * Si valida due volte con la stessa funzione: quando l'amministratore salva il
 * passo (così il rifiuto arriva nel disegnatore) e quando il passo scrive (il
 * metamodello può essere cambiato nel frattempo).
 */
import type { Session } from 'neo4j-driver'
import { stepFieldRejection } from '@opengraphity/types'
import { ValidationError } from './errors.js'
import { loadITILTypes } from './itilTypes.js'

/** Il campo del metamodello, nella forma che serve alla validazione. */
export interface StepFieldMeta {
  name:      string
  fieldType: string
  enumValues: string[]
  enumTypeName: string | null
}

/** Tipi di campo che non sono proprietà del ticket ma relazioni: si assegnano con `assign_to`. */
const RELATION_FIELD_TYPES = new Set(['user', 'team', 'reference', 'relation'])

/** Un valore di `update_field` che contiene un segnaposto `{campo}` si risolve a runtime. */
export function isTemplateValue(value: unknown): boolean {
  return typeof value === 'string' && /\{[A-Za-z_][\w.]*\}/.test(value)
}

/** I campi del tipo di ticket, dal metamodello del cliente (i suoi più quelli spediti). */
export async function stepFieldMetas(session: Session, tenantId: string, entityType: string): Promise<Map<string, StepFieldMeta>> {
  const types = await loadITILTypes(session, tenantId)
  const type = types.find((t) => t.name === entityType)
  const out = new Map<string, StepFieldMeta>()
  for (const f of type?.fields ?? []) {
    out.set(String(f.name), {
      name: String(f.name), fieldType: String(f.fieldType ?? ''),
      enumValues: (f.enumValues ?? []) as string[], enumTypeName: (f.enumTypeName ?? null) as string | null,
    })
  }
  return out
}

/**
 * Il valore da scrivere, già convertito al tipo del campo. Lancia con una chiave
 * i18n se il campo è riservato, non è del metamodello, è una relazione, o il
 * valore non va bene. `where` dice all'amministratore quale regola lo porta.
 */
export function assertStepFieldValue(
  metas: ReadonlyMap<string, StepFieldMeta>, entityType: string, field: string, value: unknown, where: string,
  { allowTemplate }: { allowTemplate: boolean },
): string | number | boolean {
  const rejection = stepFieldRejection(field, entityType)
  if (rejection) {
    throw new ValidationError(`${where}: ${rejection.message}`, { key: `errors.stepField.${rejection.reason}`, params: { where, field, entityType } })
  }
  const meta = metas.get(field)
  if (!meta) {
    throw new ValidationError(
      `${where}: the field "${field}" is not a field of ${entityType} in the metamodel. Add it in the ITIL designer, or choose another field.`,
      { key: 'errors.stepField.notInMetamodel', params: { where, field, entityType } },
    )
  }
  if (RELATION_FIELD_TYPES.has(meta.fieldType)) {
    throw new ValidationError(
      `${where}: the field "${field}" is a ${meta.fieldType}, which is assigned, not written: use the assign_to action.`,
      { key: 'errors.stepField.relation', params: { where, field } },
    )
  }
  if (value == null || String(value).trim() === '') {
    throw new ValidationError(`${where}: the field "${field}" needs a value.`, { key: 'errors.stepField.valueRequired', params: { where, field } })
  }
  if (allowTemplate && isTemplateValue(value)) return String(value)

  const text = String(value).trim()
  switch (meta.fieldType) {
    case 'enum': {
      if (meta.enumValues.length > 0 && !meta.enumValues.includes(text)) {
        throw new ValidationError(
          `${where}: "${text}" is not a value of the field "${field}" (allowed: ${meta.enumValues.join(', ')}).`,
          { key: 'errors.stepField.valueNotInVocabulary', params: { where, field, value: text, allowed: meta.enumValues.join(', ') } },
        )
      }
      return text
    }
    case 'number': {
      const n = Number(text)
      if (!Number.isFinite(n)) {
        throw new ValidationError(`${where}: the field "${field}" is a number, "${text}" is not.`, { key: 'errors.stepField.notNumber', params: { where, field, value: text } })
      }
      return n
    }
    case 'boolean': {
      if (text !== 'true' && text !== 'false') {
        throw new ValidationError(`${where}: the field "${field}" is yes/no: use true or false.`, { key: 'errors.stepField.notBoolean', params: { where, field, value: text } })
      }
      return text === 'true'
    }
    case 'date': {
      if (Number.isNaN(Date.parse(text))) {
        throw new ValidationError(`${where}: the field "${field}" is a date, "${text}" is not.`, { key: 'errors.stepField.notDate', params: { where, field, value: text } })
      }
      return text
    }
    default:
      return String(value)
  }
}
