/**
 * WHICH FIELDS THE CLIENT ASKED FOR (review of 23 Sep 2026).
 *
 * A list resolver that prefetches its children in the same query (members,
 * CIs, teams…) spares one query per row — and pays for every child the client
 * never asked for. The team pickers asked for ids and names and got every
 * owned and supported CI of 500 teams, 54,000 maps discarded. The prefetch
 * now happens only for the fields the query selects.
 */
import type { GraphQLResolveInfo, SelectionSetNode } from 'graphql'

/** The names of the fields selected directly under the current one, through fragments and inline fragments. */
export function selectedFields(info: Pick<GraphQLResolveInfo, 'fieldNodes' | 'fragments'> | undefined): Set<string> {
  const out = new Set<string>()
  if (!info) return out
  const visit = (set: SelectionSetNode | undefined, seen: Set<string>): void => {
    for (const sel of set?.selections ?? []) {
      if (sel.kind === 'Field') out.add(sel.name.value)
      else if (sel.kind === 'InlineFragment') visit(sel.selectionSet, seen)
      else if (sel.kind === 'FragmentSpread' && !seen.has(sel.name.value)) {
        seen.add(sel.name.value)
        visit(info.fragments[sel.name.value]?.selectionSet, seen)
      }
    }
  }
  for (const node of info.fieldNodes) visit(node.selectionSet, new Set())
  return out
}
