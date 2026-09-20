/**
 * L'ANALISTA DELLA CONFIGURAZIONE (20 set 2026, ondata 6 — l'ultima).
 *
 * L'area C del programma, quella in cui il modello serviva davvero. Le altre
 * due famiglie dell'area C sono deterministiche e stanno già in
 * `proposalAnalysts.ts` dall'ondata 1: qui c'è l'unica cosa che il codice non
 * sa fare da solo — **scrivere l'etichetta di un valore nell'altra lingua**.
 *
 * `tipo_accesso_applicativo` con i valori `lettura, scrittura,
 * amministratore` va mostrato in inglese a chi ha scelto l'inglese, e nessun
 * algoritmo lo ricava: `titleCase('lettura')` dà «Lettura», che in inglese
 * non vuol dire niente.
 *
 * ## La differenza con gli altri due analisti
 * Platform e daily-work producono LETTURE: numeri e prove, e chi accetta
 * apre un lavoro. Questo produce una SCRITTURA, e il testo lo scrive il
 * modello. È il punto più invasivo del programma, e per questo:
 *
 *  - il segnale è deterministico (quali valori non hanno etichetta lo sa il
 *    codice, non il modello): il modello scrive solo il TESTO;
 *  - l'azione non sovrascrive mai un'etichetta scritta da una persona, e
 *    rilegge lo stato al momento dell'esecuzione
 *    (`lib/configurationAssistActions.ts`);
 *  - si disfa per intero.
 *
 * Vale la pena dire anche che cosa NON fa: non tocca i vocabolari SPEDITI col
 * prodotto. Quelli hanno le etichette dalla migrazione `20260920_1700`, e le
 * loro traduzioni sono una decisione nostra, non di un modello che gira di
 * notte dentro un cliente.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { getSession } from '@opengraphity/neo4j'
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
import { LINGUE, parseValueLabels, vocabularyCarriesLabels, type Lingua } from './enumValueLabels.js'
import { etichetteMancanti, soloIBuchi, MAX_ETICHETTA } from './configurationAssistActions.js'
import type { ProposalToWrite } from './proposals.js'

const log = logger.child({ module: 'configuration-analyst' })

export const FUNZIONE = 'configurationAssist' as const

export const GENERI = ['proposal.configMissingLabels'] as const

export const SOGLIE_ANALISTA = {
  /** Quanti vocabolari si mandano al massimo in una corsa. */
  vocabolariMassimi: 8,
  /** Quante proposte si accettano da una corsa. Il tetto vero resta in `proposals.ts`. */
  proposteMassime: 2,
  rationaleMassimo: 700,
} as const

const SYSTEM_PROMPT = `You write the display labels of the values of a dictionary, in every language listed.

A value is a technical key chosen by the people who configured this ITSM product
("lettura", "rolled_back", "in_attesa"): you turn it into the short label a person
should see, in each requested language.

Rules:
- A label is a NOUN PHRASE of one to three words, capitalised as a UI label.
  It is not a sentence and it never ends with a full stop.
- Translate the MEANING, not the letters: "lettura" is "Read" in English, not "Reading".
- If a value is a product or standard term that people use untranslated, keep it
  as it is in every language.
- If you cannot tell what a value means, leave it out. A wrong label is worse than
  a missing one: a missing one is visibly missing, a wrong one looks correct.`

interface RispostaModello {
  vocabolari?: { vocabulary?: unknown; labels?: unknown; rationale?: unknown }[]
}

const SCHEMA_RISPOSTA = {
  type: 'object',
  properties: {
    vocabolari: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          vocabulary: { type: 'string' },
          rationale:  { type: 'string' },
          labels: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                value: { type: 'string' },
                ...Object.fromEntries(LINGUE.map((l) => [l, { type: 'string' }])),
              },
              required: ['value'],
              additionalProperties: false,
            },
          },
        },
        required: ['vocabulary', 'labels', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['vocabolari'],
  additionalProperties: false,
} as const

