/**
 * «DESCRIVIMI IL REPORT E TE LO DISEGNO» (19 set 2026).
 *
 * Il gemello del progettista dei moduli, sull'altro costruttore del prodotto:
 * chi configura scrive «gli incident aperti per team negli ultimi 30 giorni,
 * a barre» e riceve il progetto di una SEZIONE di report — entità, grafo,
 * filtri, raggruppamento, metrica, grafico. La proposta **non scrive niente**:
 * atterra nel wizard, dove si vede l'anteprima e si salva a mano.
 *
 * ## Il modello scegli dentro il metamodello del cliente
 * Prima della chiamata leggo `getNavigableEntities` — le stesse entità, gli
 * stessi campi e le stesse relazioni che il costruttore offre, compresi i campi
 * personalizzati dei ticket e le risposte dei moduli del catalogo. Il modello
 * compone quello; il filtro (`lib/reportDesignProposal.ts`) butta il resto.
 *
 * ## Due cose che questa funzione ha dovuto correggere PRIMA di esistere
 *  1. le metriche erano finte (`metric` salvato e ignorato: il Cypher contava
 *     sempre). Una proposta che scrive «media» avrebbe prodotto un conteggio;
 *  2. `top_n` era valido per l'API e non scegliibile nel costruttore.
 * Sono corrette in `reportQueryBuilder.ts` e in `ReportChartConfig.tsx`: un
 * progettista che propone quello che il prodotto non fa davvero non è un
 * aiuto, è un moltiplicatore di bugie.
 *
 * ## Cosa resta fuori, dichiarato
 *  - il TEMPLATE: si propone una sezione, non un report intero con nome,
 *    icona, condivisione e pianificazione;
 *  - qualunque scrittura: la proposta è una proposta.
 */
import Anthropic from '@anthropic-ai/sdk'
import { GraphQLError } from 'graphql'
import { config } from '../lib/config.js'
import { logger } from '../lib/logger.js'
import { assertAIFeature } from '../lib/aiSettings.js'
import { getNavigableEntities, type NavigableEntity } from '../lib/navigableGraph.js'
import { getReportWhitelist } from '../lib/reportWhitelist.js'
import { validateReportSection, CHART_TYPES, FILTER_OPERATORS, REPORT_METRICS } from '../lib/reportQueryBuilder.js'
import {
  MAX_LIMITE_PROPONIBILE, MAX_NODI_PROPONIBILI, sezioneDaProposta, validaPropostaReport,
  type PropostaReport,
} from '../lib/reportDesignProposal.js'
import { modelLanguageFor } from '../lib/systemText.js'

const log = logger.child({ module: 'report-designer' })

/** Quanto testo accetto: una descrizione, non un capitolato. */
export const MAX_PROMPT_CHARS = 2000

/**
 * Quanti valori di un vocabolario passo al modello per campo.
 *
 * Non è avarizia: il catalogo di un cliente con molti tipi di CI diventa
 * lunghissimo, e una tendina con 200 valori non aiuta a scegliere un filtro.
 * I valori troncati restano validabili dal filtro, che li conosce tutti.
 */
const MAX_VALORI_PER_CAMPO = 12

export interface RichiestaDiReport {
  readonly tenantId: string
  readonly prompt: string
}

const SYSTEM_PROMPT = `Sei il progettista dei report di OpenGrafo, una piattaforma ITSM. Ricevi la descrizione a parole di un report e il METAMODELLO REALE del cliente: le entità interrogabili (ticket, organizzazione, CMDB) con i loro campi e le loro relazioni. Restituisci il progetto di UNA sezione di report.

Regole, in ordine di importanza:
1. NON INVENTARE niente: entità, campi, relazioni e valori dei vocabolari esistono solo se te li ho passati. Un campo che non c'è fa sparire il filtro o la colonna che lo usa.
2. Il PRIMO nodo è la RADICE: l'entità che si conta o si misura («gli incident per team» ha radice Incident, non Team). Gli altri nodi servono solo se il report deve passare per una relazione, e ognuno deve essere collegato da un "collegamento" — al massimo ${String(MAX_NODI_PROPONIBILI)} nodi in tutto.
3. Un collegamento usa una relazione che l'entità di partenza HA DAVVERO, verso il bersaglio che quella relazione raggiunge.
4. Il grafico segue la domanda: "quanti" senza confronto = kpi; una ripartizione = pie/donut/bar/bar_horizontal; un andamento nel tempo = line/area (raggruppa per un campo data); una classifica = top_n; un elenco di record = table (e allora scegli le colonne).
5. La METRICA: "count" per contare i record; avg/sum/min/max SOLO su un campo NUMERICO della radice, e allora indica "metrica_campo". Se il campo che servirebbe non è numerico o non esiste, usa "count" e dillo nelle note.
6. I FILTRI restringono: "ultimi 30 giorni" = operatore last_n_days con valore 30 su un campo data; uno stato o una categoria = eq (o "in" con più valori) usando i VALORI del vocabolario che ti ho passato, non le loro etichette.
7. In "perche" scrivi, per la sezione e per ogni nodo, il pezzo della descrizione dell'utente da cui nasce: una riga, concreta. Chi legge deve poter verificare senza fidarsi.
8. In "note" metti quello che non hai potuto fare e perché (un dato che il metamodello non ha, una metrica impossibile).

Non puoi creare entità, campi o relazioni, e non progetti il report intero: solo una sezione.`

