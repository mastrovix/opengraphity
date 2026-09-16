/**
 * I moduli del catalogo servizi (ondata 1): la libreria dei campi e il modulo
 * di una voce. Il contratto, la validazione e il perché delle scelte stanno in
 * `lib/catalogForm.ts`.
 *
 * Permessi (lib/operationPermissions.ts): creare o cambiare un campo della
 * LIBRERIA è `config.metamodel`, perché un campo è una proprietà dei ticket;
 * comporre un modulo è `config.catalog`; leggere il modulo da compilare basta
 * `request.read` o `portal.read`, perché lo legge chi apre una richiesta.
 */
import { randomUUID } from 'crypto'
import { GraphQLError } from 'graphql'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import {
  CATALOG_FORM_VERSION, FORM_FIELD_TYPES, FORM_FIELD_TYPES_WITH_VOCABULARY,
  catalogFormFieldNames, emptyCatalogForm, isFormFieldType, serializeLocalizedLabels,
  type CatalogFormDefinition,
} from '@opengraphity/types'
import type { GraphQLContext } from '../../context.js'
import { ValidationError } from '../../lib/errors.js'
import { loadVocabularyEntries } from '../../lib/vocabularyEntries.js'
import {
  assertCatalogForm, assertFormFieldName, formAnswersOf, formFields, formFieldsByName, parseCatalogForm,
  saveCatalogFormRevision, type FormAnswerRead, type FormFieldDef,
} from '../../lib/catalogForm.js'

interface TestoPerLingua { language: string; text: string }

/** `[{language, text}]` → `{ it: '…' }` per il JSON su nodo, come le etichette dei vocabolari. */
function mappaTesti(list: readonly TestoPerLingua[] | null | undefined): Record<string, string> | undefined {
  if (list == null) return undefined
  const out: Record<string, string> = {}
  for (const t of list) {
    if (typeof t.language !== 'string' || t.language.trim() === '') {
      throw new ValidationError('A translation needs a language.', { key: 'errors.formField.labelLanguage', params: {} })
    }
    if (typeof t.text === 'string' && t.text.trim() !== '') out[t.language] = t.text
  }
  return out
}

/** Le voci di catalogo che citano un campo: si sa PRIMA di cancellarlo. */
async function usoDeiCampi(tenantId: string): Promise<Map<string, string[]>> {
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ name: string; form: string | null }>(session, `
      MATCH (i:ServiceCatalogItem {tenant_id: $tenantId})
      WHERE i.form IS NOT NULL
      RETURN i.name AS name, i.form AS form`, { tenantId })
    const uso = new Map<string, string[]>()
    for (const r of rows) {
      const def = parseCatalogForm(r.form, `ServiceCatalogItem ${r.name}`)
      if (!def) continue
      for (const campo of catalogFormFieldNames(def)) {
        const elenco = uso.get(campo) ?? []
        if (!elenco.includes(r.name)) elenco.push(r.name)
        uso.set(campo, elenco)
      }
    }
    return uso
  } finally { await session.close() }
}

function vistaCampo(d: FormFieldDef, usedBy: readonly string[]): Record<string, unknown> {
  return { ...d, usedBy: [...usedBy] }
}

/** Il vocabolario deve esistere per i tipi che pescano le scelte da lì, e solo per quelli. */
async function assertVocabolario(tenantId: string, fieldType: string, vocabulary: string | null | undefined): Promise<string | null> {
  const serve = FORM_FIELD_TYPES_WITH_VOCABULARY.includes(fieldType as never)
  const nome = vocabulary == null || vocabulary.trim() === '' ? null : vocabulary.trim()
  if (!serve) {
    if (nome) {
      throw new ValidationError(`A ${fieldType} field takes no vocabulary: only enum and multi_enum choose from the Dictionary.`,
        { key: 'errors.formField.vocabularyNotAllowed', params: { fieldType } })
    }
    return null
  }
  if (!nome) {
    throw new ValidationError(`A ${fieldType} field needs a vocabulary from the Dictionary: without one it would offer no choices.`,
      { key: 'errors.formField.vocabularyRequired', params: { fieldType } })
  }
  // Fail-loud subito: un vocabolario inesistente darebbe un campo vuoto a chi compila.
  await loadVocabularyEntries(tenantId, nome)
  return nome
}

async function campoPerId(tenantId: string, id: string): Promise<FormFieldDef> {
  const session = getSession(undefined, 'READ')
  try {
    const tutti = await formFields(session, tenantId)
    const trovato = tutti.find((f) => f.id === id)
    if (!trovato) throw new GraphQLError(`Form field ${id} not found`, { extensions: { code: 'NOT_FOUND' } })
    return trovato
  } finally { await session.close() }
}

