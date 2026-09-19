/**
 * «DESCRIVIMI LA SERVICE REQUEST E TE LA DISEGNO» (19 set 2026).
 *
 * Chi configura scrive in parole quello che la richiesta deve chiedere
 * («richiesta di un nuovo portatile: modello, ambiente, il dispositivo da
 * sostituire dalla CMDB, centro di costo, preventivo in PDF») e riceve una
 * PROPOSTA: sezioni, campi, obbligatorietà, condizioni di visibilità, e
 * l'intestazione della voce. La proposta **non scrive niente**: atterra sulla
 * tela del designer come bozza, e si applica accettandola.
 *
 * ## Il modello scegli DENTRO il catalogo del cliente
 * Prima della chiamata leggo il catalogo vero — i campi già in libreria coi
 * loro tipi, i vocabolari del Dizionario coi loro valori, i tipi di CI, le
 * categorie, le priorità, i workflow delle service request — e lo passo al
 * modello. Non è gentilezza: un campo «Ambiente» inventato quando in libreria
 * ce n'è già uno vuol dire due colonne per la stessa domanda in ogni report,
 * e una tendina che cita un vocabolario inesistente è un campo che non offre
 * niente. Il modello compone, non inventa il vocabolario del cliente.
 *
 * ## E quello che risponde passa comunque dal filtro
 * `lib/formDesignProposal.ts` valida la risposta con le stesse regole che
 * valgono per una mano umana, e quello che cade lo DICE. Le due metà stanno
 * separate perché il filtro deve essere provabile senza rete: i casi (tipo
 * sconosciuto, vocabolario assente, formula su un campo che non si calcola,
 * condizione su un campo scartato) sono test, non aneddoti.
 *
 * ## Cosa resta fuori, dichiarato
 *  - la TABELLA ripetibile: è un documento a parte (le colonne), e mezza
 *    tabella è un campo che il renderer non sa disegnare;
 *  - i workflow NUOVI: l'AI scegli fra quelli che esistono, non ne disegna;
 *  - qualunque SCRITTURA: la proposta è una proposta.
 */
import Anthropic from '@anthropic-ai/sdk'
import { GraphQLError } from 'graphql'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { CATALOG_FORM_VERSION, type CatalogFormDefinition } from '@opengraphity/types'
import { config } from '../lib/config.js'
import { logger } from '../lib/logger.js'
import { assertAIFeature } from '../lib/aiSettings.js'
import { catalogFormLimits } from '../lib/catalogFormLimits.js'
import { formFields, parseCatalogForm } from '../lib/catalogForm.js'
import { getScriptingPlan } from '../lib/scriptingPlan.js'
import { loadVocabularyEntries } from '../lib/vocabularyEntries.js'
import { SYSTEM_TENANT } from '../lib/enumScope.js'
import { modelLanguageFor } from '../lib/systemText.js'
import { TIPI_PROPONIBILI, validaProposta, type CatalogoPerProposta, type PropostaValidata } from '../lib/formDesignProposal.js'

const log = logger.child({ module: 'form-designer' })

/** Quanto testo accetto: una descrizione, non un capitolato. */
export const MAX_PROMPT_CHARS = 4000

export interface RichiestaDiProgetto {
  readonly tenantId: string
  /** La frase di chi configura. */
  readonly prompt: string
  /** La voce di catalogo a cui AGGIUNGERE campi; assente = una service request nuova. */
  readonly itemId: string | null
  /** Chi chiede può creare campi e vocabolari nuovi (`config.metamodel`)? */
  readonly consentiNuovi: boolean
}

// ── Il catalogo del cliente ─────────────────────────────────────────────────

interface Catalogo extends CatalogoPerProposta {
  /** Il modulo esistente, quando si aggiunge a una voce. */
  readonly moduloEsistente: CatalogFormDefinition | null
  readonly nomeVoce: string | null
}

