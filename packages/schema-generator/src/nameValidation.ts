/**
 * I NOMI del metamodello CI: la porta davanti allo schema per tenant (A-12).
 *
 * ## Perché esiste
 * Il nome di un tipo CI e il nome di un suo campo non sono etichette: sono
 * **identificatori**. Da `name` nascono, per interpolazione diretta nell'SDL
 * (`generator.ts`) e nella Cypher (`ciMutations.ts`):
 *
 * | da un tipo `load_balancer` | da un campo `costCenter` |
 * |---|---|
 * | `type LoadBalancer implements CIBase` | il campo GraphQL `costCenter` |
 * | `type LoadBalancersResult` | la proprietà Neo4j `cost_center` (`toSnakeCase`) |
 * | `input CreateLoadBalancerInput` / `UpdateLoadBalancerInput` | il campo di `Create…Input`/`Update…Input` |
 * | le query `loadBalancers` e `load_balancer` | |
 * | le mutation `createLoadBalancer` / `update…` / `delete…` | |
 * | la label Neo4j `LoadBalancer` | |
 *
 * Finché lo schema GraphQL era costruito una volta per il tenant `'system'`,
 * i tipi del cliente non arrivavano mai all'API e tre difetti restavano
 * latenti. Diventano attivi il giorno in cui si serve uno schema **per
 * tenant**:
 *
 * 1. un tipo chiamato `server` (o `incident`, `team`, `user`) produce un tipo
 *    GraphQL già dichiarato. **Correzione al rapporto A-12, verificata sulla
 *    versione di `@graphql-tools/schema` in uso**: `makeExecutableSchema`
 *    **non lancia** — fa il *merge* dei due tipi omonimi **in silenzio**, e i
 *    campi del tipo del cliente finiscono dentro il tipo del prodotto
 *    (`type Incident { id, title }` + `type Incident { campoDelCliente }` →
 *    `Incident { id, title, campoDelCliente }`). Non è un guasto rumoroso: è
 *    **corruzione silenziosa dello schema**, che è peggio. Per questo il
 *    controllo di collisione **in scrittura è l'unica difesa che esiste**:
 *    dopo non c'è nessun errore di assemblaggio che lo prenda;
 * 2. un campo chiamato `tenantId` diventa la proprietà `tenant_id`, che è **il
 *    cliente proprietario del CI**: `props[toSnakeCase(field.name)] = …` gira
 *    DOPO `tenant_id: ctx.tenantId`, quindi il CI nascerebbe nel cliente
 *    scelto da chi chiama l'API (idem `id`, `nameKey`, `discovery*`);
 * 3. un nome come `2fa_token` non è un identificatore GraphQL valido.
 *
 * Cosa è rumoroso e cosa no, verificato:
 *
 * | caso | all'assemblaggio |
 * |---|---|
 * | nome di tipo omonimo (`incident`) | **silenzioso**: merge dei campi |
 * | campo del cliente su quel tipo | **silenzioso**: entra nel tipo del prodotto |
 * | nome non identificatore (`2fa`) | lancia (`Syntax Error: Invalid number…`) |
 * | query generata omonima con tipo diverso (plurale) | lancia (`Unable to merge GraphQL type "Query"`) |
 *
 * Gli ultimi due casi hanno una rete a valle (lo schema «sicuro» servito
 * quando quello del tenant non si assembla); il primo **non ne ha nessuna**.
 *
 * ## Il modello
 * - **Nome di tipo**: `^[a-z][a-z0-9_]*$`. È anche ciò che rende sicuro
 *   `toPascalCase`, che divide **solo** su `_`.
 * - **Nome di campo**: `^[a-z][A-Za-z0-9]*$` — camelCase, **senza** trattini
 *   basso: `cost_center` e `costCenter` finirebbero sulla stessa proprietà
 *   Neo4j (`toSnakeCase`) e si sovrascriverebbero a vicenda.
 * - **L'elenco riservato non è scritto a mano**: si *calcola*. Per i tipi si
 *   generano i nomi che l'SDL emetterebbe (`emittedNamesForCIType`) e si
 *   confrontano con quelli già nello schema — letti dall'SDL di base
 *   (`apps/api/src/lib/metamodelNames.ts`) e dagli altri tipi CI del cliente.
 *   Una lista a mano divergerebbe al primo tipo nuovo.
 * - Il confronto è **senza distinzione di maiuscole**: `Server` e `server`
 *   sono lo stesso nome per chi legge, e `toPascalCase` li porta allo stesso
 *   tipo GraphQL.
 *
 * Questo modulo è **puro**: nessun accesso a Neo4j, nessun import da
 * `apps/api`. Chi chiama porta l'elenco riservato.
 */
