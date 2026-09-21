/**
 * I PARAMETRI di una diagnostica, nella forma che lo schema sa dire.
 *
 * Dentro l'API un parametro è una voce di `Record<string, string>`, che è la
 * forma comoda per chi lo scrive. Lo schema GraphQL non ha uno scalare JSON, e
 * non gliene serve uno: la stessa cosa come lista di coppie è altrettanto
 * precisa e si tipizza. La conversione sta qui, in un posto solo, perché la
 * fanno due resolver diversi (`configurationIssues` e
 * `tenantProvisioningGaps`) e due forme divergenti sarebbero due bug.
 */
import type { ProvisioningGap } from '../lib/provisionTenantData.js'

export interface IssueParam { name: string; value: string }

export function mapParams(params: Record<string, string> | undefined): IssueParam[] {
  return Object.entries(params ?? {}).map(([name, value]) => ({ name, value }))
}

export function mapGaps(gaps: readonly ProvisioningGap[]): Array<{ kind: string; params: IssueParam[] }> {
  return gaps.map((g) => ({ kind: g.kind, params: mapParams(g.params) }))
}
