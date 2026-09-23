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

/**
 * Le lingue del prodotto, nell'ordine in cui si ripiega. Sono quelle dichiarate
 * in `apps/web/src/i18n/i18n.ts`: aggiungerne una e' un atto deliberato, non
 * una configurazione.
 *
 * Questo e' un ELENCO, non una scelta: sono i file di traduzione spediti nel
 * bundle, e aggiungerne uno e' scrivere codice. QUALE di queste sia la lingua
 * predefinita e' configurazione del cliente, e sta altrove
 * (`lib/tenantLanguage.ts`): qui non c'e' — e non deve tornarci — nessuna
 * costante che dica «la lingua del prodotto e' questa».
 *
 * L'ordine conta solo come ultima istanza: la prima e' quella che si mostra a
 * un cliente che non ha ancora configurato niente, e la diagnostica gli dice
 * di configurarla.
 */
export const LINGUE = ['en', 'it'] as const
export type Lingua = typeof LINGUE[number]

/**
 * La mappa come sta sul nodo: valore → lingua → etichetta.
 *
 * Il valore resta la chiave PRIMARIA (non la lingua) perche' le operazioni che
 * contano sono sul valore: rinominarlo sposta la chiave, toglierlo la scarta.
 * Con la lingua in cima ogni rinomina avrebbe dovuto attraversare N mappe.
 */
export type EnumValueLabels = Readonly<Record<string, Readonly<Partial<Record<Lingua, string>>>>>

/**
 * Una voce pronta per l'interfaccia. `label` c'e SEMPRE — e' l'etichetta nella
 * lingua CHIESTA, o il ripiego — quindi chi legge non ripiega da se;
 * `labels` porta le lingue davvero scritte, per l'editor del Dizionario.
 */
export interface EnumValueLabelEntry {
  value: string
  label: string
  labels: { language: Lingua; label: string }[]
}

const LOWER_KEY = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const UPPER_KEY = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/

/**
 * A VALUE WITHOUT A LABEL, SHOWN THE WAY A PERSON WROTE IT (D29, tour of 23
 * Sep 2026). The fallback when the label is missing.
 *
 * It was Title Case — `mission_critical` → «Mission Critical», fine, but also
 * «Pick up at the IT desk» → «Pick Up At The IT Desk», which nobody wrote,
 * sent in `label` as if the customer had. The rule is now the one of the web
 * (`humanizeValue`, packages/web-core/src/valueLabel.ts), so the same value
 * reads the same in a list, in a report and in a form:
 *  - a value with spaces is shown AS IT IS;
 *  - a machine key — lowercase snake_case, or UPPER_SNAKE with at least one
 *    underscore — becomes a sentence: `in_progress` → «In progress»;
 *  - anything else (`DatabaseInstance`, `IT`, `e-mail`) is shown as it is.
 */
