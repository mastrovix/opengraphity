/**
 * CMDB CHAINS on the page (owner, 24 Sep 2026): which relations between CIs
 * are admitted. A chain is a tree of CI types from a root; each link says the
 * relation and its direction; every link is required, and what is optional is
 * another chain, an alternative (owner, 24 Sep 2026). The rules — families,
 * metamodel — are the API's (services/cmdbChains/model.ts): the editor only
 * offers what the API offers (`cmdbChainLinkOptions`) and shows its refusals.
 *
 * Pure helpers here: the tree, its layout, the words.
 */
export const CHAIN_KINDS = ['application', 'infrastructure', 'mixed'] as const
export type ChainKind = (typeof CHAIN_KINDS)[number]
export type LinkDirection = 'outgoing' | 'incoming'

export interface ChainNode {
  id: string
  parentId: string | null
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

/** What the editor holds while drawing: a saved chain being changed (id) or a new one (null). */
export interface ChainDraft { id: string | null; name: string; kind: ChainKind; nodes: ChainNode[] }

export interface LinkOption { relationType: string; direction: LinkDirection; ciType: string }

export interface ChainCoverage { chainId: string; name: string; kind: string; roots: number; complete: number }

export const isChainKind = (k: string): k is ChainKind => (CHAIN_KINDS as readonly string[]).includes(k)

/** A short id for a new type in the tree: unique in its chain is all it needs. */
export function newNodeId(): string {
  return `n-${crypto.randomUUID().slice(0, 8)}`
}

export const childrenOf = (nodes: readonly ChainNode[], id: string): ChainNode[] => nodes.filter((n) => n.parentId === id)

/** The tree without this type and everything that hangs below it. */
export function withoutSubtree(nodes: readonly ChainNode[], id: string): ChainNode[] {
  const gone = new Set([id])
  for (let grew = true; grew;) {
    grew = false
    for (const n of nodes) if (n.parentId && gone.has(n.parentId) && !gone.has(n.id)) { gone.add(n.id); grew = true }
  }
  return nodes.filter((n) => !gone.has(n.id))
}

export function addLink(nodes: readonly ChainNode[], parentId: string, option: LinkOption, id = newNodeId()): ChainNode[] {
  return [...nodes, { id, parentId, ciType: option.ciType, relationType: option.relationType, direction: option.direction, required: true }]
}

/**
 * Where each type sits: top-down, one row per depth; the leaves side by side
 * in the order of the tree, a parent centred over its children. No dragging:
 * the tree is the drawing.
 */
export function layoutTree(nodes: readonly ChainNode[], xGap = 220, yGap = 130): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  const root = nodes.find((n) => !n.parentId)
  if (!root) return out
  let nextLeaf = 0
  const place = (n: ChainNode, depth: number, seen: Set<string>): number => {
    const kids = childrenOf(nodes, n.id).filter((k) => !seen.has(k.id))
    seen.add(n.id)
    const xs = kids.map((k) => place(k, depth + 1, seen))
    const x = xs.length ? (xs[0]! + xs[xs.length - 1]!) / 2 : (nextLeaf++) * xGap
    out.set(n.id, { x, y: depth * yGap })
    return x
  }
  place(root, 0, new Set())
  return out
}

/** The chain as the API takes it: nothing but the fields of the input. */
export function toChainInput(draft: ChainDraft) {
  return {
    name: draft.name,
    kind: draft.kind,
    nodes: draft.nodes.map((n) => ({ id: n.id, parentId: n.parentId, ciType: n.ciType, relationType: n.relationType, direction: n.direction, required: n.required })),
  }
}

/**
 * A relation in words, from its type: «Hosted on», «Depends on», «Installed
 * on». It names the relation, so it stays as it is in every language. The
 * metamodel's labels are the names of a type's lists, each from its own side
 * («Realized By», «Dependents», «Members»): beside an arrow they read wrong.
 */
export function relationLabel(relationType: string): string {
  const words = relationType.toLowerCase().replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
