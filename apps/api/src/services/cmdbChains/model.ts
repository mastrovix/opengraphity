/**
 * CMDB CHAINS (owner, 24 Sep 2026): which relations between CIs are admitted.
 *
 * A chain is a tree of CI types drawn from a root: each link says which
 * relation joins a type to the one above it, and in which direction. Every
 * link is required and a chain is used whole — the owner: «se sfrutto
 * quell'albero, lo sfrutto tutto, altrimenti cambio albero»; what is optional
 * is another chain, an alternative. The relations a chain draws are the ones a CI may have; a
 * relation no chain draws is refused when it is created (the API, discovery,
 * a sync conflict) and CMDB Health counts the ones that got in anyway.
 *
 * ## Families and chains are different things
 * The chain families of a type (Application, Infrastructure, or both — the
 * CI Type Designer) say what a CI IS; a chain says what it may be LINKED to.
 * The families bound the drawing, in the owner's words:
 *  - two types can be linked only when they share a family (an application
 *    type and one that is both: yes; an application type and an
 *    infrastructure one: no);
 *  - a chain is `application` (every type has the Application family),
 *    `infrastructure` (every type has the Infrastructure family) or `mixed`
 *    (any type, each link still sharing a family).
 *
 * ## The metamodel still decides the relation
 * A link is drawn only with a relation the metamodel declares between the two
 * types (lib/ciRelationDeclared.ts): the chain narrows what the metamodel
 * allows, it never widens it.
 */
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import { ValidationError } from '../../lib/errors.js'
import { relationDeclaredBy } from '../../lib/ciRelationDeclared.js'

export const CHAIN_KINDS = ['application', 'infrastructure', 'mixed'] as const
export type ChainKind = (typeof CHAIN_KINDS)[number]

export const LINK_DIRECTIONS = ['outgoing', 'incoming'] as const
/** `outgoing`: the type above → this one; `incoming`: this one → the type above. */
export type LinkDirection = (typeof LINK_DIRECTIONS)[number]

/** The family a chain kind asks of every type in it (`mixed`: none). */
const KIND_FAMILY: Readonly<Record<ChainKind, string | null>> = {
  application: 'Application', infrastructure: 'Infrastructure', mixed: null,
}

export interface ChainNode {
  id: string
  /** `null` for the root, the only node without a link. */
  parentId: string | null
  /** The CI type's name (e.g. `server`). */
  ciType: string
  relationType: string | null
  direction: LinkDirection | null
  required: boolean
}

export interface CmdbChain {
  id: string
  name: string
  kind: ChainKind
  nodes: ChainNode[]
  createdAt: string | null
  updatedAt: string | null
}

export interface ChainNodeInput {
  id: string
  parentId?: string | null
  ciType: string
  relationType?: string | null
  direction?: string | null
  required?: boolean | null
}

export interface ChainInput { name: string; kind: string; nodes: ChainNodeInput[] }

export const MAX_CHAIN_NAME = 80
export const MAX_CHAIN_NODES = 60
const MAX_NODE_ID = 64

const fail = (message: string, key: string, params: Record<string, string | number> = {}): never => {
  throw new ValidationError(message, { key: `errors.cmdbChain.${key}`, params })
}

export function assertChainKind(kind: string): ChainKind {
  if (!(CHAIN_KINDS as readonly string[]).includes(kind)) fail(`"${kind}" is not a chain kind (${CHAIN_KINDS.join(', ')})`, 'unknownKind', { kind })
  return kind as ChainKind
}

function typeNamed(types: readonly CITypeWithDefinitions[], name: string): CITypeWithDefinitions {
  const t = types.find((x) => x.name === name && x.neo4jLabel)
  if (!t) fail(`"${name}" is not an active CI type of this tenant`, 'unknownType', { type: name })
  return t!
}

const shownName = (t: CITypeWithDefinitions): string => t.label || t.name

/** The families two types share: a link needs at least one. */
function sharedFamilies(a: CITypeWithDefinitions, b: CITypeWithDefinitions): string[] {
  const fa = new Set(a.chainFamilies ?? [])
  return (b.chainFamilies ?? []).filter((f) => fa.has(f))
}

