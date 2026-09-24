/**
 * I campi personalizzati dei ticket sull'API GraphQL (verifica «Cosa resta
 * cablato», ondata 4): il campo `customFields` dei quattro tipi di ticket e la
 * mutation che li scrive dal dettaglio. La logica sta in `lib/ticketCustomFields.ts`.
 */
import { isTicketCustomFieldEntityType, type TicketCustomFieldEntityType } from '@opengraphity/types'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { writeTicketCustomFields } from '../../services/ticketCustomFields.js'
import { ValidationError } from '../../lib/errors.js'
import {
  customFieldDefs, customFieldValues, loadTicketProps,
  type CustomFieldDef, type CustomFieldInput,
} from '../../lib/ticketCustomFields.js'
import { ticketPropsOf } from '../../lib/ticketProps.js'
import { LINGUE, labelFor, type Lingua } from '../../lib/enumValueLabels.js'
import { loadVocabularyEntries } from '../../lib/vocabularyEntries.js'
import { languageFor } from '../../lib/tenantLanguage.js'
import type { CustomFieldValue } from '../../lib/ticketCustomFields.js'
import { isPortalOnly } from '../../lib/permissions.js'
import { creationStepContext, parseStepEditability, parseStepVisibility, ticketStepContext, workflowStepsByDefinition, type StepEditability, type StepVisibility } from '../../lib/customFieldSteps.js'

const stepVisibilityView = (v: StepVisibility) => ({ mode: v.mode, steps: v.mode === 'steps' ? v.steps : [], step: v.mode === 'from' ? v.step : null })
const stepEditabilityView = (e: StepEditability) => ({ mode: e.mode, steps: e.mode === 'steps' ? e.steps : [] })

/** I campi del cliente, letti una volta per richiesta e per tipo (una lista di 50 ticket = una lettura). */
const defsByRequest = new WeakMap<object, Map<string, Promise<CustomFieldDef[]>>>()

export function requestCustomFieldDefs(ctx: GraphQLContext, entityType: TicketCustomFieldEntityType): Promise<CustomFieldDef[]> {
  let perType = defsByRequest.get(ctx)
  if (!perType) { perType = new Map(); defsByRequest.set(ctx, perType) }
  let defs = perType.get(entityType)
  if (!defs) {
    defs = withSession((session) => customFieldDefs(session, ctx.tenantId, entityType))
    perType.set(entityType, defs)
  }
  return defs
}

function customFieldsResolver(entityType: TicketCustomFieldEntityType) {
  return async (parent: { id: string }, _: unknown, ctx: GraphQLContext) => {
    const defs = await requestCustomFieldDefs(ctx, entityType)
    if (defs.length === 0) return []
    const props = ticketPropsOf(parent) ?? await withSession((session) => loadTicketProps(session, ctx.tenantId, entityType, parent.id)) ?? {}
    const stepContext = defs.some((d) => d.visibility.mode !== 'always' || d.editability.mode !== 'visible')
      ? await withSession((session) => ticketStepContext(session, ctx.tenantId, parent.id))
      : null
    return customFieldValues(defs, props, { onlyVisibleToEndUser: isPortalOnly(ctx), stepContext })
  }
}

/** The fields of the customer from the detail page (wave 7 · C1: the write is the service's, the REST API uses it too). */
function setTicketCustomFields(
  _: unknown,
  args: { entityType: string; id: string; values: CustomFieldInput[] },
  ctx: GraphQLContext,
) {
  return writeTicketCustomFields(args.entityType, args.id, args.values, ctx)
}

/** Le etichette di un vocabolario per richiesta: un form con dieci campi = una lettura per vocabolario. */
const labelsByRequest = new WeakMap<object, Map<string, Promise<Awaited<ReturnType<typeof loadVocabularyEntries>>>>>()

