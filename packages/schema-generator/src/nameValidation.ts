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
  'description', 'chain', 'createdAt', 'updatedAt', 'notes',
  'ownerGroup', 'supportGroup', 'dependencies', 'dependents',
  'health', 'healthSource', 'lastEventAt',
])

/** Campi già dichiarati a mano in `Create…Input` / `Update…Input`. */
export const BASE_INPUT_FIELDS: ReadonlySet<string> = new Set([
  'name', 'status', 'environment', 'description',
  'notes', 'ownerGroupId', 'supportGroupId',
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

export class MetamodelNameError extends Error {
  readonly rule: NameRule
  readonly offending: string
  constructor(rule: NameRule, offending: string, message: string) {
    super(message)
    this.name = 'MetamodelNameError'
    this.rule = rule
    this.offending = offending
  }
}

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
  return suggestion ? ` Scrivi per esempio «${suggestion}».` : ''
}

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
      `«${shown}» non va bene come nome di tipo CI: deve cominciare con una lettera minuscola e contenere solo ` +
      `lettere minuscole, cifre e trattini basso (regola: ${CI_TYPE_NAME_RE.source}).` +
      insteadWrite(fix) +
      (fix ? ` Diventerebbe il tipo GraphQL «${toPascalCase(fix)}» e la label Neo4j «${toPascalCase(fix)}».` : '') +
      ` Il nome è lo slug tecnico; il nome che si legge nell'interfaccia è la label, che può contenere ` +
      `spazi, accenti e maiuscole.`,
    )
  }

  const emitted = emittedNamesForCIType(name)
  // Il primo caso è il grave: un tipo omonimo non fa lanciare l'assemblaggio,
  // lo fa MERGE in silenzio (vedi la nota in testa al file). Gli altri due
  // farebbero fallire l'assemblaggio, che è rumoroso ma comunque inaccettabile.
  const checks: Array<{ names: string[]; taken: Map<string, string>; what: (n: string) => string; consequence: string }> = [
    { names: emitted.types, taken: reserved.types, what: (n) => `il tipo GraphQL «${n}»`,
      consequence: 'GraphQL non rifiuta due tipi con lo stesso nome: li FONDE in silenzio, e i campi del tuo tipo ' +
        'finirebbero dentro quello del prodotto — senza nessun errore, da nessuna parte' },
    { names: emitted.queryFields, taken: reserved.queryFields, what: (n) => `la query «${n}»`,
      consequence: 'due query con lo stesso nome e tipi diversi non si possono fondere: lo schema di questo cliente ' +
        'non si assemblerebbe, e finché il nome resta l\'API gli risponderebbe con lo schema ridotto' },
    { names: emitted.mutationFields, taken: reserved.mutationFields, what: (n) => `la mutation «${n}»`,
      consequence: 'due mutation con lo stesso nome e tipi diversi non si possono fondere: lo schema di questo ' +
        'cliente non si assemblerebbe' },
  ]
  for (const check of checks) {
    for (const n of check.names) {
      const owner = check.taken.get(n.toLowerCase())
      if (owner === undefined) continue
      throw new MetamodelNameError('typeNameTaken', name,
        `Il nome «${name}» è già preso: genererebbe ${check.what(n)}, che nello schema esiste già — ${owner}. ` +
        `${check.consequence}. ` +
        `Scegli un altro nome (per esempio «${name}_custom»); il nome che si legge nell'interfaccia lo decidi con la label, ` +
        `che può restare quella che volevi.`,
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
  const on = ctx.typeLabel ? ` sul tipo «${ctx.typeLabel}»` : ''

  if (typeof name !== 'string' || !CI_FIELD_NAME_RE.test(name)) {
    const shown = typeof name === 'string' ? name : JSON.stringify(name)
    throw new MetamodelNameError('fieldNameSyntax', shown,
      `«${shown}» non va bene come nome di campo${on}: deve cominciare con una lettera minuscola e contenere ` +
      `solo lettere e cifre, in camelCase (regola: ${CI_FIELD_NAME_RE.source}).` +
      insteadWrite(typeof name === 'string' ? suggestCIFieldName(name) : null) +
      ` Il trattino basso non è ammesso perché «costCenter» e «cost_center» finirebbero sulla stessa proprietà ` +
      `Neo4j e si sovrascriverebbero a vicenda. Il nome che si legge nell'interfaccia è la label, che può ` +
      `contenere spazi e accenti.`,
    )
  }

  const property = toSnakeCase(name)
  const prefix = RESERVED_CI_PROPERTY_PREFIXES.find((p) => property.startsWith(p))
  if (RESERVED_CI_PROPERTY_KEYS.has(property) || prefix) {
    throw new MetamodelNameError('fieldNameReservedProperty', name,
      `Il campo «${name}»${on} scriverebbe la proprietà «${property}», che è gestita dal prodotto` +
      (prefix ? ` (tutto ciò che comincia per «${prefix}» appartiene alla sincronizzazione)` : '') +
      `: il valore mandato da chi chiama l'API sovrascriverebbe un dato di sistema` +
      (property === 'tenant_id' ? ' — con «tenant_id» il CI nascerebbe nel cliente scelto dal chiamante' : '') +
      `.${insteadWrite(safeVariant(name))}`,
    )
  }

  if (BASE_TYPE_FIELDS.has(name) || BASE_INPUT_FIELDS.has(name)) {
    throw new MetamodelNameError('fieldNameBase', name,
      `Il campo «${name}» esiste già su ogni CI: è uno dei campi base (${[...BASE_TYPE_FIELDS].join(', ')}). ` +
      `Aggiungerlo${on} produrrebbe un campo dichiarato due volte nello schema. ` +
      `Usa il campo base che c'è già, oppure dai al tuo un nome diverso.${insteadWrite(safeVariant(name))}`,
    )
  }

  for (const existing of ctx.existingFieldNames ?? []) {
    if (existing.toLowerCase() === name.toLowerCase()) {
      throw new MetamodelNameError('fieldNameDuplicate', name,
        `Il campo «${existing}» esiste già${on}: due campi con lo stesso nome non possono stare sullo stesso tipo. ` +
        `Modifica quello che c'è, oppure dai a questo un nome diverso.${insteadWrite(safeVariant(name))}`,
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
        `Lo schema GraphQL di questo cliente non si può generare per colpa del tipo CI «${type.name}»` +
        `${type.label && type.label !== type.name ? ` («${type.label}»)` : ''}: ${e.message} ` +
        `Il tipo esiste già nel metamodello: eliminalo o rinominalo.`,
      )
    }

    const emitted = emittedNamesForCIType(type.name)
    const origin  = `il tipo CI "${type.name}"`
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
