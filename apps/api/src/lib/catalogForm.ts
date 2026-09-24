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
import { refCiConditions } from './refCiFilter.js'
import type { Session } from 'neo4j-driver'
import { getSession, runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import { createMetamodelCache } from './metamodelCache.js'
import {
  CATALOG_FORM_VERSION, FORM_FIELD_NAME_RE, FORM_FIELD_TYPES, FORM_FIELD_TYPES_MULTI,
  FORM_FIELD_TYPES_WITHOUT_ANSWER, FORM_FIELD_TYPES_WITH_VOCABULARY, FORM_CONDITION_OPS,
  FORM_CONDITION_OPS_WITHOUT_VALUE, FORM_DRAFT_ENTITY_TYPE, FORM_FIELD_TYPES_AS_PROPERTY,
  canBeConditionSubject, catalogFormConditionFieldNames, catalogFormFieldNames, catalogFormForEndUser,
  formItemsToFill, formulaInput, isFormTableColumnType, isFormTableType,
  FORM_TABLE_COLUMN_TYPES, FORM_TABLE_VERSION, FORM_TABLE_V1_KEYS,
  isFormAnswerEmpty, isFormAttachmentType, isFormConditionOp, isFormFieldType, isFormReferenceType,
  isFormTableRowEmpty,
  parseLocalizedLabels,
  type CatalogFormDefinition, type CatalogFormItem, type CatalogFormSection,
  type FormAnswerValue, type FormAnswers, type FormCondition, type FormFieldType, type LocalizedLabel,
  type FormTableColumn, type FormTableDefinition, type FormTableRow,
} from '@opengraphity/types'
import { NotFoundError, ValidationError } from './errors.js'
// Le lingue del prodotto: il titolo di una sezione le vuole tutte.
import { LINGUE } from './enumValueLabels.js'
import type { RelationFieldDef } from './filterBuilder.js'
import { assertCustomFieldName } from './customFieldName.js'
import { loadVocabularyEntries } from './vocabularyEntries.js'
import { logger } from './logger.js'
import { runFormulaScript, runValidationScript } from './metamodelScript.js'
import { labelFor, type EnumValueLabels } from './enumValueLabels.js'
import { languageFor, languageForUser } from './tenantLanguage.js'

/** Il log di questo percorso: prima non ne aveva nessuno (revisione del 17 set 2026). */
const log = logger.child({ module: 'catalog-form' })

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
  /** Le colonne, se il campo è una TABELLA (ondata 7); null per tutti gli altri tipi. */
  tableDefinition: FormTableDefinition | null
  /**
   * I TIPI DI CI fra cui si può scegliere, per un campo `ref_ci` (18 set 2026).
   *
   * Vuoto = tutta la CMDB, che è quello che facevano tutti i campi prima: la
   * ricerca offriva ogni CI del tenant, e una domanda «quale stampante?»
   * proponeva anche i firewall. Chi compila non sa quale sia la risposta
   * giusta, e chi legge la richiesta si ritrova un riferimento che non
   * c'entra.
   */
  refTypes: string[]
  /**
   * IL FILTRO sui CI offerti da un `ref_ci`, come JSON `{rules:[…]}` — lo
   * stesso documento che la CMDB usa nelle sue liste, quindi la semantica e
   * una sola (`buildAdvancedWhere`). Null = nessun filtro oltre ai tipi.
   */
  refFilter: string | null
  /**
   * CONDIVISO NELLA LIBRERIA (18 set 2026).
   *
   * Un campo nasce DENTRO un modulo e, per difetto, resta suo: non compare
   * fra i campi da riusare. Chi vuole la stessa domanda su più moduli lo dice
   * — ed è la scelta del proprietario, che si era ritrovato nella barra degli
   * attrezzi gli scarti di ogni prova fatta.
   *
   * Assente = non condiviso: i campi nati prima di questa scelta li sistema la
   * migrazione, che marca condivisi quelli usati da più di un modulo — perché
   * quelli lo sono davvero, comunque siano nati.
   */
  shared: boolean
  /** Se diventa una colonna nelle liste e nell'esportazione (ondata 4). */
  inList: boolean
  createdAt: string | null
  updatedAt: string | null
}

// ── La libreria ─────────────────────────────────────────────────────────────