import { toPascalCase, pluralize, toSnakeCase } from './stringUtils.js'

// ── Le due regole ─────────────────────────────────────────────────────────────

/** Nome di un tipo CI: snake_case, iniziale minuscola. */
export const CI_TYPE_NAME_RE = /^[a-z][a-z0-9_]*$/

/** Nome di un campo CI: camelCase, iniziale minuscola, nessun trattino basso. */
export const CI_FIELD_NAME_RE = /^[a-z][A-Za-z0-9]*$/

// ── Proprietà che un campo del cliente non può occupare ───────────────────────

/**
 * Chiavi di proprietà Neo4j **gestite dal prodotto** su un CI: un campo del
 * cliente il cui `toSnakeCase(name)` finisce qui sovrascriverebbe un dato di
 * sistema. `tenant_id` è il caso grave (il CI nascerebbe nel cliente scelto da
 * chi chiama l'API); gli altri sono derivati o scritti da un sottosistema.
 *
 * Sorgente unica: `apps/api/src/lib/cypherIdentifiers.ts` la ri-esporta come
 * `RESERVED_CI_PROPERTY_KEYS` e un test pinna che contenga tutta la
 * `RESERVED_PROPERTY_KEYS` generica, così le due non possono divergere.
 */
export const RESERVED_CI_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  // gestite dal prodotto su qualunque nodo
  'tenant_id', 'id', 'created_at', 'updated_at', 'labels',
  // chiave di riconoscimento per nome (lib/ciNameKey.ts)
  'name_key',
  // scritte SOLO da Event Management (services/events/ciHealth.ts)
  'health', 'health_source', 'last_event_at',
  // derivate
  'chain', 'type',
])

/** Prefissi riservati: tutto ciò che la discovery scrive sul CI. */
export const RESERVED_CI_PROPERTY_PREFIXES: readonly string[] = ['discovery_']

// ── Campi già presenti su ogni CI ─────────────────────────────────────────────

/**
 * Campi già dichiarati su `CIBase` (e quindi su ogni tipo generato): un campo
 * del cliente con uno di questi nomi produrrebbe un campo duplicato nell'SDL.
 * `health`, `healthSource`, `lastEventAt` sono scritti SOLO da Event
 * Management: in sola lettura qui, mai negli input.
 */
export const BASE_TYPE_FIELDS: ReadonlySet<string> = new Set([
  'id', 'name', 'type', 'status', 'environment',
  'description', 'chain', 'isInfrastructure', 'createdAt', 'updatedAt', 'notes',
  'ownerGroup', 'supportGroup', 'dependencies', 'dependents',
  'health', 'healthSource', 'lastEventAt',
])

/** Campi già dichiarati a mano in `Create…Input` / `Update…Input`. */
export const BASE_INPUT_FIELDS: ReadonlySet<string> = new Set([
  'name', 'status', 'environment', 'description',
  'notes', 'isInfrastructure', 'ownerGroupId', 'supportGroupId',
  'health', 'healthSource', 'lastEventAt',
])

// ── L'errore ──────────────────────────────────────────────────────────────────

/**
 * Un nome rifiutato. `rule` dice QUALE regola non è rispettata (serve al test e
 * al web per non dover leggere il messaggio), il messaggio dice cosa scrivere
 * invece: «nome non valido» non aiuta nessuno a rimediare.
 */
export type NameRule =
  | 'typeNameSyntax'
  | 'typeNameTaken'
  | 'fieldNameSyntax'
  | 'fieldNameReservedProperty'
  | 'fieldNameBase'
  | 'fieldNameDuplicate'

