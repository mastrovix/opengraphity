/**
 * L'AI DI UN'ORGANIZZAZIONE: un interruttore per funzione e le soglie del
 * raggruppamento degli incident simili (verifica «Cosa resta cablato», ondata 6).
 *
 * ## Il difetto
 * Nessun interruttore: se la piattaforma aveva `ANTHROPIC_API_KEY`, i dati di
 * ogni organizzazione andavano al modello (triage, assistente, analisi dei
 * report, note post-incident, articoli KB), e con `EMBEDDINGS_PROVIDER=voyage`
 * anche i testi dei ticket per gli embedding. Un cliente che non vuole mandare i
 * ticket a un servizio esterno non poteva escluderli. Il raggruppamento dei
 * candidati problem aveva 0,72 e 3 scritti nel codice.
 *
 * ## La regola
 * `Tenant.ai_settings` = `{features: {triage, assistant, reportAnalysis,
 * postIncident, kbArticles, embeddings}, clusterMinSimilarity, clusterMinSize}`.
 * Una funzione spenta NON chiama il modello (né il provider degli embedding):
 * la chiamata si ferma prima, con l'errore `AI_DISABLED` che nomina la funzione
 * e dice chi può riaccenderla. La proprietà assente è «tutto acceso, 0,72 e 3»,
 * cioè il comportamento di prima, e la migrazione `20260927_1020_ai_settings`
 * lo scrive esplicito.
 *
 * ## Una funzione che nasce dopo (19 set 2026)
 * `formDesigner` — l'AI che disegna il modulo di una service request da una
 * descrizione — è il settimo interruttore, e `reportDesigner` — quella che
 * disegna una sezione di report — l'ottavo. I tenant che avevano già salvato
 * le loro impostazioni non ce li hanno. In LETTURA l'interruttore assente vale
 * fabbrica (acceso), che è la regola di questo file; le migrazioni
 * `20261005_1090` e `20261005_1100` li scrivono espliciti su chi aveva già
 * salvato, così nel documento delle impostazioni non resta un buco che nessuno
 * sa spiegare.
 */
import { GraphQLError } from 'graphql'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { NotFoundError, ValidationError } from './errors.js'
import { createMetamodelCache } from './metamodelCache.js'
import { invalidateSchema } from './schemaInvalidator.js'

/*
 * `platformSelfAnalysis` È IL PRIMO SPENTO DI FABBRICA (20 set 2026, ondata 4).
 *
 * Gli altri otto nascono accesi perché sono aiuti dentro il perimetro di un
 * cliente: leggono i suoi ticket e rispondono a lui. Questo no. L'analista
 * della piattaforma legge la proiezione dei log del SERVER, che è l'unico
 * archivio del prodotto che attraversa il perimetro fra i clienti — scelta
 * dichiarata nel progetto, e per questo l'unica che nessuno si trova accesa
 * senza averla scelta. È anche la decisione del proprietario, presa il 20 set
 * sapendo la conseguenza: finché nessuno lo accende, l'area D non gira e lo
 * dice invece di tacere.
 */
export const AI_FEATURES = ['triage', 'assistant', 'reportAnalysis', 'postIncident', 'kbArticles', 'embeddings', 'formDesigner', 'reportDesigner', 'platformSelfAnalysis', 'dailyWorkAnalysis', 'configurationAssist'] as const
export type AIFeature = (typeof AI_FEATURES)[number]

export interface AISettings {
  features:             Record<AIFeature, boolean>
  /** Somiglianza minima (coseno) perché due incident stiano nello stesso gruppo. */
  clusterMinSimilarity: number
  /** Quanti incident servono perché un gruppo diventi un candidato problem. */
  clusterMinSize:       number
}

export const FACTORY_AI_SETTINGS: Readonly<AISettings> = {
  features: {
    triage: true, assistant: true, reportAnalysis: true, postIncident: true,
    kbArticles: true, embeddings: true, formDesigner: true, reportDesigner: true,
    /*
     * I DUE SPENTI DI FABBRICA, e non sono lo stesso interruttore (20 set 2026).
     *
     * `platformSelfAnalysis` legge l'archivio degli errori del SERVER, che
     * attraversa il perimetro fra i clienti: esiste solo sul tenant di
     * piattaforma. `dailyWorkAnalysis` legge il registro DI QUESTO cliente e
     * propone dentro casa sua. Rischi diversi, perimetri diversi, decisioni
     * diverse — un interruttore solo avrebbe costretto a sceglierli insieme.
     *
     * Entrambi spenti, e per la stessa ragione: sono gli unici due che
     * SCRIVONO qualcosa di propria iniziativa, di notte, senza che nessuno
     * clicchi. Decisione del proprietario.
     */
    platformSelfAnalysis: false,
    dailyWorkAnalysis: false,
    /*
     * Il terzo, e l'ultimo del programma. Legge la CONFIGURAZIONE di questo
     * cliente — vocabolari, workflow — e propone di completarla. È l'unico
     * dei tre le cui proposte, se accettate, fanno scrivere al modello del
     * TESTO che le persone leggeranno sullo schermo: le etichette dei valori.
     * Per questo nasce spento come gli altri due, e per questo l'azione non
     * sovrascrive MAI un'etichetta che una persona ha già scritto.
     */
    configurationAssist: false,
  },
  clusterMinSimilarity: 0.72,
  clusterMinSize: 3,
}

