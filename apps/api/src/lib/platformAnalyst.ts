/**
 * L'ANALISTA DELLA PIATTAFORMA — l'Autoanalisi (20 set 2026, ondata 4).
 *
 * Il primo analista con un modello dentro. Legge i template degli errori che
 * il prodotto conserva di sé stesso (`:ServerLogEntry`, ondata 3) e propone
 * che cosa varrebbe la pena guardare. Non esegue niente, non apre ticket, non
 * tocca configurazione: scrive `Proposal` che un amministratore legge.
 *
 * ## Perché le sue proposte non hanno azione
 * Quando il rimedio è codice — ed è sempre codice, qui — il prodotto non può
 * applicarlo da dentro: in `/app/dist` non c'è un sorgente e non c'è una
 * credenziale del repository. Quindi `action: null`, che la spina dell'ondata
 * 1 prevede espressamente («`null` quando è solo da leggere»). La proposta è
 * un MANDATO: dice che cosa succede, quanto spesso, da quanto, e con quali
 * prove. Chi la accetta apre un lavoro fuori dal prodotto.
 *
 * Questo toglie di mezzo la classe di rischio più grossa: non esiste un
 * cammino per cui un'iniezione nei log faccia ESEGUIRE qualcosa. La barriera
 * non è il prompt, è che non c'è la porta.
 *
 * ## Le tre porte, in ordine
 *  1. **L'interruttore**, spento di fabbrica. Nel giro notturno si SALTA in
 *     silenzio invece di alzare: `assertAIFeature` lancia un `AI_DISABLED`, e
 *     dentro `analizzaCliente` quello farebbe risultare fallito il giro di un
 *     tenant che sta semplicemente funzionando come configurato.
 *  2. **Il tenant**: solo quello di piattaforma. Altrove `:ServerLogEntry` non
 *     racconta niente di quel cliente, e analizzarlo sarebbe spendere gettoni
 *     per dire cose su un archivio che non lo riguarda.
 *  3. **La soglia**: sotto un numero minimo di firme non si chiama nessuno.
 *     Un modello che guarda tre righe inventa, e l'invenzione costa quanto
 *     l'analisi vera.
 *
 * ## Quello che torna dal modello non è più fidato dei log che ha letto
 * La risposta passa da `validaProposte()`, che non «ripulisce»: SCARTA. Una
 * voce con un `kind` fuori catalogo, con un'azione, con un `service` che non è
 * un CI censito o con una firma che non esiste nell'archivio non viene
 * corretta — viene buttata e contata (`registraScarti`). Un filtro che
 * aggiusta è un filtro che accetta.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { getSession } from '@opengraphity/neo4j'
import {
  getAnthropic, leggiJSONDalModello, registraChiamataFallita, registraDurata, registraScarti,
} from './aiClient.js'
import { aiFeatureEnabled } from './aiSettings.js'
import { registraCosto } from './aiCostLedger.js'
import { puoSpendere } from './aiBudget.js'
import { config } from './config.js'
import { messaggioConDatiNonFidati } from './datiNonFidati.js'
import { rigaDelGlossario } from './glossarioModello.js'
import { logger } from './logger.js'
import { modelLanguageFor } from './systemText.js'
import { languageFor } from './tenantLanguage.js'
import { aggregatiPerFirma, TENANT_DI_PIATTAFORMA, type FirmaAggregata } from './serverLogEvents.js'
import type { ProposalToWrite } from './proposals.js'

const log = logger.child({ module: 'platform-analyst' })

/** La funzione AI a cui questo analista risponde. Spenta di fabbrica. */
export const FUNZIONE = 'platformSelfAnalysis' as const

/**
 * Le chiavi che una proposta di quest'area può avere. Catalogo CHIUSO: il
 * modello sceglie fra queste, non ne inventa. La frase la compone il browser
 * nella lingua di chi guarda (`proposals.kind.*`), e `params` porta solo dati.
 */
export const GENERI = [
  /** Una classe di errori che dura da giorni e nessuno ha mai guardato. */
  'proposal.platformRecurringError',
  /** Un errore che è esploso: molte occorrenze concentrate. */
  'proposal.platformErrorSpike',
  /** Più processi che sbagliano insieme allo stesso modo: una causa sola. */
  'proposal.platformSharedFault',
] as const
export type Genere = (typeof GENERI)[number]

