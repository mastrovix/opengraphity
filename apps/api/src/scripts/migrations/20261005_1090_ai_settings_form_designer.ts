/**
 * IL SETTIMO INTERRUTTORE DELL'AI: `formDesigner` (19 set 2026).
 *
 * L'AI che disegna il modulo di una service request da una descrizione nasce
 * dopo gli altri sei, quindi i tenant che avevano già salvato le proprie
 * impostazioni hanno un `Tenant.ai_settings` senza quella chiave.
 *
 * In lettura l'assenza vale FABBRICA (acceso) — è la regola di `aiSettings.ts`,
 * e senza quella regola l'aggiunta di un interruttore romperebbe la pagina
 * Organizzazione di chi ha già salvato. Questa migrazione non serve quindi a
 * far funzionare qualcosa: serve a non lasciare un BUCO nei dati del cliente.
 * Un JSON salvato che elenca sei funzioni su sette è una domanda senza risposta
 * per chi lo leggerà fra sei mesi («era spenta? non esisteva? l'hanno tolta?»),
 * e quella domanda tocca sempre a qualcuno che non c'era.
 *
 * Scrive solo dove `ai_settings` esiste: dove è assente vale già tutto-acceso e
 * inventare il documento vorrebbe dire congelare i valori di oggi come se il
 * cliente li avesse scelti.
 *
 * Idempotente: alla seconda esecuzione non trova più niente da aggiungere.
 */
import type { Migration } from '@opengraphity/neo4j'
import { FACTORY_AI_SETTINGS } from '../../lib/aiSettings.js'

export const aiSettingsFormDesigner: Migration = {
  id: '20261005_1090_ai_settings_form_designer',
  description: 'Add the formDesigner switch to tenants that already saved their AI settings',

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
        console.log(`[${aiSettingsFormDesigner.id}] ${id}: ai_settings is not valid JSON — left alone, the read falls back to factory`)
        continue
      }
      const features = doc.features
      if (!features || typeof features !== 'object') {
        console.log(`[${aiSettingsFormDesigner.id}] ${id}: ai_settings has no features object — left alone`)
        continue
      }
      if ('formDesigner' in features) continue
      features['formDesigner'] = FACTORY_AI_SETTINGS.features.formDesigner
      daScrivere.push({ id, json: JSON.stringify(doc) })
    }

    if (daScrivere.length === 0) {
      console.log(`[${aiSettingsFormDesigner.id}] nothing to add: no saved AI settings without the formDesigner switch`)
      return
    }
    for (const { id } of daScrivere) {
      console.log(`[${aiSettingsFormDesigner.id}] ${id}: formDesigner = ${String(FACTORY_AI_SETTINGS.features.formDesigner)} (factory)`)
    }
    const esito = await session.run(`
      UNWIND $righe AS r
      MATCH (t:Tenant {id: r.id})
      SET t.ai_settings = r.json, t.updated_at = $now
      RETURN count(t) AS n
    `, { righe: daScrivere, now: new Date().toISOString() })
    const n = esito.records[0]?.get('n') as { toNumber?: () => number } | number | undefined
    console.log(`[${aiSettingsFormDesigner.id}] ${String(typeof n === 'number' ? n : (n?.toNumber?.() ?? 0))} tenants updated`)
  },
}