/**
 * Il rifiuto in forma di DATO, perche la frase la compone il client.
 *
 * `message` resta in inglese — e la lingua del prodotto, e quella che finisce
 * nei log, nelle metriche e nelle integrazioni. `i18n` porta la CHIAVE e i
 * parametri: l'API la mette nelle extensions dell'errore GraphQL
 * (`apps/api/src/lib/errors.ts`) e il link i18n del client la risolve nella
 * lingua del cliente.
 *
 * CONVENZIONE (la stessa del resto del progetto): un parametro il cui nome
 * finisce in `Key` e a sua volta una chiave, e il client la risolve passandole
 * gli stessi parametri. Serve alle parti FACOLTATIVE della frase — «sul tipo
 * X» quando il tipo si conosce, «scrivi Y invece» quando esiste un
 * suggerimento sicuro. Nessun frammento e mai vuoto: dove non c'e nulla da
 * dire si dice l'altra cosa vera («su qualunque tipo CI», «scegline un
 * altro»), perche una chiave con valore vuoto e un buco che nessun controllo
 * vede.
 */
export interface NameErrorI18n {
  key: string
  params: Record<string, string>
}

export class MetamodelNameError extends Error {
  readonly rule: NameRule
  readonly offending: string
  readonly i18n: NameErrorI18n
  constructor(rule: NameRule, offending: string, message: string, i18n: NameErrorI18n) {
    super(message)
    this.name = 'MetamodelNameError'
    this.rule = rule
    this.offending = offending
    this.i18n = i18n
  }
}

/** Radice delle chiavi di questo file, in un posto solo. */
const K = 'errors.metamodelName'


// ── L'elenco riservato, calcolato ─────────────────────────────────────────────

/**
 * Nomi già presi in uno schema. Chiave = nome **minuscolo**; valore = come è
 * scritto davvero e da dove viene, perché il messaggio di rifiuto lo dica.
 */
export interface ReservedSchemaNames {
  types:          Map<string, string>
  queryFields:    Map<string, string>
  mutationFields: Map<string, string>
}

/** Copia: la verifica aggiunge i nomi emessi, e non deve sporcare la cache del chiamante. */
export function cloneReservedNames(r: ReservedSchemaNames): ReservedSchemaNames {
  return {
    types:          new Map(r.types),
    queryFields:    new Map(r.queryFields),
    mutationFields: new Map(r.mutationFields),
  }
}

export function emptyReservedNames(): ReservedSchemaNames {
  return { types: new Map(), queryFields: new Map(), mutationFields: new Map() }
}

export function mergeReservedNames(...parts: ReservedSchemaNames[]): ReservedSchemaNames {
  const out = emptyReservedNames()
  for (const p of parts) {
    for (const [k, v] of p.types)          if (!out.types.has(k))          out.types.set(k, v)
    for (const [k, v] of p.queryFields)    if (!out.queryFields.has(k))    out.queryFields.set(k, v)
    for (const [k, v] of p.mutationFields) if (!out.mutationFields.has(k)) out.mutationFields.set(k, v)
  }
  return out
}

/** I nomi che l'SDL emetterà per un tipo CI chiamato `name`. */
export function emittedNamesForCIType(name: string): {
  types: string[]; queryFields: string[]; mutationFields: string[]
} {
  const pascal    = toPascalCase(name)
  const plural    = pluralize(pascal)
  const pluralKey = plural.charAt(0).toLowerCase() + plural.slice(1)
  return {
    types:          [pascal, `${pascal}sResult`, `Create${pascal}Input`, `Update${pascal}Input`],
    queryFields:    [pluralKey, name],
    mutationFields: [`create${pascal}`, `update${pascal}`, `delete${pascal}`],
  }
}

/**
 * L'elenco riservato che nasce dai tipi CI già presenti nello schema di un
 * cliente (base, ITIL e suoi): non i loro nomi, **i nomi che emettono**.
 */