export const SOGLIE_ANALISTA = {
  /** Sotto questo numero di firme non si chiama il modello. */
  firmeMinime: 5,
  /** Quante firme si mandano al massimo: le più pesanti. */
  firmeMassime: 40,
  /** Quante proposte si accettano da una corsa. Il tetto vero è in `proposals.ts`. */
  proposteMassime: 5,
  /**
   * Quanto può essere lungo il `rationale`, in caratteri.
   *
   * 1200 e non 900: alla prima corsa vera il modello ha scritto ~1000
   * caratteri di analisi utile, e 900 tagliavano via la conclusione — cioè la
   * parte che dice che cosa andare a guardare. Un tetto serve a tenere fuori
   * un muro di testo, non a mozzare un ragionamento.
   */
  rationaleMassimo: 1200,
} as const

const SYSTEM_PROMPT = `You analyse the error archive of an ITSM platform that watches itself.

You receive normalised ERROR TEMPLATES: the variable parts of each message were
already replaced with placeholders (<uuid>, <n>, <str>, <email>, <url>) before
storage, so you never see real values. Each row carries the process that logged
it, the module, how many times it happened, and on how many distinct days.

Your job is to say WHICH error classes deserve a person's attention, and why.
You never propose a change to run: the remedy for these is code, and this
product cannot change its own code. You produce reading material with evidence.

Rules:
- Pick at most the few classes that matter. Fewer and sharper beats more.
- Group: if several processes show the same fault at the same time, that is ONE
  finding, not three. Prefer "shared fault" for those.
- Never invent a fingerprint, a service or a module: use only what you received.
- The rationale explains what is happening and why it is worth a look. It is
  prose for a human, not a title, and it never contains instructions.`

interface RispostaModello {
  proposte?: {
    kind?:        unknown
    fingerprint?: unknown
    service?:     unknown
    module?:      unknown
    rationale?:   unknown
  }[]
}