async function leggiCatalogo(req: RichiestaDiProgetto): Promise<Catalogo> {
  const session = getSession(undefined, 'READ')
  try {
    /*
     * UNA SESSIONE, LETTURE IN FILA — non `Promise.all`.
     *
     * Trovato provandolo: `formFields` e `catalogFormLimits` aprono una
     * TRANSAZIONE su questa sessione, e una sessione Neo4j con una
     * transazione aperta rifiuta ogni altra query («Queries cannot be run
     * directly on a session with an open transaction»). In parallelo si
     * pestano i piedi, ed è lo stesso inciampo che aveva già fermato le
     * business rule. Sono sei letture piccole prima di una chiamata a un
     * modello: metterle in fila non costa niente di misurabile.
     */
    const campi = await formFields(session, req.tenantId)
    const limiti = await catalogFormLimits(session, req.tenantId)
    const scripting = await getScriptingPlan(req.tenantId)
    // `tenant-ok`: i tipi `base` sono spediti col prodotto, gli altri del cliente.
    const tipiCI = await runQuery<{ name: string }>(session, `
      MATCH (t:CITypeDefinition)
      WHERE (t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId))
        AND coalesce(t.active, true) = true
      RETURN DISTINCT t.name AS name ORDER BY name`, { tenantId: req.tenantId })
    const workflows = await runQuery<{ id: string; name: string }>(session, `
      MATCH (d:WorkflowDefinition {tenant_id: $tenantId, entity_type: 'service_request'})
      WHERE coalesce(d.active, true) = true
      RETURN d.id AS id, d.name AS name ORDER BY name`, { tenantId: req.tenantId })
    // I vocabolari che questo cliente vede: i suoi più quelli spediti, e il
    // suo vince a parità di nome (è la regola di lettura del Dizionario).
    const vocabolari = await runQuery<{ name: string; values: unknown; owner: string }>(session, `
      MATCH (e:EnumTypeDefinition)
      WHERE e.tenant_id IN [$tenantId, $systemTenant]
      RETURN e.name AS name, e.values AS values, e.tenant_id AS owner`,
    { tenantId: req.tenantId, systemTenant: SYSTEM_TENANT })

    const perNome = new Map<string, readonly string[]>()
    for (const riga of vocabolari) {
      const valori = Array.isArray(riga.values) ? (riga.values as string[]) : []
      // Il proprio scavalca lo spedito; lo spedito non scavalca il proprio.
      if (riga.owner === req.tenantId || !perNome.has(riga.name)) perNome.set(riga.name, valori)
    }

    let moduloEsistente: CatalogFormDefinition | null = null
    let nomeVoce: string | null = null
    if (req.itemId !== null) {
      const righe = await runQuery<{ name: string; form: unknown }>(session,
        'MATCH (i:ServiceCatalogItem {tenant_id: $tenantId, id: $itemId}) RETURN i.name AS name, i.form AS form',
        { tenantId: req.tenantId, itemId: req.itemId })
      const riga = righe[0]
      if (!riga) {
        throw new GraphQLError(`Service catalog item ${req.itemId} not found`, {
          extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.notFound', params: { what: 'ServiceCatalogItem' } } },
        })
      }
      nomeVoce = String(riga.name)
      moduloEsistente = parseCatalogForm(riga.form, `ServiceCatalogItem ${nomeVoce}`)
    }

    const citati = (moduloEsistente?.sections ?? []).flatMap((s) => s.items.map((i) => i.field))

    return {
      campiLibreria: new Map(campi.map((c) => [c.name, { fieldType: c.fieldType, label: c.label }])),
      vocabolari: perNome,
      tipiCI: new Set(tipiCI.map((t) => t.name)),
      categorie: await valoriDi(req.tenantId, 'category'),
      priorita: await valoriDi(req.tenantId, 'priority'),
      workflowPerNome: new Map(workflows.map((w) => [w.name.toLowerCase(), { id: w.id, name: w.name }])),
      scriptingAcceso: scripting.enabled,
      consentiNuovi: req.consentiNuovi,
      maxCampiPerModulo: limiti.maxFieldsPerForm,
      campiGiaNelModulo: citati,
      moduloEsistente,
      nomeVoce,
    }
  } finally {
    await session.close()
  }
}

