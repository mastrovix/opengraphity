/**
 * LE ETICHETTE PER VALORE di un vocabolario (ondata 1 delle quattro decise il
 * 13 set 2026).
 *
 * Il valore e il nome della cosa; l'etichetta e come la si legge. `high` resta
 * `high` — lo scrivono i record, le condizioni delle regole, le matrici — e a
 * schermo si legge «Alta». Prima l'etichetta non esisteva: il dettaglio di un
 * incident mostrava «high / high», e i valori SPEDITI sono parole inglesi in
 * un'interfaccia italiana.
 *
 * ## Perche una MAPPA e non un array parallelo
 *
 * `reorderEnumValues` esiste: l'admin riordina i valori dal Dizionario. Un
 * array di etichette allineato per indice si disallineerebbe al primo
 * riordino, in silenzio, e «Alta» finirebbe su `low`. La mappa e indicizzata
 * dal valore, quindi il riordino non la tocca — e la rinomina deve spostarne
 * la chiave (`renameEnumValue`), che e l'unico punto in cui va ricordata.
 *
 * ## Dove vive
 *
 * `EnumTypeDefinition.value_labels`, stringa JSON (Neo4j non ha un tipo mappa).
 * Sul nodo di SISTEMA per i vocabolari spediti — cosi ogni cliente legge
 * l'italiano senza personalizzare — e sulla copia del tenant quando la
 * personalizza (`customizeEnumType` la copia).
 *
 * ## Cosa NON ha etichette
 *
 * - I quattro `status_*`: i loro valori sono i NOMI DEI PASSI del workflow, e
 *   l'italiano lo scrive l'admin sul passo (`WorkflowStep.label`, nel
 *   disegnatore). Metterlo anche qui sarebbe la stessa parola in due posti.
 * - `import_severity`: 28 valori (`p1`, `sev1`, `crit`, `blocker`, `trivial`…)
 *   che sono chiavi di RICONOSCIMENTO dei dati in arrivo dagli altri sistemi
 *   di monitoraggio, non voci di menu. Nessuno le sceglie da una tendina.
 */

/** La mappa valore → etichetta, come sta sul nodo. */
export type EnumValueLabels = Readonly<Record<string, string>>

/** Una voce pronta per l'interfaccia: l'etichetta c'e SEMPRE, chi legge non ripiega. */
export interface EnumValueLabelEntry {
  value: string
  label: string
}

/**
 * `alta` → `Alta`, `mission_critical` → `Mission Critical`.
 *
 * Il ripiego quando l'etichetta manca: e la stessa regola che il web applicava
 * da sempre (`enumLabel` in lib/ciEnums.ts), portata qui perche ora la
 * decisione e una sola e sta dal lato del server.
 */
export function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Decodifica `value_labels` dal nodo. Un JSON corrotto o della forma sbagliata
 * NON ferma la lettura di un vocabolario: si perdono le etichette (e a schermo
 * si legge il valore, che e vero) e il motivo finisce nei log di chi chiama.
 * Un vocabolario e dato di configurazione letto su ogni pagina: renderlo
 * illeggibile per un'etichetta sarebbe sproporzionato.
 */
export function parseValueLabels(raw: unknown): { labels: EnumValueLabels; error: string | null } {
  if (raw == null || raw === '') return { labels: {}, error: null }
  if (typeof raw !== 'string') return { labels: {}, error: `value_labels non e una stringa (${typeof raw})` }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (e) {
    return { labels: {}, error: `value_labels non e JSON valido: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { labels: {}, error: 'value_labels non e un oggetto valore → etichetta' }
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim() !== '') out[k] = v
  }
  return { labels: out, error: null }
}

/**
 * Le voci per l'interfaccia, NELL'ORDINE DEI VALORI e sempre complete: chi
 * legge non deve sapere che l'etichetta puo mancare.
 */
export function valueLabelEntries(values: readonly string[], labels: EnumValueLabels): EnumValueLabelEntry[] {
  return values.map((v) => ({ value: v, label: labels[v] ?? titleCase(v) }))
}

/** Etichette ripulite: si tengono solo quelle dei valori che esistono ancora. */
export function pruneValueLabels(labels: EnumValueLabels, values: readonly string[]): EnumValueLabels {
  const vivi = new Set(values)
  return Object.fromEntries(Object.entries(labels).filter(([v]) => vivi.has(v)))
}

/**
 * L'etichetta segue il valore quando viene RINOMINATO. Senza questo, rinominare
 * `high` in `alta` lascerebbe «Alta» appesa a una chiave che non esiste piu, e
 * il valore nuovo comparirebbe a schermo come «Alta» (title-case del valore)
 * per caso — o come «Elevato» mai piu, se l'etichetta era quella.
 */
export function renameValueLabel(labels: EnumValueLabels, from: string, to: string): EnumValueLabels {
  if (!(from in labels)) return labels
  const out: Record<string, string> = { ...labels }
  out[to] = out[from]!
  delete out[from]
  return out
}

/** Serializza per il nodo. Mappa vuota → `null`, non `"{}"`: una proprieta assente si legge meglio. */
export function serializeValueLabels(labels: EnumValueLabels): string | null {
  const keys = Object.keys(labels)
  return keys.length === 0 ? null : JSON.stringify(labels)
}

/**
 * I vocabolari che NON hanno etichette per valore, e il perche. Lista
 * condivisa fra la migrazione che semina l'italiano e la diagnostica che
 * segnala i valori senza etichetta: due copie divergerebbero, e la seconda
 * comincerebbe a lamentarsi di cio che la prima salta di proposito.
 */
export const VOCABULARIES_WITHOUT_LABELS: Readonly<Record<string, string>> = {
  status_incident:        'i valori sono i nomi dei passi del workflow: l\'italiano lo scrive l\'admin sul passo (WorkflowStep.label)',
  status_change:          'i valori sono i nomi dei passi del workflow: l\'italiano lo scrive l\'admin sul passo (WorkflowStep.label)',
  status_problem:         'i valori sono i nomi dei passi del workflow: l\'italiano lo scrive l\'admin sul passo (WorkflowStep.label)',
  status_service_request: 'i valori sono i nomi dei passi del workflow: l\'italiano lo scrive l\'admin sul passo (WorkflowStep.label)',
  import_severity:        'i 28 valori sono chiavi di riconoscimento dei dati in arrivo dagli altri sistemi (p1, sev1, crit, blocker…), non voci di menu',
}

/** Vero quando il vocabolario, di proposito, non porta etichette per valore. */
export function vocabularyCarriesLabels(name: string): boolean {
  return !(name in VOCABULARIES_WITHOUT_LABELS)
}
