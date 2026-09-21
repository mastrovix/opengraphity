/**
 * I LIMITI DI UNA QUERY GraphQL: profondita e numero di campi.
 *
 * Stavano dentro `server.ts`, dove nessun test poteva raggiungerli — e il
 * difetto M-1 (i fragment non contavano, quindi il limite si aggirava
 * spostando il carico in un fragment) e proprio il genere di cosa che un test
 * avrebbe fissato. Qui sono due funzioni pure con il loro test.
 */
import { GraphQLError, type ValidationRule } from 'graphql'


interface SelectionSetNode { selections: unknown[] }
interface FieldLikeNode { selectionSet?: SelectionSetNode; kind?: string; name?: { value: string } }

/**
 * I FRAGMENT contano (revisione totale · M-1).
 *
 * Le due regole camminavano solo le `OperationDefinition`, e uno spread
 * `...F` non ha `selectionSet`: la profondita e il numero di campi di un
 * fragment non contavano per niente. Quindi
 *
 *   query { a { ...F } }  fragment F on A { b { c { d { … } } } }
 *
 * passava i limiti 10/2000 — cioe la protezione contro l'amplificazione si
 * aggirava spostando il carico in un fragment, che e la prima cosa che si
 * prova. Ora gli spread si risolvono nella loro definizione.
 *
 * Un fragment CICLICO (`fragment F on A { ...F }`) e vietato da una regola
 * standard di GraphQL, ma le regole girano tutte sullo stesso documento e
 * questa non puo contare sull'altra: i nomi gia visti lungo il cammino si
 * fermano, altrimenti la ricorsione non tornerebbe.
 */
type Fragments = ReadonlyMap<string, FieldLikeNode>

export function fragmentsOf(doc: { definitions: readonly unknown[] }): Fragments {
  const out = new Map<string, FieldLikeNode>()
  for (const def of doc.definitions) {
    const d = def as FieldLikeNode
    if (d.kind === 'FragmentDefinition' && d.name) out.set(d.name.value, d)
  }
  return out
}

/**
 * Uno spread e un fragment in linea NON sono un livello ne un campo: quello che
 * portano dentro sta dove sta lo spread. Senza questa distinzione le due forme
 * — scritta in linea e scritta in un fragment — darebbero numeri diversi per
 * la stessa query.
 */
const isSpread = (n: FieldLikeNode) => n.kind === 'FragmentSpread' || n.kind === 'InlineFragment'

function getDepth(node: FieldLikeNode, current: number, fragments: Fragments, seen: ReadonlySet<string> = new Set()): number {
  let scope = seen
  if (node.kind === 'FragmentSpread' && node.name) {
    const name = node.name.value
    if (seen.has(name)) return current
    const def = fragments.get(name)
    if (!def) return current
    node = def
    scope = new Set([...seen, name])
  }
  if (!node.selectionSet) return current
  return Math.max(
    ...node.selectionSet.selections.map((sel) => {
      const child = sel as FieldLikeNode
      return getDepth(child, isSpread(child) ? current : current + 1, fragments, scope)
    }),
  )
}

export function depthLimit(maxDepth: number): ValidationRule {
  return (context) => ({
    Document(node) {
      const fragments = fragmentsOf(node)
      for (const def of node.definitions) {
        if (def.kind === 'OperationDefinition') {
          const depth = getDepth(def as unknown as FieldLikeNode, 0, fragments)
          if (depth > maxDepth) {
            context.reportError(
              new GraphQLError(
                `Query depth ${depth} exceeds maximum allowed depth of ${maxDepth}`,
                { nodes: [def] },
              ),
            )
          }
        }
      }
    },
  })
}

// Total field count across the whole operation (aliases included). Depth alone
// does not stop breadth amplification — the same expensive field aliased N
// times stays shallow but multiplies the work. This caps that.
// M-1: i campi dentro un fragment contano dove sta lo spread.
function countFields(node: FieldLikeNode, fragments: Fragments, seen: ReadonlySet<string> = new Set()): number {
  let scope = seen
  if (node.kind === 'FragmentSpread' && node.name) {
    const name = node.name.value
    if (seen.has(name)) return 0
    const def = fragments.get(name)
    if (!def) return 0
    node = def
    scope = new Set([...seen, name])
  }
  if (!node.selectionSet) return 0
  let total = 0
  for (const sel of node.selectionSet.selections) {
    const child = sel as FieldLikeNode
    total += (isSpread(child) ? 0 : 1) + countFields(child, fragments, scope)
  }
  return total
}

export function fieldCountLimit(maxFields: number): ValidationRule {
  return (context) => ({
    Document(node) {
      for (const def of node.definitions) {
        if (def.kind === 'OperationDefinition') {
          const count = countFields(def as unknown as FieldLikeNode, fragmentsOf(node))
          if (count > maxFields) {
            context.reportError(
              new GraphQLError(
                `Query selects ${count} fields, exceeding the maximum of ${maxFields}`,
                { nodes: [def] },
              ),
            )
          }
        }
      }
    },
  })
}