function schemaProposta(entita: readonly NavigableEntity[]) {
  const nomi = [...new Set(entita.map((e) => e.entityType))]
  /*
   * `valore` e `valori` separati, e non un campo dal tipo libero: lo schema
   * JSON pretende un `type` per ogni proprietà (il primo tentativo è stato
   * rifiutato con «Schema type is missing»), e una lista ha bisogno dei suoi
   * `items`. Così il modello dice in che forma sta il valore invece di
   * lasciarlo indovinare a noi.
   */
  const filtro = {
    type: 'object',
    properties: {
      campo:     { type: 'string' },
      operatore: { type: 'string', enum: [...FILTER_OPERATORS] },
      valore:    { type: ['string', 'number', 'null'], description: 'Un valore: testo, o il numero di giorni per last_n_days. null per is_null/is_not_null.' },
      valori:    { type: 'array', items: { type: 'string' }, description: 'Più valori, solo per l\'operatore "in".' },
    },
    required: ['campo', 'operatore', 'valore', 'valori'],
    additionalProperties: false,
  } as const

  return {
    type: 'object',
    properties: {
      titolo:   { type: 'string' },
      perche:   { type: 'string' },
      grafico:  { type: 'string', enum: [...CHART_TYPES] },
      metrica:  { type: 'string', enum: [...REPORT_METRICS] },
      metrica_campo: { type: ['string', 'null'], description: 'Campo NUMERICO della radice, solo per avg/sum/min/max.' },
      raggruppa_per_entita: { type: ['string', 'null'], description: "L'id del nodo su cui raggruppare; null = la radice." },
      raggruppa_per_campo:  { type: ['string', 'null'] },
      limite:   { type: 'integer', description: `Da 1 a ${String(MAX_LIMITE_PROPONIBILE)}.` },
      ordine:   { type: 'string', enum: ['ASC', 'DESC'] },
      nodi: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id:            { type: 'string', description: 'Un id tuo, breve: lo citano i collegamenti.' },
            entita:        { type: 'string', enum: nomi },
            nel_risultato: { type: 'boolean', description: 'Per una tabella: se le sue colonne entrano nell\'elenco.' },
            colonne:       { type: 'array', items: { type: 'string' }, description: 'Nomi di campi, solo per una tabella.' },
            filtri:        { type: 'array', items: filtro },
            perche:        { type: 'string' },
          },
          required: ['id', 'entita', 'nel_risultato', 'colonne', 'filtri', 'perche'],
          additionalProperties: false,
        },
      },
      collegamenti: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            da:        { type: 'string', description: "L'id del nodo di partenza." },
            verso:     { type: 'string', description: "L'id del nodo di arrivo." },
            relazione: { type: 'string', description: 'Il tipo di relazione, fra quelli dell\'entità di partenza.' },
          },
          required: ['da', 'verso', 'relazione'],
          additionalProperties: false,
        },
      },
      note: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'titolo', 'perche', 'grafico', 'metrica', 'metrica_campo', 'raggruppa_per_entita',
      'raggruppa_per_campo', 'limite', 'ordine', 'nodi', 'collegamenti', 'note',
    ],
    additionalProperties: false,
  } as const
}

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!config.anthropicApiKey) {
    throw new GraphQLError('AI report designer not configured: ANTHROPIC_API_KEY missing', {
      extensions: { code: 'FAILED_PRECONDITION', i18n: { key: 'errors.ai.notConfigured' } },
    })
  }
  _client ??= new Anthropic()
  return _client
}

