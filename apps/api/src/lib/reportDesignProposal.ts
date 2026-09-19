/**
 * LA PROPOSTA DELL'AI PER UNA SEZIONE DI REPORT — e il filtro che le sta
 * davanti (19 set 2026).
 *
 * Stessa forma del progettista dei moduli (`formDesignProposal.ts`), stesso
 * patto: il modello riceve il catalogo VERO del cliente (le entità
 * interrogabili coi loro campi e le loro relazioni, dal metamodello) e
 * restituisce il progetto di una sezione; **niente arriva al costruttore se
 * non regge le regole che reggono una mano umana**.
 *
 * ## Perché il filtro, quando `validateReportSection` esiste già
 * Quella validazione è un SÌ o NO su tutta la sezione: una relazione
 * inventata, un campo che l'entità non ha, un `groupByNodeId` che non esiste, e
 * la sezione intera viene rifiutata. Di una proposta fatta da un modello si
 * butta il PEZZO sbagliato e si tiene il resto — un report con un filtro in
 * meno resta un report, e chi lo rivede lo completa in dieci secondi.
 *
 * Il filtro è quindi più severo della validazione, non meno: controlla anche
 * quello che la validazione non può sapere (che `costo` sia un campo
 * DAVVERO esistente su `Incident`, che `AFFECTS` parta davvero da lì), perché
 * il metamodello del cliente qui lo abbiamo in mano.
 *
 * ## E alla fine si ripassa dalla validazione vera
 * `assemblaSezione` produce esattamente un `ReportSectionDef`, e il servizio
 * lo dà in pasto a `validateReportSection` con la whitelist del tenant. Se
 * dopo tutti i miei controlli quella dicesse ancora no, è un difetto MIO: si
 * risponde con un errore, non con una proposta che il costruttore non potrebbe
 * salvare.
 *
 * ## Quello che il modello NON decide
 *  - gli ID dei nodi: li genero io (`n1`, `n2`…), come li genera il costruttore;
 *  - la posizione sulla tela: la calcolo a gradini, perché è disegno e non dato;
 *  - la metrica su un campo che la radice non ha: diventa un conteggio, e lo
 *    dico — è la correzione del 19 set che ha reso le metriche vere.
 */
import {
  CHART_TYPES, FILTER_OPERATORS, MAX_REPORT_LIMIT, REPORT_METRICS, REPORT_METRICS_WITH_FIELD,
  isChartType, isReportGranularity, isReportMetric,
  type ReportEdgeDef, type ReportNodeDef, type ReportSectionDef,
} from './reportQueryBuilder.js'
import type { NavigableEntity, NavigableField } from './navigableGraph.js'

/**
 * Il tetto che il COSTRUTTORE sa mostrare. L'API ne accetta 1000, ma la casella
 * del wizard si fermava a 100: proporre 500 vorrebbe dire un numero che chi
 * rivede non può correggere senza uscire dai binari dell'interfaccia.
 */
export const MAX_LIMITE_PROPONIBILE = Math.min(100, MAX_REPORT_LIMIT)

/** Quanti nodi può avere una sezione proposta: oltre, il grafo non si legge più. */
export const MAX_NODI_PROPONIBILI = 4

/** Uno scarto: cosa, e perché — con la chiave i18n che il costruttore sa rendere. */
export interface ScartoReport {
  readonly what: string
  readonly key: string
  readonly params: Readonly<Record<string, string | number>>
}

export interface NodoProposto {
  readonly id: string
  readonly entityType: string
  readonly neo4jLabel: string
  readonly label: string
  readonly isRoot: boolean
  readonly isResult: boolean
  readonly selectedFields: readonly string[]
  /** I filtri come JSON `[{field, operator, value}]`, o `null`. */
  readonly filters: string | null
  readonly positionX: number
  readonly positionY: number
  readonly why: string
}

export interface ArcoProposto {
  readonly id: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly relationshipType: string
  readonly direction: 'outgoing' | 'incoming'
  readonly label: string
}

