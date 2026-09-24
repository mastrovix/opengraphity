/**
 * THE CHAINS AGAINST THE DATA: what CMDB Health counts from the drawn chains.
 *
 * The owner's model (24 Sep 2026): every link of a chain is required, and a
 * chain is used whole — «se sfrutto quell'albero, lo sfrutto tutto,
 * altrimenti cambio albero». The chains are alternatives: a server with a
 * certificate follows one, a server without another.
 *
 * Each chain is walked from its root, a link at a time, over the CIs the
 * tenant really has:
 *  - REACHED: a CI a chain arrives at from one of its roots, whatever its
 *    status — the walk goes through retired CIs, the counts leave them out;
 *  - FOLLOWS: a CI in service follows a chain at a type when everything the
 *    chain draws below that type is there, all the way down, with CIs in
 *    service (a type with nothing below: always);
 *  - INCOMPLETE: a CI in service that follows no chain where it stands. It
 *    stands where the chains first place it — its shallowest type in them: an
 *    application is judged as the application of a business application, not
 *    as the one another depends on — and it is fine when at one of those
 *    places some chain is followed whole. The links it lacks are named, chain
 *    by chain, as the alternatives they are;
 *  - COVERAGE: for each chain, its roots in service and how many follow it.
 *
 * Three literal queries, every label and relation a parameter: the roots of a
 * type, and the CIs one link away from a set of parents, one per direction.
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import type { ChainKind, ChainNode, CmdbChain, LinkDirection } from './model.js'

const ROOTS = `
  MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
  WHERE $label IN labels(ci)
  RETURN ci.id AS id, NOT coalesce(ci.status, '') IN $retired AS inService`

const BELOW_OUTGOING = `
  UNWIND $ids AS pid
  MATCH (p:ConfigurationItem {tenant_id: $tenantId, id: pid})-[r]->(c:ConfigurationItem {tenant_id: $tenantId})
  WHERE type(r) = $relationType AND $label IN labels(c)
  RETURN pid AS parent, c.id AS child, NOT coalesce(c.status, '') IN $retired AS inService`

const BELOW_INCOMING = `
  UNWIND $ids AS pid
  MATCH (p:ConfigurationItem {tenant_id: $tenantId, id: pid})<-[r]-(c:ConfigurationItem {tenant_id: $tenantId})
  WHERE type(r) = $relationType AND $label IN labels(c)
  RETURN pid AS parent, c.id AS child, NOT coalesce(c.status, '') IN $retired AS inService`

/** A required link a CI in service lacks, in the words of the chain. */
export interface MissingLink {
  chain: string
  /** The CI type the link goes to (e.g. `server`). */
  ciType: string
  relationType: string
  direction: LinkDirection
}

export interface ChainCoverage { chainId: string; name: string; kind: ChainKind; roots: number; complete: number }

export interface ChainEvaluation {
  /** The labels of every type drawn in some chain: the CIs «outside every chain» can be of these only. */
  drawnLabels: string[]
  /** CI ids some chain reaches from a root, whatever their status. */
  reached: Set<string>
  /** CIs in service reached at a type whose required link they lack. */
  incomplete: Map<string, MissingLink[]>
  /** CIs in service reached at a type with a required link below it: what «incomplete» looked at. */
  checkedForLinks: Set<string>
  coverage: ChainCoverage[]
}

/** CI id → in service. */
type Matched = Map<string, boolean>

/** The nodes of a chain from the root down, parents before children; a node whose parent is missing is left out. */
function topDown(nodes: readonly ChainNode[]): ChainNode[] {
  const root = nodes.find((n) => !n.parentId)
  if (!root) return []
  const out: ChainNode[] = [root]
  for (let i = 0; i < out.length; i++) for (const n of nodes) if (n.parentId === out[i]!.id) out.push(n)
  return out
}

/** One chain walked over the data: the CIs at each of its types, and who is below whom along each link. */
interface Walk {
  order: ChainNode[]
  matched: Map<string, Matched>
  /** node id → parent CI id → its CIs along that node's link. */
  below: Map<string, Map<string, string[]>>
}

async function walkChain(
  session: Session, tenantId: string, order: ChainNode[], labelOf: ReadonlyMap<string, string>, roots: Matched, retired: readonly string[],
): Promise<Walk> {
  const matched = new Map<string, Matched>([[order[0]!.id, roots]])
  const below = new Map<string, Map<string, string[]>>()
  for (const node of order.slice(1)) {
    const parents = [...(matched.get(node.parentId!)?.keys() ?? [])]
    const here: Matched = new Map()
    const links = new Map<string, string[]>()
    if (parents.length) {
      const rows = await runQuery<{ parent: string; child: string; inService: boolean }>(session,
        node.direction === 'incoming' ? BELOW_INCOMING : BELOW_OUTGOING,
        { tenantId, ids: parents, relationType: node.relationType, label: labelOf.get(node.ciType), retired })
      for (const r of rows) {
        here.set(r.child, r.inService)
        links.set(r.parent, [...(links.get(r.parent) ?? []), r.child])
      }
    }
    matched.set(node.id, here)
    below.set(node.id, links)
  }
  return { order, matched, below }
}