export interface EsitoPropostaReport extends PropostaReport {
  /** La frase da cui è nata: torna indietro perché si rilegga accanto al risultato. */
  readonly prompt: string
}

export async function proponiSezioneDiReport(req: RichiestaDiReport): Promise<EsitoPropostaReport> {
  await assertAIFeature(req.tenantId, 'reportDesigner')

  const prompt = req.prompt.trim()
  if (prompt === '') {
    throw new GraphQLError('Empty description: nothing to design', {
      extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.reportDesigner.emptyPrompt' } },
    })
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new GraphQLError(`The description is too long (max ${String(MAX_PROMPT_CHARS)} characters)`, {
      extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.reportDesigner.promptTooLong', params: { max: MAX_PROMPT_CHARS } } },
    })
  }

  const entita = await getNavigableEntities(req.tenantId)
  if (entita.length === 0) {
    throw new GraphQLError('This organization has nothing reportable yet', {
      extensions: { code: 'FAILED_PRECONDITION', i18n: { key: 'errors.reportDesigner.noEntities' } },
    })
  }

  // Quello che il modello vede: le stesse entità del costruttore, coi campi e
  // le relazioni. I valori dei vocabolari troncati (vedi MAX_VALORI_PER_CAMPO).
  const contesto = {
    richiesta: prompt,
    entita: entita.map((e) => ({
      id: e.entityType,
      nome: e.label,
      dove: e.group,
      campi: e.fields.map((f) => ({
        nome: f.name,
        etichetta: f.label,
        tipo: f.fieldType,
        ...(f.enumValues.length > 0 ? { valori: f.enumValues.slice(0, MAX_VALORI_PER_CAMPO) } : {}),
      })),
      relazioni: e.relations.map((r) => ({ relazione: r.relationshipType, verso: r.targetEntityType, etichetta: r.label })),
    })),
    grafici: CHART_TYPES,
    metriche: REPORT_METRICS,
    operatori_di_filtro: FILTER_OPERATORS,
    massimo_nodi: MAX_NODI_PROPONIBILI,
    massimo_limite: MAX_LIMITE_PROPONIBILE,
  }

  const client = getClient()
  const t0 = Date.now()
  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 6000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: schemaProposta(entita) },
    },
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `Write the title and the "perche" explanations in ${await modelLanguageFor(req.tenantId)}.` },
    ],
    messages: [{ role: 'user', content: JSON.stringify(contesto, null, 1) }],
  })

  if (response.stop_reason === 'refusal') {
    throw new GraphQLError('The model refused the design request', {
      extensions: { code: 'INTERNAL_SERVER_ERROR', i18n: { key: 'errors.ai.modelRefused' } },
    })
  }
  const blocco = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
  if (!blocco) throw new Error('[report-designer] response without a text block')

  let grezza: unknown
  try { grezza = JSON.parse(blocco.text) }
  catch (err) {
    throw new GraphQLError(`The model answer is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      extensions: { code: 'INTERNAL_SERVER_ERROR', i18n: { key: 'errors.reportDesigner.badAnswer' } },
    })
  }

  const proposta = validaPropostaReport(grezza, entita)
  if (proposta === null) {
    throw new GraphQLError('The proposal names no entity of this organization', {
      extensions: { code: 'INTERNAL_SERVER_ERROR', i18n: { key: 'errors.reportDesigner.nothingUsable' } },
    })
  }

  /*
   * L'ULTIMA PAROLA È DELLA VALIDAZIONE VERA.
   *
   * Il filtro ha già buttato i pezzi che non reggono, quindi qui non dovrebbe
   * succedere niente: se succede è un difetto MIO, e va detto come errore —
   * non passato al costruttore, che si troverebbe una sezione impossibile da
   * salvare senza sapere perché.
   */
  const whitelist = await getReportWhitelist(req.tenantId)
  try {
    validateReportSection(sezioneDaProposta(proposta), whitelist)
  } catch (err) {
    log.error({ err, proposta }, '[report-designer] the filtered proposal does not pass validateReportSection')
    throw new GraphQLError(`The proposal would not be saveable: ${err instanceof Error ? err.message : String(err)}`, {
      extensions: { code: 'INTERNAL_SERVER_ERROR', i18n: { key: 'errors.reportDesigner.invalidProposal' } },
    })
  }

  log.info({
    ms: Date.now() - t0,
    chartType: proposta.chartType,
    nodi: proposta.nodes.length,
    archi: proposta.edges.length,
    scartati: proposta.scartati.length,
  }, '[report-designer] proposal generated')

  return { ...proposta, prompt }
}
