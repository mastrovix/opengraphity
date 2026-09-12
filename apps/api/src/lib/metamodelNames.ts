/**
 * La PORTA sui nomi del metamodello CI (A-12): l'unico posto che sa quali nomi
 * sono già presi nello schema di un cliente.
 *
 * Le regole e i messaggi stanno in `@opengraphity/schema-generator`
 * (`nameValidation.ts`), che è puro. Qui si calcola l'**elenco riservato**, e
 * si calcola davvero: i nomi dei tipi, delle query e delle mutation si
 * *leggono dall'SDL di base* (`buildBaseSDL() + metamodelSDL()`) invece di
 * essere ricopiati in una lista. Una lista a mano divergerebbe al primo tipo
 * nuovo aggiunto allo schema, e divergerebbe in silenzio.
 *
 * ## Perché la porta è l'unica difesa
 * Verificato sulla versione di `@graphql-tools/schema` in uso: due tipi
 * GraphQL con lo stesso nome **non** fanno lanciare `makeExecutableSchema` —
 * vengono FUSI, e i campi del tipo del cliente entrano nel tipo del prodotto
 * senza un errore da nessuna parte. Quindi un tipo CI chiamato `incident`
 * corromperebbe il tipo `Incident` del prodotto **in silenzio**. Non esiste
 * nessuna rete a valle che lo prenda: se questo controllo non gira, non gira
 * niente.
 *
 * (Un nome non identificatore — `2fa` — e un plurale che collide con una query
 * esistente fanno invece fallire l'assemblaggio: rumorosi, e con la rete dello
 * schema «sicuro» sotto. Ma restano inaccettabili: li ferma anche la porta.)
 */
import { parse, Kind, type DocumentNode, type DefinitionNode } from 'graphql'
import {
  assertCITypeName, assertCIFieldName,
  emptyReservedNames, mergeReservedNames, reservedNamesForCITypes,
  MetamodelNameError,
  metamodelSDL,
  type ReservedSchemaNames, type CIFieldNameContext,
} from '@opengraphity/schema-generator'
import { buildBaseSDL } from '../graphql/schema-base.js'
import { ValidationError } from './errors.js'

// ── I nomi che l'SDL di base dichiara ─────────────────────────────────────────

const TYPE_KINDS: ReadonlySet<string> = new Set([
  Kind.OBJECT_TYPE_DEFINITION, Kind.OBJECT_TYPE_EXTENSION,
  Kind.INPUT_OBJECT_TYPE_DEFINITION, Kind.INPUT_OBJECT_TYPE_EXTENSION,
  Kind.INTERFACE_TYPE_DEFINITION, Kind.INTERFACE_TYPE_EXTENSION,
  Kind.ENUM_TYPE_DEFINITION, Kind.ENUM_TYPE_EXTENSION,
  Kind.UNION_TYPE_DEFINITION, Kind.UNION_TYPE_EXTENSION,
  Kind.SCALAR_TYPE_DEFINITION, Kind.SCALAR_TYPE_EXTENSION,
])

function fieldNamesOf(def: DefinitionNode): string[] {
  const fields = (def as { fields?: readonly { name: { value: string } }[] }).fields
  return fields ? fields.map((f) => f.name.value) : []
}

/**
 * Legge da uno o più documenti SDL i nomi già presi: tutti i tipi dichiarati e
 * i campi di `Query` e `Mutation` (anche quando arrivano da `extend type`).
 * È la sorgente dell'elenco riservato: nessuna lista scritta a mano.
 */
export function reservedNamesFromSDL(...sdl: string[]): ReservedSchemaNames {
  const out = emptyReservedNames()
  for (const text of sdl) {
    let doc: DocumentNode
    try {
      doc = parse(text)
    } catch (e) {
      // Non si ripara: se l'SDL di base non si legge, l'elenco riservato
      // sarebbe incompleto e la porta lascerebbe passare un nome che corrompe
      // lo schema in silenzio. Meglio fermarsi qui.
      throw new Error(`reservedNamesFromSDL: SDL non analizzabile (${e instanceof Error ? e.message : String(e)})`)
    }
    for (const def of doc.definitions) {
      if (!TYPE_KINDS.has(def.kind)) continue
      const name = (def as { name?: { value: string } }).name?.value
      if (!name) continue
      const key = name.toLowerCase()
      if (name === 'Query' || name === 'Mutation' || name === 'Subscription') {
        const bucket = name === 'Query' ? out.queryFields : name === 'Mutation' ? out.mutationFields : null
        if (bucket) {
          for (const f of fieldNamesOf(def)) {
            if (!bucket.has(f.toLowerCase())) bucket.set(f.toLowerCase(), `${f} è una ${name === 'Query' ? 'query' : 'mutation'} dello schema di base`)
          }
        }
      }
      if (!out.types.has(key)) out.types.set(key, `${name} è un tipo dello schema di base`)
    }
  }
  return out
}

/**
 * L'SDL di base non cambia a runtime: si legge una volta. (Il metamodello del
 * cliente sì, e quello si rilegge a ogni chiamata.)
 */
let baseReserved: ReservedSchemaNames | null = null
export function reservedNamesOfBaseSchema(): ReservedSchemaNames {
  baseReserved ??= reservedNamesFromSDL(buildBaseSDL(), metamodelSDL())
  return baseReserved
}

/** Solo per i test: dimentica l'SDL di base già letto. */
export function resetBaseSchemaNamesCache(): void {
  baseReserved = null
}

// ── La porta ──────────────────────────────────────────────────────────────────

/** Come si chiama, per il messaggio, il tipo CI che occupa già un nome. */
function originOf(scope: string | null | undefined): string {
  switch (scope) {
    case 'base':   return 'un tipo CI spedito col prodotto'
    case 'itil':   return 'un tipo ITIL spedito col prodotto'
    case 'tenant': return 'un tuo tipo CI'
    default:       return 'un tipo CI già esistente'
  }
}

export interface ExistingCIType {
  name:  string
  scope: string | null
}

/**
 * Il nome di un tipo CI che si sta per creare, contro tutto ciò che sarà nello
 * stesso schema: l'SDL di base e gli altri tipi CI di quel cliente (base, ITIL
 * e suoi). La collisione si verifica sui nomi **emessi** — PascalCase,
 * plurale, input e mutation — perché è lì che nasce il duplicato.
 *
 * `MetamodelNameError` → `ValidationError`, così il rifiuto arriva al web come
 * `BAD_USER_INPUT` con il messaggio intero (è il messaggio che dice cosa
 * scrivere invece).
 */
export function assertNewCITypeName(name: unknown, existing: readonly ExistingCIType[]): string {
  const reserved = mergeReservedNames(
    reservedNamesOfBaseSchema(),
    reservedNamesForCITypes(existing.map((t) => ({ name: t.name, origin: originOf(t.scope) }))),
  )
  try {
    return assertCITypeName(name, reserved)
  } catch (e) {
    throw asValidationError(e)
  }
}

/** Il nome di un campo CI che si sta per aggiungere a un tipo del cliente. */
export function assertNewCIFieldName(name: unknown, ctx: CIFieldNameContext = {}): string {
  try {
    return assertCIFieldName(name, ctx)
  } catch (e) {
    throw asValidationError(e)
  }
}

function asValidationError(e: unknown): unknown {
  if (e instanceof MetamodelNameError) return new ValidationError(e.message)
  return e
}