export function humanizeValue(value: string): string {
  if (/\s/.test(value)) return value
  if (!LOWER_KEY.test(value) && !UPPER_KEY.test(value)) return value
  const words = value.toLowerCase().replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
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
  if (typeof raw !== 'string') return { labels: {}, error: `value_labels is not a string (${typeof raw})` }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (e) {
    return { labels: {}, error: `value_labels is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { labels: {}, error: 'value_labels is not a value → label object' }
  }
  const out: Record<string, Partial<Record<Lingua, string>>> = {}
  for (const [valore, v] of Object.entries(parsed as Record<string, unknown>)) {
    /*
      Si accettano DUE forme, e non e indulgenza: la prima versione di questa
      mappa era `{valore: "etichetta"}`, una lingua sola. La migrazione 1730 la
      converte, ma un tenant che non l'ha ancora ricevuta non deve perdere le
      etichette nel frattempo — e una stringa li significa «italiano», che e
      cio che quella versione scriveva. Resta l'italiano anche ora che la lingua
      del prodotto e l'inglese: e un fatto su un dato scritto allora, non un
      default da aggiornare.
    */
    if (typeof v === 'string') {
      if (v.trim() !== '') out[valore] = { it: v }
      continue
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue
    const per: Partial<Record<Lingua, string>> = {}
    for (const [lingua, etichetta] of Object.entries(v as Record<string, unknown>)) {
      if (!(LINGUE as readonly string[]).includes(lingua)) continue
      if (typeof etichetta === 'string' && etichetta.trim() !== '') per[lingua as Lingua] = etichetta
    }
    if (Object.keys(per).length > 0) out[valore] = per
  }
  return { labels: out, error: null }
}

/**
 * L'etichetta nella lingua chiesta, col ripiego DICHIARATO DA CHI CHIAMA: la
 * lingua chiesta → il `ripiego` → il valore reso leggibile (`humanizeValue`).
 *
 * Il ripiego e un parametro e non una costante perche e la lingua predefinita
 * DEL CLIENTE, che e configurazione (`lib/tenantLanguage.ts`). Prima era
 * `LINGUA_PREDEFINITA = 'it'` qui dentro: un'installazione per un cliente
 * irlandese leggeva le etichette a meta in italiano, e non c'era modo di
 * cambiarlo se non ricompilando.
 *
 * Ripiegare su un'altra lingua resta meglio che mostrare il nome interno del
 * valore: un'etichetta scritta in una lingua sola si legge comunque.
 */
export function labelFor(valore: string, labels: EnumValueLabels, lingua: Lingua, ripiego: Lingua): string {
  const per = labels[valore]
  return per?.[lingua] ?? per?.[ripiego] ?? humanizeValue(valore)
}

/**
 * Le voci per l'interfaccia, NELL'ORDINE DEI VALORI. `label` e nella lingua
 * chiesta e c'e sempre; `labels` sono le lingue davvero scritte, che servono
 * all'editor del Dizionario per mostrare due campi invece di uno.
 */
export function valueLabelEntries(
  values: readonly string[], labels: EnumValueLabels, lingua: Lingua, ripiego: Lingua,
): EnumValueLabelEntry[] {
  return values.map((v) => ({
    value: v,
    label: labelFor(v, labels, lingua, ripiego),
    labels: LINGUE.flatMap((l) => {
      const e = labels[v]?.[l]
      return e ? [{ language: l, label: e }] : []
    }),
  }))
}

/** Etichette ripulite: si tengono solo quelle dei valori che esistono ancora. */
export function pruneValueLabels(labels: EnumValueLabels, values: readonly string[]): EnumValueLabels {
  const vivi = new Set(values)
  return Object.fromEntries(Object.entries(labels).filter(([v]) => vivi.has(v)))
}

/**
 * L'etichetta segue il valore quando viene RINOMINATO, in TUTTE le lingue.
 * Senza questo, rinominare `high` in `alta` lascerebbe le etichette appese a
 * una chiave che non esiste piu.
 */
export function renameValueLabel(labels: EnumValueLabels, from: string, to: string): EnumValueLabels {
  if (!(from in labels)) return labels
  const out: Record<string, Partial<Record<Lingua, string>>> = { ...labels }
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
export interface SenzaEtichette {
  /** Il perche, per chi legge il codice: migrazione e diagnostica lo citano nei log. */
  why: string
  /**
   * La chiave con cui lo dice l'INTERFACCIA (17 set 2026).
   *
   * Mancava, e il buco si vedeva: il Dizionario mostrava «not written» accanto
   * a tutti e tredici i valori di `status_change`, in entrambe le lingue, e
   * nessuno poteva sapere che è di proposito — anzi, la lettura naturale è
   * «qui manca qualcosa, e forse per questo il prodotto è mezzo in inglese».
   * Un motivo che sta solo nei commenti del server non è un motivo: è un
   * segreto.
   */
  i18nKey: string
}

export const VOCABULARIES_WITHOUT_LABELS: Readonly<Record<string, SenzaEtichette>> = {
  status_incident:        { why: 'i valori sono i nomi dei passi del workflow: l\'italiano lo scrive l\'admin sul passo (WorkflowStep.label)', i18nKey: 'pages.dictionary.noValueLabels.workflowStep' },
  status_change:          { why: 'i valori sono i nomi dei passi del workflow: l\'italiano lo scrive l\'admin sul passo (WorkflowStep.label)', i18nKey: 'pages.dictionary.noValueLabels.workflowStep' },
  status_problem:         { why: 'i valori sono i nomi dei passi del workflow: l\'italiano lo scrive l\'admin sul passo (WorkflowStep.label)', i18nKey: 'pages.dictionary.noValueLabels.workflowStep' },
  status_service_request: { why: 'i valori sono i nomi dei passi del workflow: l\'italiano lo scrive l\'admin sul passo (WorkflowStep.label)', i18nKey: 'pages.dictionary.noValueLabels.workflowStep' },
  import_severity:        { why: 'i 28 valori sono chiavi di riconoscimento dei dati in arrivo dagli altri sistemi (p1, sev1, crit, blocker…), non voci di menu', i18nKey: 'pages.dictionary.noValueLabels.importKeys' },
}

/**
 * La chiave della frase da mostrare quando un vocabolario non porta etichette,
 * `null` quando invece le porta (e quindi un'etichetta vuota è vuota davvero).
 */
export function valueLabelsReasonKey(name: string): string | null {
  return VOCABULARIES_WITHOUT_LABELS[name]?.i18nKey ?? null
}

/** Vero quando il vocabolario, di proposito, non porta etichette per valore. */
export function vocabularyCarriesLabels(name: string): boolean {
  return !(name in VOCABULARIES_WITHOUT_LABELS)
}