export function reservedNamesForCITypes(
  types: Iterable<{ name: string; origin: string }>,
): ReservedSchemaNames {
  const out = emptyReservedNames()
  for (const { name, origin } of types) {
    const emitted = emittedNamesForCIType(name)
    for (const n of emitted.types)          if (!out.types.has(n.toLowerCase()))          out.types.set(n.toLowerCase(), `${n} (${origin})`)
    for (const n of emitted.queryFields)    if (!out.queryFields.has(n.toLowerCase()))    out.queryFields.set(n.toLowerCase(), `${n} (${origin})`)
    for (const n of emitted.mutationFields) if (!out.mutationFields.has(n.toLowerCase())) out.mutationFields.set(n.toLowerCase(), `${n} (${origin})`)
  }
  return out
}

// ── Suggerimenti ──────────────────────────────────────────────────────────────

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/**
 * Il nome valido più vicino a quello scritto, o `null` se non ne resta niente.
 * `null` (e non un nome inventato) perché un suggerimento vuoto è peggio del
 * silenzio: il messaggio in quel caso si limita a dire la regola.
 */
export function suggestCITypeName(raw: string): string | null {
  let s = stripDiacritics(String(raw)).toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  // `2fa_token` → `fa2_token`: la cifra iniziale si sposta a valle della prima
  // parola, che è come si scrive di solito uno slug che comincia per numero.
  s = s.replace(/^([0-9]+)([a-z][a-z0-9]*)/, '$2$1')
  return CI_TYPE_NAME_RE.test(s) ? s : null
}

/** Come sopra, in camelCase: `Centro di costo` → `centroDiCosto`. */
export function suggestCIFieldName(raw: string): string | null {
  const words = stripDiacritics(String(raw))
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  if (!words.length) return null
  // La cifra iniziale si sposta a valle della PRIMA parola, come in
  // `suggestCITypeName` (`2fa` → `fa2`), non alla fine del nome intero.
  words[0] = words[0]!.replace(/^([0-9]+)([A-Za-z][A-Za-z0-9]*)$/, '$2$1')
  const s = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('')
  return CI_FIELD_NAME_RE.test(s) ? s : null
}

function insteadWrite(suggestion: string | null): string {
  return suggestion ? ` Write «${suggestion}» instead.` : ' Pick another name.'
}

/** La chiave del frammento «scrivi X invece», o quella del ripiego. Mai vuota. */
const insteadKey = (suggestion: string | null) =>
  suggestion ? `${K}.instead.write` : `${K}.instead.pickAnother`

/** La chiave del frammento «sul tipo X» / «su qualunque tipo CI». Mai vuota. */
const whereKey = (typeLabel: string | undefined) =>
  typeLabel ? `${K}.where.onType` : `${K}.where.anyType`

/**
 * Una variante del nome che NON è riservata, per il suggerimento. Se anche
 * quella fosse riservata si restituisce `null`: meglio nessun suggerimento che
 * uno che verrebbe rifiutato a sua volta.
 */
function safeVariant(name: string): string | null {
  const candidate = `${name}Custom`
  if (!CI_FIELD_NAME_RE.test(candidate)) return null
  const property = toSnakeCase(candidate)
  if (RESERVED_CI_PROPERTY_KEYS.has(property)) return null
  if (RESERVED_CI_PROPERTY_PREFIXES.some((p) => property.startsWith(p))) return null
  if (BASE_TYPE_FIELDS.has(candidate) || BASE_INPUT_FIELDS.has(candidate)) return null
  return candidate
}

// ── Nome di tipo ──────────────────────────────────────────────────────────────

/**
 * Il nome di un tipo CI che si sta per creare. Lancia `MetamodelNameError`
 * dicendo quale regola è violata e cosa scrivere invece.
 *
 * `reserved` è l'elenco **calcolato** dei nomi già presi nello schema di quel
 * cliente; la collisione si verifica su tutti i nomi che l'SDL emetterebbe —
 * PascalCase, plurale, input e mutation — perché è lì che nascono i duplicati,
 * non sul nome scritto.
 */