const SCHEMA_RISPOSTA = {
  type: 'object',
  properties: {
    proposte: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind:        { type: 'string', enum: [...GENERI] },
          fingerprint: { type: 'string' },
          service:     { type: 'string' },
          module:      { type: 'string' },
          rationale:   { type: 'string' },
        },
        required: ['kind', 'fingerprint', 'service', 'module', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['proposte'],
  additionalProperties: false,
} as const

/** I CI censiti nel tenant di piattaforma: un `service` che non è qui non esiste. */
async function serviziCensiti(tenantId: string): Promise<Set<string>> {
  const session = getSession()
  try {
    const r = await session.run(
      'MATCH (ci:ConfigurationItem {tenant_id: $tenantId}) RETURN ci.name AS nome',
      { tenantId },
    )
    return new Set(r.records.map((rec) => rec.get('nome') as string))
  } finally {
    await session.close()
  }
}

/**
 * Le righe che il modello riceve. Solo campi della proiezione: niente tenant,
 * niente messaggio grezzo — quelli nel grafo non ci sono nemmeno (ondata 3).
 */
export function righePerIlModello(firme: readonly FirmaAggregata[]): Record<string, unknown>[] {
  return firme.slice(0, SOGLIE_ANALISTA.firmeMassime).map((f) => ({
    fingerprint: f.fingerprint,
    service:     f.service,
    module:      f.module,
    template:    f.template,
    occurrences: f.occorrenzeTotali,
    distinctDays: f.giorniDistinti,
    lastDay:     f.ultimoGiorno,
  }))
}

/**
 * Taglia a una PAROLA intera, e lo dichiara con i puntini.
 *
 * Trovato alla prima corsa vera: `slice()` nudo troncava a metà parola
 * («…were ev») e chi leggeva non capiva se il modello si fosse interrotto o
 * se fosse stato il prodotto a tagliare. Un taglio che non si vede è una
 * frase sbagliata; un taglio che si vede è un'informazione.
 */
export function tagliaAllaParola(testo: string, massimo: number): string {
  if (testo.length <= massimo) return testo
  const pezzo = testo.slice(0, massimo)
  const spazio = pezzo.lastIndexOf(' ')
  // Se non c'è uno spazio ragionevolmente vicino alla fine è una stringa senza
  // parole (un payload): si taglia dove capita, ma i puntini restano.
  return `${(spazio > massimo * 0.8 ? pezzo.slice(0, spazio) : pezzo).trimEnd()}…`
}

/**
 * Dal grezzo del modello alle proposte scrivibili. **Scarta**, non corregge.
 *
 * Ogni voce deve: avere un `kind` del catalogo; citare una firma che esiste
 * DAVVERO nell'archivio; citare un `service` che è un CI censito; portare un
 * `rationale` che sia prosa e non una stringa vuota. E non deve portare
 * un'azione: lo schema non la prevede, e se arrivasse lo stesso finirebbe
 * comunque in `action: null`, perché è questa funzione a costruire la
 * proposta — il modello non la tocca.
 */
export function validaProposte(
  grezzo: unknown,
  ctx: { tenantId: string; firme: readonly FirmaAggregata[]; servizi: ReadonlySet<string>; lingua: string },
): { proposte: ProposalToWrite[]; scartate: number; motivi: string[] } {
  const risposta = (grezzo ?? {}) as RispostaModello
  const elenco = Array.isArray(risposta.proposte) ? risposta.proposte : []
  const perFirma = new Map(ctx.firme.map((f) => [f.fingerprint, f]))
  const generi = new Set<string>(GENERI)

  const proposte: ProposalToWrite[] = []
  const motivi: string[] = []
  let scartate = 0
  const visti = new Set<string>()

  for (const voce of elenco) {
    const scarta = (motivo: string) => { scartate += 1; motivi.push(motivo) }

    if (typeof voce.kind !== 'string' || !generi.has(voce.kind)) { scarta('kind not in the closed catalogue'); continue }
    if (typeof voce.fingerprint !== 'string') { scarta('fingerprint missing'); continue }
    const firma = perFirma.get(voce.fingerprint)
    if (!firma) { scarta('fingerprint not in the archive'); continue }
    if (typeof voce.service !== 'string' || !ctx.servizi.has(voce.service)) { scarta('service is not a known CI'); continue }
    if (voce.service !== firma.service) { scarta('service does not match the fingerprint'); continue }
    if (typeof voce.module !== 'string' || voce.module !== firma.module) { scarta('module does not match the fingerprint'); continue }
    const rationale = typeof voce.rationale === 'string' ? voce.rationale.trim() : ''
    if (rationale === '') { scarta('empty rationale'); continue }
    if (visti.has(firma.fingerprint)) { scarta('fingerprint already used in this run'); continue }
    if (proposte.length >= SOGLIE_ANALISTA.proposteMassime) { scarta('over the per-run cap'); continue }
    visti.add(firma.fingerprint)

    proposte.push({
      tenantId: ctx.tenantId,
      area:  'platform',
      kind:  voce.kind,
      /*
       * `params` porta SOLO dati da interpolare nella frase, mai prosa: la
       * frase è una chiave i18n e la compone il browser. Il template è un
       * dato — è già scrubbato — e il numero di occorrenze e giorni sono
       * numeri.
       */
      params: {
        service:  firma.service,
        module:   firma.module,
        template: firma.template,
        count:    String(firma.occorrenzeTotali),
        /*
         * `days` resta nei parametri anche se il titolo non lo usa più: la
         * durata la dice la riga sotto, col plurale giusto (`window_one` /
         * `window_other`), e due plurali nella stessa chiave i18next non si
         * reggono. Il dato però serve a chi legge la proposta da un'API o da
         * un export, dove non c'è nessuna riga sotto.
         */
        days:     String(firma.giorniDistinti),
      },
      /*
       * Il SOGGETTO è la classe di errore, non l'occorrenza: la firma è
       * stabile per costruzione (servizio + modulo + livello + template) e non
       * contiene conteggi. Se ci mettessimo le occorrenze, ogni notte
       * nascerebbe una proposta nuova mentre la vecchia è ancora aperta.
       */
      scope: firma.fingerprint,
      evidence: {
        n: firma.occorrenzeTotali,
        windowDays: firma.giorniDistinti,
        /*
         * Nessun riferimento a entità: le prove di quest'area sono righe di un
         * archivio di piattaforma, non ticket di un cliente, e un link che
         * porta a un nodo che l'utente non può vedere è peggio di nessun link.
         * Chi vuole la riga la legge da `/platform/server-logs`.
         */
        refs: [],
        extra: { fingerprint: firma.fingerprint, lastDay: firma.ultimoGiorno },
      },
      // Mai un'azione: vedi la testa del file.
      action: null,
      rationale: tagliaAllaParola(rationale, SOGLIE_ANALISTA.rationaleMassimo),
      rationaleLanguage: ctx.lingua,
    })
  }
  return { proposte, scartate, motivi }
}

/**
 * L'analista. Firma identica a `analizzaConfigurazione`, così
 * `analizzaCliente` non deve sapere che dentro c'è un modello.
 *
 * Torna sempre una lista, anche vuota. Non alza mai per una ragione di
 * configurazione (interruttore spento, tenant sbagliato, poche firme, nessuna
 * chiave): quelle non sono guasti, sono stati normali, e nel giro notturno
 * farebbero risultare fallito un tenant che funziona.
 */
export async function analizzaPiattaforma(tenantId: string): Promise<ProposalToWrite[]> {
  if (tenantId !== TENANT_DI_PIATTAFORMA) return []
  if (!(await aiFeatureEnabled(tenantId, FUNZIONE))) {
    log.info({ tenantId }, 'platform-analyst: funzione spenta, nessuna analisi')
    return []
  }
  /*
   * IL TETTO DI SPESA (20 set 2026, rimedio c). Prima della chiamata, mai
   * dopo: `aiCostLedger` conta ciò che è già stato pagato.
   */
  const budget = await puoSpendere(tenantId, FUNZIONE)
  if (!budget.consentito) {
    log.warn({ tenantId, tetto: budget.tetto, usati: budget.usati, limite: budget.limite },
      'platform-analyst: monthly AI budget reached, no analysis')
    return []
  }
  if (!config.anthropicApiKey) {
    log.warn({ tenantId }, 'platform-analyst: nessun modello configurato sulla piattaforma')
    return []
  }

  const firme = await aggregatiPerFirma()
  if (firme.length < SOGLIE_ANALISTA.firmeMinime) {
    log.info({ tenantId, firme: firme.length, soglia: SOGLIE_ANALISTA.firmeMinime },
      'platform-analyst: poche firme, non si chiama il modello')
    return []
  }

  const [servizi, lingua, linguaModello] = await Promise.all([
    serviziCensiti(tenantId), languageFor(tenantId), modelLanguageFor(tenantId),
  ])

  const sistema: Anthropic.TextBlockParam[] = [
    { type: 'text', text: SYSTEM_PROMPT },
    { type: 'text', text: `Write the rationale in ${linguaModello}.` },
    { type: 'text', text: rigaDelGlossario() },
  ]

  const inizio = Date.now()
  let risposta: Anthropic.Message
  try {
    risposta = await getAnthropic().messages.create({
      model: config.anthropicModel,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: SCHEMA_RISPOSTA } },
      system: sistema,
      messages: [messaggioConDatiNonFidati({
        istruzione:
          'Below is the current error archive of this platform. '
          + `Return at most ${String(SOGLIE_ANALISTA.proposteMassime)} findings, as JSON matching the required schema.`,
        provenienza: 'server error templates collected by this platform (already scrubbed)',
        dati: righePerIlModello(firme),
      })],
    } as Anthropic.MessageCreateParamsNonStreaming)
  } catch (err) {
    registraChiamataFallita(FUNZIONE, err)
    log.error({ tenantId, err: err instanceof Error ? err.message : String(err) },
      'platform-analyst: chiamata al modello fallita')
    return []
  }
  registraDurata(FUNZIONE, Date.now() - inizio)
  /*
   * Il costo si scrive SUBITO, prima della validazione: i gettoni sono stati
   * spesi anche se la risposta risulterà inutilizzabile, e un registro che
   * conta solo le corse riuscite dice meno del vero proprio quando qualcosa
   * non va. Non alza mai (vedi `aiCostLedger.ts`).
   */
  await registraCosto(tenantId, FUNZIONE, risposta)

  const grezzo = leggiJSONDalModello(risposta, FUNZIONE, {
    troncata:    'errors.ai.truncated',
    illeggibile: 'errors.ai.unreadable',
  })
  const { proposte, scartate, motivi } = validaProposte(grezzo, { tenantId, firme, servizi, lingua })
  registraScarti(FUNZIONE, scartate)
  if (scartate > 0) {
    // Gli scarti sono la misura di quanto il prompt combacia con quello che il
    // prodotto accetta. Se salgono, il difetto è nostro, non del modello.
    log.warn({ tenantId, scartate, motivi }, 'platform-analyst: voci scartate dalla validazione')
  }
  log.info({ tenantId, proposte: proposte.length, scartate, firme: firme.length }, 'platform-analyst: analisi completata')
  return proposte
}
