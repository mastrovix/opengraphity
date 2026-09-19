/**
 * LE ETICHETTE DEI CAMPI PER LE INTESTAZIONI DELLE COLONNE dei report.
 *
 * Il difetto: una tabella di report scriveva in cima `SERVICE_REQUEST_TITLE` e
 * `SERVICE_REQUEST_AMBIENTE_USO` — l'etichetta dell'entità incollata al nome
 * interno del campo — mentre nel costruttore l'amministratore aveva spuntato
 * «Titolo» e «Ambiente». Valeva per ogni campo, anche quelli spediti col
 * prodotto, e usciva così anche nel PDF e nell'Excel.
 *
 * Le etichette vengono da `getNavigableEntities`, cioè ESATTAMENTE la lista che
 * il costruttore mostra: i campi del metamodello ITIL e dei tipi di CI del
 * cliente, più i campi della libreria dei moduli del catalogo. Una sola verità
 * su «come si chiama questo campo», invece di una copia per l'intestazione.
 *
 * In cache un minuto: un report con dieci sezioni le chiederebbe dieci volte, e
 * il metamodello non cambia fra due sezioni dello stesso report. La cache passa
 * dal canale del metamodello, quindi una rinomina si vede subito.
 */
import { shippedLabelIn } from '@opengraphity/types'
import { getNavigableEntities } from './navigableGraph.js'
import { createMetamodelCache } from './metamodelCache.js'
import type { ReportFieldLabels } from './reportQueryBuilder.js'
import type { Lingua } from './enumValueLabels.js'

const cache = createMetamodelCache<ReadonlyMap<string, string>>({
  name:  'report-field-labels',
  ttlMs: 60_000,
  // La sottochiave è la LINGUA: le etichette spedite si traducono, quindi la
  // stessa organizzazione ha una mappa per lingua.
  load:  async (tenantId, lingua) => {
    const out = new Map<string, string>()
    for (const entita of await getNavigableEntities(tenantId)) {
      for (const campo of entita.fields) {
        // Un'etichetta vuota non si mette: chi legge la mappa ripiega sul nome
        // interno, che è meglio di un'intestazione bianca.
        if (!campo.label) continue
        out.set(`${entita.neo4jLabel}.${campo.name}`, shippedLabelIn('field', campo.name, campo.label, lingua))
      }
    }
    return out
  },
})

/**
 * Le etichette per le intestazioni, nella lingua di chi legge il report.
 *
 * Un campo SPEDITO col prodotto porta nel grafo la sua etichetta inglese, e
 * la traduzione è del prodotto: sta in `packages/types`, dove la leggono sia
 * il web sia questo (decisione del proprietario del 20 set 2026). Prima la
 * traduzione stava nei locale del web e il server non poteva vederla: la
 * stessa colonna si chiamava «Titolo» nel costruttore e «TITLE» nella
 * tabella, nel PDF e nell'Excel. Un campo rinominato dal cliente resta col
 * suo nome, in ogni lingua.
 */
export function reportFieldLabels(tenantId: string, lingua?: Lingua): Promise<ReportFieldLabels> {
  return cache.get(tenantId, lingua ?? '')
}

/** Solo per i test. */
export function clearReportFieldLabelsCache(): void { cache.clear() }