/** The type may sit in a chain of this kind: it has a family, and the one the kind asks. */
function assertTypeFitsKind(t: CITypeWithDefinitions, kind: ChainKind): void {
  if (!(t.chainFamilies ?? []).length) {
    fail(`${shownName(t)} has no chain family: give it one in the CI Type Designer before drawing it in a chain`, 'typeWithoutFamily', { type: shownName(t) })
  }
  const family = KIND_FAMILY[kind]
  if (family && !(t.chainFamilies ?? []).includes(family)) {
    fail(`${shownName(t)} is not of the ${family} family: it cannot sit in a chain of kind ${kind}`, 'typeNotInKind', { type: shownName(t), kind })
  }
}

/** Source and target labels of a link, in the relation's own direction. */
export function linkEnds(parent: CITypeWithDefinitions, child: CITypeWithDefinitions, direction: LinkDirection): [string, string] {
  return direction === 'outgoing' ? [parent.neo4jLabel, child.neo4jLabel] : [child.neo4jLabel, parent.neo4jLabel]
}

/** A link the families and the metamodel allow, or the refusal that says why. */
function assertLinkAllowed(
  types: readonly CITypeWithDefinitions[], parent: CITypeWithDefinitions, child: CITypeWithDefinitions, relationType: string, direction: LinkDirection,
): void {
  if (!sharedFamilies(parent, child).length) {
    fail(`${shownName(parent)} and ${shownName(child)} share no chain family: they cannot be linked`, 'noSharedFamily',
      { parent: shownName(parent), child: shownName(child) })
  }
  const [from, to] = linkEnds(parent, child, direction)
  if (!relationDeclaredBy(types, relationType, from, to)) {
    const source = direction === 'outgoing' ? shownName(parent) : shownName(child)
    const target = direction === 'outgoing' ? shownName(child) : shownName(parent)
    fail(`The metamodel declares no ${relationType} from ${source} to ${target}`, 'relationNotDeclared', { relation: relationType, source, target })
  }
}

/**
 * What a chain may be saved as: the name, the kind, and a tree whose every
 * link the families and the metamodel allow. Refuses with the reason.
 */
export function validateChainInput(input: ChainInput, types: readonly CITypeWithDefinitions[]): { name: string; kind: ChainKind; nodes: ChainNode[] } {
  const name = (input.name ?? '').trim()
  if (!name) fail('A chain needs a name', 'nameRequired')
  if (name.length > MAX_CHAIN_NAME) fail(`A chain name is at most ${String(MAX_CHAIN_NAME)} characters`, 'nameTooLong', { max: MAX_CHAIN_NAME })
  const kind = assertChainKind(input.kind)
  const raw = input.nodes ?? []
  if (!raw.length) fail('A chain needs at least its root type', 'noRoot')
  if (raw.length > MAX_CHAIN_NODES) fail(`A chain has at most ${String(MAX_CHAIN_NODES)} types`, 'tooManyNodes', { max: MAX_CHAIN_NODES })
  const byId = new Map<string, ChainNodeInput>()
  for (const n of raw) {
    if (!n.id || n.id.length > MAX_NODE_ID) fail('Every type in a chain needs an id of at most 64 characters', 'badNodeId')
    if (byId.has(n.id)) fail(`The id "${n.id}" is used twice in the chain`, 'duplicateNodeId', { id: n.id })
    byId.set(n.id, n)
  }
  const roots = raw.filter((n) => !n.parentId)
  if (roots.length !== 1) fail(`A chain has exactly one root; this one has ${String(roots.length)}`, 'oneRoot', { count: roots.length })
  const nodes: ChainNode[] = []
  const siblings = new Set<string>()
  for (const n of raw) {
    const type = typeNamed(types, n.ciType)
    assertTypeFitsKind(type, kind)
    if (!n.parentId) {
      nodes.push({ id: n.id, parentId: null, ciType: type.name, relationType: null, direction: null, required: true })
      continue
    }
    const parentInput = byId.get(n.parentId)
    if (!parentInput) fail(`The type above "${n.id}" is not in the chain`, 'unknownParent', { id: n.id })
    // Walk up: a node that cannot reach the root is in a loop.
    let up: ChainNodeInput | undefined = parentInput
    for (let steps = 0; up?.parentId; steps++) {
      if (steps > raw.length) fail('The chain loops back on itself', 'cycle')
      up = byId.get(up.parentId)
    }
    const relationType = (n.relationType ?? '').trim()
    if (!relationType) fail(`The link to ${shownName(type)} has no relation`, 'relationRequired', { type: shownName(type) })
    if (!(LINK_DIRECTIONS as readonly string[]).includes(n.direction ?? '')) {
      fail(`"${String(n.direction)}" is not a direction (${LINK_DIRECTIONS.join(', ')})`, 'unknownDirection', { direction: String(n.direction) })
    }
    const direction = n.direction as LinkDirection
    // Every link is required: an optional one is an alternative, drawn as another chain.
    if (n.required === false) fail(`The link to ${shownName(type)} is optional: every link of a chain is required, and an alternative is another chain`, 'linkOptional', { type: shownName(type) })
    const parent = typeNamed(types, parentInput!.ciType)
    assertLinkAllowed(types, parent, type, relationType, direction)
    const sibling = `${n.parentId}|${relationType}|${direction}|${type.name}`
    if (siblings.has(sibling)) {
      fail(`${shownName(parent)} has the same link to ${shownName(type)} twice`, 'duplicateLink', { parent: shownName(parent), child: shownName(type) })
    }
    siblings.add(sibling)
    nodes.push({ id: n.id, parentId: n.parentId, ciType: type.name, relationType, direction, required: true })
  }
  return { name, kind, nodes }
}

