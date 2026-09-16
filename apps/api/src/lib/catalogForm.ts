/**
 * I moduli del catalogo servizi: lettura, validazione e scrittura (ondata 1).
 *
 * Due cose vivono qui:
 *
 *  - la LIBRERIA dei campi del tenant (nodi `:FormField`), letta e scritta dai
 *    resolver del costruttore;
 *  - la DEFINIZIONE del modulo di una voce di catalogo, che sta come JSON su
 *    `ServiceCatalogItem.form`.
 *
 * Lo stampo del JSON è quello di `Tenant.event_policy`, l'unico precedente
 * fatto per bene nel prodotto: una `version` esplicita, le chiavi attese per
 * versione, il nome della migrazione da eseguire se non combaciano, e NESSUN
 * valore predefinito messo in silenzio. Un documento corrotto è un errore, non
 * un modulo vuoto — perché un modulo vuoto sembra una configurazione, e il
 * cliente lo riempirebbe di nuovo senza sapere che ne aveva già uno.
 *
 * LA REGOLA DI SICUREZZA. Le condizioni di visibilità si valutano DUE volte:
 * nel browser per decidere cosa mostrare, e qui per decidere cosa accettare.
 * Il valutatore è lo stesso (`evaluateFormCondition` di @opengraphity/types),
 * perché due valutatori diversi trasformerebbero un campo nascosto in un
 * varco: un obbligatorio aggirabile, o un valore scritto su un campo che non
 * doveva comparire.
 */
import type { Session } from 'neo4j-driver'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { createMetamodelCache } from './metamodelCache.js'
import {
  CATALOG_FORM_VERSION, FORM_FIELD_NAME_RE, FORM_FIELD_TYPES, FORM_FIELD_TYPES_MULTI,
  FORM_FIELD_TYPES_WITHOUT_ANSWER, FORM_FIELD_TYPES_WITH_VOCABULARY, FORM_CONDITION_OPS,
  FORM_CONDITION_OPS_WITHOUT_VALUE, FORM_DRAFT_ENTITY_TYPE, FORM_FIELD_TYPES_AS_PROPERTY,
  canBeConditionSubject, catalogFormConditionFieldNames, catalogFormFieldNames,
  evaluateFormCondition, formulaInput,
  isFormAnswerEmpty, isFormAttachmentType, isFormConditionOp, isFormFieldType, isFormReferenceType,
  parseLocalizedLabels,
  type CatalogFormDefinition, type CatalogFormItem, type CatalogFormSection,
  type FormAnswerValue, type FormAnswers, type FormCondition, type FormFieldType, type LocalizedLabel,
} from '@opengraphity/types'
import { ValidationError } from './errors.js'
import { assertCustomFieldName } from './customFieldName.js'
import { loadVocabularyEntries } from './vocabularyEntries.js'
import { runFormulaScript, runValidationScript } from './metamodelScript.js'
import { labelFor, type EnumValueLabels } from './enumValueLabels.js'
import { languageFor } from './tenantLanguage.js'

export { FORM_DRAFT_ENTITY_TYPE }

/** Chiavi attese nella versione 1 del documento: se mancano, è di una versione che non conosciamo. */
export const CATALOG_FORM_V1_KEYS = ['version', 'revision', 'sections'] as const

/** Un campo della libreria, come lo leggono i resolver e la validazione. */
export interface FormFieldDef {
  id: string
  name: string
  fieldType: FormFieldType
  label: string
  labels: LocalizedLabel[]
  help: string | null
  helps: LocalizedLabel[]
  required: boolean
  vocabulary: string | null
  validationScript: string | null
  /**
   * LA FORMULA di un campo calcolato (ondata 6): JavaScript che riceve le
   * risposte già date in `input` e RESTITUISCE il valore. Null = campo normale,
   * lo compila una persona. Un campo con formula è in sola lettura: il valore
   * lo decide il server al salvataggio, e il browser lo mostra intanto.
   */
  formula: string | null
  /** Se diventa una colonna nelle liste e nell'esportazione (ondata 4). */
  inList: boolean
  createdAt: string | null
  updatedAt: string | null
}

// ── La libreria ─────────────────────────────────────────────────────────────

const FIELD_RETURN = `
  f.id AS id, f.name AS name, f.field_type AS fieldType, f.label AS label, f.labels AS labels,
  f.help AS help, f.helps AS helps, f.required AS required, f.vocabulary AS vocabulary,
  f.validation_script AS validationScript, f.formula AS formula, f.in_list AS inList,
  f.created_at AS createdAt, f.updated_at AS updatedAt`

function mapField(row: Record<string, unknown>): FormFieldDef {
  const name = String(row['name'])
  const fieldType = row['fieldType']
  if (!isFormFieldType(fieldType)) {
    // Fail-loud: un tipo che il renderer non conosce non va mostrato a metà.
    throw new Error(`FormField ${name}: unknown field type ${JSON.stringify(fieldType)} (known: ${FORM_FIELD_TYPES.join(', ')})`)
  }
  return {
    id: String(row['id']),
    name,
    fieldType,
    label: String(row['label'] ?? name),
    labels: parseLocalizedLabels(row['labels'], `FormField ${name}`),
    help: row['help'] == null || row['help'] === '' ? null : String(row['help']),
    helps: parseLocalizedLabels(row['helps'], `FormField ${name} (help)`),
    required: row['required'] === true,
    vocabulary: row['vocabulary'] == null || row['vocabulary'] === '' ? null : String(row['vocabulary']),
    validationScript: row['validationScript'] == null || row['validationScript'] === '' ? null : String(row['validationScript']),
    formula: row['formula'] == null || row['formula'] === '' ? null : String(row['formula']),
    // Assente sui campi nati prima dell'ondata 4: fuori dalle liste, che è la
    // scelta prudente — una colonna in più la si chiede, non la si subisce.
    inList: row['inList'] === true,
    createdAt: row['createdAt'] == null ? null : String(row['createdAt']),
    updatedAt: row['updatedAt'] == null ? null : String(row['updatedAt']),
  }
}

