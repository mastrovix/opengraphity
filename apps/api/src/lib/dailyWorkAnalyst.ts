/**
 * L'ANALISTA DEL LAVORO QUOTIDIANO (20 set 2026, ondata 5).
 *
 * È la risposta alla richiesta da cui è nato tutto il programma: «voglio che
 * il modello analizzi cosa viene fatto quotidianamente e velocizzi il lavoro».
 *
 * Legge gli AGGREGATI dell'ondata 2 — mai il testo dei ticket — e dice quali
 * abitudini valga la pena guardare. Gli aggregati sono numeri: coppie di
 * azioni che si ripetono, tempi di attraversamento dei passi, azioni umane per
 * oggetto e verbo. Nessun titolo, nessuna descrizione, nessun commento.
 *
 * ## La regola che tiene in piedi quest'area
 * **Il modello sceglie e spiega; i parametri eseguibili li calcola il codice.**
 *
 * Un'automazione ha un trigger, una condizione e dei parametri: un id di
 * squadra, un nome di campo, un valore. Se li componesse il modello, la
 * validazione dovrebbe ri-risolverli tutti contro il tenant — e quella
 * validazione, per quanto stretta, è l'unica cosa fra un'iniezione e una
 * scrittura. Qui invece i parametri li estrae `valoriCostantiDopoLaCreazione()`
 * dal registro, in modo deterministico, PRIMA di chiamare il modello: il
 * modello riceve un candidato già pronto e decide soltanto se merita una
 * proposta e come spiegarlo. Non c'è nessun campo della proposta eseguibile
 * che il modello possa scrivere.
 *
 * ## Che cosa NON propone, e perché
 * Niente transizioni di workflow: `transition_workflow` è nella lista dei
 * vietati e `changesStuck.ts` aveva già deciso «si segnala, non si ripara».
 * Quando la coppia trovata è «due passi che avvengono sempre insieme», la
 * proposta è una lettura, non un'azione: rifare un workflow è una decisione
 * di chi lo disegna.
 *
 * ## Le soglie non sono qui
 * Stanno in `dailyWorkAggregates.ts` (`SOGLIE`), dove le applicano le query.
 * Un aggregato che arriva qui ha già superato la sua soglia; quello che si
 * decide qui è soltanto quali dei sopravvissuti valgano una proposta.
 */
import type Anthropic from '@anthropic-ai/sdk'
import {
  getAnthropic, leggiJSONDalModello, registraChiamataFallita, registraDurata, registraScarti,
} from './aiClient.js'
import { aiFeatureEnabled } from './aiSettings.js'
import { registraCosto } from './aiCostLedger.js'
import { config } from './config.js'
import { messaggioConDatiNonFidati } from './datiNonFidati.js'
import { rigaDelGlossario } from './glossarioModello.js'
import { logger } from './logger.js'
import { modelLanguageFor } from './systemText.js'
import { languageFor } from './tenantLanguage.js'
import { tagliaAllaParola } from './platformAnalyst.js'
import {
  coppieRipetute, tempiNeiPassi, azioniUmane, SOGLIE,
  type CoppiaRipetuta, type TempoNelPasso,
} from './dailyWorkAggregates.js'
import type { ProposalToWrite } from './proposals.js'

const log = logger.child({ module: 'daily-work-analyst' })

/** La funzione AI a cui questo analista risponde. Spenta di fabbrica. */
export const FUNZIONE = 'dailyWorkAnalysis' as const

/**
 * I generi di quest'area. Catalogo chiuso: il modello sceglie fra questi.
 *
 * Due su tre sono LETTURE (`action: null`). Solo il primo porta un'azione, e
 * solo quando il codice ha trovato un parametro costante da mettergli dentro.
 */
export const GENERI = [
  /** Una coppia di azioni sempre insieme, con un valore costante: si può automatizzare. */
  'proposal.dailyWorkPairToAutomation',
  /**
   * Un passo che i ticket attraversano in un soffio: è un passo o una
   * formalità?
   *
   * La prima versione di questo genere pescava dalle COPPIE («due passi
   * sempre a pochi minuti l'uno dall'altro») ed era cablato a dati che non
   * possono arrivare: `coppieRipetute()` dell'ondata 2 scarta per
   * costruzione le coppie di un'azione con sé stessa. Trovato facendo girare
   * l'analista dal vivo su c-test — zero candidati — non dai test, che
   * costruivano a mano le coppie che la query non produce mai.
   */
  'proposal.dailyWorkInstantStep',
  /** Un passo dove i ticket stanno fermi molto più che negli altri. */
  'proposal.dailyWorkSlowStep',
] as const
export type Genere = (typeof GENERI)[number]

