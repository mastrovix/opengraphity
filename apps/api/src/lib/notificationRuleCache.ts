/**
 * La cache delle regole di notifica del dispatcher passa dal canale fra
 * processi (revisione totale · E-20).
 *
 * Il dispatcher vive nel container `events-worker` e tiene le regole in
 * memoria per 60 s; `invalidateRuleCache` chiamata dall'API svuotava solo la
 * cache DELL'API, che non consegna niente. L'admin spegneva una regola e il
 * worker continuava a notificare fino alla scadenza del TTL, mentre la pagina
 * diceva che era spenta.
 *
 * Qui il clearer viene registrato sul canale del metamodello, che ogni
 * processo riceve: chi consegna svuota la SUA copia. Il modulo è importato
 * all'avvio dell'API e dei worker (`registerCaches`).
 */
import { invalidateRuleCache, clearRuleCache, invalidateNotificationLocale } from '@opengraphity/notifications'
import { registerMetamodelCacheClearer } from './schemaInvalidator.js'

registerMetamodelCacheClearer('notification-rules', (tenantId: string) => {
  invalidateRuleCache(tenantId)
  // La lingua e il fuso con cui i messaggi vengono composti: stessa copia per
  // processo, stessa invalidazione (A-15).
  invalidateNotificationLocale(tenantId)
}, () => {
  clearRuleCache()
  invalidateNotificationLocale()
})