export function assertCITypeName(name: unknown, reserved: ReservedSchemaNames): string {
  if (typeof name !== 'string' || !CI_TYPE_NAME_RE.test(name)) {
    const shown = typeof name === 'string' ? name : JSON.stringify(name)
    const fix   = typeof name === 'string' ? suggestCITypeName(name) : null
    throw new MetamodelNameError('typeNameSyntax', shown,
      `«${shown}» is not a valid CI type name: it must start with a lowercase letter and contain only ` +
      `lowercase letters, digits and underscores (rule: ${CI_TYPE_NAME_RE.source}).` +
      insteadWrite(fix) +
      (fix ? ` It would become the GraphQL type «${toPascalCase(fix)}» and the Neo4j label «${toPascalCase(fix)}».` : '') +
      ` The name is the technical slug; the name people read in the interface is the label, which may contain ` +
      `spaces, accents and capitals.`,
      {
        key: `${K}.typeSyntax`,
        params: {
          name: shown,
          pattern: CI_TYPE_NAME_RE.source,
          insteadKey: fix ? `${K}.instead.writeType` : `${K}.instead.pickAnother`,
          ...(fix ? { suggestion: fix, graphqlType: toPascalCase(fix) } : {}),
        },
      },
    )
  }

  const emitted = emittedNamesForCIType(name)
  // Il primo caso è il grave: un tipo omonimo non fa lanciare l'assemblaggio,
  // lo fa MERGE in silenzio (vedi la nota in testa al file). Gli altri due
  // farebbero fallire l'assemblaggio, che è rumoroso ma comunque inaccettabile.
  const checks: Array<{
    names: string[]; taken: Map<string, string>
    what: (n: string) => string; whatKey: string
    consequence: string; consequenceKey: string
  }> = [
    { names: emitted.types, taken: reserved.types,
      what: (n) => `the GraphQL type «${n}»`, whatKey: `${K}.what.type`,
      consequence: 'GraphQL does not reject two types with the same name: it MERGES them silently, and the fields ' +
        'of your type would end up inside the product one — with no error anywhere',
      consequenceKey: `${K}.consequence.typeMerge` },
    { names: emitted.queryFields, taken: reserved.queryFields,
      what: (n) => `the query «${n}»`, whatKey: `${K}.what.query`,
      consequence: 'two queries with the same name and different types cannot be merged: the schema of this tenant ' +
        'would not assemble, and while the name stays the API would answer it with the reduced schema',
      consequenceKey: `${K}.consequence.queryClash` },
    { names: emitted.mutationFields, taken: reserved.mutationFields,
      what: (n) => `the mutation «${n}»`, whatKey: `${K}.what.mutation`,
      consequence: 'two mutations with the same name and different types cannot be merged: the schema of this ' +
        'tenant would not assemble',
      consequenceKey: `${K}.consequence.mutationClash` },
  ]
  for (const check of checks) {
    for (const n of check.names) {
      const owner = check.taken.get(n.toLowerCase())
      if (owner === undefined) continue
      throw new MetamodelNameError('typeNameTaken', name,
        `The name «${name}» is already taken: it would generate ${check.what(n)}, which already exists in the ` +
        `schema — ${owner}. ${check.consequence}. ` +
        `Pick another name (for example «${name}_custom»); the name people read in the interface is the label, ` +
        `which can stay the one you wanted.`,
        {
          key: `${K}.typeTaken`,
          params: {
            name, owner, generated: n, suggestion: `${name}_custom`,
            whatKey: check.whatKey, consequenceKey: check.consequenceKey,
          },
        },
      )
    }
  }
  return name
}

// ── Nome di campo ─────────────────────────────────────────────────────────────

export interface CIFieldNameContext {
  /** Nomi dei campi già presenti sul tipo (compresi quelli di `__base__`). */
  existingFieldNames?: Iterable<string>
  /** Etichetta del tipo, per il messaggio. */
  typeLabel?: string
}

/**
 * Il nome di un campo CI che si sta per aggiungere.
 *
 * Il caso da cui questa funzione nasce è `tenantId`: `toSnakeCase` lo porta a
 * `tenant_id`, non è fra i campi esclusi dagli input, e la scrittura del CI
 * imposta le proprietà del cliente **prima** di copiarci i campi del
 * metamodello. Senza questo controllo il CI nascerebbe nel cliente scelto da
 * chi chiama l'API.
 */