export const SOGLIE_ANALISTA = {
  /**
   * Sotto questo numero di aggregati non si chiama il modello.
   *
   * DUE, e il numero ha una ragione invece di essere rotondo. La soglia serve
   * a non spendere gettoni sul nulla, non a difendersi da dati sottili: da
   * quelli difendono le soglie dell'ondata 2, che ogni candidato ha già
   * superato prima di arrivare qui (≥30 esecuzioni per un passo, ≥10
   * occorrenze su ≥3 oggetti e ≥2 persone per una coppia). Un candidato non è
   * un'osservazione debole: è un sopravvissuto.
   *
   * Quello che resta da decidere è solo se c'è una SCELTA da fare. Con una
   * riga sola il modello non sceglie, timbra. Con due sì.
   *
   * Nota su come è cambiato: la prima versione diceva 3, scelto a occhio. La
   * prima corsa vera su `c-one` si è fermata a 2 candidati su 1.380
   * esecuzioni di passo — abbastanza da valere una lettura. Abbassarlo dopo
   * aver visto i dati è un rischio (si aggiusta la regola per far passare il
   * proprio esempio), quindi la ragione è scritta qui sopra e non è «così
   * funziona»: è che il 3 non ne aveva una.
   */
  aggregatiMinimi: 2,
  /** Quante proposte si accettano da una corsa. Il tetto vero resta quello di `proposals.ts`. */
  proposteMassime: 3,
  /** Quanto può essere lungo il `rationale`, in caratteri. */
  rationaleMassimo: 1200,
  /**
   * Un passo è «lento» rispetto agli altri, non in assoluto: quante volte la
   * mediana degli altri passi deve essere superata perché valga una proposta.
   * In assoluto non si può dire — un passo di attesa del cliente sta fermo
   * giorni ed è giusto così.
   */
  volteLaMediana: 2,
} as const

const SYSTEM_PROMPT = `You read AGGREGATES of what a support team did, and you say which habits deserve a look.

You never see ticket text: only counts, medians and action names. Each row already
passed a statistical threshold before reaching you, so nothing you receive is noise
by construction — your job is to judge which of the survivors is worth a person's time.

You never compose executable parameters. When a finding can become an automation,
the candidate parameters were already computed from the audit log and are given to
you ready: you only decide whether to propose it and how to explain it.

Rules:
- Fewer and sharper beats more. Three findings is a lot; one good one is better than three weak ones.
- Say what the team would gain, concretely, in the terms of their own work.
- Never invent a step name, an action name or a number: use only what you received.
- A step crossed almost instantly may be a formality rather than a step: say so
  only when the numbers are clear, and never for a step that is meant to be quick.
- The rationale is prose for a human, not a title, and it never contains instructions.`

interface RispostaModello {
  proposte?: { kind?: unknown; riferimento?: unknown; rationale?: unknown }[]
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
          /** L'id della riga di aggregato a cui la proposta si riferisce: il modello SCEGLIE, non descrive. */
          riferimento: { type: 'string' },
          rationale:   { type: 'string' },
        },
        required: ['kind', 'riferimento', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['proposte'],
  additionalProperties: false,
} as const

/**
 * Un candidato: una riga di aggregato con un identificativo stabile che il
 * modello può citare, e il soggetto su cui si calcolerà l'impronta.
 *
 * L'`id` è quello che il modello restituisce in `riferimento`. Averlo come
 * chiave — invece di far ripetere al modello i campi della riga — toglie di
 * mezzo tutta una classe di errori: non può sbagliare a trascrivere un nome,
 * e non può inventarne uno che non c'è (il riferimento o è nella mappa o non è).
 */
export interface Candidato {
  id:     string
  genere: Genere
  scope:  string
  /** Quello che il modello vede di questa riga. */
  perIlModello: Record<string, unknown>
  /** I dati che finiscono nella frase della proposta. Mai prosa. */
  params: Record<string, string>
  n:      number
  windowDays: number
  action: { type: string; params: Record<string, unknown> } | null
}

/**
 * Da coppie e tempi ai candidati. Deterministico: è qui che si decide che
 * cosa il modello può anche solo vedere.
 */