export interface Candidato {
  vocabulary: string
  values:     string[]
  /** valore → lingue scoperte. Lo sa il codice, non il modello. */
  mancanti:   Record<string, Lingua[]>
}

/**
 * I vocabolari DEL CLIENTE con etichette mancanti.
 *
 * Solo i suoi: quelli spediti col prodotto (`tenant_id: 'system'`) non si
 * toccano. E solo quelli che le etichette le PORTANO — `vocabularyCarriesLabels`
 * sa quali no (vedi `VOCABULARIES_WITHOUT_LABELS`), e proporre etichette per
 * un vocabolario che non le usa sarebbe rumore.
 */
export async function candidati(tenantId: string): Promise<Candidato[]> {
  const session = getSession()
  try {
    const r = await session.run(`
      MATCH (e:EnumTypeDefinition {tenant_id: $tenantId})
      RETURN e.name AS name, e.values AS values, e.value_labels AS raw
      ORDER BY e.name
    `, { tenantId })
    const out: Candidato[] = []
    for (const rec of r.records) {
      const name = rec.get('name') as string
      if (!vocabularyCarriesLabels(name)) continue
      const values = (rec.get('values') as string[] | null) ?? []
      if (values.length === 0) continue
      const { labels, error } = parseValueLabels(rec.get('raw'))
      // Un documento illeggibile non si propone di completare: si ripara a mano.
      if (error) continue
      const mancanti = etichetteMancanti(values, labels)
      if (Object.keys(mancanti).length === 0) continue
      out.push({ vocabulary: name, values, mancanti })
    }
    return out.slice(0, SOGLIE_ANALISTA.vocabolariMassimi)
  } finally {
    await session.close()
  }
}

/**
 * Dal grezzo del modello alle proposte. SCARTA, non corregge.
 *
 * Le etichette passano da `soloIBuchi`, cioè dalla stessa funzione che
 * l'azione riapplicherà al momento dell'esecuzione: se una proposta chiede di
 * riscrivere qualcosa che c'è già, viene scartata qui e non arriverebbe
 * comunque a scrivere.
 */
export function validaProposte(
  grezzo: unknown,
  ctx: { tenantId: string; candidati: readonly Candidato[]; lingua: string },
): { proposte: ProposalToWrite[]; scartate: number; motivi: string[] } {
  const risposta = (grezzo ?? {}) as RispostaModello
  const elenco = Array.isArray(risposta.vocabolari) ? risposta.vocabolari : []
  const perNome = new Map(ctx.candidati.map((c) => [c.vocabulary, c]))

  const proposte: ProposalToWrite[] = []
  const motivi: string[] = []
  const visti = new Set<string>()
  let scartate = 0

  for (const voce of elenco) {
    const scarta = (m: string) => { scartate += 1; motivi.push(m) }
    if (typeof voce.vocabulary !== 'string') { scarta('dictionary missing'); continue }
    const cand = perNome.get(voce.vocabulary)
    if (!cand) { scarta('dictionary not among the candidates'); continue }
    if (visti.has(cand.vocabulary)) { scarta('dictionary already used in this run'); continue }
    if (proposte.length >= SOGLIE_ANALISTA.proposteMassime) { scarta('over the per-run cap'); continue }

    const righe = Array.isArray(voce.labels) ? voce.labels as Record<string, unknown>[] : []
    /* Dalla lista di righe alla mappa valore → lingua → testo. */
    const grezze: Record<string, Partial<Record<Lingua, string>>> = {}
    for (const riga of righe) {
      const valore = typeof riga['value'] === 'string' ? riga['value'] : null
      if (valore === null) continue
      const perLingua: Partial<Record<Lingua, string>> = {}
      for (const l of LINGUE) if (typeof riga[l] === 'string') perLingua[l] = riga[l]
      if (Object.keys(perLingua).length > 0) grezze[valore] = perLingua
    }

    const { tenute, scartate: fuori } = soloIBuchi(grezze, cand.mancanti)
    for (const f of fuori) motivi.push(`${cand.vocabulary} → ${f}`)
    scartate += fuori.length
    const quante = Object.values(tenute).reduce((n, v) => n + Object.keys(v).length, 0)
    if (quante === 0) { scarta(`${cand.vocabulary}: nothing left to fill`); continue }

    const rationale = typeof voce.rationale === 'string' ? voce.rationale.trim() : ''
    if (rationale === '') { scarta('empty rationale'); continue }
    visti.add(cand.vocabulary)

    proposte.push({
      tenantId: ctx.tenantId,
      area:  'configuration',
      kind:  'proposal.configMissingLabels',
      params: {
        vocabulary: cand.vocabulary,
        count:      String(quante),
        values:     Object.keys(tenute).join(', '),
      },
      /* Il soggetto è il vocabolario: se domani ne mancano altre, è la stessa proposta. */
      scope: `labels:${cand.vocabulary}`,
      evidence: {
        n: quante,
        windowDays: 0,
        refs: [],
        extra: { vocabulary: cand.vocabulary, missing: Object.keys(cand.mancanti).length },
      },
      action: { type: 'enum_value_labels.fill', params: { vocabulary: cand.vocabulary, labels: tenute } },
      rationale: tagliaAllaParola(rationale, SOGLIE_ANALISTA.rationaleMassimo),
      rationaleLanguage: ctx.lingua,
    })
  }
  return { proposte, scartate, motivi }
}

