/**
 * LE FUNZIONI AI, IN UN POSTO SOLO (nel web).
 *
 * L'elenco viveva in tre copie dentro il web — la sezione di Organizzazione,
 * il tipo del hook `useAIFeature` e la selezione della query — più due
 * nell'API (`AI_FEATURES` e lo schema GraphQL). Aggiungendo `formDesigner` il
 * 19 set 2026 ne ho aggiornate tre su cinque: l'interruttore non compariva in
 * pagina e il salvataggio delle impostazioni si sarebbe rotto per tutti.
 *
 * Adesso il web ne ha UNA: da qui derivano le etichette, il tipo del hook e i
 * campi chiesti alla query. Dall'altro lato il guardiano
 * `apps/api/src/graphql/__tests__/aiFeatureSwitches.test.ts` tiene allineati
 * `AI_FEATURES` e lo schema.
 */
export const AI_FEATURE_KEYS = [
  'triage', 'assistant', 'reportAnalysis', 'postIncident', 'kbArticles', 'embeddings', 'formDesigner',
] as const
export type AIFeatureKey = (typeof AI_FEATURE_KEYS)[number]