const FIELD_RETURN = `
  f.id AS id, f.name AS name, f.field_type AS fieldType, f.label AS label, f.labels AS labels,
  f.help AS help, f.helps AS helps, f.required AS required, f.vocabulary AS vocabulary,
  f.validation_script AS validationScript, f.formula AS formula,
  f.table_definition AS tableDefinition, f.in_list AS inList, f.ref_types AS refTypes, f.shared AS shared,
  f.ref_filter AS refFilter,
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
    tableDefinition: parseFormTable(row['tableDefinition'], `FormField ${name} (table)`),
    // Assente sui campi nati prima: nessun filtro, cioè tutta la CMDB —
    // esattamente quello che facevano.
    refTypes: Array.isArray(row['refTypes']) ? (row['refTypes']).map((x) => String(x)) : [],
    shared: row['shared'] === true,
    refFilter: row['refFilter'] == null || row['refFilter'] === '' ? null : String(row['refFilter']),
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

/**
 * UN'AUTOMAZIONE PUÒ SCRIVERLO? (ondata 8) — la regola, in un posto solo.
 *
 * La usano tutti e tre i lati, e devono dire la stessa cosa: il client per
 * OFFRIRE il campo nell'azione (`settableByAutomation` in
 * `entityFilterFields`), la validazione della regola per ACCETTARLA
 * (`assertAutomationFieldWrites`), e `writeFormAnswer` per
 * scrivere. Quando erano due, il client offriva un campo che la validazione
 * rifiutava — visto dal vivo su c-test: «modello_richiesto non è un campo di
 * questo tipo di ticket» su un campo che la tendina proponeva.
 *
 * Fuori: i campi con FORMULA (li calcola il server), le scelte MULTIPLE (sul
 * nodo sono liste), e tutto ciò che non diventa una proprietà (note, allegati,
 * riferimenti, tabelle).
 */
export function settableByAutomation(d: FormFieldDef): boolean {
  if (d.formula) return false
  if (FORM_FIELD_TYPES_MULTI.includes(d.fieldType)) return false
  return FORM_FIELD_TYPES_AS_PROPERTY.includes(d.fieldType)
}

/**
 * Il tipo di un campo di modulo nel vocabolario della validazione delle azioni
 * (`StepFieldMeta`): un modulo parla di `text`/`textarea`/`datetime`, quella
 * validazione di stringa, numero, data, sì/no, enum. Un tipo senza
 * corrispondente resta FUORI, invece di arrivare come «?tipo».
 */
const FORM_TYPE_TO_STEP_FIELD: Readonly<Record<string, string>> = {
  text: 'string', textarea: 'string', number: 'number',
  date: 'date', datetime: 'date', boolean: 'boolean', enum: 'enum',
}

/**
 * I campi della LIBRERIA che un'automazione può scrivere, nella forma che
 * `assertStepFieldValue` sa validare (nome, tipo, valori del vocabolario).
 * Solo per le RICHIESTE: sono le sole che compilano un modulo.
 */
export async function formFieldAutomationMetas(
  session: Session, tenantId: string, entityType: string,
): Promise<Map<string, { name: string; fieldType: string; enumValues: string[]; enumTypeName: string | null }>> {
  const out = new Map<string, { name: string; fieldType: string; enumValues: string[]; enumTypeName: string | null }>()
  if (entityType !== 'service_request') return out
  for (const d of await formFields(session, tenantId)) {
    if (!settableByAutomation(d)) continue
    const tipo = FORM_TYPE_TO_STEP_FIELD[d.fieldType]
    if (!tipo) continue
    const valori = d.vocabulary ? (await loadVocabularyEntries(tenantId, d.vocabulary)).values as string[] : []
    out.set(d.name, { name: d.name, fieldType: tipo, enumValues: valori, enumTypeName: d.vocabulary })
  }
  return out
}

/**
 * Le ETICHETTE dei campi che hanno una formula (ondata 6). La usa la
 * diagnostica di configurazione per dire all'amministratore che i suoi campi
 * calcolati non gireranno con gli script spenti.
 */
export async function formFieldsWithFormula(tenantId: string): Promise<string[]> {
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ label: string }>(session, `
      MATCH (f:FormField {tenant_id: $tenantId})
      WHERE f.formula IS NOT NULL AND f.formula <> ''
      RETURN f.label AS label
      ORDER BY toLower(f.label)`, { tenantId })
    return rows.map((r) => String(r.label))
  } finally { await session.close() }
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
  if (o['readOnly'] != null) {
    if (typeof o['readOnly'] !== 'boolean') throw new ValidationError(`${where}: readOnly must be true or false.`, { key: 'errors.catalogForm.shape', params: { where } })
    item['readOnly'] = o['readOnly']
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
  /*
   * LE COLONNE DELLA SEZIONE (18 set 2026). Solo 1 o 2: tre colonne su un
   * modulo che si compila anche da telefono non sono una scelta, sono un
   * errore che si vede tardi. Assente = una colonna, come tutti i moduli
   * scritti finora — nessuno cambia aspetto da solo.
   */
  const colonne = o['columns']
  if (colonne !== undefined && colonne !== null) {
    if (colonne !== 1 && colonne !== 2) {
      throw new ValidationError(`${where}: columns must be 1 or 2.`, { key: 'errors.catalogForm.sectionColumns', params: { where } })
    }
    if (colonne === 2) s['columns'] = 2
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
      throw new Error(`${where}: form is not valid JSON (${e instanceof Error ? e.message : String(e)})`, { cause: e })
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

    /*
     * IL TITOLO DELLA SEZIONE, IN TUTTE LE LINGUE DEL PRODOTTO (18 set 2026).
     *
     * Prima si poteva pubblicare una sezione senza nome, in silenzio: nel
     * grafo restava `title: {}` e a schermo un blocco anonimo. Il proprietario
     * ci è arrivato dal vivo — «riaprendo non vedo il titolo della sezione» —
     * e la domanda giusta non era «dov'è finito» ma «perché si è potuto
     * pubblicare senza».
     *
     * Entrambe le lingue, per scelta del proprietario: una sezione tradotta a
     * metà si scopre quando qualcuno apre il modulo nell'altra lingua, cioè
     * troppo tardi. Il rifiuto NOMINA la sezione e la lingua che manca, perché
     * su un modulo di sei sezioni «manca un titolo» non basta a nessuno.
     */
    for (const lingua of LINGUE) {
      const testo = (s.title as Record<string, string | undefined>)[lingua]
      if (typeof testo !== 'string' || testo.trim() === '') {
        throw new ValidationError(
          `The section "${s.id}" has no title in ${lingua}: a section without a name is an anonymous block on the form.`,
          { key: 'errors.catalogForm.sectionTitleRequired', params: { section: s.id, language: lingua } },
        )
      }
    }
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
       * NEL PORTALE SI SCEGLIE FRA I CI DI UN TIPO, non si naviga la CMDB
       * (20 set 2026, decisione del proprietario dal giro nel browser).
       *
       * Il divieto nasceva da una ragione giusta — «un utente finale non
       * naviga la CMDB» — ma la conseguenza si è vista dal vivo su una voce
       * che l'AI aveva appena creato: «Richiesta di accesso ad applicazione»,
       * la cui descrizione dice «un'applicazione presente in CMDB», dal
       * portale non poteva chiedere QUALE. Il richiedente la scriveva nella
       * motivazione, se ci pensava, e un operatore la collegava dopo leggendo
       * il testo libero.
       *
       * La regola adesso: un riferimento a CI si offre nel portale SOLO se il
       * campo dichiara i tipi ammessi. Allora non è una ricerca nella CMDB, è
       * una scelta in un elenco — «le Business Application», come un
       * vocabolario — e il portale la chiede al prodotto
       * (`portalReferenceChoices`), che risponde con i CI di QUEI tipi e
       * niente altro. Senza tipi dichiarati il campo resta dell'area di
       * lavoro: là la ricerca libera ha senso, nel portale no.
       *
       * Persone e squadre restano fuori: nessuno le ha chieste, e «l'elenco
       * del personale» era l'altra metà della ragione originale.
       */
      if (isFormReferenceType(f.fieldType) && i.endUser !== false) {
        const tipiDichiarati = f.fieldType === 'ref_ci' && (f.refTypes?.length ?? 0) > 0
        if (!tipiDichiarati) {
          throw new ValidationError(
            `The field "${i.field}" is a reference (${f.fieldType}) without declared CI types: in the portal one picks from a list, not by searching the CMDB. Declare which CI types it points to, or untick "offer it in the portal".`,
            { key: 'errors.catalogForm.referenceEndUserNeedsTypes', params: { field: i.field, fieldType: f.fieldType } },
          )
        }
      }
      /**
       * OBBLIGATORIO + NON OFFERTO NEL PORTALE = UN DATO CHE NON ARRIVERÀ MAI
       * (revisione del 17 set 2026).
       *
       * Ogni voce di catalogo attiva è offerta nel portale, e dal portale i
       * campi `endUser: false` non si chiedono nemmeno — `visibleFormItems` li
       * salta PRIMA del controllo di obbligatorietà. Quindi chi compila da lì
       * non viene bloccato: la domanda semplicemente non gli viene fatta, la
       * richiesta nasce senza quel dato, e non esiste un modo di riempirlo
       * dopo. Un buco silenzioso, garantito, su ogni richiesta dal portale.
       *
       * Il rifiuto sta QUI e non a chi compila: è l'amministratore che può
       * rimediare, e ha due strade — offrire il campo nel portale, o non
       * pretenderlo. Nota che i RIFERIMENTI sono per forza non offerti (regola
       * sopra): un riferimento obbligatorio non si pubblica, e questo è il
       * modo giusto di scoprirlo.
       */
      /*
       * SOLA LETTURA + OBBLIGATORIO = un dato che nessuno puo mettere.
       *
       * Un campo in sola lettura non si compila: se e anche obbligatorio, la
       * richiesta non nasce — e chi compila si trova bloccato davanti a un
       * campo che non puo toccare. L'eccezione e il campo CALCOLATO: li il
       * valore ce lo mette la formula, quindi obbligatorio ha senso.
       */
      if (i.readOnly === true && (i.required ?? f.required) && !f.formula) {
        throw new ValidationError(
          `The field "${i.field}" is read-only and required, and it has no formula: nobody could ever fill it, so the request could not be created. Either drop the requirement, or give the field a formula.`,
          { key: 'errors.catalogForm.readOnlyRequired', params: { field: i.field } },
        )
      }
      if ((i.required ?? f.required) && i.endUser === false) {
        throw new ValidationError(
          `The field "${i.field}" is required but it is not offered in the portal: a request opened from the portal would never be asked for it, and nothing can fill it afterwards. Either offer it in the portal, or stop requiring it.`,
          { key: 'errors.catalogForm.requiredNotForEndUser', params: { field: i.field } },
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
  /** Per i campi TABELLA: le righe, valore per nome di colonna (ondata 7). */
  rows?: readonly FormTableRow[] | null
}

/** `[{name, value}]` → `{name: valore}`, la forma che il valutatore delle condizioni si aspetta. */
export function formAnswerMap(inputs: readonly FormAnswerInput[] | null | undefined): FormAnswers {
  const out: Record<string, FormAnswerValue> = {}
  for (const i of inputs ?? []) out[i.name] = i.values != null ? [...i.values] : (i.value ?? null)
  return out
}

/**
 * Le voci del modulo che, date queste risposte, sono davvero da compilare.
 *
 * È LA STESSA FUNZIONE del browser, non una copia: `formItemsToFill` vive in
 * `@opengraphity/types`. Il nome locale resta perché lo chiamano venti punti,
 * e perché dal server si legge meglio così.
 */
export function visibleFormItems(def: CatalogFormDefinition, answers: FormAnswers, opts: { endUser?: boolean } = {}): CatalogFormItem[] {
  return formItemsToFill(def, answers, opts)
}

/**
 * UNA DATA SI SALVA IN UNA FORMA SOLA (revisione del 17 set 2026).
 *
 * Il controllo era `Date.parse` e poi si scriveva il TESTO GREZZO. Ma la
 * risposta diventa una proprietà del ticket, e su quella proprietà i filtri
 * delle liste, i report e le condizioni fanno confronti d'ORDINE: su una
 * stringa l'ordine è lessicografico. Una data scritta `01/02/2026` — che
 * `Date.parse` accetta, e che un client REST o un browser con un formato
 * locale può mandare — non veniva trovata da «dopo il 2026-01-01» e in un
 * raggruppamento per mese finiva a parte. Peggio: un report che la converte
 * con `datetime()` manda in errore tutta la sezione.
 *
 * `date` → `YYYY-MM-DD`, senza fuso: una data di calendario non è un istante.
 * `datetime` senza fuso → si aggiungono i secondi e basta (`2026-03-01T10:00`
 * resta le dieci di quel giorno: convertirlo in UTC sposterebbe l'ora che chi
 * compila ha scritto). Con un fuso dichiarato è un istante, e si normalizza in
 * UTC perché due istanti uguali si devono leggere uguali.
 */
function normalizzaData(fieldType: string, testo: string): string {
  if (fieldType === 'date') {
    // Già `YYYY-MM-DD…`: si prendono i tre numeri e basta.
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(testo)
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
    /*
     * Altrimenti si legge quello che il parser ha capito, NEI CAMPI LOCALI.
     * Passare da `toISOString()` sposterebbe il giorno: `new Date('02/01/2026')`
     * è la mezzanotte LOCALE del primo febbraio, che in UTC è il 31 gennaio —
     * e una data di calendario non ha un fuso da convertire. (Difetto del
     * rimedio stesso, trovato dal test che lo accompagna.)
     */
    const d = new Date(testo)
    const due = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${due(d.getMonth() + 1)}-${due(d.getDate())}`
  }
  const locale = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.exec(testo)
  if (locale) return locale[1] ? testo : `${testo}:00`
  return new Date(testo).toISOString()
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
      return normalizzaData(def.fieldType, testo)
    }
    case 'enum': {
      /*
       * UN VOCABOLARIO VUOTO È UN ERRORE DI CONFIGURAZIONE, non un permesso
       * (revisione del 17 set 2026). Il controllo era «se ci sono valori
       * ammessi»: chi pubblicava un modulo prima di riempire il Dizionario
       * otteneva un campo che accetta QUALUNQUE testo, e quei valori finivano
       * come proprietà del ticket — in filtri, report e widget, con scelte che
       * il Dizionario non conosce e che nessuno saprebbe da dove vengono.
       * La pubblicazione verifica che il vocabolario ESISTA; qui si pretende
       * che abbia qualcosa dentro.
       */
      if (allowed && allowed.length === 0) {
        throw new ValidationError(
          `The field "${def.label}" chooses from a Dictionary that has no values yet: fill it in Settings → Dictionary, or the field cannot be answered.`,
          { key: 'errors.formField.vocabularyEmpty', params: { field: def.label, vocabulary: def.vocabulary ?? '' } },
        )
      }
      if (allowed && !allowed.includes(testo)) {
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
  opts: { endUser?: boolean; draftId?: string | null; userId?: string | null; maxTableRows?: number } = {},
): Promise<FormWriteResult> {
  /**
   * La lingua di chi legge i rifiuti: le etichette dei campi entrano nei
   * messaggi, e l'etichetta base è quella con cui il campo è nato (spesso
   * inglese). Una lettura sola per salvataggio.
   */
  // La lingua di CHI COMPILA quando la si conosce, non quella del cliente: un
  // utente inglese su un tenant italiano leggeva l'etichetta nell'altra lingua.
  const lingua = await languageForUser(tenantId, opts.userId)
  /** L'etichetta del campo per i messaggi. */
  const nome = (c: FormFieldDef): string => etichettaDelCampo(c, lingua)
  /*
   * LA FORMA DELLA RISPOSTA SI CONTROLLA PRIMA DI TUTTO, ed è un varco che si
   * chiude qui e non più in basso (revisione del 17 set 2026).
   *
   * `formAnswerMap` preferisce `values` a `value` — deve, perché una selezione
   * multipla è una lista — anche quando `values` è una lista VUOTA. Ma la
   * scrittura di un campo a valore singolo legge `value`. Quindi
   * `{value: '5000', values: []}` su un campo numerico faceva due cose insieme:
   * per le CONDIZIONI quel campo risultava vuoto (ogni regola falsa, quindi un
   * campo di approvazione obbligatorio sopra i mille non veniva mai chiesto) e
   * per il TICKET valeva 5000. Il renderer manda sempre una forma sola, quindi
   * era un attacco via API, non un difetto quotidiano — ma la mappa delle
   * risposte è la base su cui si rivaluta tutto, e una base falsificabile
   * rende inutili i tre controlli che seguono.
   *
   * La regola: la forma della risposta deve corrispondere al TIPO del campo.
   * Chi manda l'altra è un client con un difetto, e glielo si dice.
   */
  for (const input of inputs ?? []) {
    const campo = library.get(input.name)
    if (!campo) continue                          // lo dice il controllo 1, con il suo messaggio
    const multi = FORM_FIELD_TYPES_MULTI.includes(campo.fieldType)
    if (!multi && input.values != null) {
      throw new ValidationError(
        `The field "${nome(campo)}" holds one value: it was sent as a list. Send "value", not "values".`,
        { key: 'errors.catalogForm.answerNotAList', params: { field: nome(campo), name: campo.name } },
      )
    }
    if (multi && input.value != null && String(input.value).trim() !== '') {
      throw new ValidationError(
        `The field "${nome(campo)}" holds several values: it was sent as one. Send "values", not "value".`,
        { key: 'errors.catalogForm.answerNotASingleValue', params: { field: nome(campo), name: campo.name } },
      )
    }
    /*
     * E le altre due forme, che venivano BUTTATE IN SILENZIO: un `refIds` su un
     * campo di testo e un `rows` su un campo che non è una tabella. Lo stesso
     * file rifiuta a voce alta un campo nascosto, un calcolato mandato e una
     * colonna inesistente — qui taceva, e chi aveva sbagliato la chiamata
     * credeva di aver scritto qualcosa (revisione del 17 set 2026).
     */
    if (input.refIds != null && !isFormReferenceType(campo.fieldType)) {
      throw new ValidationError(
        `The field "${nome(campo)}" is not a reference: it takes a value, not ids.`,
        { key: 'errors.catalogForm.answerNotAReference', params: { field: nome(campo), name: campo.name } },
      )
    }
    if (input.rows != null && !isFormTableType(campo.fieldType)) {
      throw new ValidationError(
        `The field "${nome(campo)}" is not a table: it takes a value, not rows.`,
        { key: 'errors.catalogForm.answerNotATable', params: { field: nome(campo), name: campo.name } },
      )
    }
  }
  const nelModulo = new Set(catalogFormFieldNames(def))

  const out: Record<string, unknown> = {}
  const riferimenti: FormReferenceWrite[] = []
  const tabelle: FormTableWrite[] = []
  const vocabolari = new Map<string, readonly string[]>()
  const vocabolarioDi = async (nome: string): Promise<readonly string[] | null> => {
    if (vocabolari.has(nome)) return vocabolari.get(nome)!
    const v = await loadVocabularyEntries(tenantId, nome)
    vocabolari.set(nome, v.values)
    return v.values
  }

  /*
   * ── LE FORMULE GIRANO PRIMA DELLA VISIBILITÀ ───────────────────────────────
   *
   * Scelta del proprietario (17 set 2026), dopo che il difetto è stato
   * riprodotto nel browser: una condizione su un campo CALCOLATO si deve
   * poter scrivere. «Chiedi la giustificazione se il costo totale supera
   * mille» è la prima regola che un cliente scrive, e il costruttore la
   * offriva già.
   *
   * Prima l'ordine era: visibilità → rifiuti → formule. Quindi per il server
   * un campo calcolato era SEMPRE vuoto quando valutava le condizioni (i
   * calcolati non arrivano dal client: li rifiuta, giustamente), mentre il
   * browser li aveva già in mano. Risultato misurato: il campo compariva, si
   * compilava, e al salvataggio arrivava «il campo non viene chiesto con
   * queste risposte» — richiesta non creabile, mai.
   *
   * Ora l'ordine è: formule → visibilità → rifiuti → scrittura. Le tre cose
   * che lo tengono in piedi:
   *
   *  1. NIENTE CATENE, come prima: una formula vede solo le risposte dei campi
   *     NON calcolati (`formulaInput`), quindi eseguirle tutte insieme non
   *     crea dipendenze fra loro e non c'è nessun ciclo da riconoscere.
   *  2. I VALORI GREZZI per la formula si convertono in modo TOLLERANTE: qui
   *     non si rifiuta niente, perché i rifiuti veri hanno il loro posto più
   *     sotto e devono restare nell'ordine di prima (un campo nascosto che
   *     arriva è più informativo di «questo numero non è un numero»). Per una
   *     richiesta valida le risposte sono solo quelle visibili, quindi la
   *     formula vede esattamente quello che vedeva prima.
   *  3. UNA FORMULA CHE FALLISCE non ferma il salvataggio QUI: l'errore si
   *     ricorda e si solleva dov'era prima, cioè scrivendo quel campo se è
   *     visibile. Una formula rotta su un campo che nessuno vede non deve
   *     rompere la richiesta.
   */
  const calcolatiDelModulo = [...nelModulo].filter((n) => library.get(n)?.formula)
  /** Le risposte convertite per la formula: nessun rifiuto, vedi il punto 2. */
  const grezze: Record<string, unknown> = {}
  if (calcolatiDelModulo.length > 0) {
    for (const input of inputs ?? []) {
      const campo = library.get(input.name)
      if (!campo || campo.formula) continue
      if (FORM_FIELD_TYPES_MULTI.includes(campo.fieldType)) {
        grezze[input.name] = (input.values ?? []).map((v) => String(v).trim()).filter((v) => v !== '')
        continue
      }
      if (!FORM_FIELD_TYPES_AS_PROPERTY.includes(campo.fieldType)) continue
      const raw = input.value
      if (raw == null || String(raw).trim() === '') continue
      try {
        grezze[input.name] = coerce(campo, String(raw), campo.vocabulary ? await vocabolarioDi(campo.vocabulary) : null)
      } catch {
        // Tollerante di proposito: il rifiuto con il messaggio giusto arriva più sotto.
      }
    }
  }
  /** Per campo calcolato: il valore, oppure l'errore da sollevare al momento di scriverlo. */
  const formule = new Map<string, { value: unknown } | { error: string }>()
  if (calcolatiDelModulo.length > 0) {
    const perLaFormula = formulaInput(grezze, new Set(calcolatiDelModulo))
    for (const n of calcolatiDelModulo) {
      const campo = library.get(n)!
      const esito = await runFormulaScript(campo.formula!, perLaFormula, campo.name, tenantId)
      formule.set(n, esito.ok ? { value: esito.value } : { error: esito.error })
    }
  }

  /**
   * Le risposte con cui si valutano le condizioni: quelle mandate più i valori
   * calcolati, normalizzati come li normalizza il browser (`null`, booleano e
   * numero così come sono, tutto il resto come testo) — se i due lati
   * normalizzassero diversamente, la stessa condizione direbbe due cose.
   */
  const answers: Record<string, FormAnswerValue> = { ...formAnswerMap(inputs) }
  for (const [n, esito] of formule) {
    if ('error' in esito) continue
    const v = esito.value
    answers[n] = v == null || (typeof v === 'number' && !Number.isFinite(v)) || String(v).trim() === ''
      ? null
      : typeof v === 'boolean' || typeof v === 'number' ? v : String(v)
  }
  const visibili = visibleFormItems(def, answers, opts)
  const perNome = new Map(visibili.map((i) => [i.field, i]))

  for (const input of inputs ?? []) {
    if (!nelModulo.has(input.name)) {
      throw new ValidationError(`"${input.name}" is not a field of this form.`,
        { key: 'errors.catalogForm.answerUnknown', params: { field: input.name, name: input.name } })
    }
    const item = perNome.get(input.name)
    if (!item) {
      throw new ValidationError(`The field "${input.name}" is not being asked with these answers: it is hidden by a condition, or not offered here.`,
        { key: 'errors.catalogForm.answerHidden', params: { field: input.name, name: input.name } })
    }
    const campo = library.get(input.name)!
    if (FORM_FIELD_TYPES_WITHOUT_ANSWER.includes(campo.fieldType)) {
      throw new ValidationError(`The field "${input.name}" is a note: it carries no answer.`,
        { key: 'errors.catalogForm.answerNote', params: { field: input.name, name: input.name } })
    }
    /**
     * Un campo CALCOLATO non si riceve: lo calcola il server (ondata 6). Il
     * rifiuto invece del silenzio perché un client che lo manda ha un difetto,
     * e ignorarlo lascerebbe credere che il valore mandato conti qualcosa.
     */
    if (campo.formula) {
      throw new ValidationError(`The field "${nome(campo)}" is computed: its value comes from its formula, it cannot be sent.`,
        { key: 'errors.catalogForm.answerComputed', params: { field: nome(campo), name: campo.name } })
    }
    /*
     * Un campo in SOLA LETTURA non si riceve da chi compila, per la stessa
     * ragione: il modulo non gliel'ha nemmeno offerto, quindi un valore che
     * arriva viene da un client che non rispetta il documento. Le automazioni
     * passano da un'altra strada (`writeFormAnswer`) e non da qui.
     */
    if (item.readOnly === true) {
      throw new ValidationError(`The field "${nome(campo)}" is read-only in this form: its value does not come from whoever fills it.`,
        { key: 'errors.catalogForm.answerReadOnly', params: { field: nome(campo), name: campo.name } })
    }

    const multi = FORM_FIELD_TYPES_MULTI.includes(campo.fieldType)
    if (multi) {
      const valori = (input.values ?? []).map((v) => String(v).trim()).filter((v) => v !== '')
      if (valori.length === 0) { out[input.name] = null; continue }
      const allowed = campo.vocabulary ? await vocabolarioDi(campo.vocabulary) : null
      if (allowed && allowed.length === 0) {
        throw new ValidationError(
          `The field "${nome(campo)}" chooses from a Dictionary that has no values yet: fill it in Settings → Dictionary, or the field cannot be answered.`,
          { key: 'errors.formField.vocabularyEmpty', params: { field: nome(campo), name: campo.name, vocabulary: campo.vocabulary ?? '' } },
        )
      }
      for (const v of valori) {
        if (allowed && !allowed.includes(v)) {
          throw new ValidationError(`"${v}" is not a value of "${nome(campo)}" (allowed: ${allowed.join(', ')}).`,
            { key: 'errors.formField.notInVocabulary', params: { field: nome(campo), name: campo.name, value: v, allowed: allowed.join(', ') } })
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
        throw new ValidationError(`The field "${nome(campo)}" takes one reference, ${ids.length} were sent.`,
          { key: 'errors.formField.oneReference', params: { field: nome(campo), name: campo.name, count: String(ids.length) } })
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

    /**
     * Una TABELLA non è una proprietà: sono righe (ondata 7). Si validano qui —
     * colonne, tipi, obbligatorietà, tetto — e si scrivono alla creazione, come
     * le relazioni dei riferimenti. Il controllo sta PRIMA del ripiego su
     * `coerce` più sotto: senza, una tabella finirebbe stringata in una
     * proprietà, che è il documento opaco che questo modulo evita.
     */
    if (isFormTableType(campo.fieldType)) {
      const righe = await validaRigheTabella(campo, nome(campo), input.rows ?? [], vocabolarioDi, opts.maxTableRows ?? Number.POSITIVE_INFINITY)
      if (righe.length > 0) tabelle.push({ field: campo.name, rows: righe })
      continue
    }

    const raw = input.value
    if (raw == null || String(raw).trim() === '') { out[input.name] = null; continue }
    const allowed = campo.vocabulary ? await vocabolarioDi(campo.vocabulary) : null
    out[input.name] = coerce(campo, String(raw), allowed)
  }

  /**
   * I CAMPI CALCOLATI (ondata 6) si SCRIVONO qui, prima dell'obbligatorietà:
   * una formula che non produce niente su un campo obbligatorio deve far
   * fallire il salvataggio come un campo lasciato vuoto.
   *
   * Le formule sono già state eseguite più sopra, perché le condizioni le
   * guardano (decisione del 17 set 2026): qui si prende l'esito e si scrive.
   * Solo i campi VISIBILI: se una condizione nasconde il campo, la domanda non
   * è stata fatta e la formula non c'entra — per questo il rifiuto di una
   * formula rotta vive qui e non dove gira.
   */
  for (const item of visibili) {
    const campo = library.get(item.field)!
    if (!campo.formula) continue
    const esito = formule.get(campo.name)
    // Il modulo cita il campo, quindi la formula è stata eseguita sopra: se
    // manca è un difetto nostro, e si dice invece di scrivere un null.
    if (!esito) {
      throw new ValidationError(`The formula of field "${nome(campo)}" was not computed.`,
        { key: 'errors.formField.formulaFailed', params: { field: nome(campo), name: campo.name, message: 'not computed' } })
    }
    if ('error' in esito) {
      // La scelta del proprietario: si RIFIUTA e si nomina la formula. Chi
      // compila non può rimediare, ma nessun ticket nasce con un dato finto.
      // Il rifiuto sta QUI e non dove la formula gira: una formula rotta su un
      // campo che nessuno vede non deve rompere la richiesta.
      throw new ValidationError(`The formula of field "${nome(campo)}" failed: ${esito.error}`,
        { key: 'errors.formField.formulaFailed', params: { field: nome(campo), name: campo.name, message: esito.error } })
    }
    const valore = esito.value
    // `NaN`/`Infinity` non sono valori: sono il segno che la formula ha
    // moltiplicato qualcosa che non c'era. Il sandbox li fa già diventare
    // `null` passando per JSON; il controllo esplicito c'è perché la regola
    // sia scritta e non un effetto collaterale di come si serializza.
    if (valore == null || (typeof valore === 'number' && !Number.isFinite(valore)) || String(valore).trim() === '') {
      out[campo.name] = null
      continue
    }
    /**
     * UNA SQUADRA CALCOLATA non è una proprietà: è una RELAZIONE.
     *
     * La formula restituisce il NOME e il server lo risolve in un nodo
     * `Team`. È l'unico riferimento che una formula può produrre, e serve a
     * una cosa precisa: «se la sede è Milano allora il Desk di Milano», che
     * poi decide a chi va il task del workflow.
     *
     * Il nome che non si risolve è un RIFIUTO, non un campo vuoto: un refuso
     * nella formula darebbe task senza destinatario che nessuno vede. Vale la
     * stessa regola di un valore fuori vocabolario.
     *
     * Sta QUI e non nel giro sugli input mandati dal client: un campo
     * calcolato il client non lo manda mai — il renderer lo esclude e l'API
     * lo rifiuterebbe — quindi là il ramo era codice morto, e la squadra non
     * veniva scritta. Trovato provando dal portale, non dai test.
     */
    if (isFormReferenceType(campo.fieldType)) {
      const nomeSquadra = String(valore).trim()
      const riga = await runQueryOne<{ id: string }>(session, `
        MATCH (t:Team {tenant_id: $tenantId}) WHERE t.name = $nomeSquadra RETURN t.id AS id LIMIT 1
      `, { tenantId, nomeSquadra })
      if (!riga) {
        throw new ValidationError(
          `The formula of "${nome(campo)}" returned the team "${nomeSquadra}", which does not exist.`,
          { key: 'errors.formField.teamNotFound', params: { field: nome(campo), name: campo.name, team: nomeSquadra } },
        )
      }
      riferimenti.push({ field: campo.name, fieldType: campo.fieldType, ids: [riga.id] })
      continue
    }
    const allowed = campo.vocabulary ? await vocabolarioDi(campo.vocabulary) : null
    // Lo stesso `coerce` di un valore scritto a mano: una formula che
    // restituisce «pippo» per un numero, o un valore fuori vocabolario, viene
    // rifiutata dalle regole che valgono per tutti.
    out[campo.name] = coerce(campo, String(valore), allowed)
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
      const quanti = opts.draftId && opts.userId
        ? await contaAllegatiBozza(session, tenantId, opts.draftId, campo.name, opts.userId)
        : 0
      allegatiRichiesti.push({ field: campo.name, label: campo.label, required: obbligatorio, count: quanti })
      if (obbligatorio && quanti === 0) {
        throw new ValidationError(`The field "${nome(campo)}" needs at least one file.`,
          { key: 'errors.formField.fileRequired', params: { field: nome(campo), name: campo.name } })
      }
      continue
    }

    if (isFormReferenceType(campo.fieldType)) {
      if (obbligatorio && !riferimenti.some((r) => r.field === campo.name)) {
        throw new ValidationError(`The field "${nome(campo)}" is required.`,
          { key: 'errors.formField.required', params: { field: nome(campo), name: campo.name } })
      }
      continue
    }

    // Una TABELLA obbligatoria vuole almeno una riga piena: ogni genere di
    // campo ha il suo modo di essere vuoto, e per una tabella è «zero righe».
    if (isFormTableType(campo.fieldType)) {
      if (obbligatorio && !tabelle.some((t) => t.field === campo.name && t.rows.length > 0)) {
        throw new ValidationError(`The table "${nome(campo)}" needs at least one row.`,
          { key: 'errors.formTable.rowRequired', params: { field: nome(campo), name: campo.name } })
      }
      continue
    }

    if (!obbligatorio) continue
    const scritto = Object.prototype.hasOwnProperty.call(out, item.field) ? out[item.field] : undefined
    const vuoto = scritto === undefined
      ? isFormAnswerEmpty(answers[item.field])
      : isFormAnswerEmpty(scritto as FormAnswerValue)
    if (vuoto) {
      throw new ValidationError(`The field "${nome(campo)}" is required.`,
        { key: 'errors.formField.required', params: { field: nome(campo), name: campo.name } })
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
      throw new ValidationError(`The field "${nome(campo)}" was refused: ${rifiuto}`,
        { key: 'errors.formField.script', params: { field: nome(campo), name: campo.name, message: rifiuto } })
    }
  }

  return { props: out, references: riferimenti, attachmentFields: allegatiRichiesti, tables: tabelle }
}

/**
 * L'ETICHETTA DI UN CAMPO nella lingua di chi legge il messaggio.
 *
 * `FormFieldDef.label` è l'etichetta base, quella con cui il campo è nato — di
 * solito inglese. I messaggi di rifiuto la mettevano dentro così com'era, e un
 * utente del portale in italiano leggeva «The field "Estimated cost (EUR)" was
 * refused» — metà frase tradotta dal client, metà nome in un'altra lingua.
 * Trovato provando dal portale, non dai test.
 */
export function etichettaDelCampo(campo: FormFieldDef, lingua: string | null | undefined): string {
  if (!lingua) return campo.label
  return campo.labels.find((l) => l.language === lingua)?.label || campo.label
}

// ── La tabella ripetibile: definizione, validazione, righe (ondata 7) ────────

/**
 * Legge la definizione delle colonne di un campo tabella. Fail-loud come per il
 * documento del modulo: un JSON rotto o di una versione che non conosciamo è un
 * errore, non «una tabella senza colonne» — che sembrerebbe una configurazione.
 */
export function parseFormTable(raw: unknown, where: string): FormTableDefinition | null {
  if (raw == null || raw === '') return null
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch (e) {
      throw new Error(`${where}: table definition is not valid JSON (${e instanceof Error ? e.message : String(e)})`, { cause: e })
    }
  }
  const o = oggetto(parsed, where)
  const mancanti = FORM_TABLE_V1_KEYS.filter((k) => !(k in o))
  if (mancanti.length > 0) {
    throw new Error(`${where}: the table definition has no ${mancanti.join(', ')}: it was written by an older version of the product`)
  }
  const version = o['version']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error(`${where}: table version must be a positive integer, got ${JSON.stringify(version)}`)
  }
  if (version > FORM_TABLE_VERSION) {
    throw new Error(`${where}: the table definition is version ${version}, this build understands up to ${FORM_TABLE_VERSION}: a newer version of the product wrote it`)
  }
  const columns = o['columns']
  if (!Array.isArray(columns)) throw new Error(`${where}: table columns must be a list`)
  return {
    version,
    columns: columns.map((c, i) => leggiColonna(c, `${where}: column #${i + 1}`)),
  }
}

function leggiColonna(raw: unknown, where: string): FormTableColumn {
  const o = oggetto(raw, where)
  const name = o['name']
  if (typeof name !== 'string' || !FORM_FIELD_NAME_RE.test(name)) {
    throw new Error(`${where}: name must be lowercase letters, digits and underscores, got ${JSON.stringify(name)}`)
  }
  const fieldType = o['fieldType']
  if (!isFormTableColumnType(fieldType)) {
    throw new Error(`${where}: fieldType must be one of ${FORM_TABLE_COLUMN_TYPES.join(', ')}, got ${JSON.stringify(fieldType)}`)
  }
  const vocabulary = o['vocabulary']
  if (vocabulary != null && typeof vocabulary !== 'string') throw new Error(`${where}: vocabulary must be a string`)
  const labels = o['labels']
  if (labels != null && (typeof labels !== 'object' || Array.isArray(labels))) {
    throw new Error(`${where}: labels must be an object of language → text`)
  }
  return {
    name,
    labels: (labels ?? {}) as Record<string, string>,
    fieldType,
    vocabulary: typeof vocabulary === 'string' && vocabulary !== '' ? vocabulary : null,
    required: o['required'] === true,
  }
}

/**
 * I controlli che il costruttore di una tabella deve passare per essere
 * SALVATA. Separati dalla lettura perché sono un'altra domanda: la lettura
 * chiede «questo documento lo capisco?», questi «questa tabella ha senso?».
 */
export function assertFormTable(def: FormTableDefinition, where: string): void {
  if (def.columns.length === 0) {
    throw new ValidationError(`${where}: a table needs at least one column.`,
      { key: 'errors.formTable.noColumns', params: { field: where } })
  }
  const viste = new Set<string>()
  for (const c of def.columns) {
    if (viste.has(c.name)) {
      throw new ValidationError(`${where}: the column "${c.name}" appears twice.`,
        { key: 'errors.formTable.duplicateColumn', params: { field: where, column: c.name } })
    }
    viste.add(c.name)
    // Un enum senza vocabolario non offrirebbe nessuna scelta: è la stessa
    // regola di un campo enum della libreria, e vale detta qui perché una
    // colonna non passa da `assertVocabolario`.
    if (c.fieldType === 'enum' && !c.vocabulary) {
      throw new ValidationError(`${where}: the column "${c.name}" is a choice but has no vocabulary: it would offer nothing.`,
        { key: 'errors.formTable.columnWithoutVocabulary', params: { field: where, column: c.name } })
    }
    if (c.fieldType !== 'enum' && c.vocabulary) {
      throw new ValidationError(`${where}: the column "${c.name}" is a ${c.fieldType} and takes no vocabulary.`,
        { key: 'errors.formTable.columnVocabularyNotAllowed', params: { field: where, column: c.name, fieldType: c.fieldType } })
    }
  }
}

/**
 * LE RIGHE DI UNA TABELLA sul ticket (ondata 7).
 *
 * Un nodo per riga, appeso al ticket con l'indice: l'ordine in cui le ha
 * scritte chi compila è un dato (la prima persona dell'elenco è la prima), e
 * senza indice tornerebbe in ordine di creazione, cioè per caso.
 *
 * Le proprietà della riga sono le COLONNE, con i nomi validati alla
 * definizione: le stesse regole del nome di un campo, quindi nel Cypher
 * generato non arriva mai un nome scritto dall'utente. La mappa si passa come
 * PARAMETRO (`SET r += $valori`), non interpolata: le chiavi vengono da lì.
 */
export interface FormTableWrite {
  field: string
  rows: readonly FormTableRow[]
}

export async function writeFormTables(
  session: Queryable, tenantId: string, entityId: string, tables: readonly FormTableWrite[],
): Promise<void> {
  /*
   * UNA QUERY SOLA, non una per riga (revisione del 22 set 2026).
   *
   * Erano due cicli annidati con una `runQuery` dentro: tabelle × righe
   * andate e ritorni a Neo4j per una sola compilazione, e un modulo con sei
   * tabelle da cinquanta righe ne faceva trecento. La lettura qui sotto
   * (`leggiRigheTabella`) il problema se l'era già posto e lo dice nel suo
   * commento — «leggerne una per campo vorrebbe dire una query per tabella su
   * ogni apertura di ticket» — ma la scrittura era rimasta indietro.
   *
   * L'atomicità c'era già e resta: chi chiama passa una transazione.
   */
  // Every row has an `id` (review of 23 Sep 2026): without one the restore
  // could not find it again, and matched it by its values — two requests with
  // the same line would have shared one row.
  const righe = tables.flatMap((t) =>
    t.rows.map((valori, indice) => ({ field: t.field, index: indice, values: valori })),
  )
  if (righe.length === 0) return
  await runQuery(session, `
    MATCH (s:ServiceRequest {id: $entityId, tenant_id: $tenantId})
    UNWIND $righe AS riga
    CREATE (s)-[:FORM_TABLE_ROW {field: riga.field, row_index: riga.index}]->(r:FormTableRow {tenant_id: $tenantId, id: randomUUID()})
    SET r += riga.values`,
  { entityId, tenantId, righe })
}

/**
 * Le righe di TUTTE le tabelle di un ticket, per nome di campo e in ordine. Una
 * query sola: leggerne una per campo vorrebbe dire una query per tabella su
 * ogni apertura di ticket.
 */
export async function leggiRigheTabella(
  session: Session, tenantId: string, entityId: string,
): Promise<Map<string, FormTableRow[]>> {
  const rows = await runQuery<{ field: string; values: Record<string, unknown> }>(session, `
    MATCH (s:ServiceRequest {id: $entityId, tenant_id: $tenantId})-[rel:FORM_TABLE_ROW]->(r:FormTableRow)
    RETURN rel.field AS field, properties(r) AS values
    ORDER BY rel.field, rel.row_index`, { entityId, tenantId })
  const out = new Map<string, FormTableRow[]>()
  for (const r of rows) {
    const elenco = out.get(r.field) ?? []
    // `tenant_id` è nostro, non una colonna: non si restituisce come risposta.
    const { tenant_id: _t, ...valori } = r.values
    elenco.push(Object.fromEntries(Object.entries(valori).map(([k, v]) => [k, v == null ? null : String(v)])))
    out.set(r.field, elenco)
  }
  return out
}

/**
 * Le righe arrivate dal client, controllate contro le colonne. Restituisce le
 * righe da scrivere, già convertite; lancia al primo problema, nominando la
 * RIGA e la COLONNA — «la riga 3 non ha il ruolo» è un errore che si corregge,
 * «dati non validi» no.
 *
 * Le righe VUOTE si scartano in silenzio, e qui il silenzio è giusto: una riga
 * aggiunta e mai compilata è un clic, non un dato. Le altre mantengono il loro
 * ordine, che è l'unica cosa che l'indice deve conservare.
 */
export async function validaRigheTabella(
  campo: FormFieldDef,
  /** L'etichetta del campo nella lingua di chi legge: la risolve il chiamante. */
  etichetta: string,
  righe: readonly FormTableRow[],
  vocabolarioDi: (nomeVocabolario: string) => Promise<readonly string[] | null>,
  maxRighe: number,
): Promise<FormTableRow[]> {
  const def = campo.tableDefinition
  if (!def) {
    throw new ValidationError(`The field "${etichetta}" is a table but has no columns: fix it in the field library.`,
      { key: 'errors.formTable.noColumns', params: { field: etichetta } })
  }
  const perNome = new Map(def.columns.map((c) => [c.name, c]))
  const piene = righe.filter((r) => !isFormTableRowEmpty(r))
  if (piene.length > maxRighe) {
    throw new ValidationError(`The table "${etichetta}" takes at most ${maxRighe} rows, ${piene.length} were sent.`,
      { key: 'errors.formTable.tooManyRows', params: { field: etichetta, max: String(maxRighe), count: String(piene.length) } })
  }

  const out: FormTableRow[] = []
  for (const [i, riga] of piene.entries()) {
    const numero = String(i + 1)
    const convertita: Record<string, string | null> = {}
    for (const nomeColonna of Object.keys(riga)) {
      if (!perNome.has(nomeColonna)) {
        throw new ValidationError(`The table "${etichetta}" has no column "${nomeColonna}".`,
          { key: 'errors.formTable.unknownColumn', params: { field: etichetta, column: nomeColonna } })
      }
    }
    for (const colonna of def.columns) {
      const grezzo = riga[colonna.name]
      const vuoto = grezzo == null || String(grezzo).trim() === ''
      if (vuoto) {
        if (colonna.required) {
          throw new ValidationError(`Row ${numero} of "${etichetta}": the column "${etichettaColonna(colonna)}" is required.`,
            { key: 'errors.formTable.cellRequired', params: { field: etichetta, column: etichettaColonna(colonna), row: numero } })
        }
        convertita[colonna.name] = null
        continue
      }
      const allowed = colonna.vocabulary ? await vocabolarioDi(colonna.vocabulary) : null
      convertita[colonna.name] = String(convertiCella(etichetta, colonna, String(grezzo).trim(), allowed, numero))
    }
    out.push(convertita)
  }
  return out
}

/** L'etichetta di una colonna per un messaggio d'errore: la prima che c'è, o il nome. */
function etichettaColonna(colonna: FormTableColumn): string {
  const primo = Object.values(colonna.labels)[0]
  return primo && primo.trim() !== '' ? primo : colonna.name
}

/**
 * Una cella nel tipo della sua colonna. Le stesse regole di `coerce` per un
 * campo — un numero deve essere un numero, una data una data, una scelta dentro
 * il vocabolario — ma il messaggio dice anche QUALE RIGA, che è l'unica cosa in
 * più che serve a chi sta compilando.
 *
 * Il valore torna come TESTO: sulla riga si scrive una stringa per ogni
 * colonna, perché una riga è un record di celle e non una proprietà tipizzata
 * del ticket. Il numero convertito serve a rifiutare «pippo», non a cambiare
 * come si salva.
 */
function convertiCella(
  etichetta: string, colonna: FormTableColumn, testo: string,
  allowed: readonly string[] | null, riga: string,
): string {
  const dove = { field: etichetta, column: etichettaColonna(colonna), row: riga }
  switch (colonna.fieldType) {
    case 'number': {
      const n = Number(testo)
      if (!Number.isFinite(n)) {
        throw new ValidationError(`Row ${riga} of "${etichetta}": "${testo}" is not a number for "${dove.column}".`,
          { key: 'errors.formTable.cellNotNumber', params: { ...dove, value: testo } })
      }
      return String(n)
    }
    case 'boolean':
      if (testo !== 'true' && testo !== 'false') {
        throw new ValidationError(`Row ${riga} of "${etichetta}": "${dove.column}" takes true or false, got "${testo}".`,
          { key: 'errors.formTable.cellNotBoolean', params: { ...dove, value: testo } })
      }
      return testo
    case 'date': {
      if (Number.isNaN(Date.parse(testo))) {
        throw new ValidationError(`Row ${riga} of "${etichetta}": "${testo}" is not a date for "${dove.column}".`,
          { key: 'errors.formTable.cellNotDate', params: { ...dove, value: testo } })
      }
      return testo
    }
    case 'enum':
      // Come per i campi: un vocabolario vuoto è configurazione rotta, non un
      // permesso di scrivere qualunque cosa nella cella.
      if (allowed && allowed.length === 0) {
        throw new ValidationError(
          `Row ${riga} of "${etichetta}": the column "${dove.column}" chooses from a Dictionary that has no values yet.`,
          { key: 'errors.formTable.cellVocabularyEmpty', params: { ...dove } })
      }
      if (allowed && !allowed.includes(testo)) {
        throw new ValidationError(`Row ${riga} of "${etichetta}": "${testo}" is not a value of "${dove.column}" (allowed: ${allowed.join(', ')}).`,
          { key: 'errors.formTable.cellNotInVocabulary', params: { ...dove, value: testo, allowed: allowed.join(', ') } })
      }
      return testo
    case 'text':
      return testo
  }
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
  session: Queryable, tenantId: string, itemId: string, def: CatalogFormDefinition, publishedAt: string, publishedBy: string | null,
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
  /** Per i campi TABELLA: le righe, in ordine (ondata 7). */
  rows: FormTableRow[]
  /** Le colonne della tabella, per sapere cosa mostrare e in che ordine. */
  tableColumns: readonly FormTableColumn[]
  /**
   * Le scelte del vocabolario, già con l'etichetta: servono a CORREGGERE la
   * risposta (decisione del 17 set 2026). Senza, la correzione di un campo a
   * vocabolario sarebbe una casella di testo dove bisogna indovinare il valore
   * interno — cioè il difetto che la revisione ha appena chiuso altrove. Vuota
   * per i campi senza vocabolario.
   */
  options: ReadonlyArray<{ value: string; label: string }>
}

/**
 * Le risposte di un ticket, con le domande della revisione con cui è stato
 * compilato.
 *
 * `endUser: true` = le legge chi ha compilato dal portale: si mostrano solo le
 * voci che il modulo offre a un utente finale. Le altre sono domande che a lui
 * non sono state fatte, e alcune portano dato interno.
 */
export async function formAnswersOf(
  session: Session, tenantId: string,
  ticket: { id: string; catalogItemId: string | null; formRevision: number | null; props: Record<string, unknown> },
  opts: { endUser?: boolean } = {},
): Promise<FormAnswerRead[]> {
  if (!ticket.catalogItemId || !ticket.formRevision) return []
  const completo = await catalogFormRevision(session, tenantId, ticket.catalogItemId, ticket.formRevision)
  if (!completo) {
    /*
     * La copia congelata di quella revisione non c'è: le risposte sono sul
     * nodo ma non si sa più che domande erano. Restituire una lista vuota è il
     * comportamento di prima — un ticket che dice «nessuna risposta» pur
     * avendone — e va bene per la pagina (meglio di un errore che la fa
     * cadere), ma non deve essere un SILENZIO: è un dato mancante, e ora si
     * vede nei log (revisione del 17 set 2026: questo file non ne aveva
     * nessuno).
     */
    log.warn({ tenantId, requestId: ticket.id, itemId: ticket.catalogItemId, revision: ticket.formRevision },
      'Form revision frozen copy missing: answers cannot be read with the questions of that revision')
    return []
  }
  const def = opts.endUser === true ? catalogFormForEndUser(completo) : completo
  const nomi = catalogFormFieldNames(def)
  const library = await formFieldsByName(session, tenantId, nomi)

  // Riferimenti, file e righe si leggono in tre query sole, non una per campo.
  const riferimenti = await leggiRiferimenti(session, tenantId, ticket.id)
  const file = await leggiFileDelModulo(session, tenantId, ticket.id)
  const righe = await leggiRigheTabella(session, tenantId, ticket.id)

  // Le etichette dei vocabolari citati dal modulo: una lettura per vocabolario,
  // non una per risposta.
  const leggibile = await etichetteDeiValori(tenantId, [...library.values()])
  /** Le scelte dei vocabolari citati, una lettura per vocabolario. */
  const scelte = new Map<string, Array<{ value: string; label: string }>>()
  for (const campo of library.values()) {
    if (!campo.vocabulary || scelte.has(campo.name)) continue
    const v = await loadVocabularyEntries(tenantId, campo.vocabulary)
    const etichetta = leggibile(campo.name)
    scelte.set(campo.name, (v.values as string[]).map((valore) => ({ value: valore, label: etichetta(valore) })))
  }

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
      // Le righe della tabella, nell'ordine in cui le ha scritte chi compila.
      rows: righe.get(nome) ?? [],
      // Le colonne di ALLORA le porta il campo: senza, una riga sarebbe una
      // mappa di nomi interni e chi legge non saprebbe in che ordine mostrarla.
      tableColumns: campo?.tableDefinition?.columns ?? [],
      options: scelte.get(nome) ?? [],
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
  /** Le righe delle tabelle (ondata 7): le scrive chi crea il ticket, come le relazioni. */
  tables: FormTableWrite[]
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
  let esiste: boolean
  switch (campo.fieldType) {
    case 'ref_ci': {
      // Of the field's types and within its filter, not just any CI of the
      // tenant (review of 23 Sep 2026): what the choices offer is what is accepted.
      const params: Record<string, unknown> = { id, tenantId }
      const condizioni = await refCiConditions(session, tenantId, campo.refTypes, campo.refFilter, params)
      const rows = await runQuery<{ id: string }>(session,
        `MATCH (n:ConfigurationItem {id: $id, tenant_id: $tenantId}) WHERE ${condizioni || 'true'} RETURN n.id AS id LIMIT 1`, params)
      esiste = rows.length > 0
      break
    }
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
  session: Session, tenantId: string, draftId: string, field: string, userId: string,
): Promise<number> {
  const rows = await runQuery<{ n: number }>(session, `
    MATCH (a:Attachment {tenant_id: $tenantId, entity_type: $draftType, entity_id: $draftId, field_name: $field})
    WHERE a.uploaded_by = $userId
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
 * ## SOLO I FILE DELLE DOMANDE CHE QUESTO MODULO HA FATTO
 *
 * `fields` sono i campi allegato VISIBILI con le risposte date — gli stessi
 * che `resolveFormWrites` ha usato per l'obbligatorietà. Prima si reclamava
 * TUTTO quello che stava sulla bozza, senza guardare il campo, e il difetto è
 * stato riprodotto dal vivo il 17 set 2026: nel portale si carica un file su
 * «Nuovo portatile», si chiude, si invia «Nuovo mouse» — una voce senza modulo
 * e senza campi allegato — e la richiesta del mouse si porta dietro il file
 * dell'altra, `field_name` compreso. Lo stesso accadeva col file di un campo
 * poi nascosto da una condizione: la risposta veniva dimenticata, il file no.
 *
 * La regola è quella già valida per i valori: se la domanda non è stata fatta,
 * la risposta non si prende — nemmeno quando è un file. I file rimasti sulla
 * bozza non si cancellano qui (non sono nostri da buttare): li porta via la
 * passata notturna, e quanti sono lo dice il valore restituito, perché un
 * silenzio qui era esattamente il difetto.
 */
export async function claimDraftAttachments(
  session: Queryable, tenantId: string, draftId: string, entityType: string, entityId: string, userId: string,
  fields: readonly string[],
): Promise<{ claimed: number; leftBehind: number }> {
  const comuni = { tenantId, draftType: FORM_DRAFT_ENTITY_TYPE, draftId, userId, fields: [...fields] }
  const presi = await runQuery<{ n: number }>(session, `
    MATCH (a:Attachment {tenant_id: $tenantId, entity_type: $draftType, entity_id: $draftId})
    WHERE a.uploaded_by = $userId AND a.field_name IN $fields
    SET a.entity_type = $entityType, a.entity_id = $entityId, a.claimed_at = $now
    RETURN count(a) AS n`,
  { ...comuni, entityType, entityId, now: new Date().toISOString() })
  const lasciati = await runQuery<{ n: number }>(session, `
    MATCH (a:Attachment {tenant_id: $tenantId, entity_type: $draftType, entity_id: $draftId})
    WHERE a.uploaded_by = $userId AND NOT coalesce(a.field_name, '') IN $fields
    RETURN count(a) AS n`, comuni)
  return { claimed: Number(presi[0]?.n ?? 0), leftBehind: Number(lasciati[0]?.n ?? 0) }
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
  session: Queryable, tenantId: string, entityLabelIsServiceRequest: true, entityId: string,
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

/**
 * FILTRARE UNA TABELLA: una riga per volta (ondata 7).
 *
 * La domanda che una persona fa non è «com'è la tabella», è «ci sono ticket
 * dove qualcuno ha chiesto il ruolo di amministratore». Cioè: esiste UNA RIGA
 * con quel valore. È la stessa forma dei campi di riferimento dell'ondata 2 —
 * una relazione da interrogare con `EXISTS` — quindi si riusa lo stesso
 * meccanismo del costruttore di filtri, `relProps` compreso: `rel.field`
 * distingue le righe di due tabelle diverse, che condividono il tipo di
 * relazione.
 *
 * Nessuna Cypher nuova, quindi: un campo virtuale per ogni (tabella, colonna),
 * e il generatore di WHERE che c'è già fa il resto.
 */
export const FORM_TABLE_FILTER_SEPARATOR = '__'

/** Il nome del campo virtuale: `persone_da_abilitare__ruolo`. */
export function formTableFilterName(field: string, column: string): string {
  return `${field}${FORM_TABLE_FILTER_SEPARATOR}${column}`
}

/**
 * I campi virtuali per filtrare le righe, uno per colonna di ogni tabella
 * della libreria. Le colonne senza definizione (una tabella mai finita) non
 * producono niente: non si inventa un filtro su una colonna che non c'è.
 */
export function formTableFilterFields(library: readonly FormFieldDef[]): Record<string, RelationFieldDef> {
  const out: Record<string, RelationFieldDef> = {}
  for (const campo of library) {
    if (!isFormTableType(campo.fieldType) || !campo.tableDefinition) continue
    for (const colonna of campo.tableDefinition.columns) {
      out[formTableFilterName(campo.name, colonna.name)] = {
        relType: 'FORM_TABLE_ROW',
        targetLabel: 'FormTableRow',
        searchProp: colonna.name,
        relProps: { field: campo.name },
      }
    }
  }
  return out
}

/**
 * SCRIVERE UNA RISPOSTA a modulo già compilato (ondata 8; dal 17 set 2026 la
 * usano in due).
 *
 * Fino all'ondata 8 una regola poteva LEGGERE una risposta (la condizione vede
 * `properties(nodo)`) ma non scriverla: l'azione «imposta campo» valida il
 * nome contro il metamodello ITIL, e un campo della libreria non è lì. Il
 * rifiuto era giusto, perché scrivere la proprietà a mano scavalcherebbe
 * tutto quello che protegge una risposta.
 *
 * Quindi si passa da qui, che applica le STESSE regole di una persona che
 * compila — sono le cinque decisioni del proprietario:
 *
 *  1. il ticket deve NASCERE DA UN MODULO. Su una richiesta generica non c'è
 *     niente che dica se quel campo andava chiesto: si rifiuta dicendolo.
 *  2. valgono le domande di ALLORA, cioè la revisione con cui il ticket è
 *     stato compilato. Un campo aggiunto al modulo dopo non si scrive su un
 *     ticket vecchio: su quel ticket quella domanda non è mai stata fatta.
 *  3. un campo NASCOSTO da una condizione non si scrive: non è stato chiesto.
 *  4. un campo CALCOLATO non si scrive: ha già il suo valore, e al prossimo
 *     salvataggio la formula lo rifarebbe — due verità.
 *  5. vocabolario e script di validazione SI APPLICANO: una regola non è più
 *     autorevole di un utente. E svuotare un campo obbligatorio si rifiuta.
 *
 * Fuori: allegati, riferimenti e tabelle. Un'azione manda un valore solo, e
 * quei tre non sono un valore — sono file, relazioni e righe.
 *
 * I CHIAMANTI SONO DUE, e per questo la funzione non si chiama più
 * «…FromAutomation» e i suoi rifiuti non dicono più «un'automazione non può»:
 * ci passa anche una PERSONA che corregge una risposta dal riquadro della
 * richiesta (`setServiceRequestFormAnswer`). Provandola nel browser il primo
 * rifiuto arrivato a schermo diceva a un operatore che «un'automazione non può
 * rispondere a una domanda che non è stata fatta»: vero sul perché, falso su
 * chi — e chi legge un errore che parla di qualcun altro non sa cosa fare.
 */
export async function writeFormAnswer(
  session: Session,
  tenantId: string,
  requestId: string,
  field: string,
  value: unknown,
): Promise<{ before: unknown; after: unknown }> {
  const ticket = await runQueryOne<{ props: Record<string, unknown> }>(session, `
    MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
    RETURN properties(r) AS props`, { id: requestId, tenantId })
  if (!ticket) throw new NotFoundError('ServiceRequest', requestId)

  const itemId = ticket.props['catalog_item_id']
  const revision = ticket.props['form_revision']
  const lingua = await languageFor(tenantId)
  const library = await formFieldsByName(session, tenantId, [field])
  const campo = library.get(field)
  if (!campo) {
    throw new ValidationError(`"${field}" is not a field of the form library.`,
      { key: 'errors.formField.notInLibrary', params: { field } })
  }
  const etichetta = etichettaDelCampo(campo, lingua)

  // 1. Il ticket nasce da un modulo?
  if (typeof itemId !== 'string' || itemId === '' || revision == null || Number(revision) === 0) {
    throw new ValidationError(`The request does not come from a catalog form: "${etichetta}" was never asked, so there is no answer to write.`,
      { key: 'errors.formField.ticketWithoutForm', params: { field: etichetta } })
  }

  // 2. Le domande di ALLORA.
  const def = await catalogFormRevision(session, tenantId, itemId, Number(revision))
  if (!def) {
    throw new ValidationError(`The form revision ${String(revision)} of this request cannot be read: the frozen copy is missing.`,
      { key: 'errors.formField.revisionMissing', params: { revision: String(revision) } })
  }

  /*
   * 3. Il campo era CHIESTO su questo ticket, e non nascosto da una condizione.
   *
   * Le risposte si rimettono insieme dalle proprietà del nodo NELLA LORO FORMA:
   * una lista resta una lista, un numero resta un numero. Prima si passava
   * tutto per `String(...)` con un `join(',')`, quindi una selezione multipla
   * arrivava al valutatore come `"produzione,collaudo"` e l'appartenenza non
   * scattava: una regola legittima veniva rifiutata con «una condizione lo
   * nasconde», che era falso — e con `contains` funzionava per caso, come
   * sottostringa, il che rendeva il difetto intermittente (revisione del 17
   * set 2026).
   */
  const answers = formAnswerMap(
    catalogFormFieldNames(def).map((nome) => rispostaDaProprieta(nome, ticket.props[nome])),
  )
  /*
   * E le stesse risposte COL LORO TIPO, per formule e script (review of 23 Sep
   * 2026). Alla creazione una formula vede `false` e `3`; qui vedeva `'false'`
   * e `'3'`: correggere una risposta qualunque riscriveva `livello` da
   * «bassa» ad «alta» (la stringa 'false' è vera) e `a + b` diventava una
   * concatenazione. Il nodo tiene già i valori col tipo che `coerce` ha dato.
   */
  const tipizzate: Record<string, unknown> = Object.fromEntries(
    catalogFormFieldNames(def).map((nome) => [nome, ticket.props[nome] ?? null]),
  )
  const item = visibleFormItems(def, answers).find((i) => i.field === field)
  if (!item) {
    throw new ValidationError(`The field "${etichetta}" is not asked by the form this request was filled with (revision ${String(revision)}), or a condition hides it: a question that was never put has no answer to write.`,
      { key: 'errors.formField.notAskedHere', params: { field: etichetta, revision: String(revision) } })
  }

  // 4. Un campo calcolato ha già il suo valore.
  if (campo.formula) {
    throw new ValidationError(`The field "${etichetta}" is computed: its value comes from its formula, it cannot be set by hand.`,
      { key: 'errors.formField.computedNotSettable', params: { field: etichetta } })
  }

  // Fuori dal perimetro: quello che non è un valore singolo.
  if (FORM_FIELD_TYPES_WITHOUT_ANSWER.includes(campo.fieldType)
    || isFormAttachmentType(campo.fieldType)
    || isFormReferenceType(campo.fieldType)
    || isFormTableType(campo.fieldType)
    || FORM_FIELD_TYPES_MULTI.includes(campo.fieldType)) {
    throw new ValidationError(`"${etichetta}" cannot be set this way: a ${campo.fieldType} field is not a single value.`,
      { key: 'errors.formField.notSettableType', params: { field: etichetta, fieldType: campo.fieldType } })
  }

  /*
   * 5. Le regole di tutti: obbligatorietà, vocabolario, script.
   *
   * Svuotare un campo NON è una scorciatoia: prima uscivo subito con un `SET`
   * solo, e così un campo svuotato non spegneva le risposte che dipendevano da
   * lui né rifaceva i calcolati che lo leggevano — lo stesso difetto di
   * `RICH-000022`, dalla porta accanto. Un valore vuoto è un valore: passa
   * dalla stessa stabilizzazione.
   */
  const testo = value == null ? '' : String(value).trim()
  const obbligatorio = item.required ?? campo.required
  const vuoto = testo === ''
  if (vuoto && obbligatorio) {
    throw new ValidationError(`The field "${etichetta}" is required: it cannot be cleared.`,
      { key: 'errors.formField.requiredNotClearable', params: { field: etichetta } })
  }
  const allowed = campo.vocabulary ? (await loadVocabularyEntries(tenantId, campo.vocabulary)).values : null
  const convertito = vuoto ? null : coerce(campo, testo, allowed as readonly string[] | null)

  if (!vuoto && campo.validationScript) {
    const rifiuto = await runValidationScript(
      campo.validationScript,
      { input: { ...tipizzate, [field]: convertito }, value: convertito },
      campo.name, tenantId, 'tenant',
    )
    if (rifiuto) {
      throw new ValidationError(`The field "${etichetta}" was refused: ${rifiuto}`,
        { key: 'errors.formField.script', params: { field: etichetta, message: rifiuto } })
    }
  }
  /*
   * 6. LO STATO CHE QUESTA RISPOSTA PRODUCE: formule e visibilità, fino a
   *    quando smettono di cambiare (17 set 2026).
   *
   * Il punto 3 rifiuta di SCRIVERE un campo nascosto; mancava la sua
   * conseguenza dall'altro lato. Su `RICH-000022`, correggendo «Ambiente» da
   * Produzione a Sviluppo, «Costo stimato» — che il modulo chiede solo in
   * produzione — restava sul nodo con 2000, e il calcolato «Costo totale» col
   * suo 2440: il ticket mostrava come risposte due domande che quel modulo, in
   * quella configurazione, non fa. Quei numeri finiscono in filtri, report,
   * widget e condizioni delle regole, e nessuno li avrebbe più potuti
   * correggere, perché ormai nascosti il punto 3 li rifiuta — un valore
   * bloccato e sbagliato per sempre.
   *
   * E le due cose si inseguono: svuotare «Costo stimato» rifà «Costo totale»,
   * e «Costo totale» decide se si chiede «Ambienti coinvolti». Provato dal
   * vivo con una passata sola di ciascuna, «Ambienti coinvolti» restava a
   * «Produzione» con un totale ormai a 0 — corretto a metà è sempre sbagliato.
   * Quindi si gira fino al punto fisso, come fa il browser a ogni tasto.
   *
   * Il valore di prima non è perduto: chi chiama registra nell'Audit Log il
   * valore prima e dopo e l'elenco delle risposte svuotate
   * (`setServiceRequestFormAnswer`).
   */
  const nomiDelModulo = catalogFormFieldNames(def)
  const libreria = await formFieldsByName(session, tenantId, nomiDelModulo)
  const { spente, calcolati } = await stabilizzaRisposte(
    def, libreria, answers, { ...answers, [field]: convertito as FormAnswerValue }, tenantId,
    { ...tipizzate, [field]: convertito },
  )

  /*
   * Quello che non si può svuotare con una proprietà si RIFIUTA prima di
   * scrivere: i file di un allegato, le relazioni di un riferimento e le righe
   * di una tabella stanno fuori dal nodo, e cancellarli non è un lavoro che
   * la correzione di una riga possa fare di nascosto. Meglio dire quale campo
   * sta in mezzo, così chi corregge decide lui.
   */
  for (const nome of spente) {
    const suo = libreria.get(nome)
    if (!suo) continue
    if (isFormAttachmentType(suo.fieldType) || isFormReferenceType(suo.fieldType) || isFormTableType(suo.fieldType)) {
      const sua = etichettaDelCampo(suo, lingua)
      throw new ValidationError(`Setting "${etichetta}" would stop the form from asking "${sua}", whose files, references or rows cannot be cleared from here: empty that field first.`,
        { key: 'errors.formField.hidesUnclearable', params: { field: etichetta, other: sua } })
    }
  }

  /*
   * UNA SCRITTURA SOLA: il valore chiesto, le risposte che il modulo non
   * chiede più e i calcolati rifatti. Erano tre `SET` in fila, e fra l'uno e
   * l'altro il ticket esisteva con un totale che non tornava coi suoi addendi
   * — letto da un webhook o da una regola in quell'istante, era una verità
   * falsa.
   */
  const daScrivere: Record<string, unknown> = { [field]: convertito }
  for (const n of spente) daScrivere[n] = null
  for (const [n, v] of Object.entries(calcolati)) daScrivere[n] = v
  const esito = await scriviProprieta(session, tenantId, requestId, daScrivere)
  if (spente.length > 0) {
    log.info({ tenantId, requestId, field, spente }, 'form answers cleared: the form no longer asks them')
  }
  return esito
}

/**
 * LO STATO STABILE di un modulo dopo che una risposta è cambiata: le formule
 * rifatte e le risposte che il modulo non chiede più, insieme.
 *
 * Non sono due passaggi in fila, sono due cose che si INSEGUONO: una risposta
 * spenta rifà i calcolati che la leggevano, e un calcolato nuovo può nascondere
 * un altro campo, che una volta spento rifà altri calcolati. Su `RICH-000022`
 * la passata sola lasciava «Ambienti coinvolti» compilato con un «Costo
 * totale» ormai a 0 e la condizione (`> 1000`) falsa.
 *
 * Quindi si gira fino a quando niente cambia più, come fa il browser a ogni
 * tasto. Il tetto delle dieci passate è una sicurezza contro un modulo con
 * condizioni circolari, non un limite di profondità che il cliente possa
 * incontrare (ogni giro spegne almeno una risposta, e le risposte sono finite).
 *
 * `prima` è la fotografia delle risposte come stavano: si spegne solo ciò che
 * ERA chiesto e non lo è più. Un campo già nascosto da prima con un valore vecchio non si
 * tocca — sarebbe una pulizia altrui fatta di straforo, dentro la correzione di
 * un'altra risposta.
 */
async function stabilizzaRisposte(
  def: CatalogFormDefinition,
  libreria: Map<string, FormFieldDef>,
  prima: Record<string, FormAnswerValue>,
  partenza: Record<string, FormAnswerValue>,
  tenantId: string,
  /** The same answers with their type: what the formulas see, as at creation. */
  tipizzate: Record<string, unknown>,
): Promise<{ spente: string[]; calcolati: Record<string, unknown> }> {
  const nomi = catalogFormFieldNames(def)
  const nomiCalcolati = nomi.filter((n) => libreria.get(n)?.formula)
  const eranoVisibili = new Set(visibleFormItems(def, prima).map((i) => i.field))
  const stato: Record<string, FormAnswerValue> = { ...partenza }
  const tipi: Record<string, unknown> = { ...tipizzate }
  const spente: string[] = []
  const calcolati: Record<string, unknown> = {}

  for (let giro = 0; giro < 10; giro++) {
    let cambiato = false

    // Le formule: solo i calcolati VISIBILI adesso, e vedono solo i campi non
    // calcolati (`formulaInput`), così non ci sono catene fra formule.
    const visibili = new Set(visibleFormItems(def, stato).map((i) => i.field))
    const perLaFormula = formulaInput(tipi, new Set(nomiCalcolati))
    for (const n of nomiCalcolati) {
      if (!visibili.has(n)) continue
      const campo = libreria.get(n)!
      const r = await runFormulaScript(campo.formula!, perLaFormula, campo.name, tenantId)
      if (!r.ok) {
        throw new ValidationError(`The formula of field "${campo.label}" failed while recomputing: ${r.error}`,
          { key: 'errors.formField.formulaFailed', params: { field: campo.label, name: campo.name, message: r.error } })
      }
      const v = r.value
      const valore = (v == null || (typeof v === 'number' && !Number.isFinite(v)) || String(v).trim() === '')
        ? null
        : coerce(campo, String(v), campo.vocabulary ? (await loadVocabularyEntries(tenantId, campo.vocabulary)).values as readonly string[] : null)
      if (!Object.prototype.hasOwnProperty.call(calcolati, n) || calcolati[n] !== valore) cambiato = true
      calcolati[n] = valore
      stato[n] = valore as FormAnswerValue
      tipi[n] = valore
    }

    // La visibilità, con i calcolati appena rifatti già dentro.
    const oraVisibili = new Set(visibleFormItems(def, stato).map((i) => i.field))
    for (const n of nomi) {
      if (!eranoVisibili.has(n) || oraVisibili.has(n) || spente.includes(n)) continue
      if (isFormAnswerEmpty(stato[n])) continue
      stato[n] = null
      tipi[n] = null
      spente.push(n)
      delete calcolati[n]
      cambiato = true
    }
    if (!cambiato) break
  }

  // Un calcolato spento non si riscrive col suo valore: comanda lo spegnimento.
  for (const n of spente) delete calcolati[n]
  return { spente, calcolati }
}

/**
 * Una risposta ricostruita da una proprietà del nodo, nella forma che il
 * valutatore delle condizioni si aspetta: una LISTA resta una lista (è così
 * che `eq` diventa appartenenza), tutto il resto è un valore singolo.
 */
function rispostaDaProprieta(name: string, raw: unknown): FormAnswerInput {
  if (raw == null) return { name, value: null }
  if (Array.isArray(raw)) return { name, values: raw.map((v) => String(v)) }
  return { name, value: String(raw) }
}

/**
 * LA SCRITTURA, UNA SOLA. `SET r += $props` con la mappa come PARAMETRO: i
 * nomi dei campi sono validati dalla libreria, ma la regola qui è che in
 * Cypher non si interpola comunque.
 *
 * Prende una MAPPA e non un campo perché una correzione tocca più proprietà
 * insieme — il valore chiesto, le risposte che il modulo non chiede più, i
 * calcolati rifatti — e in mezzo a tre `SET` in fila il ticket esisteva con un
 * totale che non tornava coi suoi addendi.
 */
async function scriviProprieta(
  session: Session, tenantId: string, requestId: string, props: Record<string, unknown>,
): Promise<{ before: unknown; after: unknown }> {
  const row = await runQueryOne<{ before: Record<string, unknown>; after: Record<string, unknown> }>(session, `
    MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
    WITH r, properties(r) AS before
    SET r += $props, r.updated_at = $now
    RETURN before, properties(r) AS after`,
  { id: requestId, tenantId, props, now: new Date().toISOString() })
  if (!row) throw new NotFoundError('ServiceRequest', requestId)
  return { before: row.before, after: row.after }
}