export async function analizzaConfigurazioneConIlModello(tenantId: string): Promise<ProposalToWrite[]> {
  if (!(await aiFeatureEnabled(tenantId, FUNZIONE))) return []
  if (!config.anthropicApiKey) {
    log.warn({ tenantId }, 'configuration-analyst: no model configured on this platform')
    return []
  }

  const cands = await candidati(tenantId)
  if (cands.length === 0) {
    log.info({ tenantId }, 'configuration-analyst: every dictionary of this tenant has its labels')
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
        { type: 'text', text: `Write the rationale in ${linguaModello}. The labels go in every language listed for each value.` },
        { type: 'text', text: rigaDelGlossario() },
      ],
      messages: [messaggioConDatiNonFidati({
        istruzione:
          'Below are the dictionaries of one organization whose values have no display label yet. '
          + `For each, write the missing labels. Labels are at most ${String(MAX_ETICHETTA)} characters. `
          + `Return at most ${String(SOGLIE_ANALISTA.proposteMassime)} dictionaries, as JSON matching the schema.`,
        provenienza: 'dictionary names and values configured by this organization',
        dati: cands.map((c) => ({
          vocabulary: c.vocabulary,
          /* Solo i buchi: il modello non deve nemmeno vedere le etichette già scritte. */
          missing: Object.entries(c.mancanti).map(([value, lingue]) => ({ value, languages: lingue })),
        })),
      })],
    } as Anthropic.MessageCreateParamsNonStreaming)
  } catch (err) {
    registraChiamataFallita(FUNZIONE, err)
    log.error({ tenantId, err: err instanceof Error ? err.message : String(err) }, 'configuration-analyst: model call failed')
    return []
  }
  registraDurata(FUNZIONE, Date.now() - inizio)
  await registraCosto(tenantId, FUNZIONE, risposta)

  const grezzo = leggiJSONDalModello(risposta, FUNZIONE, {
    troncata: 'errors.ai.truncated', illeggibile: 'errors.ai.unreadable',
  })
  const { proposte, scartate, motivi } = validaProposte(grezzo, { tenantId, candidati: cands, lingua })
  registraScarti(FUNZIONE, scartate)
  if (scartate > 0) log.warn({ tenantId, scartate, motivi }, 'configuration-analyst: entries dropped by validation')
  log.info({ tenantId, proposte: proposte.length, scartate, candidati: cands.length }, 'configuration-analyst: analysis complete')
  return proposte
}
