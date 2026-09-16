/**
 * Campi filtrabili di un tipo GraphQL, calcolati lato server dallo schema
 * eseguibile (`info.schema`).
 *
 * Il FilterBuilder del web li otteneva con una query di introspezione
 * (`__type(name)`), che in produzione è disattivata: qui esponiamo la sola
 * informazione che serve (nome, kind, scalare, valori enum) senza riaprire
 * l'introspezione. Liste e oggetti (relazioni) sono esclusi: non sono
 * filtrabili come scalari. I tipi interni (`__*`) e i non-object sono
 * rifiutati con errore.
 */
import { GraphQLObjectType, getNamedType, isEnumType, isListType, isNonNullType, isScalarType, type GraphQLResolveInfo, type GraphQLOutputType } from 'graphql'
import { ValidationError } from '../../lib/errors.js'
import { FORM_FIELD_TYPES_MULTI, formTableColumnLabel, isFormTableType, type TicketCustomFieldEntityType } from '@opengraphity/types'
import type { GraphQLContext } from '../../context.js'
import { requestCustomFieldDefs } from './ticketCustomFields.js'
import { formFields, formTableFilterName } from '../../lib/catalogForm.js'
import { loadVocabularyEntries } from '../../lib/vocabularyEntries.js'
import { withSession } from './ci-utils.js'
import { labelFor } from '../../lib/enumValueLabels.js'
import { languageFor } from '../../lib/tenantLanguage.js'

export interface EntityFilterChoice { value: string; label: string }

export interface EntityFilterField {
  name:       string
  kind:       'SCALAR' | 'ENUM'
  scalarName: string | null
  enumValues: string[] | null
  /** L'etichetta del campo quando il server ne conosce una (campi dei moduli); altrimenti null. */
  label:      string | null
  /** Le scelte con l'etichetta del Dizionario; vuota per i campi senza vocabolario. */
  choices:    EntityFilterChoice[]
  /** Il tipo del campo se viene da un modulo del catalogo; null altrimenti (ondata 5). */
  formFieldType: string | null
  /** Il vocabolario del Dizionario del campo, per leggerne le etichette. */
  vocabulary: string | null
  /** Filtra le righe di una tabella: operatori di relazione (ondata 7). */
  rowFilter: boolean
  /** Il valore sul nodo è una lista (selezione multipla): serve un operatore di lista. */
  multi:      boolean
}

function classify(type: GraphQLOutputType): EntityFilterField | null {
  const inner = isNonNullType(type) ? type.ofType : type
  if (isListType(inner)) return null                       // liste = relazioni/array
  const named = getNamedType(inner)
  if (isScalarType(named)) return { name: '', kind: 'SCALAR', scalarName: named.name, enumValues: null, label: null, choices: [], formFieldType: null, vocabulary: null, rowFilter: false, multi: false }
  if (isEnumType(named))   return { name: '', kind: 'ENUM', scalarName: null, enumValues: named.getValues().map((v) => v.name), label: null, choices: [], formFieldType: null, vocabulary: null, rowFilter: false, multi: false }
  return null                                              // object/interface/union
}

export function entityFilterFieldsFromSchema(schema: GraphQLResolveInfo['schema'], typeName: string): EntityFilterField[] {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(typeName)) throw new ValidationError(`invalid typeName: "${typeName}"`, { key: 'errors.filter.invalidTypeName', params: { typeName } })
  const type = schema.getType(typeName)
  if (!type || !(type instanceof GraphQLObjectType)) throw new ValidationError(`Type "${typeName}" does not exist, or cannot be filtered`, { key: 'errors.filter.typeNotFilterable', params: { typeName } })
  const out: EntityFilterField[] = []
  for (const [name, field] of Object.entries(type.getFields())) {
    const c = classify(field.type)
    if (c) out.push({ ...c, name })
  }
  return out
}

/** I tipi GraphQL dei ticket che hanno campi del cliente (ondata 4). */
const CUSTOM_FIELD_TYPES: Readonly<Record<string, TicketCustomFieldEntityType>> = {
  Incident: 'incident', Problem: 'problem', Change: 'change', ServiceRequest: 'service_request',
}