export function assertCIFieldName(name: unknown, ctx: CIFieldNameContext = {}): string {
  const on = ctx.typeLabel ? ` on the type «${ctx.typeLabel}»` : ''
  const dove = { whereKey: whereKey(ctx.typeLabel), ...(ctx.typeLabel ? { typeLabel: ctx.typeLabel } : {}) }

  if (typeof name !== 'string' || !CI_FIELD_NAME_RE.test(name)) {
    const shown = typeof name === 'string' ? name : JSON.stringify(name)
    const fix = typeof name === 'string' ? suggestCIFieldName(name) : null
    throw new MetamodelNameError('fieldNameSyntax', shown,
      `«${shown}» is not a valid field name${on}: it must start with a lowercase letter and contain only ` +
      `letters and digits, in camelCase (rule: ${CI_FIELD_NAME_RE.source}).` +
      insteadWrite(fix) +
      ` The underscore is not allowed because «costCenter» and «cost_center» would land on the same Neo4j ` +
      `property and overwrite each other. The name people read in the interface is the label, which may ` +
      `contain spaces and accents.`,
      {
        key: `${K}.fieldSyntax`,
        params: {
          name: shown, pattern: CI_FIELD_NAME_RE.source, ...dove,
          insteadKey: insteadKey(fix), ...(fix ? { suggestion: fix } : {}),
        },
      },
    )
  }

  const property = toSnakeCase(name)
  const prefix = RESERVED_CI_PROPERTY_PREFIXES.find((p) => property.startsWith(p))
  if (RESERVED_CI_PROPERTY_KEYS.has(property) || prefix) {
    const fix = safeVariant(name)
    throw new MetamodelNameError('fieldNameReservedProperty', name,
      `The field «${name}»${on} would write the property «${property}», which the product manages` +
      (prefix ? ` (everything starting with «${prefix}» belongs to synchronisation)` : '') +
      `: the value sent by an API caller would overwrite a system value` +
      (property === 'tenant_id' ? ' — with «tenant_id» the CI would be born in the tenant chosen by the caller' : '') +
      `.${insteadWrite(fix)}`,
      {
        key: `${K}.reservedProperty`,
        params: {
          name, property, ...dove, insteadKey: insteadKey(fix), ...(fix ? { suggestion: fix } : {}),
          whyKey: prefix ? `${K}.why.syncPrefix`
            : property === 'tenant_id' ? `${K}.why.tenant`
            : `${K}.why.system`,
          ...(prefix ? { prefix } : {}),
        },
      },
    )
  }

  if (BASE_TYPE_FIELDS.has(name) || BASE_INPUT_FIELDS.has(name)) {
    const fix = safeVariant(name)
    throw new MetamodelNameError('fieldNameBase', name,
      `The field «${name}» already exists on every CI: it is one of the base fields (${[...BASE_TYPE_FIELDS].join(', ')}). ` +
      `Adding it${on} would declare the same field twice in the schema. ` +
      `Use the base field that is already there, or give yours a different name.${insteadWrite(fix)}`,
      {
        key: `${K}.baseField`,
        params: {
          name, baseFields: [...BASE_TYPE_FIELDS].join(', '), ...dove,
          insteadKey: insteadKey(fix), ...(fix ? { suggestion: fix } : {}),
        },
      },
    )
  }

  for (const existing of ctx.existingFieldNames ?? []) {
    if (existing.toLowerCase() === name.toLowerCase()) {
      const fix = safeVariant(name)
      throw new MetamodelNameError('fieldNameDuplicate', name,
        `The field «${existing}» already exists${on}: two fields with the same name cannot live on the same type. ` +
        `Edit the one that is there, or give this one a different name.${insteadWrite(fix)}`,
        {
          key: `${K}.duplicateField`,
          params: {
            existing, ...dove, insteadKey: insteadKey(fix), ...(fix ? { suggestion: fix } : {}),
          },
        },
      )
    }
  }
  return name
}

// ── La rete, davanti a makeExecutableSchema ───────────────────────────────────