/**
 * I valori di un vocabolario del cliente. Un vocabolario che non esiste non è
 * un errore qui: vuol dire che quella parte della proposta non si può fare, e
 * il filtro scarta la categoria o la priorità che il modello avesse azzardato.
 */
async function valoriDi(tenantId: string, nome: string): Promise<readonly string[]> {
  try {
    return (await loadVocabularyEntries(tenantId, nome)).values
  } catch (err) {
    log.warn({ err, vocabulary: nome }, '[form-designer] vocabulary unavailable: that part of the proposal is off the table')
    return []
  }
}

// ── La chiamata al modello ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sei il progettista dei moduli di OpenGrafo, una piattaforma ITSM. Ricevi la descrizione a parole di una SERVICE REQUEST e il catalogo REALE del cliente (i campi già in libreria, i vocabolari del Dizionario con i loro valori, i tipi di CI, le categorie, le priorità, i workflow disponibili). Restituisci il progetto del modulo.

Regole, in ordine di importanza:
1. RIUSA i campi della libreria quando la domanda è la stessa: indica il nome del campo in "riuso" e non inventarne uno nuovo. Due campi per la stessa domanda diventano due colonne diverse nei report del cliente.
2. NON INVENTARE niente che non sia nel catalogo: un vocabolario, un tipo di CI, una categoria, una priorità o un workflow che non ti ho passato non esiste. Se serve un elenco di scelte che non c'è, proponilo in "vocabolari_nuovi" con i suoi valori.
3. Il tipo di campo si scegli fra quelli ammessi. Una scelta ("enum"/"multi_enum") ha SEMPRE un vocabolario. Un riferimento alla CMDB ("ref_ci") può restringere i tipi di CI. Un allegato per un documento, una nota per le istruzioni senza risposta.
4. Chiedi solo quello che serve: pochi campi giusti, non un questionario. Obbligatori solo quelli senza cui la richiesta non si può lavorare.
5. Le sezioni raggruppano per argomento e hanno un titolo breve in italiano e inglese. Due colonne per gruppi di campi corti, una per i testi lunghi.
6. Le condizioni di visibilità ("visibile_quando") guardano un ALTRO campo dello stesso modulo, e solo campi a valore semplice (non allegati, non riferimenti).
7. Gli script (formula, script_validazione) sono JavaScript e vanno proposti solo se servono davvero: una formula riceve "input" con le risposte degli altri campi e RESTITUISCE il valore; uno script di validazione riceve "value" e lancia un errore se il valore non va. Niente require, import, eval, process, cicli infiniti.
8. In "perche" scrivi, per ogni campo e per la voce, il pezzo della descrizione dell'utente da cui nasce: una riga, concreta. Chi legge deve poter verificare la proposta senza fidarsi.
9. In "note" metti quello che non hai potuto fare e perché.