export const entityFilterFieldsResolvers = {
  Query: {
    entityFilterFields: async (_: unknown, args: { typeName: string }, ctx: GraphQLContext, info: GraphQLResolveInfo) => {
      const fields = entityFilterFieldsFromSchema(info.schema, args.typeName)
      const entityType = CUSTOM_FIELD_TYPES[args.typeName]
      if (!entityType) return fields
      // I campi del cliente non sono nello schema (i tipi dei ticket sono di
      // base): si aggiungono dal metamodello, con i valori del loro vocabolario.
      const custom = (await requestCustomFieldDefs(ctx, entityType))
        .filter((d) => !fields.some((f) => f.name === d.name))
        .map((d): EntityFilterField => d.fieldType === 'enum'
          ? { name: d.name, kind: 'ENUM', scalarName: null, enumValues: d.enumValues, label: null, choices: [], formFieldType: null, vocabulary: null, rowFilter: false, multi: false }
          : { name: d.name, kind: 'SCALAR', scalarName: d.fieldType === 'number' ? 'Float' : d.fieldType === 'boolean' ? 'Boolean' : 'String', enumValues: null, label: null, choices: [], formFieldType: null, vocabulary: null, rowFilter: false, multi: false })
      /**
       * I campi della LIBRERIA dei moduli del catalogo (ondata 1): sono
       * proprieta dei ticket come gli altri, quindi vanno OFFERTI nel
       * selettore, non solo ammessi dal filtro. Solo per le richieste: sono i
       * moduli del catalogo a scriverli.
       */
      // La lingua: quella del tenant, con lo stesso ripiego del resto del
      // prodotto (`labelFor`). Il filtro non chiede una lingua perche' la
      // chiede la pagina, e la pagina è già nella lingua del tenant.
      const ripiego = await languageFor(ctx.tenantId)
      const lingua = ripiego
      const daModuli = entityType !== 'service_request' ? [] : await withSession(async (session) => {
        const libreria = await formFields(session, ctx.tenantId)
        return libreria
          // Fuori le note (nessuna risposta) e le TABELLE (ondata 7): una
          // tabella non è un valore, sono righe — si filtrerà per riga, con i
          // suoi operatori, non come se fosse un testo.
          .filter((d) => d.fieldType !== 'note' && !isFormTableType(d.fieldType))
          .filter((d) => !fields.some((f) => f.name === d.name) && !custom.some((f) => f.name === d.name))
          .map(async (d): Promise<EntityFilterField> => {
            // `multi`: la selezione multipla finisce sul nodo come lista, e un
            // «uguale a» su una lista non trova mai niente (ondata 4).
            const multi = FORM_FIELD_TYPES_MULTI.includes(d.fieldType)
            // Etichetta del campo e delle scelte: le stesse che si leggono
            // nella colonna e nel modulo. Senza, il filtro direbbe
            // «Ambienti_coinvolti / Production» dove tutto il resto del
            // prodotto dice «Ambienti coinvolti / Produzione».
            if (!d.vocabulary) {
              return { name: d.name, kind: 'SCALAR', scalarName: d.fieldType === 'number' ? 'Float' : d.fieldType === 'boolean' ? 'Boolean' : 'String', enumValues: null, label: d.label, choices: [], formFieldType: d.fieldType, vocabulary: null, rowFilter: false, multi }
            }
            const v = await loadVocabularyEntries(ctx.tenantId, d.vocabulary)
            return {
              name: d.name, kind: 'ENUM', scalarName: null, enumValues: v.values as string[], label: d.label,
              choices: (v.values as string[]).map((valore) => ({ value: valore, label: labelFor(valore, v.labels, lingua, ripiego) })),
              formFieldType: d.fieldType, vocabulary: d.vocabulary, rowFilter: false, multi,
            }
          })
      }).then((p) => Promise.all(p))
      /**
       * Le TABELLE si filtrano per RIGA (ondata 7): un campo virtuale per
       * colonna, `persone_da_abilitare__ruolo`, con l'etichetta che dice di che
       * tabella si tratta — «Persone da abilitare · Ruolo».
       *
       * `rowFilter: true` non è decorazione: dice al client che qui gli
       * operatori sono quelli che una relazione sa fare (uguale, contiene,
       * vuoto). Gli altri l'API li rifiuta, e offrirli sarebbe mandare chi
       * filtra contro un rifiuto.
       */
      const dalleTabelle = entityType !== 'service_request' ? [] : await withSession(async (session) => {
        const libreria = await formFields(session, ctx.tenantId)
        const promesse: Array<Promise<EntityFilterField>> = []
        for (const campo of libreria) {
          if (!isFormTableType(campo.fieldType) || !campo.tableDefinition) continue
          for (const colonna of campo.tableDefinition.columns) {
            promesse.push((async (): Promise<EntityFilterField> => {
              const nome = formTableFilterName(campo.name, colonna.name)
              const etichetta = `${campo.label} · ${formTableColumnLabel(colonna, lingua)}`
              if (!colonna.vocabulary) {
                return {
                  name: nome, kind: 'SCALAR', scalarName: 'String', enumValues: null, label: etichetta,
                  choices: [], formFieldType: colonna.fieldType, vocabulary: null, rowFilter: true, multi: false,
                }
              }
              const v = await loadVocabularyEntries(ctx.tenantId, colonna.vocabulary)
              return {
                name: nome, kind: 'ENUM', scalarName: null, enumValues: v.values as string[], label: etichetta,
                choices: (v.values as string[]).map((valore) => ({ value: valore, label: labelFor(valore, v.labels, lingua, ripiego) })),
                formFieldType: colonna.fieldType, vocabulary: colonna.vocabulary, rowFilter: true, multi: false,
              }
            })())
          }
        }
        return promesse
      }).then((p) => Promise.all(p))
      return [...fields, ...custom, ...daModuli, ...dalleTabelle]
    },
  },
}
