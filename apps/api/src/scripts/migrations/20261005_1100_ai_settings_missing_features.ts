/**
 * GLI INTERRUTTORI AI CHE MANCANO, TUTTI (19 set 2026).
 *
 * `20261005_1090` aggiungeva `formDesigner` ai tenant che avevano già salvato
 * le proprie impostazioni AI. Il giorno stesso è nato l'ottavo interruttore
 * (`reportDesigner`), e scrivere una migrazione per ognuno vorrebbe dire una
 * migrazione identica a ogni funzione nuova — con la certezza che una volta ci
 * si dimentica.
 *
 * Quindi questa non nomina una funzione: aggiunge **ogni funzione di
 * `AI_FEATURES` che manca** al documento salvato, col valore di fabbrica. È
 * idempotente per costruzione (alla seconda esecuzione non manca niente) e
 * resta corretta quando l'elenco cresce ancora.
 *
 * Perché serve, dato che la lettura è già tollerante: l'interruttore assente
 * vale fabbrica e il prodotto funziona comunque. Quello che questa migrazione
 * evita è un BUCO nei dati del cliente — un JSON che elenca sei funzioni su
 * otto è una domanda senza risposta per chi lo leggerà fra sei mesi («era
 * spenta? non esisteva?»), e quella domanda tocca sempre a qualcuno che non
 * c'era.
 *
 * Scrive solo dove `ai_settings` esiste: dove è assente vale già tutto-acceso,
 * e inventare il documento vorrebbe dire congelare i valori di oggi come se il
 * cliente li avesse scelti.
 */
import type { Migration } from '@opengraphity/neo4j'
import { AI_FEATURES, FACTORY_AI_SETTINGS } from '../../lib/aiSettings.js'

export const aiSettingsMissingFeatures: Migration = {
  id: '20261005_1100_ai_settings_missing_features',
  description: 'Add every missing AI feature switch to tenants that already saved their AI settings',

  async up(session) {
    const righe = await session.run(`
      MATCH (t:Tenant)
      WHERE t.ai_settings IS NOT NULL AND t.ai_settings <> ''
      RETURN t.id AS id, t.ai_settings AS raw
    `)

    const daScrivere: { id: string; json: string }[] = []
    for (const rec of righe.records) {
      const id = rec.get('id') as string
      let doc: { features?: Record<string, unknown> }
      try { doc = JSON.parse(rec.get('raw') as string) as typeof doc }
      catch {
        console.log(`[${aiSettingsMissingFeatures.id}] ${id}: ai_settings is not valid JSON — left alone, the read falls back to factory`)
        continue
      }
      const features = doc.features
      if (!features || typeof features !== 'object') {
        console.log(`[${aiSettingsMissingFeatures.id}] ${id}: ai_settings has no features object — left alone`)
        continue
      }
      const aggiunte: string[] = []
      for (const f of AI_FEATURES) {
        if (f in features) continue
        features[f] = FACTORY_AI_SETTINGS.features[f]
        aggiunte.push(`${f}=${String(FACTORY_AI_SETTINGS.features[f])}`)
      }
      if (aggiunte.length === 0) continue
      console.log(`[${aiSettingsMissingFeatures.id}] ${id}: adding ${aggiunte.join(', ')} (factory)`)
      daScrivere.push({ id, json: JSON.stringify(doc) })
    }

    if (daScrivere.length === 0) {
      console.log(`[${aiSettingsMissingFeatures.id}] nothing to add: every saved AI setting lists all ${String(AI_FEATURES.length)} features`)
      return
    }
    const esito = await session.run(`
      UNWIND $righe AS r
      MATCH (t:Tenant {id: r.id})
      SET t.ai_settings = r.json, t.updated_at = $now
      RETURN count(t) AS n
    `, { righe: daScrivere, now: new Date().toISOString() })
    const n = esito.records[0]?.get('n') as { toNumber?: () => number } | number | undefined
    console.log(`[${aiSettingsMissingFeatures.id}] ${String(typeof n === 'number' ? n : (n?.toNumber?.() ?? 0))} tenants updated`)
  },
}
