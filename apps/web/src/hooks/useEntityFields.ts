/**
 * Campi di un'entità, in due forme:
 *
 *  - `useEntityFields(typeName)`: FieldConfig[] per FilterBuilder, da
 *    query `entityFilterFields` (scalari/enum dallo schema, senza introspezione).
 *  - `useEntityFieldMetas(entityType)`: FieldMeta[] dal METAMODELLO
 *    (GET_ITIL_TYPES / GET_CI_TYPES) per gli editor di automazione. Prima
 *    esisteva in tre varianti quasi identiche (ConditionRowEditor,
 *    ActionParamsEditor, AutomationPreview).
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@apollo/client/react'
import type { FieldConfig } from '@/components/FilterBuilder'
import { GET_ITIL_TYPES, GET_CI_TYPES, GET_ENTITY_FILTER_FIELDS } from '@/graphql/queries'
import { isITILEntity } from '@/lib/automationOperators'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { shippedLabel } from '@/lib/shippedLabel'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { localizedLabel } from '@/lib/localizedLabel'

// ── Metamodel field metas (automazione) ──────────────────────────────────────

export interface FieldMeta {
  name:       string
  label:      string
  fieldType:  string
  enumValues: string[]
  /**
   * Il nome del VOCABOLARIO a cui il campo è legato (`null` se non è un enum,
   * o se il legame manca). Serve a leggere l'ETICHETTA dei valori: senza
   * sapere di che vocabolario si tratta, le tendine delle condizioni e delle
   * azioni mostravano il valore grezzo — `low → low` — mentre la stessa parola
   * a due righe di distanza si leggeva «Bassa».
   */
  enumTypeName: string | null
}

interface TypeDef {
  name:   string
  fields: { name: string; label: string; fieldType: string; enumValues?: string[] | null; enumTypeName?: string | null }[]
}

/**
 * Campi "virtuali" di relazione, offerti oltre a quelli del tipo.
 *
 * Le etichette dei campi del METAMODELLO sono dato del cliente e arrivano
 * cosi come sono; queste due sono nostre, quindi portano una CHIAVE e le
 * traduce il client (`labelKey`, come nel resto del progetto).
 */
const VIRTUAL_RELATION_FIELDS: (Omit<FieldMeta, 'label'> & { labelKey: string })[] = [
  { name: 'assigned_to',   labelKey: 'detail.assignedTo', fieldType: 'user', enumValues: [], enumTypeName: null },
  { name: 'assigned_team', labelKey: 'detail.team',       fieldType: 'team', enumValues: [], enumTypeName: null },
]

/**
 * Campi del tipo `entityType` (ITIL o CI) dal metamodello. `withVirtual`
 * aggiunge assigned_to/assigned_team se il tipo non li dichiara già.
 * Tipo non trovato → lista vuota + `error` (non un silenzio).
 */
export function useEntityFieldMetas(entityType: string, { withVirtual = true }: { withVirtual?: boolean } = {}): { fields: FieldMeta[]; error: string | null } {
  const { t } = useTranslation()
  const isITIL = isITILEntity(entityType)
  const { data: itilData, error: itilErr } = useQuery(GET_ITIL_TYPES, { skip: !isITIL || !entityType, fetchPolicy: METAMODEL_FETCH_POLICY })
  const { data: ciData,   error: ciErr   } = useQuery(GET_CI_TYPES,   { skip: isITIL  || !entityType, fetchPolicy: METAMODEL_FETCH_POLICY })

  return useMemo(() => {
    if (!entityType) return { fields: [], error: null }
    const qErr = (isITIL ? itilErr : ciErr)
    if (qErr) return { fields: [], error: qErr.message }
    const types = isITIL
      ? (itilData as { itilTypes?: TypeDef[] } | undefined)?.itilTypes
      : (ciData   as { ciTypes?:   TypeDef[] } | undefined)?.ciTypes
    if (!types) return { fields: [], error: null }   // in caricamento
    const typeDef = types.find(t => t.name === entityType)
    if (!typeDef) return { fields: [], error: `entity type "${entityType}" is not in the metamodel` }
    const fields: FieldMeta[] = typeDef.fields.map(f => ({
      name: f.name, label: shippedLabel('field', f.name, f.label), fieldType: f.fieldType, enumValues: f.enumValues ?? [],
      enumTypeName: f.enumTypeName ?? null,
    }))
    if (withVirtual) {
      for (const { labelKey, ...v } of VIRTUAL_RELATION_FIELDS) {
        if (!fields.find(f => f.name === v.name)) fields.push({ ...v, label: t(labelKey) })
      }
    }
    return { fields, error: null }
  }, [isITIL, entityType, itilData, ciData, itilErr, ciErr, withVirtual, t])
}