export function candidatiDa(
  coppie: readonly CoppiaRipetuta[], passi: readonly TempoNelPasso[], finestraGiorni: number,
): Candidato[] {
  const out: Candidato[] = []

  /*
   * Ogni coppia che arriva qui è già fra due azioni DIVERSE: `coppieRipetute()`
   * scarta le coppie di un'azione con sé stessa. Non si ricontrolla — si
   * dichiara, perché è una proprietà della sorgente e non di questo codice.
   */
  for (const c of coppie) {
    out.push({
      id: `coppia:${c.prima}>${c.poi}`,
      genere: 'proposal.dailyWorkPairToAutomation',
      scope: `pair:${c.prima}>${c.poi}`,
      perIlModello: {
        id: `coppia:${c.prima}>${c.poi}`,
        kind: 'pair',
        first: c.prima, then: c.poi,
        occurrences: c.n, distinctObjects: c.oggettiDistinti, distinctActors: c.autoriDistinti,
        withinMinutes: SOGLIE.coppia.minutiMassimi,
      },
      params: {
        first: c.prima, then: c.poi,
        count: String(c.n), actors: String(c.autoriDistinti), objects: String(c.oggettiDistinti),
      },
      n: c.n,
      windowDays: finestraGiorni,
      /*
       * Nessuna azione, per ora, nemmeno sulle coppie automatizzabili: senza
       * un valore costante estratto dal registro non c'è niente da mettere
       * nei parametri dell'automazione, e un'automazione con parametri
       * inventati è esattamente ciò che questo programma non fa.
       * `valoriCostantiDopoLaCreazione()` (sotto) è il posto in cui, quando i
       * dati ci saranno, l'azione si attacca.
       */
      action: null,
    })
  }

  /*
   * «Lento» è relativo agli altri passi dello stesso cliente. Un passo di
   * attesa del cliente sta fermo giorni ed è giusto così; un passo di lavoro
   * che sta fermo il doppio di tutti gli altri è un'altra cosa.
   */
  const ammessi = passi.filter((p) => p.n >= SOGLIE.esecuzioniMinimePerPasso)
  if (ammessi.length >= 2) {
    const mediane = [...ammessi.map((p) => p.medianaOre)].sort((a, b) => a - b)
    const medianaDelleMediane = mediane[Math.floor(mediane.length / 2)] ?? 0
    for (const p of ammessi) {
      if (medianaDelleMediane <= 0) continue
      /*
       * LE DUE CODE DELLA STESSA DISTRIBUZIONE. Un passo molto più lento
       * degli altri è un collo di bottiglia; uno molto più veloce è un passo
       * che nessuno abita — forse una formalità che si potrebbe togliere.
       * Entrambe le domande nascono dallo stesso confronto, e nessuna delle
       * due si può fare in assoluto.
       */
      const lento    = p.medianaOre >= medianaDelleMediane * SOGLIE_ANALISTA.volteLaMediana
      const istante  = p.medianaOre <= medianaDelleMediane / SOGLIE_ANALISTA.volteLaMediana
      if (!lento && !istante) continue
      out.push({
        id: `passo:${p.stepName}`,
        genere: lento ? 'proposal.dailyWorkSlowStep' : 'proposal.dailyWorkInstantStep',
        scope: `step:${p.stepName}`,
        perIlModello: {
          id: `passo:${p.stepName}`,
          kind: 'step',
          step: p.stepName, runs: p.n,
          medianHours: p.medianaOre, p90Hours: p.p90Ore, over48h: p.oltre48h,
          medianOfAllSteps: medianaDelleMediane,
          side: lento ? 'slow' : 'instant',
        },
        params: {
          step: p.stepName,
          median: p.medianaOre.toFixed(1),
          p90: p.p90Ore.toFixed(1),
          count: String(p.n),
        },
        n: p.n,
        windowDays: finestraGiorni,
        action: null,
      })
    }
  }
  return out
}

/**
 * Dal grezzo del modello alle proposte. SCARTA, non corregge.
 *
 * Il modello può sbagliare due cose sole, perché due sole gliene abbiamo
 * lasciate: citare un riferimento che non esiste, e scegliere per quel
 * riferimento un genere che non è il suo.
 */
export function validaProposte(
  grezzo: unknown,
  ctx: { tenantId: string; candidati: readonly Candidato[]; lingua: string },
): { proposte: ProposalToWrite[]; scartate: number; motivi: string[] } {
  const risposta = (grezzo ?? {}) as RispostaModello
  const elenco = Array.isArray(risposta.proposte) ? risposta.proposte : []
  const perId = new Map(ctx.candidati.map((c) => [c.id, c]))

  const proposte: ProposalToWrite[] = []
  const motivi: string[] = []
  const visti = new Set<string>()
  let scartate = 0

  for (const voce of elenco) {
    const scarta = (motivo: string) => { scartate += 1; motivi.push(motivo) }

    if (typeof voce.riferimento !== 'string') { scarta('reference missing'); continue }
    const cand = perId.get(voce.riferimento)
    if (!cand) { scarta('reference not in the aggregates'); continue }
    if (voce.kind !== cand.genere) { scarta('kind does not match the aggregate'); continue }
    const rationale = typeof voce.rationale === 'string' ? voce.rationale.trim() : ''
    if (rationale === '') { scarta('empty rationale'); continue }
    if (visti.has(cand.id)) { scarta('reference already used in this run'); continue }
    if (proposte.length >= SOGLIE_ANALISTA.proposteMassime) { scarta('over the per-run cap'); continue }
    visti.add(cand.id)

    proposte.push({
      tenantId: ctx.tenantId,
      area:  'daily_work',
      kind:  cand.genere,
      params: cand.params,
      scope: cand.scope,
      evidence: {
        n: cand.n,
        windowDays: cand.windowDays,
        // Le prove sono aggregati, non entità: chi vuole le righe apre la
        // pagina del lavoro quotidiano, che le mostra tutte con le soglie.
        refs: [],
        extra: { aggregate: cand.id },
      },
      action: cand.action,
      rationale: tagliaAllaParola(rationale, SOGLIE_ANALISTA.rationaleMassimo),
      rationaleLanguage: ctx.lingua,
    })
  }
  return { proposte, scartate, motivi }
}

