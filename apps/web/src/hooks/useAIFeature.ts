/**
 * Una funzione AI è accesa per questa organizzazione? (verifica «Cosa resta
 * cablato», ondata 6). `null` finché non si sa: chi chiama non mostra né il
 * bottone né l'avviso, invece di indovinare.
 */
import { useQuery } from '@apollo/client/react'
import { GET_AI_SETTINGS } from '@/graphql/queries'

export type AIFeature = 'triage' | 'assistant' | 'reportAnalysis' | 'postIncident' | 'kbArticles' | 'embeddings'

export function useAIFeature(feature: AIFeature): boolean | null {
  const { data } = useQuery<{ aiSettings: { features: Record<AIFeature, boolean> } }>(GET_AI_SETTINGS, { fetchPolicy: 'cache-first' })
  return data ? data.aiSettings.features[feature] : null
}