/**
 * La rete sotto il generatore: i nomi già scritti nel grafo, controllati
 * **prima** di costruire l'SDL, così un nome entrato per altre vie (uno
 * script, una versione precedente del prodotto, una scrittura diretta in
 * Neo4j) dà un errore che NOMINA il tipo colpevole invece di un
 * `Syntax Error: Invalid number` da dentro `makeExecutableSchema`.
 *
 * **Non è la difesa principale**: la collisione fra il nome di un tipo del
 * cliente e un tipo dello schema di base è *silenziosa* all'assemblaggio
 * (merge), quindi l'unica difesa è la porta in scrittura
 * (`apps/api/src/lib/metamodelNames.ts`, che ha l'SDL di base). Qui si vede
 * solo ciò che si può sapere senza quell'SDL: la sintassi dei nomi, le chiavi
 * di proprietà riservate, e le collisioni **fra i tipi ricevuti** — che è
 * comunque il caso «tipo del cliente omonimo di un tipo base», perché nello
 * stesso elenco arrivano entrambi.
 */
export function assertGeneratableNames(
  types: readonly { name: string; label?: string; fields: readonly { name: string; isSystem?: boolean }[] }[],
  /**
   * I nomi già occupati dallo schema di BASE (revisione delle otto ondate ·
   * D·N-4). Senza questo la verifica partiva da un insieme vuoto, quindi
   * vedeva solo le collisioni fra i tipi del cliente: un tipo CI chiamato
   * `incident` passava — e graphql-tools **non lancia**, FONDE, quindi i suoi
   * campi finivano innestati sul tipo base `Incident` (dal vivo: da 32 a 44
   * campi) senza un errore da nessuna parte. La validazione in scrittura
   * (ondata 5) usa gli stessi nomi, ma non protegge il dato già scritto.
   *
   * Il generatore non può calcolarli da sé (l'SDL di base sta in `apps/api`),
   * quindi glieli passa il chiamante — la stessa sorgente unica di
   * `reservedNamesOfBaseSchema()`.
   */
  reserved?: ReservedSchemaNames,
): void {
  const seen = reserved ? cloneReservedNames(reserved) : emptyReservedNames()
  for (const type of types) {
    // Il messaggio di `assertCITypeName` parla a chi sta creando un tipo; qui
    // il tipo esiste già, e la via d'uscita è eliminarlo o rinominarlo.
    try {
      assertCITypeName(type.name, seen)
    } catch (e) {
      if (!(e instanceof MetamodelNameError)) throw e
      throw new MetamodelNameError(e.rule, e.offending,
        `The GraphQL schema of this tenant cannot be generated because of the CI type «${type.name}»` +
        `${type.label && type.label !== type.name ? ` («${type.label}»)` : ''}: ${e.message} ` +
        `The type already exists in the metamodel: delete it or rename it.`,
        // `detailKey` e la chiave del rifiuto INTERNO, e i suoi parametri
        // viaggiano insieme: il client risolve `detailKey` passandogli gli
        // stessi parametri, quindi la frase interna si compone come se fosse
        // stata lanciata da sola. Il parametro del wrapper si chiama `type`
        // per non pestare il `name` di quella interna.
        {
          key: `${K}.notGeneratable`,
          params: { ...e.i18n.params, type: type.name, detailKey: e.i18n.key },
        },
      )
    }

    const emitted = emittedNamesForCIType(type.name)
    const origin  = `the CI type "${type.name}"`
    for (const n of emitted.types)          seen.types.set(n.toLowerCase(), `${n} (${origin})`)
    for (const n of emitted.queryFields)    seen.queryFields.set(n.toLowerCase(), `${n} (${origin})`)
    for (const n of emitted.mutationFields) seen.mutationFields.set(n.toLowerCase(), `${n} (${origin})`)

    for (const f of type.fields) {
      if (f.isSystem) continue
      // I campi base l'SDL li filtra già: non arrivano mai a essere emessi.
      if (BASE_TYPE_FIELDS.has(f.name) || BASE_INPUT_FIELDS.has(f.name)) continue
      assertCIFieldName(f.name, { typeLabel: type.label ?? type.name })
    }
  }
}