async function vocePerId(tenantId: string, itemId: string): Promise<{ id: string; name: string; form: string | null; updatedAt: string | null }> {
  const session = getSession(undefined, 'READ')
  try {
    const row = await runQueryOne<{ id: string; name: string; form: string | null; updatedAt: string | null }>(session, `
      MATCH (i:ServiceCatalogItem {id: $itemId, tenant_id: $tenantId})
      RETURN i.id AS id, i.name AS name, i.form AS form, i.form_updated_at AS updatedAt`, { itemId, tenantId })
    if (!row) throw new GraphQLError(`Service catalog item ${itemId} not found`, { extensions: { code: 'NOT_FOUND' } })
    return row
  } finally { await session.close() }
}

export const catalogFormResolvers = {
  Query: {
    formFields: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const session = getSession(undefined, 'READ')
      try {
        const [defs, uso] = await Promise.all([formFields(session, ctx.tenantId), usoDeiCampi(ctx.tenantId)])
        return defs.map((d) => vistaCampo(d, uso.get(d.name) ?? []))
      } finally { await session.close() }
    },

    catalogForm: async (_: unknown, args: { itemId: string }, ctx: GraphQLContext) => {
      const voce = await vocePerId(ctx.tenantId, args.itemId)
      const def = parseCatalogForm(voce.form, `ServiceCatalogItem ${voce.name}`) ?? emptyCatalogForm()
      return {
        itemId: voce.id, itemName: voce.name, revision: def.revision,
        definition: JSON.stringify(def), updatedAt: voce.updatedAt,
      }
    },

    /**
     * Il modulo pronto da compilare. `null` quando la voce non ha un modulo
     * pubblicato: il chiamante allora mostra la richiesta generica di sempre,
     * senza modulo — non una pagina vuota.
     */
    catalogFormToFill: async (_: unknown, args: { itemId: string; endUser?: boolean }, ctx: GraphQLContext) => {
      const voce = await vocePerId(ctx.tenantId, args.itemId)
      const def = parseCatalogForm(voce.form, `ServiceCatalogItem ${voce.name}`)
      if (!def || def.revision === 0 || def.sections.every((s) => s.items.length === 0)) return null
      const session = getSession(undefined, 'READ')
      try {
        const nomi = catalogFormFieldNames(def)
        const library = await formFieldsByName(session, ctx.tenantId, nomi)
        // I campi citati e non più in libreria: il modulo è stato salvato e poi
        // il campo cancellato. Non si finge: si dice quale manca.
        const mancanti = nomi.filter((n) => !library.has(n))
        if (mancanti.length > 0) {
          throw new GraphQLError(
            `The form of "${voce.name}" uses fields that no longer exist in the library: ${mancanti.join(', ')}. Open the form builder and fix it.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          )
        }
        return {
          itemId: voce.id, revision: def.revision, definition: JSON.stringify(def),
          fields: nomi.map((n) => vistaCampo(library.get(n)!, [])),
        }
      } finally { await session.close() }
    },
  },

  Mutation: {
    createFormField: async (_: unknown, args: { input: Record<string, unknown> }, ctx: GraphQLContext) => {
      const input = args.input
      const name = String(input['name'] ?? '').trim()
      const fieldType = String(input['fieldType'] ?? '')
      if (!isFormFieldType(fieldType)) {
        throw new ValidationError(`"${fieldType}" is not a field type (known: ${FORM_FIELD_TYPES.join(', ')}).`,
          { key: 'errors.formField.type', params: { fieldType, allowed: FORM_FIELD_TYPES.join(', ') } })
      }
      const label = String(input['label'] ?? '').trim()
      if (label === '') throw new ValidationError('A field needs a label.', { key: 'errors.formField.labelRequired', params: {} })

      const write = getSession(undefined, 'WRITE')
      try {
        await assertFormFieldName(write, ctx.tenantId, name)
        const vocabulary = await assertVocabolario(ctx.tenantId, fieldType, input['vocabulary'] as string | null)
        const esiste = await runQueryOne<{ n: number }>(write, `
          MATCH (f:FormField {tenant_id: $tenantId, name: $name}) RETURN count(f) AS n`, { tenantId: ctx.tenantId, name })
        if (Number(esiste?.n ?? 0) > 0) {
          throw new ValidationError(`A field called "${name}" is already in the library.`,
            { key: 'errors.formField.nameTakenInLibrary', params: { name } })
        }
        const now = new Date().toISOString()
        await runQuery(write, `
          CREATE (f:FormField {
            id: $id, tenant_id: $tenantId, name: $name, field_type: $fieldType,
            label: $label, labels: $labels, help: $help, helps: $helps,
            required: $required, vocabulary: $vocabulary, validation_script: $validationScript,
            created_at: $now, updated_at: $now
          })`, {
          id: randomUUID(), tenantId: ctx.tenantId, name, fieldType, label,
          labels: serializeLocalizedLabels(mappaTesti(input['labels'] as TestoPerLingua[] | null)),
          help: (input['help'] as string | null) ?? null,
          helps: serializeLocalizedLabels(mappaTesti(input['helps'] as TestoPerLingua[] | null)),
          required: input['required'] === true,
          vocabulary,
          validationScript: (input['validationScript'] as string | null) ?? null,
          now,
        })
        const creato = (await formFields(write, ctx.tenantId)).find((f) => f.name === name)!
        return vistaCampo(creato, [])
      } finally { await write.close() }
    },

    /**
     * Nome e tipo NON si cambiano, come per i campi personalizzati dei ticket:
     * il nome è la proprietà sul ticket, quindi rinominarlo perderebbe tutte le
     * risposte già raccolte, e cambiare tipo le renderebbe illeggibili.
     */
    updateFormField: async (_: unknown, args: { id: string; input: Record<string, unknown> }, ctx: GraphQLContext) => {
      const corrente = await campoPerId(ctx.tenantId, args.id)
      const input = args.input
      const vocabulary = 'vocabulary' in input
        ? await assertVocabolario(ctx.tenantId, corrente.fieldType, input['vocabulary'] as string | null)
        : corrente.vocabulary
      if (input['label'] != null && String(input['label']).trim() === '') {
        throw new ValidationError('A field needs a label.', { key: 'errors.formField.labelRequired', params: {} })
      }
      const write = getSession(undefined, 'WRITE')
      try {
        await runQuery(write, `
          MATCH (f:FormField {id: $id, tenant_id: $tenantId})
          SET f.label = coalesce($label, f.label),
              f.labels = CASE WHEN $labelsSet THEN $labels ELSE f.labels END,
              f.help = CASE WHEN $helpSet THEN $help ELSE f.help END,
              f.helps = CASE WHEN $helpsSet THEN $helps ELSE f.helps END,
              f.required = CASE WHEN $requiredSet THEN $required ELSE f.required END,
              f.vocabulary = $vocabulary,
              f.validation_script = CASE WHEN $scriptSet THEN $validationScript ELSE f.validation_script END,
              f.updated_at = $now`, {
          id: args.id, tenantId: ctx.tenantId,
          label: input['label'] == null ? null : String(input['label']).trim(),
          labelsSet: 'labels' in input, labels: serializeLocalizedLabels(mappaTesti(input['labels'] as TestoPerLingua[] | null)),
          helpSet: 'help' in input, help: (input['help'] as string | null) ?? null,
          helpsSet: 'helps' in input, helps: serializeLocalizedLabels(mappaTesti(input['helps'] as TestoPerLingua[] | null)),
          requiredSet: 'required' in input, required: input['required'] === true,
          vocabulary,
          scriptSet: 'validationScript' in input, validationScript: (input['validationScript'] as string | null) ?? null,
          now: new Date().toISOString(),
        })
        const aggiornato = await campoPerId(ctx.tenantId, args.id)
        const uso = await usoDeiCampi(ctx.tenantId)
        return vistaCampo(aggiornato, uso.get(aggiornato.name) ?? [])
      } finally { await write.close() }
    },

    /**
     * Si cancella solo un campo che NESSUN modulo usa: altrimenti il modulo
     * resterebbe con un riferimento morto e chi apre una richiesta troverebbe
     * un errore. Il rifiuto elenca i moduli, così si sa dove andare.
     *
     * Le risposte già raccolte sui ticket NON vengono toccate: restano leggibili
     * come dato storico. È la differenza con `deleteITILField`, che oggi esegue
     * REMOVE della proprietà su tutti i ticket esistenti e perde la storia.
     */
    deleteFormField: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const campo = await campoPerId(ctx.tenantId, args.id)
      const uso = (await usoDeiCampi(ctx.tenantId)).get(campo.name) ?? []
      if (uso.length > 0) {
        throw new ValidationError(
          `The field "${campo.label}" is used by the form of: ${uso.join(', ')}. Remove it from those forms first.`,
          { key: 'errors.formField.inUse', params: { field: campo.label, forms: uso.join(', ') } },
        )
      }
      const write = getSession(undefined, 'WRITE')
      try {
        await runQuery(write, `MATCH (f:FormField {id: $id, tenant_id: $tenantId}) DETACH DELETE f`,
          { id: args.id, tenantId: ctx.tenantId })
        return true
      } finally { await write.close() }
    },

    /**
     * Salva E pubblica: la `revision` sale di uno. Nessuna bozza nell'ondata 1
     * (il costruttore ha l'anteprima); i ticket già compilati portano la loro
     * revisione e non cambiano.
     */
    saveCatalogForm: async (_: unknown, args: { itemId: string; definition: string }, ctx: GraphQLContext) => {
      const voce = await vocePerId(ctx.tenantId, args.itemId)
      const precedente = parseCatalogForm(voce.form, `ServiceCatalogItem ${voce.name}`)
      const inviata = parseCatalogForm(args.definition, 'definition')
      if (!inviata) throw new ValidationError('The form definition is empty.', { key: 'errors.catalogForm.empty', params: {} })

      const session = getSession(undefined, 'WRITE')
      try {
        const library = await formFieldsByName(session, ctx.tenantId, catalogFormFieldNames(inviata))
        assertCatalogForm(inviata, library)

        const salvata: CatalogFormDefinition = {
          version: CATALOG_FORM_VERSION,
          revision: (precedente?.revision ?? 0) + 1,
          sections: inviata.sections,
        }
        const now = new Date().toISOString()
        await runQuery(session, `
          MATCH (i:ServiceCatalogItem {id: $itemId, tenant_id: $tenantId})
          SET i.form = $form, i.form_updated_at = $now, i.updated_at = $now`,
        { itemId: args.itemId, tenantId: ctx.tenantId, form: JSON.stringify(salvata), now })
        // La copia immutabile: e cio che rende leggibile domani un ticket compilato oggi.
        await saveCatalogFormRevision(session, ctx.tenantId, args.itemId, salvata, now, ctx.userId ?? null)
        return {
          itemId: voce.id, itemName: voce.name, revision: salvata.revision,
          definition: JSON.stringify(salvata), updatedAt: now,
        }
      } finally { await session.close() }
    },
  },
}

/**
 * `ServiceRequest.formAnswers`: le risposte del modulo, nell'ordine del modulo
 * con cui la richiesta e stata compilata. Registrato in resolvers/service_request.ts
 * accanto agli altri campi del tipo.
 */
export async function serviceRequestFormAnswers(
  parent: { id: string; catalogItemId?: string | null; formRevision?: number | null },
  _args: unknown, ctx: GraphQLContext,
): Promise<FormAnswerRead[]> {
  if (!parent.catalogItemId || !parent.formRevision) return []
  const session = getSession(undefined, 'READ')
  try {
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
      RETURN properties(r) AS props`, { id: parent.id, tenantId: ctx.tenantId })
    if (!row) return []
    return await formAnswersOf(session, ctx.tenantId, {
      id: parent.id, catalogItemId: parent.catalogItemId, formRevision: parent.formRevision, props: row.props,
    })
  } finally { await session.close() }
}

/**
 * `FormField.options`: le scelte di un campo a vocabolario, con l'etichetta
 * nella lingua chiesta. Risolte dall'API e non dal client perche' le rende sia
 * il web sia il portale, e il portale non ha accesso al Dizionario.
 *
 * Il ripiego e' quello del resto del prodotto (enumValueLabels.labelFor):
 * lingua chiesta, poi lingua del tenant, poi il valore con l'iniziale grande —
 * mostrare il nome interno e' sempre meglio che mostrare niente.
 */
export const formFieldOptions = async (
  parent: { fieldType: string; vocabulary: string | null },
  args: { language?: string | null }, ctx: GraphQLContext,
): Promise<Array<{ value: string; label: string }>> => {
  if (!parent.vocabulary) return []
  const { labelFor } = await import('../../lib/enumValueLabels.js')
  const { isLingua, languageFor } = await import('../../lib/tenantLanguage.js')
  const ripiego = await languageFor(ctx.tenantId)
  const lingua = isLingua(args.language) ? args.language : ripiego
  const v = await loadVocabularyEntries(ctx.tenantId, parent.vocabulary)
  return v.values.map((valore) => ({ value: valore, label: labelFor(valore, v.labels, lingua, ripiego) }))
}