/**
 * La libreria con una cache, per le LISTE (ondata 4). Una colonna per campo su
 * venti righe vorrebbe dire venti letture della libreria: qui è una, e la
 * scadenza è la rete di sicurezza — la via normale è il canale del metamodello,
 * che le mutation della libreria tirano a ogni modifica.
 */
export const formFieldsCache = createMetamodelCache<FormFieldDef[]>({
  name: 'formFields',
  load: async (tenantId) => {
    const session = getSession(undefined, 'READ')
    try { return await formFields(session, tenantId) } finally { await session.close() }
  },
})

/** Tutta la libreria del tenant, in ordine alfabetico di etichetta. */
export async function formFields(session: Session, tenantId: string): Promise<FormFieldDef[]> {
  const rows = await runQuery<Record<string, unknown>>(session, `
    MATCH (f:FormField {tenant_id: $tenantId})
    RETURN ${FIELD_RETURN}
    ORDER BY toLower(f.label), f.name`, { tenantId })
  return rows.map(mapField)
}

/** I campi chiesti per nome (per validare un modulo senza rileggere tutta la libreria). */
export async function formFieldsByName(session: Session, tenantId: string, names: readonly string[]): Promise<Map<string, FormFieldDef>> {
  if (names.length === 0) return new Map()
  const rows = await runQuery<Record<string, unknown>>(session, `
    MATCH (f:FormField {tenant_id: $tenantId})
    WHERE f.name IN $names
    RETURN ${FIELD_RETURN}`, { tenantId, names: [...names] })
  return new Map(rows.map((r) => { const d = mapField(r); return [d.name, d] }))
}

/**
 * Il nome di un campo della libreria. È il nome della proprietà sul ticket,
 * quindi valgono i divieti dei campi personalizzati (identità, campi del
 * motore, campi derivati) — con `service_request` come tipo di riferimento,
 * perché è l'unico che i moduli compilano.
 */
export async function assertFormFieldName(session: Session, tenantId: string, name: string): Promise<void> {
  // `assertCustomFieldName` fa i quattro controlli che servono anche qui: la
  // forma, i nomi riservati del motore, i campi che l'API espone gia per le
  // service request, e le proprieta che i ticket del cliente portano gia (un
  // campo nuovo non deve mostrare dati storici di un import).
  await assertCustomFieldName(session, tenantId, 'service_request', name)
}

// ── La definizione del modulo ───────────────────────────────────────────────

function oggetto(raw: unknown, where: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError(`${where}: expected an object.`, { key: 'errors.catalogForm.shape', params: { where } })
  }
  return raw as Record<string, unknown>
}

