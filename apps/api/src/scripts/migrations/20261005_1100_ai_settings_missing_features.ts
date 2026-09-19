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
        // NON «ripiega su fabbrica»: `aiSettings.ts` lancia su un documento
        // illeggibile, e lancia anche la pagina che lo riparerebbe. Si dice
        // forte, perché quel tenant ha bisogno di una mano a parte.
        console.error(`[${aiSettingsMissingFeatures.id}] ${id}: ai_settings is NOT valid JSON — left alone; every AI read will fail for this tenant until it is fixed`)
        continue
      }
      const features = doc.features
      if (!features || typeof features !== 'object') {
        console.log(`[${aiSettingsMissingFeatures.id}] ${id}: ai_settings has no features object — left alone`)
        continue
      }
      /*
       * IL VALORE DI UNA FUNZIONE NUOVA SEGUE QUELLO CHE IL CLIENTE HA SCELTO
       * PER LE ALTRE (19 set 2026, dalla revisione).
       *
       * Scrivere il valore di fabbrica (acceso) sembrava innocuo e non lo è:
       * un cliente che NON vuole mandare i suoi testi a un servizio esterno
       * apre Organizzazione → AI e spegne tutto; questa migrazione gli
       * riaccendeva due funzioni e scriveva nel suo documento che era una sua
       * scelta. È il contrario del motivo per cui gli interruttori esistono —
       * la prima riga di `aiSettings.ts` parla proprio di quel cliente.
       *
       * Regola: se ha spento TUTTO, la funzione nuova nasce spenta; se no,
       * vale fabbrica, che è il comportamento di chi non ha scelto niente.
       */
      const esistenti = Object.entries(features).filter(([k]) => (AI_FEATURES as readonly string[]).includes(k))
      const tutteSpente = esistenti.length > 0 && esistenti.every(([, v]) => v === false)
      const aggiunte: string[] = []
      for (const f of AI_FEATURES) {
        if (f in features) continue
        const valore = tutteSpente ? false : FACTORY_AI_SETTINGS.features[f]
        features[f] = valore
        aggiunte.push(`${f}=${String(valore)}${tutteSpente ? ' (tutte le altre erano spente)' : ' (factory)'}`)
      }
      if (aggiunte.length === 0) continue
      console.log(`[${aiSettingsMissingFeatures.id}] ${id}: adding ${aggiunte.join(', ')}`)
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