/** The CIs in service along a link below `ci`. */
const liveBelow = (w: Walk, link: ChainNode, ci: string): string[] =>
  (w.below.get(link.id)?.get(ci) ?? []).filter((c) => w.matched.get(link.id)?.get(c) === true)

/** The CIs in service that follow the chain at each type, from the leaves up. */
function followersAt(w: Walk): Map<string, Set<string>> {
  const follows = new Map<string, Set<string>>()
  for (const node of [...w.order].reverse()) {
    const kids = w.order.filter((n) => n.parentId === node.id)
    const ok = new Set<string>()
    for (const [ci, inService] of w.matched.get(node.id) ?? []) {
      if (inService && kids.every((k) => liveBelow(w, k, ci).some((c) => follows.get(k.id)?.has(c) === true))) ok.add(ci)
    }
    follows.set(node.id, ok)
  }
  return follows
}

/** Where a CI does not follow the chain: the first link missing on each branch, going down the first CI it has there. */
function missingBelow(w: Walk, follows: Map<string, Set<string>>, chainName: string, node: ChainNode, ci: string, seen = new Set<string>()): MissingLink[] {
  if (seen.has(`${node.id}|${ci}`)) return []
  seen.add(`${node.id}|${ci}`)
  const out: MissingLink[] = []
  for (const k of w.order.filter((n) => n.parentId === node.id)) {
    const live = liveBelow(w, k, ci)
    if (live.some((c) => follows.get(k.id)?.has(c) === true)) continue
    if (!live.length) out.push({ chain: chainName, ciType: k.ciType, relationType: k.relationType!, direction: k.direction! })
    else out.push(...missingBelow(w, follows, chainName, k, live[0]!, seen))
  }
  return out
}

/** One place a CI stands in a chain: how deep, whether the chain asks nothing more there, whether it is followed. */
interface Place { depth: number; leaf: boolean; follows: boolean; missing: MissingLink[] }

function collectPlaces(w: Walk, chainName: string, places: Map<string, Place[]>): Set<string> {
  const follows = followersAt(w)
  const depth = new Map<string, number>([[w.order[0]!.id, 0]])
  for (const node of w.order.slice(1)) depth.set(node.id, depth.get(node.parentId!)! + 1)
  for (const node of w.order) {
    const leaf = !w.order.some((n) => n.parentId === node.id)
    for (const [ci, inService] of w.matched.get(node.id) ?? []) {
      if (!inService) continue
      const ok = follows.get(node.id)!.has(ci)
      places.set(ci, [...(places.get(ci) ?? []), { depth: depth.get(node.id)!, leaf, follows: ok, missing: ok ? [] : missingBelow(w, follows, chainName, node, ci) }])
    }
  }
  return follows.get(w.order[0]!.id)!
}

export async function evaluateChains(
  session: Session, tenantId: string, chains: readonly CmdbChain[], types: readonly CITypeWithDefinitions[], retired: readonly string[],
): Promise<ChainEvaluation> {
  const labelOf = new Map(types.filter((t) => t.neo4jLabel).map((t) => [t.name, t.neo4jLabel]))
  const rootsByLabel = new Map<string, Matched>()
  const out: ChainEvaluation = { drawnLabels: [], reached: new Set(), incomplete: new Map(), checkedForLinks: new Set(), coverage: [] }
  const drawn = new Set<string>()
  const places = new Map<string, Place[]>()
  for (const chain of chains) {
    const order = topDown(chain.nodes).filter((n) => labelOf.has(n.ciType))
    const root = order[0]
    if (!root || root.parentId) { out.coverage.push({ chainId: chain.id, name: chain.name, kind: chain.kind, roots: 0, complete: 0 }); continue }
    for (const n of order) drawn.add(labelOf.get(n.ciType)!)
    const rootLabel = labelOf.get(root.ciType)!
    if (!rootsByLabel.has(rootLabel)) {
      const rows = await runQuery<{ id: string; inService: boolean }>(session, ROOTS, { tenantId, label: rootLabel, retired })
      rootsByLabel.set(rootLabel, new Map(rows.map((r) => [r.id, r.inService])))
    }
    const roots = rootsByLabel.get(rootLabel)!
    const w = await walkChain(session, tenantId, order, labelOf, roots, retired)
    for (const m of w.matched.values()) for (const id of m.keys()) out.reached.add(id)
    const followed = collectPlaces(w, chain.name, places)
    out.coverage.push({ chainId: chain.id, name: chain.name, kind: chain.kind, roots: [...roots.values()].filter(Boolean).length, complete: followed.size })
  }
  // Judged where the chains first place it: fine when one chain is followed whole there.
  for (const [ci, all] of places) {
    const top = Math.min(...all.map((p) => p.depth))
    const here = all.filter((p) => p.depth === top)
    if (here.some((p) => p.leaf)) continue
    out.checkedForLinks.add(ci)
    if (!here.some((p) => p.follows)) out.incomplete.set(ci, here.flatMap((p) => p.missing))
  }
  out.drawnLabels = [...drawn]
  return out
}