/**
 * Stessi campi, indicizzati per nome (anteprime/lookup) — più quelli dei
 * moduli del catalogo (ondata 5). Servono anche qui: senza, l'anteprima di una
 * regola diceva «ambienti_coinvolti contiene "production"» invece di «Ambienti
 * coinvolti contiene "Produzione"», cioè leggeva il nome interno proprio nella
 * frase che serve a capire se la regola è quella giusta.
 */
export function useEntityFieldLookup(entityType: string): Map<string, FieldMeta> {
  const { fields } = useEntityFieldMetas(entityType)
  const daiModuli = useFormFieldMetas(entityType)
  return useMemo(() => {
    const m = new Map(fields.map(f => [f.name, f]))
    for (const f of daiModuli) if (!m.has(f.name)) m.set(f.name, f)
    return m
  }, [fields, daiModuli])
}

/**
 * I tipi di un campo di modulo nel vocabolario dell'automazione (ondata 5).
 *
 * Due vocabolari diversi: un modulo parla di `text`/`textarea`/`datetime`,
 * l'editor delle condizioni di `string`/`date`. La conversione sta QUI, in un
 * posto solo, e un tipo che non ha un corrispondente resta fuori invece di
 * arrivare all'editor come «?tipo».
 */
const FORM_TYPE_TO_AUTOMATION: Readonly<Record<string, string>> = {
  text: 'string', textarea: 'string', number: 'number',
  date: 'date', datetime: 'date', boolean: 'boolean',
  enum: 'enum', multi_enum: 'multi_enum',
}

/**
 * I campi della LIBRERIA dei moduli del catalogo come `FieldMeta`, per gli
 * editor delle automazioni (ondata 5).
 *
 * Perché esistono qui: una risposta di modulo è una proprietà del ticket, e il
 * motore delle condizioni legge `properties(nodo)` — quindi una condizione su
 * «Ambiente = produzione» FUNZIONAVA già, ma non si potevano scrivere: la
 * tendina dei campi veniva dal solo metamodello. Si offrono solo per le
 * RICHIESTE, le sole che compilano un modulo.
 *
 * La sorgente è `entityFilterFields` (dato di riferimento che ogni pagina può
 * leggere), non la libreria dell'amministratore: chi scrive una regola non ha
 * per forza i permessi della configurazione del catalogo.
 */
export function useFormFieldMetas(entityType: string): FieldMeta[] {
  const richiesta = entityType === 'service_request'
  const { data } = useQuery<{ entityFilterFields: EntityFilterField[] }>(
    GET_ENTITY_FILTER_FIELDS,
    { variables: { typeName: 'ServiceRequest' }, skip: !richiesta, fetchPolicy: METAMODEL_FETCH_POLICY },
  )
  const campi = data?.entityFilterFields
  return useMemo(() => (campi ?? [])
    .filter((f) => f.formFieldType != null && FORM_TYPE_TO_AUTOMATION[f.formFieldType] != null)
    .map((f): FieldMeta => ({
      name:         f.name,
      label:        f.label ?? f.name,
      fieldType:    FORM_TYPE_TO_AUTOMATION[f.formFieldType!],
      enumValues:   f.enumValues ?? [],
      // Il vocabolario: da lì l'editor legge l'etichetta di ogni valore, come
      // fa per i campi del metamodello.
      enumTypeName: f.vocabulary,
    })), [campi])
}

// ── Campi filtrabili dal server (FilterBuilder) ──────────────────────────────
// Prima si usava l'introspezione `__type`, che in produzione è disattivata:
// ora l'API espone `entityFilterFields` (solo scalari ed enum, già "unwrappati").

interface EntityFilterField {
  name:       string
  kind:       'SCALAR' | 'ENUM'
  scalarName: string | null
  enumValues: string[] | null
  /** L'etichetta decisa dal server (campi dei moduli); null = la componiamo dal nome. */
  label:      string | null
  /** Le scelte con l'etichetta del Dizionario; vuota = valgono `enumValues`. */
  choices:    { value: string; label: string }[]
  /** Il tipo del campo se viene da un modulo del catalogo; null altrimenti (ondata 5). */
  formFieldType: string | null
  /** Il vocabolario del Dizionario del campo, per leggerne le etichette. */
  vocabulary: string | null
  /** Il valore sul nodo è una LISTA: vuole gli operatori di lista (ondata 4). */
  multi:      boolean
  /** Filtra le RIGHE di una tabella: operatori di relazione (ondata 7). */
  rowFilter:  boolean
}