Non puoi progettare tabelle ripetibili, né creare workflow nuovi.`

function schemaProposta(tipi: readonly string[]) {
  const condizione = {
    type: ['object', 'null'],
    properties: {
      match: { type: 'string', enum: ['all', 'any'] },
      rules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            op:    { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'filled', 'empty'] },
            value: { type: ['string', 'null'] },
          },
          required: ['field', 'op', 'value'],
          additionalProperties: false,
        },
      },
    },
    required: ['match', 'rules'],
    additionalProperties: false,
  } as const

  const campo = {
    type: 'object',
    properties: {
      riuso:                     { type: ['string', 'null'], description: 'Nome di un campo della libreria da riusare; null per un campo nuovo.' },
      tipo:                      { type: 'string', enum: [...tipi] },
      etichetta_it:              { type: 'string' },
      etichetta_en:              { type: 'string' },
      aiuto_it:                  { type: ['string', 'null'] },
      aiuto_en:                  { type: ['string', 'null'] },
      vocabolario:               { type: ['string', 'null'], description: 'Nome del vocabolario, per una scelta.' },
      tipi_ci:                   { type: 'array', items: { type: 'string' }, description: 'Tipi di CI ammessi, per ref_ci; vuoto = tutta la CMDB.' },
      formula:                   { type: ['string', 'null'] },
      script_validazione:        { type: ['string', 'null'] },
      obbligatorio:              { type: 'boolean' },
      larghezza:                 { type: 'string', enum: ['full', 'half'] },
      visibile_nella_richiesta:  { type: 'boolean', description: 'Falso = campo interno, chi apre la richiesta non lo vede.' },
      solo_lettura:              { type: 'boolean' },
      visibile_quando:           condizione,
      perche:                    { type: 'string' },
    },
    required: [
      'riuso', 'tipo', 'etichetta_it', 'etichetta_en', 'aiuto_it', 'aiuto_en', 'vocabolario', 'tipi_ci',
      'formula', 'script_validazione', 'obbligatorio', 'larghezza', 'visibile_nella_richiesta', 'solo_lettura',
      'visibile_quando', 'perche',
    ],
    additionalProperties: false,
  } as const

  return {
    type: 'object',
    properties: {
      voce: {
        type: ['object', 'null'],
        description: 'L\'intestazione della service request; null se si stanno solo aggiungendo campi a una voce esistente.',
        properties: {
          nome:                   { type: 'string' },
          descrizione:            { type: ['string', 'null'] },
          categoria:              { type: ['string', 'null'] },
          priorita:               { type: ['string', 'null'] },
          richiede_approvazione:  { type: 'boolean' },
          workflow:               { type: ['string', 'null'], description: 'Nome di un workflow esistente.' },
          perche:                 { type: 'string' },
        },
        required: ['nome', 'descrizione', 'categoria', 'priorita', 'richiede_approvazione', 'workflow', 'perche'],
        additionalProperties: false,
      },
      vocabolari_nuovi: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nome:      { type: 'string', description: 'minuscolo, lettere cifre e _' },
            etichetta: { type: 'string' },
            valori:    { type: 'array', items: { type: 'string' } },
            perche:    { type: 'string' },
          },
          required: ['nome', 'etichetta', 'valori', 'perche'],
          additionalProperties: false,
        },
      },
      sezioni: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            titolo_it: { type: 'string' },
            titolo_en: { type: 'string' },
            colonne:   { type: 'integer', enum: [1, 2] },
            campi:     { type: 'array', items: campo },
          },
          required: ['titolo_it', 'titolo_en', 'colonne', 'campi'],
          additionalProperties: false,
        },
      },
      note: { type: 'array', items: { type: 'string' } },
    },
    required: ['voce', 'vocabolari_nuovi', 'sezioni', 'note'],
    additionalProperties: false,
  } as const
}

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!config.anthropicApiKey) {
    throw new GraphQLError('AI form designer not configured: ANTHROPIC_API_KEY missing', {
      extensions: { code: 'FAILED_PRECONDITION', i18n: { key: 'errors.ai.notConfigured' } },
    })
  }
  _client ??= new Anthropic()
  return _client
}

export interface EsitoProposta extends PropostaValidata {
  /** La frase da cui è nata: torna indietro perché si rilegga accanto al risultato. */
  readonly prompt: string
  /** Quanti campi il modulo poteva ancora accogliere: per spiegare un troncamento. */
  readonly maxFieldsPerForm: number
}

export async function proponiModulo(req: RichiestaDiProgetto): Promise<EsitoProposta> {
  await assertAIFeature(req.tenantId, 'formDesigner')

  const prompt = req.prompt.trim()
  if (prompt === '') {
    throw new GraphQLError('Empty description: nothing to design', {
      extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.formDesigner.emptyPrompt' } },
    })
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new GraphQLError(`The description is too long (max ${String(MAX_PROMPT_CHARS)} characters)`, {
      extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.formDesigner.promptTooLong', params: { max: MAX_PROMPT_CHARS } } },
    })
  }

  const catalogo = await leggiCatalogo(req)

  // Quello che il modello vede del cliente. I campi della libreria arrivano
  // TUTTI (anche i non condivisi): qui non si sta offrendo il riuso a un altro
  // modulo, si sta evitando di creare un doppione di qualcosa che esiste.
  const contesto = {
    richiesta: prompt,
    sto_aggiungendo_a: catalogo.nomeVoce,
    modulo_esistente: catalogo.moduloEsistente === null ? null : {
      campi_gia_presenti: catalogo.campiGiaNelModulo,
      sezioni: catalogo.moduloEsistente.sections.map((s) => ({ titolo: s.title, campi: s.items.map((i) => i.field) })),
    },
    campi_in_libreria: [...catalogo.campiLibreria.entries()].map(([nome, d]) => ({ nome, tipo: d.fieldType, etichetta: d.label })),
    vocabolari: [...catalogo.vocabolari.entries()].map(([nome, valori]) => ({ nome, valori })),
    tipi_di_ci: [...catalogo.tipiCI],
    categorie: catalogo.categorie,
    priorita: catalogo.priorita,
    workflow_disponibili: [...catalogo.workflowPerNome.values()].map((w) => w.name),
    posso_creare_campi_e_vocabolari_nuovi: catalogo.consentiNuovi,
    script_del_cliente_accesi: catalogo.scriptingAcceso,
    campi_ancora_disponibili: Math.max(0, catalogo.maxCampiPerModulo - catalogo.campiGiaNelModulo.length),
  }

  const client = getClient()
  const t0 = Date.now()
  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: schemaProposta(TIPI_PROPONIBILI) },
    },
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      // Etichette, aiuti e spiegazioni le legge chi configura: nella sua lingua.
      { type: 'text', text: `Write labels, help texts, section titles and the "perche" explanations in ${await modelLanguageFor(req.tenantId)}, and always fill both etichetta_it and etichetta_en.` },
    ],
    messages: [{ role: 'user', content: JSON.stringify(contesto, null, 1) }],
  })

  if (response.stop_reason === 'refusal') {
    throw new GraphQLError('The model refused the design request', {
      extensions: { code: 'INTERNAL_SERVER_ERROR', i18n: { key: 'errors.ai.modelRefused' } },
    })
  }
  const blocco = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
  if (!blocco) throw new Error('[form-designer] response without a text block')

  let grezza: unknown
  try { grezza = JSON.parse(blocco.text) }
  catch (err) {
    throw new GraphQLError(`The model answer is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      extensions: { code: 'INTERNAL_SERVER_ERROR', i18n: { key: 'errors.formDesigner.badAnswer' } },
    })
  }

  const proposta = validaProposta(grezza, catalogo)
  log.info({
    ms: Date.now() - t0,
    sezioni: proposta.sezioni.length,
    campiNuovi: proposta.campiNuovi.length,
    vocabolariNuovi: proposta.vocabolariNuovi.length,
    scartati: proposta.scartati.length,
    itemId: req.itemId,
  }, '[form-designer] proposal generated')

  return { ...proposta, prompt, maxFieldsPerForm: catalogo.maxCampiPerModulo }
}

/**
 * La proposta come DEFINIZIONE di modulo, pronta per la tela.
 *
 * La `revision` resta quella del modulo esistente (o 0): la proposta non
 * pubblica niente, e far salire la revisione qui vorrebbe dire dire ai ticket
 * già compilati che il modulo è cambiato quando non è ancora successo.
 */
export function propostaComeDefinizione(
  proposta: PropostaValidata, esistente: CatalogFormDefinition | null,
): CatalogFormDefinition {
  const sezioniNuove = proposta.sezioni.map((s) => ({
    id: s.id,
    title: { it: s.titleIt, en: s.titleEn },
    columns: s.columns,
    items: s.items.map((i) => ({
      field: i.field,
      required: i.required,
      width: i.width,
      endUser: i.endUser,
      readOnly: i.readOnly,
      ...(i.visibleWhen === null ? {} : { visibleWhen: JSON.parse(i.visibleWhen) as CatalogFormDefinition['sections'][number]['items'][number]['visibleWhen'] }),
    })),
  }))
  return {
    version: CATALOG_FORM_VERSION,
    revision: esistente?.revision ?? 0,
    sections: [...(esistente?.sections ?? []), ...sezioniNuove],
  }
}
