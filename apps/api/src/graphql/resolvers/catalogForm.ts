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
  canBeComputed, CATALOG_FORM_VERSION, formTableColumnLabel, FORM_FIELD_TYPES, FORM_FIELD_TYPES_AS_PROPERTY, isFormTableType,
  FORM_FIELD_TYPES_WITHOUT_ANSWER, FORM_FIELD_TYPES_WITH_VOCABULARY,
  catalogFormFieldNames, emptyCatalogForm, isFormFieldType, serializeLocalizedLabels,
  type CatalogFormDefinition,
} from '@opengraphity/types'
import type { GraphQLContext } from '../../context.js'
import { ValidationError } from '../../lib/errors.js'
import { loadVocabularyEntries } from '../../lib/vocabularyEntries.js'
import { assertFormSize, assertLibraryRoom, assertLimitValue, CATALOG_FORM_LIMIT_MAX, CATALOG_FORM_LIMIT_MIN, catalogFormLimits as leggiTetti } from '../../lib/catalogFormLimits.js'
import { assertFormTable, etichetteDeiValori, parseFormTable } from '../../lib/catalogForm.js'
import { labelFor, type EnumValueLabels } from '../../lib/enumValueLabels.js'
import { languageFor } from '../../lib/tenantLanguage.js'
import { invalidateSchema } from '../../lib/schemaInvalidator.js'
import {
  assertCatalogForm, assertFormFieldName, formAnswersOf, formFields, formFieldsByName, formFieldsCache,
  parseCatalogForm, saveCatalogFormRevision, type FormAnswerRead, type FormFieldDef,
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
  return {
    ...d,
    usedBy: [...usedBy],
    // Le colonne viaggiano come JSON (come il documento del modulo): nel campo
    // sono un oggetto, nello schema una stringa.
    tableDefinition: d.tableDefinition ? JSON.stringify(d.tableDefinition) : null,
  }
}

/**
 * Le COLONNE si mettono solo su un campo TABELLA (ondata 7), e devono stare in
 * piedi: almeno una colonna, nomi senza doppioni, una scelta con il suo
 * vocabolario. Una tabella SENZA colonne non si salva — sarebbe un campo che
 * non chiede niente, e chi compila vedrebbe una tabella vuota senza capire.
 */
function assertTabella(fieldType: string, raw: unknown, dove: string): string | null {
  const testo = raw == null || String(raw).trim() === '' ? null : String(raw)
  if (!isFormTableType(fieldType)) {
    if (testo) {
      throw new ValidationError(`A ${fieldType} field takes no table columns: only a table field does.`,
        { key: 'errors.formTable.notATable', params: { fieldType } })
    }
    return null
  }
  if (!testo) {
    throw new ValidationError(`The table "${dove}" has no columns: add at least one.`,
      { key: 'errors.formTable.noColumns', params: { field: dove } })
  }
  const def = parseFormTable(testo, `FormField ${dove} (table)`)!
  assertFormTable(def, dove)
  // Si riscrive dal documento letto, non dal testo arrivato: così nel grafo
  // finisce la forma che questa versione capisce, senza chiavi di troppo.
  return JSON.stringify(def)
}

/**
 * La FORMULA si può mettere solo su un campo che può essere calcolato (ondata
 * 6): un valore singolo che diventa una proprietà. Rifiutare invece di
 * ignorare — una formula salvata su una nota o su un allegato resterebbe lì a
 * non fare niente, e chi l'ha scritta crederebbe il contrario.
 */
function assertFormulaPossibile(fieldType: string, formula: unknown): string | null {
  const testo = formula == null || String(formula).trim() === '' ? null : String(formula)
  if (testo && !canBeComputed(fieldType)) {
    throw new ValidationError(`A ${fieldType} field cannot be computed: only single-value fields stored as a ticket property can have a formula.`,
      { key: 'errors.formField.notComputable', params: { fieldType } })
  }
  return testo
}

