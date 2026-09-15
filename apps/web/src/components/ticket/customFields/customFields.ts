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
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'

export type TicketEntityType = 'incident' | 'problem' | 'change' | 'service_request'

export interface CustomFieldDefView {
  name:             string
  label:            string
  fieldType:        string
  required:         boolean
  enumValues:       string[]
  enumTypeName:     string | null
  visibleToEndUser: boolean
  /** In quali fasi del workflow si vede e si modifica (assenti = sempre). */
  stepVisibility?:  StepVisibilityView
  stepEditability?: StepEditabilityView
}

export interface StepVisibilityView  { mode: string; steps: string[]; step?: string | null }
export interface StepEditabilityView { mode: string; steps: string[] }

/** Il valore di un campo come lo restituisce l'API (`CustomFieldValue`): `visible`/`editable` sono della fase del ticket. */
export interface CustomFieldValueView extends CustomFieldDefView { value: string | null; visible?: boolean; editable?: boolean }

/**
 * Visibile e modificabile in una fase: la stessa regola dell'API
 * (`lib/customFieldSteps.ts`), per il modulo di apertura, che non ha ancora un
 * ticket da chiedere. Secondo giro UI del 15 set 2026.
 */
export function customFieldStepState(
  d: Pick<CustomFieldDefView, 'stepVisibility' | 'stepEditability'>,
  ctx: { current: string; steps: readonly { name: string; order: number }[] } | null,
): { visible: boolean; editable: boolean } {
  if (!ctx) return { visible: true, editable: true }
  const v = d.stepVisibility ?? { mode: 'always', steps: [] }
  const e = d.stepEditability ?? { mode: 'visible', steps: [] }
  let visible = true
  if (v.mode === 'steps') visible = v.steps.includes(ctx.current)
  else if (v.mode === 'from') {
    const from = ctx.steps.find((s) => s.name === v.step)
    const here = ctx.steps.find((s) => s.name === ctx.current)
    visible = !!from && !!here && here.order >= from.order
  }
  const editable = visible && (e.mode !== 'steps' || e.steps.includes(ctx.current))
  return { visible, editable }
}

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
      stepVisibility: f.stepVisibility, stepEditability: f.stepEditability,
    })), [data, entityType])
  return { defs, loading, error }
}

/**
 * I campi del modulo di APERTURA: solo quelli che nella fase iniziale del
 * workflow si modificano. «Outcome» della change, «da review in poi», non si
 * chiede più a chi apre la change (secondo giro UI del 15 set 2026).
 */
export function useCreationCustomFieldDefs(entityType: TicketEntityType): { defs: CustomFieldDefView[]; loading: boolean; error: Error | undefined } {
  const all = useTicketCustomFieldDefs(entityType)
  const workflow = useWorkflowSteps(entityType)
  const defs = useMemo(() => {
    const initial = workflow.initialStep
    const ctx = initial ? { current: initial.name, steps: workflow.steps.map((s) => ({ name: s.name, order: s.order })) } : null
    return all.defs.filter((d) => customFieldStepState(d, ctx).editable)
  }, [all.defs, workflow.initialStep, workflow.steps])
  return { defs, loading: all.loading || workflow.loading, error: all.error ?? (workflow.error as Error | undefined) }
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