/** The key of an admitted relation: `SourceLabel|RELATION|TargetLabel`. */
export const relationKey = (from: string, relationType: string, to: string): string => `${from}|${relationType}|${to}`

/** The labels of every type some chain draws: the chains govern the relations between these, and only these. */
export function drawnTypeLabels(chains: readonly CmdbChain[], types: readonly CITypeWithDefinitions[]): Set<string> {
  const byName = new Map(types.filter((t) => t.neo4jLabel).map((t) => [t.name, t.neo4jLabel]))
  return new Set(chains.flatMap((c) => c.nodes.map((n) => byName.get(n.ciType)).filter((l): l is string => !!l)))
}

/**
 * Every relation the chains admit, by key. A chain whose type has since
 * gone from the metamodel admits nothing through it — the chain stays, and
 * CMDB Health shows its relations as not admitted until it is redrawn.
 */
export function admittedRelationKeys(chains: readonly CmdbChain[], types: readonly CITypeWithDefinitions[]): Set<string> {
  const byName = new Map(types.filter((t) => t.neo4jLabel).map((t) => [t.name, t]))
  const keys = new Set<string>()
  for (const chain of chains) {
    const nodeById = new Map(chain.nodes.map((n) => [n.id, n]))
    for (const n of chain.nodes) {
      if (!n.parentId || !n.relationType || !n.direction) continue
      const parent = byName.get(nodeById.get(n.parentId)?.ciType ?? '')
      const child = byName.get(n.ciType)
      if (!parent || !child) continue
      const [from, to] = linkEnds(parent, child, n.direction)
      keys.add(relationKey(from, n.relationType, to))
    }
  }
  return keys
}

/**
 * The links that may hang below a type in a chain of this kind: every relation
 * the metamodel declares for it, in either direction, toward a type the
 * families allow. What the editor offers — the same rule the save applies.
 */
export function linkOptions(types: readonly CITypeWithDefinitions[], parentName: string, kind: ChainKind): Array<{ relationType: string; direction: LinkDirection; ciType: string }> {
  const parent = typeNamed(types, parentName)
  const out: Array<{ relationType: string; direction: LinkDirection; ciType: string }> = []
  const seen = new Set<string>()
  const relationTypes = new Set(types.flatMap((t) => t.relations.flatMap((r) => r.relationshipType.split('|').map((x) => x.trim()).filter(Boolean))))
  for (const child of types) {
    if (!child.neo4jLabel || !(child.chainFamilies ?? []).length) continue
    const family = KIND_FAMILY[kind]
    if (family && !(child.chainFamilies ?? []).includes(family)) continue
    if (!sharedFamilies(parent, child).length) continue
    for (const relationType of relationTypes) {
      for (const direction of LINK_DIRECTIONS) {
        const [from, to] = linkEnds(parent, child, direction)
        const key = `${relationType}|${direction}|${child.name}`
        if (!seen.has(key) && relationDeclaredBy(types, relationType, from, to)) {
          seen.add(key)
          out.push({ relationType, direction, ciType: child.name })
        }
      }
    }
  }
  return out.sort((a, b) => a.ciType.localeCompare(b.ciType) || a.relationType.localeCompare(b.relationType) || a.direction.localeCompare(b.direction))
}