export const CLUSTER_SIMILARITY_RANGE = { min: 0.5, max: 0.99 } as const
export const CLUSTER_SIZE_RANGE = { min: 2, max: 20 } as const

const cache = createMetamodelCache<AISettings & { isDefault: boolean }>({
  name: 'ai-settings',
  load: (tenantId) => loadSettings(tenantId),
})

/** Solo per i test. */
export function clearAISettingsCache(): void { cache.clear() }

export function aiSettings(tenantId: string): Promise<AISettings & { isDefault: boolean }> {
  return cache.get(tenantId)
}

export async function aiFeatureEnabled(tenantId: string, feature: AIFeature): Promise<boolean> {
  return (await aiSettings(tenantId)).features[feature]
}

/** L'errore di una funzione spenta: il client lo riconosce dal codice e lo dice nella sua lingua. */
export function aiDisabledError(feature: AIFeature): GraphQLError {
  return new GraphQLError(
    `The AI feature "${feature}" is turned off for this organization. An administrator can turn it on in Organization → AI.`,
    { extensions: { code: 'AI_DISABLED', feature, i18n: { key: 'errors.ai.disabled', params: { feature } } } },
  )
}

/** Si ferma PRIMA di qualunque chiamata al modello se la funzione è spenta. */
export async function assertAIFeature(tenantId: string, feature: AIFeature): Promise<void> {
  if (!(await aiFeatureEnabled(tenantId, feature))) throw aiDisabledError(feature)
}

/**
 * `tollerante` serve a LEGGERE impostazioni scritte prima che una funzione
 * esistesse (19 set 2026: `formDesigner`). In scrittura no: l'interruttore
 * mancante in un input verrebbe da un client che non conosce quella funzione, e
 * accettarlo vorrebbe dire spegnere in silenzio quello che l'utente vede acceso.
 * In lettura l'assenza vale quello che vale dappertutto qui: il valore di
 * fabbrica, cioè il comportamento di prima.
 */
export function assertAISettings(raw: unknown, opts: { tollerante?: boolean } = {}): AISettings {
  const obj = (raw ?? {}) as Record<string, unknown>
  const features = (obj['features'] ?? null) as Record<string, unknown> | null
  if (!features || typeof features !== 'object') {
    throw new ValidationError('AI settings: features must be an object', { key: 'errors.aiSettings.shape', params: {} })
  }
  const out = {} as Record<AIFeature, boolean>
  for (const f of AI_FEATURES) {
    if (typeof features[f] !== 'boolean') {
      if (opts.tollerante === true && !(f in features)) { out[f] = FACTORY_AI_SETTINGS.features[f]; continue }
      throw new ValidationError(`AI settings: "${f}" must be on or off`, { key: 'errors.aiSettings.shape', params: {} })
    }
    out[f] = features[f] as boolean
  }
  const sim = obj['clusterMinSimilarity']
  if (typeof sim !== 'number' || !Number.isFinite(sim) || sim < CLUSTER_SIMILARITY_RANGE.min || sim > CLUSTER_SIMILARITY_RANGE.max) {
    throw new ValidationError(`The minimum similarity must be between ${String(CLUSTER_SIMILARITY_RANGE.min)} and ${String(CLUSTER_SIMILARITY_RANGE.max)}.`,
      { key: 'errors.aiSettings.similarity', params: { min: CLUSTER_SIMILARITY_RANGE.min, max: CLUSTER_SIMILARITY_RANGE.max } })
  }
  const size = obj['clusterMinSize']
  if (typeof size !== 'number' || !Number.isInteger(size) || size < CLUSTER_SIZE_RANGE.min || size > CLUSTER_SIZE_RANGE.max) {
    throw new ValidationError(`The minimum group size must be a whole number between ${String(CLUSTER_SIZE_RANGE.min)} and ${String(CLUSTER_SIZE_RANGE.max)}.`,
      { key: 'errors.aiSettings.size', params: { min: CLUSTER_SIZE_RANGE.min, max: CLUSTER_SIZE_RANGE.max } })
  }
  return { features: out, clusterMinSimilarity: Math.round(sim * 100) / 100, clusterMinSize: size }
}

async function loadSettings(tenantId: string): Promise<AISettings & { isDefault: boolean }> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ raw: unknown }>(session, 'MATCH (t:Tenant {id: $tenantId}) RETURN t.ai_settings AS raw', { tenantId })
    if (!row) throw new NotFoundError('Tenant', tenantId)
    if (row.raw == null) return { ...FACTORY_AI_SETTINGS, features: { ...FACTORY_AI_SETTINGS.features }, isDefault: true }
    let parsed: unknown
    try { parsed = JSON.parse(String(row.raw)) }
    catch (e) { throw new Error(`Tenant ${tenantId}: ai_settings is not valid JSON (${e instanceof Error ? e.message : String(e)})`) }
    return { ...assertAISettings(parsed, { tollerante: true }), isDefault: false }
  } finally {
    await session.close()
  }
}

export async function setAISettings(tenantId: string, raw: unknown): Promise<AISettings & { isDefault: boolean }> {
  const settings = assertAISettings(raw)
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session,
      'MATCH (t:Tenant {id: $tenantId}) SET t.ai_settings = $json, t.updated_at = $now RETURN t.id AS id',
      { tenantId, json: JSON.stringify(settings), now: new Date().toISOString() })
    if (!row) throw new NotFoundError('Tenant', tenantId)
  } finally {
    await session.close()
  }
  invalidateSchema(tenantId)
  return { ...settings, isDefault: false }
}