/**
 * Colonna nelle liste: solo i campi che diventano una PROPRIETÀ del ticket
 * (ondata 4). Una nota non ha risposta, un allegato è un file e un riferimento
 * è una relazione: nessuno dei tre è un valore che una cella possa mostrare, e
 * `formFieldValues` non li restituisce affatto. Rifiutare qui invece di
 * ignorare, perché una spunta che resta accesa senza effetto è una bugia.
 */
function assertColonnaPossibile(fieldType: string, inList: boolean): boolean {
  if (inList && !FORM_FIELD_TYPES_AS_PROPERTY.includes(fieldType as never)) {
    throw new ValidationError(`A ${fieldType} field cannot be a list column: only fields stored as a ticket property can.`,
      { key: 'errors.formField.notAColumn', params: { fieldType } })
  }
  return inList
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

    catalogFormLimits: async (_: unknown, _args: unknown, ctx: GraphQLContext) => {
      const session = getSession(undefined, 'READ')
      try {
        const tetti = await leggiTetti(session, ctx.tenantId)
        const row = await runQueryOne<{ n: unknown }>(session, `
          MATCH (f:FormField {tenant_id: $tenantId}) RETURN count(f) AS n`, { tenantId: ctx.tenantId })
        return { ...tetti, libraryFieldsUsed: Number(row?.n ?? 0), min: CATALOG_FORM_LIMIT_MIN, max: CATALOG_FORM_LIMIT_MAX }
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
        // Il tetto PRIMA di tutto: inutile validare un campo che non ci sta.
        await assertLibraryRoom(write, ctx.tenantId)
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
            in_list: $inList, formula: $formula, table_definition: $tableDefinition,
            created_at: $now, updated_at: $now
          })`, {
          id: randomUUID(), tenantId: ctx.tenantId, name, fieldType, label,
          labels: serializeLocalizedLabels(mappaTesti(input['labels'] as TestoPerLingua[] | null)),
          help: (input['help'] as string | null) ?? null,
          helps: serializeLocalizedLabels(mappaTesti(input['helps'] as TestoPerLingua[] | null)),
          required: input['required'] === true,
          vocabulary,
          validationScript: (input['validationScript'] as string | null) ?? null,
          inList: assertColonnaPossibile(fieldType, input['inList'] === true),
          formula: assertFormulaPossibile(fieldType, input['formula']),
          tableDefinition: assertTabella(fieldType, input['tableDefinition'], label || name),
          now,
        })
        // La leva del metamodello: la cache della libreria (che serve alle
        // colonne delle liste) deve dimenticare subito, in ogni processo.
        invalidateSchema(ctx.tenantId)
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
              f.in_list = CASE WHEN $inListSet THEN $inList ELSE f.in_list END,
              f.formula = CASE WHEN $formulaSet THEN $formula ELSE f.formula END,
              f.table_definition = CASE WHEN $tableSet THEN $tableDefinition ELSE f.table_definition END,
              f.updated_at = $now`, {
          id: args.id, tenantId: ctx.tenantId,
          label: input['label'] == null ? null : String(input['label']).trim(),
          labelsSet: 'labels' in input, labels: serializeLocalizedLabels(mappaTesti(input['labels'] as TestoPerLingua[] | null)),
          helpSet: 'help' in input, help: (input['help'] as string | null) ?? null,
          helpsSet: 'helps' in input, helps: serializeLocalizedLabels(mappaTesti(input['helps'] as TestoPerLingua[] | null)),
          requiredSet: 'required' in input, required: input['required'] === true,
          vocabulary,
          scriptSet: 'validationScript' in input, validationScript: (input['validationScript'] as string | null) ?? null,
          // Il tipo non si cambia, quindi la guardia guarda quello che il campo È già.
          inListSet: 'inList' in input, inList: assertColonnaPossibile(corrente.fieldType, input['inList'] === true),
          formulaSet: 'formula' in input, formula: assertFormulaPossibile(corrente.fieldType, input['formula']),
          // Le colonne si cambiano solo se arrivano: un aggiornamento che non le
          // manda non le cancella (una tabella senza colonne non è salvabile).
          tableSet: 'tableDefinition' in input,
          tableDefinition: 'tableDefinition' in input
            ? assertTabella(corrente.fieldType, input['tableDefinition'], corrente.label)
            : null,
          now: new Date().toISOString(),
        })
        invalidateSchema(ctx.tenantId)
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
        invalidateSchema(ctx.tenantId)
        return true
      } finally { await write.close() }
    },

    /**
     * Salva E pubblica: la `revision` sale di uno. Nessuna bozza nell'ondata 1
     * (il costruttore ha l'anteprima); i ticket già compilati portano la loro
     * revisione e non cambiano.
     */
    /**
     * Il tetto lo cambia l'amministratore, non il piano (ondata 4). Non tocca
     * nulla di gia scritto: una libreria gia oltre il nuovo tetto resta dov'e,
     * semplicemente non cresce piu. Cancellare campi per far tornare i conti
     * sarebbe perdere dati per rispettare un numero.
     */
    setCatalogFormLimits: async (_: unknown, args: { maxLibraryFields: number; maxFieldsPerForm: number }, ctx: GraphQLContext) => {
      const maxLibraryFields = assertLimitValue('The library limit', args.maxLibraryFields)
      const maxFieldsPerForm = assertLimitValue('The per-form limit', args.maxFieldsPerForm)
      const write = getSession(undefined, 'WRITE')
      try {
        const row = await runQueryOne<{ n: unknown }>(write, `
          MATCH (t:Tenant {id: $tenantId})
          SET t.max_form_fields = toInteger($maxLibraryFields),
              t.max_form_fields_per_form = toInteger($maxFieldsPerForm)
          WITH t
          OPTIONAL MATCH (f:FormField {tenant_id: $tenantId})
          RETURN count(f) AS n`, { tenantId: ctx.tenantId, maxLibraryFields, maxFieldsPerForm })
        if (!row) throw new Error(`Tenant ${ctx.tenantId} has no :Tenant node: fix the tenant before changing the catalog form limits`)
        return { maxLibraryFields, maxFieldsPerForm, libraryFieldsUsed: Number(row.n ?? 0), min: CATALOG_FORM_LIMIT_MIN, max: CATALOG_FORM_LIMIT_MAX }
      } finally { await write.close() }
    },

    saveCatalogForm: async (_: unknown, args: { itemId: string; definition: string }, ctx: GraphQLContext) => {
      const voce = await vocePerId(ctx.tenantId, args.itemId)
      const precedente = parseCatalogForm(voce.form, `ServiceCatalogItem ${voce.name}`)
      const inviata = parseCatalogForm(args.definition, 'definition')
      if (!inviata) throw new ValidationError('The form definition is empty.', { key: 'errors.catalogForm.empty', params: {} })

      const session = getSession(undefined, 'WRITE')
      try {
        const nomi = catalogFormFieldNames(inviata)
        await assertFormSize(session, ctx.tenantId, nomi.length)
        const library = await formFieldsByName(session, ctx.tenantId, nomi)
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
/**
 * Le risposte nella forma dello schema. Le RIGHE di una tabella (ondata 7)
 * diventano celle in ORDINE DI COLONNA: nel grafo una riga è una mappa, e una
 * mappa non ha ordine — l'ordine è quello che l'amministratore ha dato alle
 * colonne, e va rimesso qui o la tabella si legge a caso.
 */
function vistaRisposta(
  a: FormAnswerRead,
  etichette: (colonna: string, valore: string) => string,
): Record<string, unknown> {
  return {
    ...a,
    rows: a.rows.map((riga) => ({
      cells: a.tableColumns.map((c) => {
        const valore = riga[c.name] ?? null
        return { column: c.name, value: valore, displayValue: valore == null ? null : etichette(c.name, valore) }
      }),
    })),
    tableColumns: a.tableColumns.map((c) => ({
      name: c.name,
      label: formTableColumnLabel(c, null),
      fieldType: c.fieldType,
    })),
  }
}

export async function serviceRequestFormAnswers(
  parent: { id: string; catalogItemId?: string | null; formRevision?: number | null },
  _args: unknown, ctx: GraphQLContext,
): Promise<Array<Record<string, unknown>>> {
  if (!parent.catalogItemId || !parent.formRevision) return []
  const session = getSession(undefined, 'READ')
  try {
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
      RETURN properties(r) AS props`, { id: parent.id, tenantId: ctx.tenantId })
    if (!row) return []
    const risposte = await formAnswersOf(session, ctx.tenantId, {
      id: parent.id, catalogItemId: parent.catalogItemId, formRevision: parent.formRevision, props: row.props,
    })
    /**
     * Le etichette dei valori delle celle: i vocabolari delle colonne, letti
     * una volta ciascuno. Una colonna a scelta deve leggersi «Amministratore»
     * come ovunque, non `admin`.
     */
    const vocabolariColonne = new Map<string, EnumValueLabels>()
    const lingua = await languageFor(ctx.tenantId)
    for (const a of risposte) {
      for (const c of a.tableColumns) {
        if (!c.vocabulary || vocabolariColonne.has(`${a.name}.${c.name}`)) continue
        vocabolariColonne.set(`${a.name}.${c.name}`, (await loadVocabularyEntries(ctx.tenantId, c.vocabulary)).labels)
      }
    }
    return risposte.map((a) => vistaRisposta(a, (colonna, valore) => {
      const etichette = vocabolariColonne.get(`${a.name}.${colonna}`)
      return etichette && etichette[valore] ? labelFor(valore, etichette, lingua, lingua) : valore
    }))
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

/**
 * `ServiceRequest.formFieldValues` (ondata 4): i valori dei campi della
 * libreria presenti su QUESTO ticket.
 *
 * Perché non riusa `formAnswers`: quello ricostruisce il modulo della revisione
 * con cui il ticket è stato compilato — le domande come sono state fatte — e
 * per una colonna di lista è troppo (una lettura della revisione per riga) e
 * troppo poco (un ticket senza modulo non avrebbe colonne, anche se un campo
 * della libreria ha un valore, per esempio da un import).
 *
 * La libreria si legge dalla CACHE del metamodello: una volta per pagina invece
 * di una per riga. Le mutation della libreria tirano la leva, quindi un campo
 * nuovo compare subito.
 */
export async function serviceRequestFormFieldValues(
  parent: { id: string },
  _args: unknown, ctx: GraphQLContext,
): Promise<Array<{ name: string; label: string; fieldType: string; value: string | null; values: string[]; displayValue: string | null; displayValues: string[]; references: never[]; files: never[]; rows: never[]; tableColumns: never[] }>> {
  const libreria = await formFieldsCache.get(ctx.tenantId)
  // Solo i campi che l'amministratore ha messo nelle liste: senza questo filtro
  // il ticket porterebbe TUTTA la libreria a ogni riga della lista.
  const conRisposta = libreria.filter((f) => f.inList
    && !FORM_FIELD_TYPES_WITHOUT_ANSWER.includes(f.fieldType) && FORM_FIELD_TYPES_AS_PROPERTY.includes(f.fieldType))
  if (conRisposta.length === 0) return []
  const session = getSession(undefined, 'READ')
  try {
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
      RETURN properties(r) AS props`, { id: parent.id, tenantId: ctx.tenantId })
    if (!row) return []
    // Le etichette dei valori le mette l'API, come per le risposte del modulo e
    // per i report: una sola verita su «come si legge production».
    const leggibile = await etichetteDeiValori(ctx.tenantId, conRisposta)
    return conRisposta
      .filter((f) => row.props[f.name] != null && row.props[f.name] !== '')
      .map((f) => {
        const raw = row.props[f.name]
        const lista = Array.isArray(raw) ? raw.map((v) => String(v)) : []
        const valore = Array.isArray(raw) ? null : String(raw)
        const comeSiLegge = leggibile(f.name)
        return {
          name: f.name, label: f.label, fieldType: f.fieldType,
          value: valore,
          values: lista,
          displayValue: valore == null ? null : comeSiLegge(valore),
          displayValues: lista.map(comeSiLegge),
          references: [] as never[], files: [] as never[],
          // Liste vuote e non assenti: lo schema le vuole non-null, e una
          // tabella non arriva qui (non è una proprietà) — ondata 7.
          rows: [] as never[], tableColumns: [] as never[],
        }
      })
  } finally { await session.close() }
}