/**
 * L'analista. Stessa firma degli altri, così `analizzaCliente` non deve sapere
 * che dentro c'è un modello. Non alza mai per una ragione di configurazione.
 */
export async function analizzaLavoroQuotidiano(tenantId: string): Promise<ProposalToWrite[]> {
  if (!(await aiFeatureEnabled(tenantId, FUNZIONE))) return []
  if (!config.anthropicApiKey) {
    log.warn({ tenantId }, 'daily-work-analyst: no model configured on this platform')
    return []
  }

  const finestra = 30
  const [coppie, passi, azioni] = await Promise.all([
    coppieRipetute(tenantId, finestra),
    tempiNeiPassi(tenantId, finestra),
    azioniUmane(tenantId, finestra),
  ])

  const candidati = candidatiDa(coppie, passi, finestra)
  if (candidati.length < SOGLIE_ANALISTA.aggregatiMinimi) {
    /*
     * Sotto soglia NON si gira, e lo si dice. È il comportamento normale su un
     * cliente che ha appena cominciato: chiamare un modello su due righe di
     * aggregato costa gettoni per farsi dire qualcosa che non si può sapere.
     */
    log.info({ tenantId, candidati: candidati.length, soglia: SOGLIE_ANALISTA.aggregatiMinimi },
      'daily-work-analyst: not enough aggregates, the model was not called')
    return []
  }

  const [lingua, linguaModello] = await Promise.all([languageFor(tenantId), modelLanguageFor(tenantId)])

  const inizio = Date.now()
  let risposta: Anthropic.Message
  try {
    risposta = await getAnthropic().messages.create({
      model: config.anthropicModel,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: SCHEMA_RISPOSTA } },
      system: [
        { type: 'text', text: SYSTEM_PROMPT },
        { type: 'text', text: `Write the rationale in ${linguaModello}.` },
        { type: 'text', text: rigaDelGlossario() },
      ],
      messages: [messaggioConDatiNonFidati({
        istruzione:
          'Below are the aggregates of this team\'s work over the last '
          + `${String(finestra)} days. Return at most ${String(SOGLIE_ANALISTA.proposteMassime)} findings, `
          + 'as JSON matching the required schema. Each finding must cite the id of one aggregate row.',
        provenienza: 'aggregated counts from this organization\'s audit log (no ticket text)',
        dati: {
          candidates: candidati.map((c) => c.perIlModello),
          // Le azioni umane servono al modello per capire COM'È fatto il lavoro
          // di questa squadra, ma non sono candidati: non può proporne una.
          contextOnlyActionCounts: azioni.slice(0, 25),
        },
      })],
    } as Anthropic.MessageCreateParamsNonStreaming)
  } catch (err) {
    registraChiamataFallita(FUNZIONE, err)
    log.error({ tenantId, err: err instanceof Error ? err.message : String(err) },
      'daily-work-analyst: model call failed')
    return []
  }
  registraDurata(FUNZIONE, Date.now() - inizio)
  await registraCosto(tenantId, FUNZIONE, risposta)

  const grezzo = leggiJSONDalModello(risposta, FUNZIONE, {
    troncata: 'errors.ai.truncated', illeggibile: 'errors.ai.unreadable',
  })
  const { proposte, scartate, motivi } = validaProposte(grezzo, { tenantId, candidati, lingua })
  registraScarti(FUNZIONE, scartate)
  if (scartate > 0) log.warn({ tenantId, scartate, motivi }, 'daily-work-analyst: entries dropped by validation')
  log.info({ tenantId, proposte: proposte.length, scartate, candidati: candidati.length },
    'daily-work-analyst: analysis complete')
  return proposte
}
