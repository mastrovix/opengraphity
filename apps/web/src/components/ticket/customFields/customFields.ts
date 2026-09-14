/**
 * I CAMPI PERSONALIZZATI DEI TICKET nel web (verifica «Cosa resta cablato»,
 * ondata 4): le definizioni dal metamodello, la forma che l'API vuole e i
 * controlli che il form fa prima di mandare. L'API resta l'autorità (tipo,
 * vocabolario, obbligo, script).
 */
import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import type { TFunction } from 'i18next'
import { GET_ITIL_TYPES } from '@/graphql/queries'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { formatDate } from '@/lib/datetime'
import type { FieldRules } from '@/hooks/useFormFieldRules'

export type TicketEntityType = 'incident' | 'problem' | 'change' | 'service_request'

export interface CustomFieldDefView {
  name:             string
  label:            string
  fieldType:        string
  required:         boolean
  enumValues:       string[]
  enumTypeName:     string | null
  visibleToEndUser: boolean
}

/** Il valore di un campo come lo restituisce l'API (`CustomFieldValue`). */
export interface CustomFieldValueView extends CustomFieldDefView { value: string | null }

interface ItilTypesData {
  itilTypes: { name: string; fields: (CustomFieldDefView & { isSystem: boolean; order: number })[] }[]
}

/** I campi del cliente per un tipo di ticket, in ordine. */
export function useTicketCustomFieldDefs(entityType: TicketEntityType): { defs: CustomFieldDefView[]; loading: boolean; error: Error | undefined } {
  const { data, loading, error } = useQuery<ItilTypesData>(GET_ITIL_TYPES, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const defs = useMemo(() => (data?.itilTypes.find((t) => t.name === entityType)?.fields ?? [])
    .filter((f) => !f.isSystem)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((f) => ({
      name: f.name, label: f.label || f.name, fieldType: f.fieldType, required: f.required,
      enumValues: f.enumValues ?? [], enumTypeName: f.enumTypeName ?? null, visibleToEndUser: f.visibleToEndUser === true,
    })), [data, entityType])
  return { defs, loading, error }
}

/** Da `{nome: valore}` a quello che l'API vuole: tutti i campi del form, il vuoto come null. */
export function customFieldsInput(defs: readonly CustomFieldDefView[], values: Record<string, string>): { name: string; value: string | null }[] {
  return defs.map((d) => ({ name: d.name, value: (values[d.name] ?? '').trim() === '' ? null : (values[d.name] ?? '').trim() }))
}

/** I valori iniziali del form di modifica, dai valori del ticket. */
export function customFieldValuesMap(fields: readonly CustomFieldValueView[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.name, f.value ?? '']))
}

/** I campi obbligatori senza valore: obbligatori nel metamodello o per le regole del cliente, se visibili. */
export function missingCustomFields(defs: readonly CustomFieldDefView[], values: Record<string, string>, rules: Record<string, FieldRules> = {}): string[] {
  return defs
    .filter((d) => (rules[d.name]?.visible ?? true) && (d.required || rules[d.name]?.required === true))
    .filter((d) => (values[d.name] ?? '').trim() === '')
    .map((d) => d.name)
}

/** Come si legge un valore: l'etichetta del Dizionario, Sì/No, la data nella lingua di chi guarda. */
export function customFieldDisplay(
  field: Pick<CustomFieldValueView, 'fieldType' | 'enumTypeName' | 'value'>,
  labelOf: (vocabulary: string, value: string) => string | null,
  t: TFunction,
): string {
  if (field.value == null || field.value === '') return '—'
  if (field.fieldType === 'enum' && field.enumTypeName) return labelOf(field.enumTypeName, field.value) ?? field.value
  if (field.fieldType === 'boolean') return t(field.value === 'true' ? 'common.yes' : 'common.no')
  if (field.fieldType === 'date') return formatDate(field.value)
  return field.value
}