function testoPerLingua(raw: unknown, where: string): Record<string, string> | undefined {
  if (raw == null) return undefined
  const o = oggetto(raw, where)
  const out: Record<string, string> = {}
  for (const [lingua, valore] of Object.entries(o)) {
    if (typeof valore !== 'string') {
      throw new ValidationError(`${where}: the ${lingua} text is not a string.`, { key: 'errors.catalogForm.shape', params: { where } })
    }
    if (valore.trim() !== '') out[lingua] = valore
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function condizione(raw: unknown, where: string): FormCondition | undefined {
  if (raw == null) return undefined
  const o = oggetto(raw, where)
  const match = o['match']
  if (match !== 'all' && match !== 'any') {
    throw new ValidationError(`${where}: match must be "all" or "any".`, { key: 'errors.catalogForm.conditionMatch', params: { where } })
  }
  const regole = o['rules']
  if (!Array.isArray(regole) || regole.length === 0) {
    // Un elenco vuoto sarebbe ambiguo: «tutte le zero regole» = sempre
    // visibile, «almeno una di zero» = mai visibile, cioè un campo che nessuno
    // può compilare. Chi non vuole condizioni non mette il blocco.
    throw new ValidationError(`${where}: a condition needs at least one rule (remove the condition to always show the field).`,
      { key: 'errors.catalogForm.conditionEmpty', params: { where } })
  }
  return {
    match,
    rules: regole.map((r, i) => {
      const ro = oggetto(r, `${where}.rules[${i}]`)
      const field = ro['field']
      if (typeof field !== 'string' || !FORM_FIELD_NAME_RE.test(field)) {
        throw new ValidationError(`${where}.rules[${i}]: field is not a field name.`, { key: 'errors.catalogForm.conditionField', params: { where } })
      }
      const op = ro['op']
      if (!isFormConditionOp(op)) {
        throw new ValidationError(`${where}.rules[${i}]: unknown operator ${JSON.stringify(op)} (known: ${FORM_CONDITION_OPS.join(', ')}).`,
          { key: 'errors.catalogForm.conditionOp', params: { where, op: String(op) } })
      }
      const senzaValore = FORM_CONDITION_OPS_WITHOUT_VALUE.includes(op)
      const value = ro['value']
      if (!senzaValore && (typeof value !== 'string' || value === '')) {
        throw new ValidationError(`${where}.rules[${i}]: the operator "${op}" needs a value.`,
          { key: 'errors.catalogForm.conditionValue', params: { where, op } })
      }
      return senzaValore ? { field, op } : { field, op, value: String(value) }
    }),
  }
}

function voce(raw: unknown, where: string): CatalogFormItem {
  const o = oggetto(raw, where)
  const field = o['field']
  if (typeof field !== 'string' || !FORM_FIELD_NAME_RE.test(field)) {
    throw new ValidationError(`${where}: field is not a field name.`, { key: 'errors.catalogForm.itemField', params: { where } })
  }
  const width = o['width']
  if (width != null && width !== 'full' && width !== 'half') {
    throw new ValidationError(`${where}: width must be "full" or "half".`, { key: 'errors.catalogForm.itemWidth', params: { where } })
  }
  const item: Record<string, unknown> = { field }
  if (o['required'] != null) {
    if (typeof o['required'] !== 'boolean') throw new ValidationError(`${where}: required must be true or false.`, { key: 'errors.catalogForm.shape', params: { where } })
    item['required'] = o['required']
  }
  if (o['defaultValue'] != null) {
    if (typeof o['defaultValue'] !== 'string') throw new ValidationError(`${where}: defaultValue must be text.`, { key: 'errors.catalogForm.shape', params: { where } })
    item['defaultValue'] = o['defaultValue']
  }
  if (o['endUser'] != null) {
    if (typeof o['endUser'] !== 'boolean') throw new ValidationError(`${where}: endUser must be true or false.`, { key: 'errors.catalogForm.shape', params: { where } })
    item['endUser'] = o['endUser']
  }
  const help = testoPerLingua(o['help'], `${where}.help`)
  if (help) item['help'] = help
  if (width) item['width'] = width
  const quando = condizione(o['visibleWhen'], `${where}.visibleWhen`)
  if (quando) item['visibleWhen'] = quando
  return item as unknown as CatalogFormItem
}

function sezione(raw: unknown, where: string): CatalogFormSection {
  const o = oggetto(raw, where)
  const id = o['id']
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(id)) {
    throw new ValidationError(`${where}: id is not a section id (lowercase letters, digits, underscore).`, { key: 'errors.catalogForm.sectionId', params: { where } })
  }
  const items = o['items']
  if (!Array.isArray(items)) {
    throw new ValidationError(`${where}: items must be a list.`, { key: 'errors.catalogForm.shape', params: { where } })
  }
  const s: Record<string, unknown> = {
    id,
    title: testoPerLingua(o['title'], `${where}.title`) ?? {},
    items: items.map((it, i) => voce(it, `${where}.items[${i}]`)),
  }
  const descrizione = testoPerLingua(o['description'], `${where}.description`)
  if (descrizione) s['description'] = descrizione
  const quando = condizione(o['visibleWhen'], `${where}.visibleWhen`)
  if (quando) s['visibleWhen'] = quando
  return s as unknown as CatalogFormSection
}

/**
 * Legge la definizione salvata. `null`/`''` = la voce non ha ancora un modulo
 * (caso normale, non un errore). Un JSON corrotto o di una versione che non
 * conosciamo è un errore che nomina la migrazione da eseguire.
 */
export function parseCatalogForm(raw: unknown, where: string): CatalogFormDefinition | null {
  if (raw == null || raw === '') return null
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch (e) {
      throw new Error(`${where}: form is not valid JSON (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  const o = oggetto(parsed, where)
  const mancanti = CATALOG_FORM_V1_KEYS.filter((k) => !(k in o))
  if (mancanti.length > 0) {
    throw new Error(`${where}: the form document has no ${mancanti.join(', ')}: it was written by an older version of the product`)
  }
  const version = o['version']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error(`${where}: version must be a positive integer, got ${JSON.stringify(version)}`)
  }
  if (version > CATALOG_FORM_VERSION) {
    throw new Error(`${where}: the form document is version ${version}, this build understands up to ${CATALOG_FORM_VERSION}: a newer version of the product wrote it`)
  }
  const revision = o['revision']
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new Error(`${where}: revision must be an integer >= 0, got ${JSON.stringify(revision)}`)
  }
  const sections = o['sections']
  if (!Array.isArray(sections)) throw new Error(`${where}: sections must be a list`)
  return {
    version,
    revision,
    sections: sections.map((s, i) => sezione(s, `${where}.sections[${i}]`)),
  }
}

/**
 * Le regole che una definizione deve rispettare rispetto alla LIBRERIA e a sé
 * stessa. Separata dal parse perché il parse non ha bisogno del database: così
 * la forma si prova senza Neo4j e i controlli che leggono la libreria stanno
 * in un posto solo.
 */
export function assertCatalogForm(def: CatalogFormDefinition, library: ReadonlyMap<string, FormFieldDef>): void {
  const nomiSezioni = new Set<string>()
  for (const s of def.sections) {
    if (nomiSezioni.has(s.id)) {
      throw new ValidationError(`Two sections have the id "${s.id}": ids identify a section, they cannot repeat.`,
        { key: 'errors.catalogForm.sectionDuplicate', params: { id: s.id } })
    }
    nomiSezioni.add(s.id)
  }

  const usati = catalogFormFieldNames(def)
  const visti = new Set<string>()
  for (const nome of usati) {
    if (visti.has(nome)) {
      // Lo stesso campo due volte scriverebbe due volte la stessa proprietà:
      // chi compila vedrebbe due caselle e una sola risposta sopravvivrebbe.
      throw new ValidationError(`The field "${nome}" appears twice in this form: a field can be used once.`,
        { key: 'errors.catalogForm.fieldDuplicate', params: { field: nome } })
    }
    visti.add(nome)
    const def_ = library.get(nome)
    if (!def_) {
      throw new ValidationError(`The field "${nome}" is not in the field library: add it there first, or remove it from the form.`,
        { key: 'errors.catalogForm.fieldUnknown', params: { field: nome } })
    }
    if (FORM_FIELD_TYPES_WITH_VOCABULARY.includes(def_.fieldType) && !def_.vocabulary) {
      throw new ValidationError(`The field "${nome}" is a ${def_.fieldType} but has no vocabulary: it would offer no choices.`,
        { key: 'errors.catalogForm.fieldNoVocabulary', params: { field: nome } })
    }
  }

  // Una condizione che guarda un campo NON presente nel modulo non potrebbe
  // mai diventare vera: il campo che dipende da lei resterebbe invisibile per
  // sempre, e nel costruttore sembrerebbe configurato.
  for (const nome of catalogFormConditionFieldNames(def)) {
    if (!visti.has(nome)) {
      throw new ValidationError(`A condition looks at the field "${nome}", which this form does not contain: the condition could never become true.`,
        { key: 'errors.catalogForm.conditionFieldMissing', params: { field: nome } })
    }
  }

  for (const s of def.sections) {
    for (const i of s.items) {
      const f = library.get(i.field)!
      // Una nota non porta risposta: non può essere obbligatoria.
      if (FORM_FIELD_TYPES_WITHOUT_ANSWER.includes(f.fieldType) && i.required === true) {
        throw new ValidationError(`The field "${i.field}" is a note: it carries no answer, so it cannot be required.`,
          { key: 'errors.catalogForm.noteRequired', params: { field: i.field } })
      }
      /**
       * UN RIFERIMENTO NON SI OFFRE NEL PORTALE (ondata 2, limite dichiarato).
       * Scegliere un CI, una persona o una squadra vuol dire cercarli, e un
       * utente finale non naviga la CMDB né l'elenco del personale: non è una
       * mancanza del renderer, è una decisione. Il campo resta compilabile
       * dall'area di lavoro; il rifiuto lo dice qui, alla pubblicazione, invece
       * di lasciare nel portale una casella che non trova niente.
       */
      if (isFormReferenceType(f.fieldType) && i.endUser !== false) {
        throw new ValidationError(
          `The field "${i.field}" is a reference (${f.fieldType}): it cannot be offered in the portal, because choosing one means searching the CMDB or the staff list. Untick "offer it in the portal".`,
          { key: 'errors.catalogForm.referenceEndUser', params: { field: i.field, fieldType: f.fieldType } },
        )
      }
    }
  }
  /**
   * Una condizione può guardare SOLO un campo che diventa una proprietà. Un
   * allegato o un riferimento andrebbero letti dal grafo per essere valutati, e
   * il valutatore gira anche nel browser su quello che ha in mano: vietarlo qui
   * è meglio che offrirlo e farlo sbagliare a metà.
   */
  for (const nome of catalogFormConditionFieldNames(def)) {
    const f = library.get(nome)
    if (!f) continue
    if (!canBeConditionSubject(f.fieldType)) {
      throw new ValidationError(
        `A condition looks at the field "${nome}", which is a ${f.fieldType}: only fields stored as a property can be a condition subject (${FORM_FIELD_TYPES_AS_PROPERTY.join(', ')}).`,
        { key: 'errors.catalogForm.conditionFieldType', params: { field: nome, fieldType: f.fieldType } },
      )
    }
  }
}

// ── Le risposte ─────────────────────────────────────────────────────────────

export interface FormAnswerInput {
  name: string
  value?: string | null
  values?: readonly string[] | null
  /** Per i campi di riferimento: gli id dei nodi puntati (CI, persona, squadra). */
  refIds?: readonly string[] | null
}

/** `[{name, value}]` → `{name: valore}`, la forma che il valutatore delle condizioni si aspetta. */
export function formAnswerMap(inputs: readonly FormAnswerInput[] | null | undefined): FormAnswers {
  const out: Record<string, FormAnswerValue> = {}
  for (const i of inputs ?? []) out[i.name] = i.values != null ? [...i.values] : (i.value ?? null)
  return out
}

/**
 * Le voci del modulo che, date queste risposte, sono davvero da compilare:
 * sezione visibile e campo visibile. È il calcolo che il browser fa per
 * mostrare e che il server rifà per accettare.
 */
export function visibleFormItems(def: CatalogFormDefinition, answers: FormAnswers, opts: { endUser?: boolean } = {}): CatalogFormItem[] {
  const out: CatalogFormItem[] = []
  for (const s of def.sections) {
    if (!evaluateFormCondition(s.visibleWhen, answers)) continue
    for (const i of s.items) {
      if (opts.endUser && i.endUser === false) continue
      if (!evaluateFormCondition(i.visibleWhen, answers)) continue
      out.push(i)
    }
  }
  return out
}

function coerce(def: FormFieldDef, raw: string, allowed: readonly string[] | null): unknown {
  const testo = raw.trim()
  switch (def.fieldType) {
    case 'number': {
      const n = Number(testo)
      if (!Number.isFinite(n)) {
        throw new ValidationError(`The field "${def.label}" is a number, "${testo}" is not.`,
          { key: 'errors.formField.notNumber', params: { field: def.label, value: testo } })
      }
      return n
    }
    case 'boolean': {
      if (testo !== 'true' && testo !== 'false') {
        throw new ValidationError(`The field "${def.label}" is yes/no: use true or false.`,
          { key: 'errors.formField.notBoolean', params: { field: def.label, value: testo } })
      }
      return testo === 'true'
    }
    case 'date':
    case 'datetime': {
      if (Number.isNaN(Date.parse(testo))) {
        throw new ValidationError(`The field "${def.label}" is a date, "${testo}" is not.`,
          { key: 'errors.formField.notDate', params: { field: def.label, value: testo } })
      }
      return testo
    }
    case 'enum': {
      if (allowed && allowed.length > 0 && !allowed.includes(testo)) {
        throw new ValidationError(`"${testo}" is not a value of "${def.label}" (allowed: ${allowed.join(', ')}).`,
          { key: 'errors.formField.notInVocabulary', params: { field: def.label, value: testo, allowed: allowed.join(', ') } })
      }
      return testo
    }
    default:
      return raw
  }
}

/**
 * Le proprietà da scrivere sul ticket per le risposte mandate.
 *
 * Cosa controlla, e perché in quest'ordine:
 *  1. il campo appartiene al modulo di QUESTA voce di catalogo (altrimenti
 *     chiunque potrebbe scrivere qualunque proprietà del ticket);
 *  2. il campo è VISIBILE con queste risposte — condizioni rivalutate qui, non
 *     fidandosi del browser; un campo nascosto che arriva comunque è un errore,
 *     non un valore da accettare in silenzio;
 *  3. dal portale, il campo è offerto agli utenti finali (`endUser`);
 *  4. il tipo e il vocabolario;
 *  5. l'obbligatorietà, sui soli campi visibili: un obbligatorio nascosto da
 *     una condizione non si chiede;
 *  6. lo script di validazione del campo, che vede tutte le risposte.
 */
export async function resolveFormWrites(
  session: Session,
  tenantId: string,
  def: CatalogFormDefinition,
  library: ReadonlyMap<string, FormFieldDef>,
  inputs: readonly FormAnswerInput[] | null | undefined,
  opts: { endUser?: boolean; draftId?: string | null; userId?: string | null } = {},
): Promise<FormWriteResult> {
  const answers = formAnswerMap(inputs)
  const visibili = visibleFormItems(def, answers, opts)
  const perNome = new Map(visibili.map((i) => [i.field, i]))
  const nelModulo = new Set(catalogFormFieldNames(def))

  const out: Record<string, unknown> = {}
  const riferimenti: FormReferenceWrite[] = []
  const vocabolari = new Map<string, readonly string[]>()
  const vocabolarioDi = async (nome: string): Promise<readonly string[] | null> => {
    if (vocabolari.has(nome)) return vocabolari.get(nome)!
    const v = await loadVocabularyEntries(tenantId, nome)
    vocabolari.set(nome, v.values)
    return v.values
  }

  for (const input of inputs ?? []) {
    if (!nelModulo.has(input.name)) {
      throw new ValidationError(`"${input.name}" is not a field of this form.`,
        { key: 'errors.catalogForm.answerUnknown', params: { field: input.name } })
    }
    const item = perNome.get(input.name)
    if (!item) {
      throw new ValidationError(`The field "${input.name}" is not being asked with these answers: it is hidden by a condition, or not offered here.`,
        { key: 'errors.catalogForm.answerHidden', params: { field: input.name } })
    }
    const campo = library.get(input.name)!
    if (FORM_FIELD_TYPES_WITHOUT_ANSWER.includes(campo.fieldType)) {
      throw new ValidationError(`The field "${input.name}" is a note: it carries no answer.`,
        { key: 'errors.catalogForm.answerNote', params: { field: input.name } })
    }
    /**
     * Un campo CALCOLATO non si riceve: lo calcola il server (ondata 6). Il
     * rifiuto invece del silenzio perché un client che lo manda ha un difetto,
     * e ignorarlo lascerebbe credere che il valore mandato conti qualcosa.
     */
    if (campo.formula) {
      throw new ValidationError(`The field "${campo.label}" is computed: its value comes from its formula, it cannot be sent.`,
        { key: 'errors.catalogForm.answerComputed', params: { field: campo.label } })
    }

    const multi = FORM_FIELD_TYPES_MULTI.includes(campo.fieldType)
    if (multi) {
      const valori = (input.values ?? []).map((v) => String(v).trim()).filter((v) => v !== '')
      if (valori.length === 0) { out[input.name] = null; continue }
      const allowed = campo.vocabulary ? await vocabolarioDi(campo.vocabulary) : null
      for (const v of valori) {
        if (allowed && allowed.length > 0 && !allowed.includes(v)) {
          throw new ValidationError(`"${v}" is not a value of "${campo.label}" (allowed: ${allowed.join(', ')}).`,
            { key: 'errors.formField.notInVocabulary', params: { field: campo.label, value: v, allowed: allowed.join(', ') } })
        }
      }
      out[input.name] = [...new Set(valori)]
      continue
    }

    /**
     * Un RIFERIMENTO non diventa una proprietà: diventa una relazione. Qui si
     * verifica solo che il nodo puntato esista NEL TENANT e con l'etichetta
     * giusta — scrivere la relazione tocca a chi crea il ticket, nella sua
     * transazione.
     */
    if (isFormReferenceType(campo.fieldType)) {
      const ids = (input.refIds ?? []).map((v) => String(v).trim()).filter((v) => v !== '')
      if (ids.length === 0) continue
      if (ids.length > 1) {
        // Un riferimento è uno solo, per ora: accettarne due qui e scriverne
        // uno sarebbe una perdita silenziosa.
        throw new ValidationError(`The field "${campo.label}" takes one reference, ${ids.length} were sent.`,
          { key: 'errors.formField.oneReference', params: { field: campo.label, count: String(ids.length) } })
      }
      await assertRiferimentoEsiste(session, tenantId, campo, ids[0]!)
      riferimenti.push({ field: campo.name, fieldType: campo.fieldType, ids })
      continue
    }

    /**
     * Un ALLEGATO non arriva come valore: i file sono già stati caricati sulla
     * BOZZA (entity_type `form_draft`) e portano il nome del campo. Qui non c'è
     * niente da scrivere: si conta, per l'obbligatorietà, e si reclama alla
     * creazione.
     */
    if (isFormAttachmentType(campo.fieldType)) continue

    const raw = input.value
    if (raw == null || String(raw).trim() === '') { out[input.name] = null; continue }
    const allowed = campo.vocabulary ? await vocabolarioDi(campo.vocabulary) : null
    out[input.name] = coerce(campo, String(raw), allowed)
  }

  /**
   * I CAMPI CALCOLATI (ondata 6), prima dell'obbligatorietà: una formula che
   * non produce niente su un campo obbligatorio deve far fallire il
   * salvataggio come un campo lasciato vuoto.
   *
   * Solo i campi VISIBILI: se una condizione nasconde il campo, la domanda non
   * è stata fatta e la formula non c'entra. E solo quelli del modulo: un campo
   * calcolato della libreria che questo modulo non cita non si scrive.
   *
   * La formula vede le risposte già convertite dei campi NON calcolati
   * (`formulaInput`): niente catene, quindi niente cicli da riconoscere.
   */
  const calcolati = new Set(visibili.map((i) => i.field).filter((n) => library.get(n)?.formula))
  if (calcolati.size > 0) {
    const perLaFormula = formulaInput(out, calcolati)
    for (const item of visibili) {
      const campo = library.get(item.field)!
      if (!campo.formula) continue
      const esito = await runFormulaScript(campo.formula, perLaFormula, campo.name, tenantId)
      if (!esito.ok) {
        // La scelta del proprietario: si RIFIUTA e si nomina la formula. Chi
        // compila non può rimediare, ma nessun ticket nasce con un dato finto.
        throw new ValidationError(`The formula of field "${campo.label}" failed: ${esito.error}`,
          { key: 'errors.formField.formulaFailed', params: { field: campo.label, message: esito.error } })
      }
      const valore = esito.value
      if (valore == null || String(valore).trim() === '') { out[campo.name] = null; continue }
      const allowed = campo.vocabulary ? await vocabolarioDi(campo.vocabulary) : null
      // Lo stesso `coerce` di un valore scritto a mano: una formula che
      // restituisce «pippo» per un numero, o un valore fuori vocabolario,
      // viene rifiutata dalle regole che valgono per tutti.
      out[campo.name] = coerce(campo, String(valore), allowed)
    }
  }

  /**
   * L'obbligatorietà, sui soli campi VISIBILI: la sovrascrittura del modulo
   * vince sulla libreria. Ogni genere di campo ha il suo modo di essere vuoto —
   * un allegato obbligatorio si conta sulla bozza, un riferimento sugli id
   * arrivati, gli altri sul valore scritto.
   */
  const allegatiRichiesti: FormAttachmentField[] = []
  for (const item of visibili) {
    const campo = library.get(item.field)!
    if (FORM_FIELD_TYPES_WITHOUT_ANSWER.includes(campo.fieldType)) continue
    const obbligatorio = item.required ?? campo.required

    if (isFormAttachmentType(campo.fieldType)) {
      const quanti = opts.draftId
        ? await contaAllegatiBozza(session, tenantId, opts.draftId, campo.name, opts.userId ?? null)
        : 0
      allegatiRichiesti.push({ field: campo.name, label: campo.label, required: obbligatorio, count: quanti })
      if (obbligatorio && quanti === 0) {
        throw new ValidationError(`The field "${campo.label}" needs at least one file.`,
          { key: 'errors.formField.fileRequired', params: { field: campo.label } })
      }
      continue
    }

    if (isFormReferenceType(campo.fieldType)) {
      if (obbligatorio && !riferimenti.some((r) => r.field === campo.name)) {
        throw new ValidationError(`The field "${campo.label}" is required.`,
          { key: 'errors.formField.required', params: { field: campo.label } })
      }
      continue
    }

    if (!obbligatorio) continue
    const scritto = Object.prototype.hasOwnProperty.call(out, item.field) ? out[item.field] : undefined
    const vuoto = scritto === undefined
      ? isFormAnswerEmpty(answers[item.field])
      : isFormAnswerEmpty(scritto as FormAnswerValue)
    if (vuoto) {
      throw new ValidationError(`The field "${campo.label}" is required.`,
        { key: 'errors.formField.required', params: { field: campo.label } })
    }
  }

  // Gli script per ultimi: vedono tutte le risposte già convertite, così uno
  // script che confronta due campi legge valori dello stesso tipo.
  for (const item of visibili) {
    const campo = library.get(item.field)!
    if (!campo.validationScript) continue
    const valore = Object.prototype.hasOwnProperty.call(out, item.field) ? out[item.field] : null
    if (valore == null) continue
    const rifiuto = await runValidationScript(
      campo.validationScript, { input: { ...out }, value: valore }, campo.name, tenantId, 'tenant',
    )
    if (rifiuto) {
      throw new ValidationError(`The field "${campo.label}" was refused: ${rifiuto}`,
        { key: 'errors.formField.script', params: { field: campo.label, message: rifiuto } })
    }
  }

  return { props: out, references: riferimenti, attachmentFields: allegatiRichiesti }
}

// ── Le revisioni pubblicate ─────────────────────────────────────────────────
//
// Ogni pubblicazione lascia una copia IMMUTABILE della definizione. Serve a
// una cosa sola, ed è la ragione per cui la `revision` esiste: un ticket
// compilato tre mesi fa si rilegge con il modulo di allora — le domande che
// gli sono state fatte, nel loro ordine — anche se il modulo è cambiato dieci
// volte. Senza questa copia il numero di revisione sarebbe un numero e basta.

/** Scrive la copia immutabile di una revisione appena pubblicata. */
export async function saveCatalogFormRevision(
  session: Session, tenantId: string, itemId: string, def: CatalogFormDefinition, publishedAt: string, publishedBy: string | null,
): Promise<void> {
  await runQuery(session, `
    MATCH (i:ServiceCatalogItem {id: $itemId, tenant_id: $tenantId})
    CREATE (i)-[:HAS_FORM_REVISION]->(r:CatalogFormRevision {
      tenant_id: $tenantId, item_id: $itemId, revision: $revision,
      definition: $definition, published_at: $publishedAt, published_by: $publishedBy
    })`, {
    itemId, tenantId, revision: def.revision,
    definition: JSON.stringify(def), publishedAt, publishedBy,
  })
}

/** La definizione di UNA revisione; null se quella revisione non è stata conservata. */
export async function catalogFormRevision(
  session: Session, tenantId: string, itemId: string, revision: number,
): Promise<CatalogFormDefinition | null> {
  const rows = await runQuery<{ definition: string }>(session, `
    MATCH (r:CatalogFormRevision {tenant_id: $tenantId, item_id: $itemId, revision: $revision})
    RETURN r.definition AS definition
    LIMIT 1`, { tenantId, itemId, revision })
  return rows[0] ? parseCatalogForm(rows[0].definition, `CatalogFormRevision ${itemId}#${revision}`) : null
}

/**
 * Le risposte di un ticket, nell'ordine del modulo con cui è stato compilato.
 *
 * Le etichette sono quelle di ADESSO (dalla libreria): se il cliente corregge
 * un'etichetta, il ticket vecchio si legge con quella corretta — è il
 * comportamento giusto, perché l'etichetta descrive lo stesso dato. Un campo
 * cancellato dalla libreria ripiega sul suo nome, così il valore resta
 * leggibile invece di sparire.
 */
export interface FormAnswerRead {
  name: string
  label: string
  fieldType: string
  value: string | null
  values: string[]
  /**
   * Il valore COME SI LEGGE (ondata 5): l'etichetta del Dizionario per un
   * campo a vocabolario, il valore stesso per gli altri. Separato da `value`
   * perché quello è il dato — lo leggono i filtri, i report e le condizioni —
   * mentre questo è per gli occhi. Prima la scheda del ticket diceva
   * «production» dove la colonna della lista diceva «Produzione».
   */
  displayValue: string | null
  /** Gli stessi valori di `values`, come si leggono. */
  displayValues: string[]
  /** Per i campi di riferimento: i nodi puntati, col loro nome. */
  references: Array<{ id: string; label: string }>
  /** Per i campi allegato: i file reclamati dal ticket per questo campo. */
  files: Array<{ id: string; filename: string; sizeBytes: number }>
}

export async function formAnswersOf(
  session: Session, tenantId: string,
  ticket: { id: string; catalogItemId: string | null; formRevision: number | null; props: Record<string, unknown> },
): Promise<FormAnswerRead[]> {
  if (!ticket.catalogItemId || !ticket.formRevision) return []
  const def = await catalogFormRevision(session, tenantId, ticket.catalogItemId, ticket.formRevision)
  if (!def) return []
  const nomi = catalogFormFieldNames(def)
  const library = await formFieldsByName(session, tenantId, nomi)

  // Riferimenti e file si leggono in due query sole, non una per campo.
  const riferimenti = await leggiRiferimenti(session, tenantId, ticket.id)
  const file = await leggiFileDelModulo(session, tenantId, ticket.id)

  // Le etichette dei vocabolari citati dal modulo: una lettura per vocabolario,
  // non una per risposta.
  const leggibile = await etichetteDeiValori(tenantId, [...library.values()])

  const out: FormAnswerRead[] = []
  for (const nome of nomi) {
    const campo = library.get(nome)
    if (campo && FORM_FIELD_TYPES_WITHOUT_ANSWER.includes(campo.fieldType)) continue
    const raw = ticket.props[nome]
    const lista = Array.isArray(raw) ? raw.map((v) => String(v)) : []
    const valore = Array.isArray(raw) || raw == null || raw === '' ? null : String(raw)
    const comeSiLegge = leggibile(nome)
    out.push({
      name: nome,
      label: campo?.label ?? nome,
      fieldType: campo?.fieldType ?? 'text',
      value: valore,
      values: lista,
      displayValue: valore == null ? null : comeSiLegge(valore),
      displayValues: lista.map(comeSiLegge),
      references: riferimenti.get(nome) ?? [],
      files: file.get(nome) ?? [],
    })
  }
  return out
}

/**
 * Per ogni campo, come si legge un suo valore (ondata 5). I vocabolari si
 * leggono una volta ciascuno; un campo senza vocabolario e un valore che il
 * vocabolario non conosce più restano com'erano — il dato vero, non
 * un'etichetta inventata.
 *
 * La lingua è quella del tenant, come per le colonne delle liste e i report:
 * le risposte di un ticket le legge lo staff nella lingua del prodotto.
 */
export async function etichetteDeiValori(
  tenantId: string, campi: readonly FormFieldDef[],
): Promise<(nomeCampo: string) => (valore: string) => string> {
  const conVocabolario = campi.filter((c) => c.vocabulary)
  if (conVocabolario.length === 0) return () => (v) => v
  const lingua = await languageFor(tenantId)
  const perVocabolario = new Map<string, EnumValueLabels>()
  for (const nome of new Set(conVocabolario.map((c) => c.vocabulary!))) {
    perVocabolario.set(nome, (await loadVocabularyEntries(tenantId, nome)).labels)
  }
  const perCampo = new Map(conVocabolario.map((c) => [c.name, perVocabolario.get(c.vocabulary!)!]))
  return (nomeCampo) => {
    const etichette = perCampo.get(nomeCampo)
    if (!etichette) return (v) => v
    return (v) => (etichette[v] ? labelFor(v, etichette, lingua, lingua) : v)
  }
}

/**
 * I nodi puntati dai campi di riferimento, per nome di campo. Tre query
 * scritte per intero (una per genere) invece di una con il tipo di relazione
 * interpolato: il guardiano `check-cypher.mjs` deve poterle mandare in EXPLAIN.
 */
async function leggiRiferimenti(
  session: Session, tenantId: string, entityId: string,
): Promise<Map<string, Array<{ id: string; label: string }>>> {
  const out = new Map<string, Array<{ id: string; label: string }>>()
  const raccogli = async (query: string) => {
    const rows = await runQuery<{ field: string; id: string; label: string }>(session, query, { entityId, tenantId })
    for (const r of rows) {
      const elenco = out.get(r.field) ?? []
      elenco.push({ id: r.id, label: r.label })
      out.set(r.field, elenco)
    }
  }
  await raccogli(`
    MATCH (t:ServiceRequest {id: $entityId, tenant_id: $tenantId})-[rel:FORM_REFERS_TO_CI]->(n:ConfigurationItem)
    RETURN rel.field AS field, n.id AS id, coalesce(n.name, n.id) AS label`)
  await raccogli(`
    MATCH (t:ServiceRequest {id: $entityId, tenant_id: $tenantId})-[rel:FORM_REFERS_TO_USER]->(n:User)
    RETURN rel.field AS field, n.id AS id, coalesce(n.name, n.email, n.id) AS label`)
  await raccogli(`
    MATCH (t:ServiceRequest {id: $entityId, tenant_id: $tenantId})-[rel:FORM_REFERS_TO_TEAM]->(n:Team)
    RETURN rel.field AS field, n.id AS id, coalesce(n.name, n.id) AS label`)
  return out
}

/** I file reclamati dal ticket, raggruppati per campo del modulo. */
async function leggiFileDelModulo(
  session: Session, tenantId: string, entityId: string,
): Promise<Map<string, Array<{ id: string; filename: string; sizeBytes: number }>>> {
  const rows = await runQuery<{ field: string; id: string; filename: string; sizeBytes: number }>(session, `
    MATCH (a:Attachment {tenant_id: $tenantId, entity_type: 'service_request', entity_id: $entityId})
    WHERE a.field_name IS NOT NULL
    RETURN a.field_name AS field, a.id AS id, a.filename AS filename, a.size_bytes AS sizeBytes
    ORDER BY a.uploaded_at`, { entityId, tenantId })
  const out = new Map<string, Array<{ id: string; filename: string; sizeBytes: number }>>()
  for (const r of rows) {
    const elenco = out.get(r.field) ?? []
    elenco.push({ id: r.id, filename: r.filename, sizeBytes: Number(r.sizeBytes ?? 0) })
    out.set(r.field, elenco)
  }
  return out
}

// ── Ondata 2: riferimenti e allegati ────────────────────────────────────────

/** Un riferimento da scrivere come relazione, dopo che il ticket esiste. */
export interface FormReferenceWrite {
  field: string
  fieldType: string
  ids: string[]
}

/** Un campo allegato del modulo, con quanti file porta la bozza. */
export interface FormAttachmentField {
  field: string
  label: string
  required: boolean
  count: number
}

export interface FormWriteResult {
  /** Le proprietà da scrivere sul ticket. */
  props: Record<string, unknown>
  /** Le relazioni da creare (chi crea il ticket le scrive nella sua transazione). */
  references: FormReferenceWrite[]
  /** I campi allegato visibili, col conto dei file sulla bozza. */
  attachmentFields: FormAttachmentField[]
}

/**
 * Il nodo puntato da un riferimento deve esistere NEL TENANT e portare
 * l'etichetta giusta. Tre query scritte per intero, una per genere, invece di
 * una con l'etichetta interpolata: così `scripts/check-cypher.mjs` le manda in
 * EXPLAIN davvero, invece di lasciarle «fuori perimetro».
 */
async function assertRiferimentoEsiste(session: Session, tenantId: string, campo: FormFieldDef, id: string): Promise<void> {
  const trovato = async (query: string): Promise<boolean> => {
    const rows = await runQuery<{ id: string }>(session, query, { id, tenantId })
    return rows.length > 0
  }
  let esiste = false
  switch (campo.fieldType) {
    case 'ref_ci':
      esiste = await trovato('MATCH (n:ConfigurationItem {id: $id, tenant_id: $tenantId}) RETURN n.id AS id LIMIT 1')
      break
    case 'ref_user':
      esiste = await trovato('MATCH (n:User {id: $id, tenant_id: $tenantId}) RETURN n.id AS id LIMIT 1')
      break
    case 'ref_team':
      esiste = await trovato('MATCH (n:Team {id: $id, tenant_id: $tenantId}) RETURN n.id AS id LIMIT 1')
      break
    default:
      throw new Error(`assertRiferimentoEsiste: ${campo.fieldType} is not a reference type`)
  }
  if (!esiste) {
    throw new ValidationError(`The field "${campo.label}" points to something that does not exist here.`,
      { key: 'errors.formField.referenceNotFound', params: { field: campo.label } })
  }
}

/**
 * Quanti file la bozza porta per questo campo. Filtra anche su chi ha caricato:
 * una bozza è di chi la sta compilando, e reclamare i file di un altro sarebbe
 * un varco (l'identificativo di bozza lo scegli tu, quindi indovinarlo è
 * possibile).
 */
async function contaAllegatiBozza(
  session: Session, tenantId: string, draftId: string, field: string, userId: string | null,
): Promise<number> {
  const rows = await runQuery<{ n: number }>(session, `
    MATCH (a:Attachment {tenant_id: $tenantId, entity_type: $draftType, entity_id: $draftId, field_name: $field})
    WHERE $userId IS NULL OR a.uploaded_by = $userId
    RETURN count(a) AS n`,
  { tenantId, draftType: FORM_DRAFT_ENTITY_TYPE, draftId, field, userId })
  return Number(rows[0]?.n ?? 0)
}

/**
 * Reclama i file della bozza per il ticket appena creato: gli stessi nodi
 * `:Attachment`, con `entity_type`/`entity_id` che passano dalla bozza al
 * ticket. Nessun file si muove sul disco — il percorso è già scritto in
 * `storage_path` ed è opaco — quindi qui non c'è niente che possa fallire a
 * metà lasciando un file orfano e un nodo giusto.
 *
 * Restituisce quanti ne ha reclamati: il chiamante lo registra.
 */
export async function claimDraftAttachments(
  session: Session, tenantId: string, draftId: string, entityType: string, entityId: string, userId: string | null,
): Promise<number> {
  const rows = await runQuery<{ n: number }>(session, `
    MATCH (a:Attachment {tenant_id: $tenantId, entity_type: $draftType, entity_id: $draftId})
    WHERE $userId IS NULL OR a.uploaded_by = $userId
    SET a.entity_type = $entityType, a.entity_id = $entityId, a.claimed_at = $now
    RETURN count(a) AS n`,
  { tenantId, draftType: FORM_DRAFT_ENTITY_TYPE, draftId, entityType, entityId, userId, now: new Date().toISOString() })
  return Number(rows[0]?.n ?? 0)
}

/**
 * Scrive le relazioni dei campi di riferimento. Tre query per intero, una per
 * genere, per la stessa ragione di `assertRiferimentoEsiste`: il guardiano deve
 * poterle mandare in EXPLAIN.
 *
 * `MERGE` sulla relazione col nome del campo: due volte lo stesso riferimento
 * non fa due archi, e il campo resta leggibile da chi rilegge le risposte.
 */
export async function writeFormReferences(
  session: Session, tenantId: string, entityLabelIsServiceRequest: true, entityId: string,
  references: readonly FormReferenceWrite[],
): Promise<void> {
  void entityLabelIsServiceRequest
  for (const r of references) {
    for (const id of r.ids) {
      const params = { entityId, id, tenantId, field: r.field }
      switch (r.fieldType) {
        case 'ref_ci':
          await runQuery(session, `
            MATCH (t:ServiceRequest {id: $entityId, tenant_id: $tenantId})
            MATCH (n:ConfigurationItem {id: $id, tenant_id: $tenantId})
            MERGE (t)-[rel:FORM_REFERS_TO_CI {field: $field}]->(n)`, params)
          break
        case 'ref_user':
          await runQuery(session, `
            MATCH (t:ServiceRequest {id: $entityId, tenant_id: $tenantId})
            MATCH (n:User {id: $id, tenant_id: $tenantId})
            MERGE (t)-[rel:FORM_REFERS_TO_USER {field: $field}]->(n)`, params)
          break
        case 'ref_team':
          await runQuery(session, `
            MATCH (t:ServiceRequest {id: $entityId, tenant_id: $tenantId})
            MATCH (n:Team {id: $id, tenant_id: $tenantId})
            MERGE (t)-[rel:FORM_REFERS_TO_TEAM {field: $field}]->(n)`, params)
          break
        default:
          throw new Error(`writeFormReferences: ${r.fieldType} is not a reference type`)
      }
    }
  }
}
