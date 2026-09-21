/**
 * Doppio di `lib/aiSettings.ts`: tutte le funzioni AI accese (il comportamento
 * di fabbrica), senza leggere il Tenant. `aiOff` spegne una funzione per un test.
 */
import { GraphQLError } from 'graphql'

export const AI_FEATURES = ['triage', 'assistant', 'reportAnalysis', 'postIncident', 'kbArticles', 'embeddings'] as const
export type AIFeature = (typeof AI_FEATURES)[number]

const off = new Set<string>()
export function aiOff(...features: AIFeature[]): void { for (const f of features) off.add(f) }
export function aiResetFake(): void { off.clear() }

export async function aiSettings() {
  return {
    features: Object.fromEntries(AI_FEATURES.map((f) => [f, !off.has(f)])) as Record<AIFeature, boolean>,
    clusterMinSimilarity: 0.72, clusterMinSize: 3, isDefault: true,
  }
}
export async function aiFeatureEnabled(_tenantId: string, feature: AIFeature): Promise<boolean> { return !off.has(feature) }
export function aiDisabledError(feature: AIFeature): GraphQLError {
  return new GraphQLError(`The AI feature "${feature}" is turned off for this organization.`, { extensions: { code: 'AI_DISABLED', feature } })
}
export async function assertAIFeature(tenantId: string, feature: AIFeature): Promise<void> {
  if (!(await aiFeatureEnabled(tenantId, feature))) throw aiDisabledError(feature)
}