export interface PropostaReport {
  readonly title: string
  readonly chartType: string
  readonly metric: string
  readonly metricField: string | null
  readonly groupByNodeId: string | null
  readonly groupByField: string | null
  /** Il periodo di una serie: `day`, `week`, `month`; `null` fuori dalle serie. */
  readonly groupByGranularity: string | null
  readonly limit: number
  readonly sortDir: 'ASC' | 'DESC'
  readonly nodes: readonly NodoProposto[]
  readonly edges: readonly ArcoProposto[]
  /** Perché questo disegno: la frase dell'utente da cui nasce. */
  readonly why: string
  readonly scartati: readonly ScartoReport[]
  readonly note: readonly string[]
}

// ── Lettura difensiva ───────────────────────────────────────────────────────

function testo(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}
function lista(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : []
}
function oggetto(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}
function booleano(raw: unknown, difetto: boolean): boolean {
  return typeof raw === 'boolean' ? raw : difetto
}

/** Confronto indulgente sui nomi: «Incident» e «incident» sono la stessa entità. */
function chiave(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * VALIDA LA PROPOSTA GREZZA contro il catalogo del cliente.
 *
 * Ritorna `null` solo quando non resta NIENTE di utilizzabile (nessuna entità
 * riconosciuta): in quel caso il servizio risponde con un errore, perché una
 * sezione senza radice non è una mezza proposta, è nessuna proposta.
 */
export function validaPropostaReport(
  grezza: unknown,
  entita: readonly NavigableEntity[],
): PropostaReport | null {
  const doc = oggetto(grezza)
  const scartati: ScartoReport[] = []
  const note: string[] = lista(doc['note']).map((n) => testo(n)).filter((n) => n !== '')

  const perNome = new Map<string, NavigableEntity>()
  for (const e of entita) {
    perNome.set(chiave(e.entityType), e)
    perNome.set(chiave(e.neo4jLabel), e)
    perNome.set(chiave(e.label), e)
  }

  // ── I nodi ────────────────────────────────────────────────────────────────
  //
  // Gli id li genero io: il modello può ripetersi o inventare caratteri che
  // Cypher non accetta, e il costruttore genera i suoi allo stesso modo.
  interface Riconosciuto { entita: NavigableEntity; grezzo: Record<string, unknown>; idChiesto: string }
  const riconosciuti: Riconosciuto[] = []
  for (const raw of lista(doc['nodi'])) {
    const n = oggetto(raw)
    const chiesto = testo(n['entita'])
    const trovata = perNome.get(chiave(chiesto))
    if (!trovata) {
      scartati.push({ what: chiesto || '—', key: 'reportProposal.discard.entityUnknown', params: { name: chiesto || '—' } })
      continue
    }
    if (riconosciuti.length >= MAX_NODI_PROPONIBILI) {
      scartati.push({ what: trovata.label, key: 'reportProposal.discard.tooManyNodes', params: { max: MAX_NODI_PROPONIBILI } })
      continue
    }
    riconosciuti.push({ entita: trovata, grezzo: n, idChiesto: testo(n['id']) })
  }
  if (riconosciuti.length === 0) return null

  /** L'id chiesto dal modello → l'id vero: gli archi e il raggruppamento lo citano. */
  const idVero = new Map<string, string>()
  const nodes: NodoProposto[] = riconosciuti.map((r, i) => {
    const id = `n${String(i + 1)}`
    if (r.idChiesto !== '') idVero.set(r.idChiesto, id)
    idVero.set(chiave(r.entita.entityType), id)
    idVero.set(chiave(r.entita.neo4jLabel), id)
    idVero.set(chiave(r.entita.label), id)
    return {
      id,
      entityType: r.entita.entityType,
      neo4jLabel: r.entita.neo4jLabel,
      label: r.entita.label,
      // La RADICE è la prima: è l'entità che si conta, e il modello la mette
      // per prima perché il prompt gliela chiede così. Una proposta con due
      // radici non si può salvare (la validazione pretende una sola).
      isRoot: i === 0,
      isResult: i === 0 || booleano(r.grezzo['nel_risultato'], false),
      selectedFields: campiEsistenti(r.entita, lista(r.grezzo['colonne']), scartati),
      filters: filtriValidi(r.entita, r.grezzo['filtri'], scartati),
      // A gradini: la radice in alto a sinistra, gli altri sotto e a destra.
      positionX: 80 + i * 260,
      positionY: 80 + i * 40,
      why: testo(r.grezzo['perche']),
    }
  })

  // ── Gli archi ─────────────────────────────────────────────────────────────
  const edges: ArcoProposto[] = []
  for (const raw of lista(doc['collegamenti'])) {
    const a = oggetto(raw)
    const da = idVero.get(testo(a['da'])) ?? idVero.get(chiave(testo(a['da']))) ?? null
    const verso = idVero.get(testo(a['verso'])) ?? idVero.get(chiave(testo(a['verso']))) ?? null
    const tipo = testo(a['relazione'])
    if (da === null || verso === null || da === verso) {
      scartati.push({ what: tipo || '—', key: 'reportProposal.discard.edgeEnds', params: { name: tipo || '—' } })
      continue
    }
    const sorgente = nodes.find((n) => n.id === da)!
    const bersaglio = nodes.find((n) => n.id === verso)!
    const entitaSorgente = entita.find((e) => e.entityType === sorgente.entityType)
    // La relazione deve ESISTERE su quell'entità e puntare a quel bersaglio:
    // la whitelist del tenant sa solo che il tipo è interrogabile, non che
    // parta da lì — e un arco che non esiste dà un report sempre vuoto.
    const relazione = (entitaSorgente?.relations ?? []).find((r) =>
      r.relationshipType === tipo && chiave(r.targetNeo4jLabel) === chiave(bersaglio.neo4jLabel))
    if (!relazione) {
      scartati.push({
        what: tipo || '—',
        key: 'reportProposal.discard.relationUnknown',
        params: { name: tipo || '—', from: sorgente.label, to: bersaglio.label },
      })
      continue
    }
    edges.push({
      id: `e${String(edges.length + 1)}`,
      sourceNodeId: da,
      targetNodeId: verso,
      relationshipType: tipo,
      direction: relazione.direction === 'incoming' ? 'incoming' : 'outgoing',
      label: relazione.label,
    })
  }

  /*
   * UN NODO SENZA STRADA NON SI TIENE.
   *
   * La query parte dalla radice e cammina sugli archi: un nodo che nessun arco
   * raggiunge resterebbe scollegato, e in Cypher un MATCH scollegato è un
   * PRODOTTO CARTESIANO — il report darebbe numeri moltiplicati, che è peggio
   * di un report in meno.
   */
  const raggiunti = new Set<string>([nodes[0]!.id])
  let cresciuto = true
  while (cresciuto) {
    cresciuto = false
    for (const e of edges) {
      if (raggiunti.has(e.sourceNodeId) && !raggiunti.has(e.targetNodeId)) { raggiunti.add(e.targetNodeId); cresciuto = true }
      if (raggiunti.has(e.targetNodeId) && !raggiunti.has(e.sourceNodeId)) { raggiunti.add(e.sourceNodeId); cresciuto = true }
    }
  }
  const tenuti = nodes.filter((n) => raggiunti.has(n.id))
  for (const perso of nodes.filter((n) => !raggiunti.has(n.id))) {
    scartati.push({ what: perso.label, key: 'reportProposal.discard.nodeUnreachable', params: { name: perso.label } })
  }
  const archiTenuti = edges.filter((e) => raggiunti.has(e.sourceNodeId) && raggiunti.has(e.targetNodeId))

  // ── Il grafico, il raggruppamento, la metrica ─────────────────────────────
  const radice = tenuti[0]!
  const entitaRadice = entita.find((e) => e.entityType === radice.entityType)!

  let chartType = testo(doc['grafico'])
  if (!isChartType(chartType)) {
    scartati.push({ what: chartType || '—', key: 'reportProposal.discard.chartUnknown', params: { name: chartType || '—', allowed: CHART_TYPES.join(', ') } })
    chartType = 'bar'
  }

  // Il raggruppamento: su quale nodo, e su quale suo campo.
  const nodoGruppoChiesto = testo(doc['raggruppa_per_entita'])
  const nodoGruppo = nodoGruppoChiesto === ''
    ? radice.id
    : (idVero.get(nodoGruppoChiesto) ?? idVero.get(chiave(nodoGruppoChiesto)) ?? radice.id)
  const nodoGruppoTenuto = tenuti.some((n) => n.id === nodoGruppo) ? nodoGruppo : radice.id
  const entitaGruppo = entita.find((e) => e.entityType === tenuti.find((n) => n.id === nodoGruppoTenuto)!.entityType)!

  let groupByField: string | null = null
  const campoGruppoChiesto = testo(doc['raggruppa_per_campo'])
  if (chartType !== 'kpi' && chartType !== 'table') {
    const trovato = campoDi(entitaGruppo, campoGruppoChiesto)
    if (campoGruppoChiesto !== '' && trovato === null) {
      scartati.push({ what: campoGruppoChiesto, key: 'reportProposal.discard.groupFieldUnknown', params: { name: campoGruppoChiesto, entity: entitaGruppo.label } })
    }
    /*
     * Un default che non sia una bugia: le serie si raggruppano per data, le
     * categorie per `status` se esiste. Se non esiste nemmeno quello si lascia
     * `null`, e il costruttore lo chiede — meglio una domanda che un grafico
     * raggruppato per qualcosa che nessuno ha scelto.
     */
    const serie = chartType === 'line' || chartType === 'area'
    groupByField = trovato?.name
      ?? (serie ? campoDi(entitaGruppo, 'created_at')?.name ?? null : campoDi(entitaGruppo, 'status')?.name ?? null)
  }

  let metric = testo(doc['metrica'])
  if (metric === '' || !isReportMetric(metric)) {
    if (metric !== '') {
      scartati.push({ what: metric, key: 'reportProposal.discard.metricUnknown', params: { name: metric, allowed: REPORT_METRICS.join(', ') } })
    }
    metric = 'count'
  }
  let metricField: string | null = null
  if ((REPORT_METRICS_WITH_FIELD as readonly string[]).includes(metric)) {
    const chiesto = testo(doc['metrica_campo'])
    const campo = campoDi(entitaRadice, chiesto)
    // La metrica si calcola sulla RADICE e su un campo NUMERICO: fuori da lì
    // Neo4j darebbe `null`, cioè una media che sembra un dato (vedi la
    // correzione del 19 set su `REPORT_METRICS`).
    if (campo !== null && campo.fieldType === 'number') {
      metricField = campo.name
    } else {
      scartati.push({
        what: chiesto || metric,
        key: campo === null ? 'reportProposal.discard.metricFieldUnknown' : 'reportProposal.discard.metricFieldNotNumber',
        params: { name: chiesto || '—', entity: entitaRadice.label },
      })
      metric = 'count'
    }
  }

  const limiteChiesto = Number(doc['limite'])
  const limit = Number.isInteger(limiteChiesto) && limiteChiesto >= 1
    ? Math.min(limiteChiesto, MAX_LIMITE_PROPONIBILE)
    : 20
  if (Number.isInteger(limiteChiesto) && limiteChiesto > MAX_LIMITE_PROPONIBILE) {
    scartati.push({ what: String(limiteChiesto), key: 'reportProposal.discard.limitCapped', params: { max: MAX_LIMITE_PROPONIBILE } })
  }

  /*
   * UNA TABELLA SENZA COLONNE NON SI SALVA: la validazione la rifiuta, e a
   * ragione (una tabella senza colonne non mostra niente). Se il modello non
   * ne ha scelte, si prendono i primi campi della radice — è quello che fa una
   * persona, e si vedono e si cambiano nel costruttore.
   */
  const nodiFiniti = tenuti.map((n) => {
    if (chartType !== 'table' || !n.isRoot || n.selectedFields.length > 0) return n
    const primi = entitaRadice.fields.slice(0, 4).map((f) => f.name)
    if (primi.length > 0) {
      scartati.push({ what: n.label, key: 'reportProposal.discard.columnsGuessed', params: { fields: primi.join(', ') } })
    }
    return { ...n, selectedFields: primi }
  })

  /*
   * IL PERIODO (19 set 2026).
   *
   * Vale per QUALUNQUE grafico raggruppato per una data, non solo per le
   * serie: un istogramma per `created_at` senza periodo dà una barra per
   * timestamp. Una serie ha sempre un periodo (giorno, se non detto); un
   * grafico a categorie lo prende solo quando raggruppa per una data, perché
   * su «stato» o «team» non vuol dire niente.
   */
  const serie = chartType === 'line' || chartType === 'area'
  const campoGruppo = groupByField === null ? null : campoDi(entitaGruppo, groupByField)
  const gruppoEUnaData = campoGruppo !== null && (campoGruppo.fieldType === 'date' || campoGruppo.fieldType === 'datetime')
  const periodoChiesto = testo(doc['raggruppa_per_periodo'])
  let granularita: string | null = null
  if (serie || gruppoEUnaData) {
    granularita = isReportGranularity(periodoChiesto) ? periodoChiesto : 'day'
    if (periodoChiesto !== '' && !isReportGranularity(periodoChiesto)) {
      scartati.push({ what: periodoChiesto, key: 'reportProposal.discard.granularityUnknown', params: { name: periodoChiesto } })
    }
  } else if (periodoChiesto !== '') {
    scartati.push({ what: periodoChiesto, key: 'reportProposal.discard.granularityNotADate', params: { name: groupByField ?? '—' } })
  }

  return {
    title: testo(doc['titolo']) || entitaRadice.label,
    chartType,
    metric,
    metricField,
    groupByNodeId: chartType === 'kpi' || chartType === 'table' ? null : nodoGruppoTenuto,
    groupByField,
    groupByGranularity: granularita,
    limit,
    sortDir: testo(doc['ordine']).toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
    nodes: nodiFiniti,
    edges: archiTenuti,
    why: testo(doc['perche']),
    scartati,
    note,
  }
}

/** Un campo dell'entità, cercato con indulgenza sul nome e sull'etichetta. */
function campoDi(entita: NavigableEntity, nome: string): NavigableField | null {
  if (nome === '') return null
  const k = chiave(nome)
  return entita.fields.find((f) => chiave(f.name) === k) ?? entita.fields.find((f) => chiave(f.label) === k) ?? null
}

/** Le colonne che l'entità ha davvero; le altre si scartano dicendolo. */
function campiEsistenti(entita: NavigableEntity, chiesti: readonly unknown[], scartati: ScartoReport[]): string[] {
  const out: string[] = []
  for (const raw of chiesti) {
    const nome = testo(raw)
    if (nome === '') continue
    const campo = campoDi(entita, nome)
    if (campo === null) {
      scartati.push({ what: nome, key: 'reportProposal.discard.fieldUnknown', params: { name: nome, entity: entita.label } })
      continue
    }
    if (!out.includes(campo.name)) out.push(campo.name)
  }
  return out
}

/**
 * I FILTRI del nodo. Si tiene solo quello che il costruttore sa anche
 * MOSTRARE: un filtro che l'interfaccia non rende è un filtro che chi rivede
 * non può correggere, e allora il report fa una cosa che nessuno vede scritta.
 */
function filtriValidi(entita: NavigableEntity, raw: unknown, scartati: ScartoReport[]): string | null {
  const buoni: { field: string; operator: string; value: unknown }[] = []
  for (const rawFiltro of lista(raw)) {
    const f = oggetto(rawFiltro)
    const nome = testo(f['campo'])
    const operatore = testo(f['operatore']) || 'eq'
    const campo = campoDi(entita, nome)
    if (campo === null) {
      scartati.push({ what: nome || '—', key: 'reportProposal.discard.filterFieldUnknown', params: { name: nome || '—', entity: entita.label } })
      continue
    }
    if (!(FILTER_OPERATORS as readonly string[]).includes(operatore)) {
      scartati.push({ what: campo.label, key: 'reportProposal.discard.operatorUnknown', params: { op: operatore, allowed: FILTER_OPERATORS.join(', ') } })
      continue
    }
    const senzaValore = operatore === 'is_null' || operatore === 'is_not_null'
    const valoreGrezzo = f['valore']
    if (senzaValore) {
      buoni.push({ field: campo.name, operator: operatore, value: null })
      continue
    }
    if (operatore === 'last_n_days') {
      const giorni = Number(valoreGrezzo)
      if (!Number.isInteger(giorni) || giorni < 1) {
        scartati.push({ what: campo.label, key: 'reportProposal.discard.filterDays', params: { value: String(valoreGrezzo ?? '—') } })
        continue
      }
      buoni.push({ field: campo.name, operator: operatore, value: giorni })
      continue
    }
    if (operatore === 'in') {
      // `valori` è il campo giusto (lo schema lo pretende); `valore` si accetta
      // comunque, perché un modello che scrive un valore solo dove ne stanno
      // molti ha detto una cosa sensata, non un errore.
      const grezzi = lista(f['valori']).length > 0 ? lista(f['valori']) : lista(valoreGrezzo)
      const valori = grezzi.map((v) => testo(v)).filter((v) => v !== '')
      if (valori.length === 0 && testo(valoreGrezzo) !== '') valori.push(testo(valoreGrezzo))
      if (valori.length === 0) {
        scartati.push({ what: campo.label, key: 'reportProposal.discard.filterEmpty', params: { op: operatore } })
        continue
      }
      buoni.push({ field: campo.name, operator: operatore, value: valoriAmmessi(campo, valori, scartati) })
      continue
    }
    const valore = testo(valoreGrezzo)
    if (valore === '') {
      scartati.push({ what: campo.label, key: 'reportProposal.discard.filterEmpty', params: { op: operatore } })
      continue
    }
    const ammessi = valoriAmmessi(campo, [valore], scartati)
    if (ammessi.length === 0) continue
    buoni.push({ field: campo.name, operator: operatore, value: ammessi[0] })
  }
  return buoni.length === 0 ? null : JSON.stringify(buoni)
}

/**
 * I valori di un campo a VOCABOLARIO devono essere del vocabolario: un filtro
 * «stato = Chiuso» su un vocabolario che scrive `closed` non trova niente per
 * sempre, e il report resta vuoto senza dire perché.
 */
function valoriAmmessi(campo: NavigableField, valori: readonly string[], scartati: ScartoReport[]): string[] {
  if (campo.enumValues.length === 0) return [...valori]
  const out: string[] = []
  for (const v of valori) {
    const trovato = campo.enumValues.find((x) => chiave(x) === chiave(v))
    if (trovato === undefined) {
      scartati.push({
        what: campo.label,
        key: 'reportProposal.discard.filterValueUnknown',
        params: { value: v, allowed: campo.enumValues.slice(0, 8).join(', ') },
      })
      continue
    }
    out.push(trovato)
  }
  return out
}

/**
 * La proposta come SEZIONE, per darla alla validazione vera e all'anteprima.
 * `order` e `title` sono quelli di una sezione nuova: la proposta non sa dove
 * finirà nel report, e lo decide chi la accetta.
 */
export function sezioneDaProposta(p: PropostaReport): ReportSectionDef {
  const nodes: ReportNodeDef[] = p.nodes.map((n) => ({
    id: n.id,
    entityType: n.entityType,
    neo4jLabel: n.neo4jLabel,
    label: n.label,
    isResult: n.isResult,
    isRoot: n.isRoot,
    positionX: n.positionX,
    positionY: n.positionY,
    filters: n.filters,
    selectedFields: [...n.selectedFields],
  }))
  const edges: ReportEdgeDef[] = p.edges.map((e) => ({
    id: e.id,
    sourceNodeId: e.sourceNodeId,
    targetNodeId: e.targetNodeId,
    relationshipType: e.relationshipType,
    direction: e.direction,
    label: e.label,
  }))
  return {
    id: 'proposta',
    order: 0,
    title: p.title,
    chartType: p.chartType,
    groupByNodeId: p.groupByNodeId,
    groupByField: p.groupByField,
    groupByGranularity: p.groupByGranularity,
    metric: p.metric,
    metricField: p.metricField,
    limit: p.limit,
    sortDir: p.sortDir,
    nodes,
    edges,
  }
}
