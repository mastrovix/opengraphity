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
import { getNavigableEntities } from './navigableGraph.js'
import { createMetamodelCache } from './metamodelCache.js'
import type { ReportFieldLabels } from './reportQueryBuilder.js'

const cache = createMetamodelCache<ReadonlyMap<string, string>>({
  name:  'report-field-labels',
  ttlMs: 60_000,
  load:  async (tenantId) => {
    const out = new Map<string, string>()
    for (const entita of await getNavigableEntities(tenantId)) {
      for (const campo of entita.fields) {
        // Un'etichetta vuota non si mette: chi legge la mappa ripiega sul nome
        // interno, che è meglio di un'intestazione bianca.
        if (!campo.label) continue
        out.set(`${entita.neo4jLabel}.${campo.name}`, campo.label)
      }
    }
    return out
  },
})

export function reportFieldLabels(tenantId: string): Promise<ReportFieldLabels> {
  return cache.get(tenantId)
}

/** Solo per i test. */
export function clearReportFieldLabelsCache(): void { cache.clear() }