async function optionLabels(ctx: GraphQLContext, field: CustomFieldValue, language: string | null | undefined) {
  const tenantLanguage = await languageFor(ctx.tenantId)
  const lingua: Lingua = (LINGUE as readonly string[]).includes(language ?? '') ? language as Lingua : tenantLanguage
  if (!field.enumTypeName) return (value: string) => value
  let perName = labelsByRequest.get(ctx)
  if (!perName) { perName = new Map(); labelsByRequest.set(ctx, perName) }
  let entries = perName.get(field.enumTypeName)
  if (!entries) { entries = loadVocabularyEntries(ctx.tenantId, field.enumTypeName); perName.set(field.enumTypeName, entries) }
  const { labels } = await entries
  return (value: string) => labelFor(value, labels, lingua, tenantLanguage)
}

/**
 * Il modulo di apertura (secondo giro UI del 15 set 2026): i campi con visibile
 * e modificabile calcolati sulla fase iniziale del workflow che il motore
 * sceglierà per tipo E categoria. Prima web e portale leggevano il workflow
 * generico e l'API quello della categoria: con due workflow diversi il modulo
 * poteva offrire un campo che l'API rifiutava.
 */
async function ticketCreationCustomFields(_: unknown, args: { entityType: string; category?: string | null }, ctx: GraphQLContext) {
  if (!isTicketCustomFieldEntityType(args.entityType)) {
    throw new ValidationError(`"${args.entityType}" has no custom fields.`, { key: 'errors.customField.entityType', params: { entityType: args.entityType } })
  }
  const entityType = args.entityType
  return withSession(async (session) => customFieldValues(await customFieldDefs(session, ctx.tenantId, entityType), {}, {
    stepContext: await creationStepContext(session, ctx.tenantId, entityType, args.category ?? null),
  }))
}

/** Le fasi di tutti i workflow attivi del tipo, per il disegnatore dei campi (etichette con le traduzioni spedite). */
async function ticketWorkflowSteps(_: unknown, args: { entityType: string }, ctx: GraphQLContext) {
  const groups = await withSession((session) => workflowStepsByDefinition(session, ctx.tenantId, args.entityType))
  return groups.map((g) => ({
    workflow: g.workflow, category: g.category,
    steps: g.steps.map((s) => ({
      name: s.name, label: s.label,
      labels: s.labels ? Object.entries(JSON.parse(s.labels) as Record<string, string>).map(([language, label]) => ({ language, label })) : [],
    })),
  }))
}

export const ticketCustomFieldResolvers = {
  Query:    { ticketCreationCustomFields, ticketWorkflowSteps },
  Mutation: { setTicketCustomFields },
  Incident:       { customFields: customFieldsResolver('incident') },
  Problem:        { customFields: customFieldsResolver('problem') },
  Change:         { customFields: customFieldsResolver('change') },
  ServiceRequest: { customFields: customFieldsResolver('service_request') },
  CustomFieldValue: {
    options: async (f: CustomFieldValue, args: { language?: string | null }, ctx: GraphQLContext) => {
      const label = await optionLabels(ctx, f, args.language)
      return f.enumValues.map((value) => ({ value, label: label(value) }))
    },
    valueLabel: async (f: CustomFieldValue, args: { language?: string | null }, ctx: GraphQLContext) => {
      if (f.value == null) return null
      if (f.fieldType === 'enum') return (await optionLabels(ctx, f, args.language))(f.value)
      return f.value
    },
  },
  // I campi dei CI non hanno l'opzione del portale: sempre no.
  CIFieldDef:     {
    visibleToEndUser: (f: { visibleToEndUser?: boolean }) => f.visibleToEndUser === true,
    // I campi dei CI non hanno fasi: sempre visibili e modificabili.
    stepVisibility:  (f: { name?: string; stepVisibilityRaw?: string | null }) => stepVisibilityView(parseStepVisibility(f.stepVisibilityRaw, `field ${f.name ?? ''}`)),
    stepEditability: (f: { name?: string; stepEditabilityRaw?: string | null }) => stepEditabilityView(parseStepEditability(f.stepEditabilityRaw, `field ${f.name ?? ''}`)),
  },
}