/**
 * Gli operatori che una RELAZIONE sa fare, cioè quelli con cui si filtrano le
 * righe di una tabella (ondata 7). La lista è quella di `filterBuilder.ts`
 * sull'API: lì gli altri sono un rifiuto esplicito, e offrirli qui vorrebbe
 * dire mandare l'utente contro quel rifiuto.
 */
const OPERATORI_DI_RELAZIONE = ['equals', 'contains', 'is_empty', 'is_not_empty'] as const

// ── Fields to always skip ─────────────────────────────────────────────────────

const SKIP_FIELDS = new Set(['id', 'tenantId', '__typename'])

// ── Date field names that don't end with "At" ─────────────────────────────────

const DATE_FIELD_NAMES = new Set(['dueDate', 'scheduledStart', 'scheduledEnd', 'implementedAt'])

// ── Label: camelCase → "Camel Case" ──────────────────────────────────────────

function camelToLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim()
}

// ── Enum value label: "in_progress" → "In Progress" ──────────────────────────

function enumLabel(v: string): string {
  return v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useEntityFields(typeName: string): { fields: FieldConfig[]; error: Error | null } {
  const { data, error } = useQuery<{ entityFilterFields: EntityFilterField[] }>(
    GET_ENTITY_FILTER_FIELDS,
    { variables: { typeName }, fetchPolicy: METAMODEL_FETCH_POLICY },
  )
  // Giro nel browser del 14 set 2026 (#23): nello schema GraphQL severità,
  // priorità e stato di un ticket sono stringhe, quindi il filtro offriva
  // operatori di testo e un valore libero. Il metamodello sa quali campi hanno
  // un vocabolario: quelli diventano una scelta, con le etichette del Dizionario;
  // lo stato ha i passi del workflow del cliente.
  const entity = typeName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  const itil = isITILEntity(entity)
  const { fields: metas } = useEntityFieldMetas(itil ? entity : '', { withVirtual: false })
  const { labelOf } = useDomainVocabularies()
  const { steps } = useWorkflowSteps(itil ? entity : '')

  const rawFields = data?.entityFilterFields
  if (!rawFields) return { fields: [], error: error ?? null }

  const metaOf = (name: string) => metas.find((m) => m.name === name || m.name === name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
  const result: FieldConfig[] = []

  for (const f of rawFields) {
    if (SKIP_FIELDS.has(f.name)) continue

    const meta = metaOf(f.name)
    // L'ordine conta: l'etichetta del server (campi dei moduli, nella lingua
    // del tenant), poi quella del metamodello, e solo alla fine il nome
    // ripulito — che è un ripiego, non una traduzione.
    const label = f.label ?? meta?.label ?? camelToLabel(f.name)

    // GraphQL enum — values and labels come directly from the schema
    if (f.kind === 'ENUM') {
      result.push({
        key:     f.name,
        label,
        ...(f.rowFilter ? { operators: OPERATORI_DI_RELAZIONE } : {}),
        type:    f.multi ? 'multi_enum' : 'enum',
        // Le scelte con l'etichetta del Dizionario quando il server le manda;
        // altrimenti il valore ripulito, che è quello che si faceva prima.
        options: f.choices.length > 0
          ? f.choices
          : (f.enumValues ?? []).map((v) => ({ value: v, label: enumLabel(v) })),
      })
      continue
    }

    if (itil && f.name === 'status' && steps.length > 0) {
      result.push({ key: f.name, label, type: 'enum', options: steps.map((st) => ({ value: st.name, label: localizedLabel(st) })) })
      continue
    }
    if (meta && meta.enumValues.length > 0) {
      result.push({
        key: f.name, label, type: 'enum',
        options: meta.enumValues.map((v) => ({ value: v, label: (meta.enumTypeName && labelOf(meta.enumTypeName, v)) || v })),
      })
      continue
    }

    // Scalar
    const scalarName = f.scalarName ?? ''

    if (scalarName === 'Boolean' || scalarName === 'ID' || scalarName === 'Int' || scalarName === 'Float') continue

    if (f.name.endsWith('At') || DATE_FIELD_NAMES.has(f.name)) {
      result.push({ key: f.name, label, type: 'date' })
      continue
    }

    // Una lista senza vocabolario non ha scelte da offrire, ma resta una lista:
    // gli operatori di testo su di essa non troverebbero niente.
    result.push({
      key: f.name, label,
      ...(f.rowFilter ? { operators: OPERATORI_DI_RELAZIONE } : {}),
      type: f.multi ? 'multi_enum' : 'text',
    })
  }

  return { fields: result, error: error ?? null }
}
