/**
 * LA PROPOSTA DELL'AI PER UNA SERVICE REQUEST — e il filtro che le sta davanti
 * (19 set 2026).
 *
 * «Io inserisco come vorrei la SR e l'AI mi crea i campi nel designer.» Il
 * modello riceve il catalogo VERO del tenant (tipi di campo, campi già in
 * libreria, vocabolari del Dizionario coi loro valori, tipi di CI, workflow) e
 * restituisce un documento JSON a schema. Questo file è quello che sta fra il
 * documento del modello e la tela: **nessun pezzo arriva al designer se non
 * regge le stesse regole che reggono una mano umana**.
 *
 * ## Perché un filtro e non la fiducia
 * Le validazioni del prodotto stanno sulle mutation: `createFormField` rifiuta
 * un tipo che non esiste, `saveCatalogForm` rifiuta una condizione su un campo
 * che il modulo non cita, `assertFiltroCI` rifiuta un filtro CMDB inutilizzabile.
 * Se lasciassi passare la proposta grezza, l'utente accetterebbe una tela che
 * al salvataggio viene rifiutata a metà — e la metà rifiutata sarebbe quella
 * che non capisce. Meglio scartare PRIMA, e dire cosa si è scartato.
 *
 * ## Niente in silenzio
 * Ogni scarto esce in `scartati` con una chiave i18n: il designer lo mostra
 * accanto alla proposta. Uno scarto silenzioso è la famiglia di difetti
 * peggiore, perché l'interfaccia promette qualcosa che non è avvenuto.
 *
 * ## Le tre cose che il filtro NON delega al modello
 *  1. **Il nome della proprietà** (`nomeDaEtichetta`): è la colonna nei report
 *     e non si cambia più. Lo decide la stessa regola che lo decide quando un
 *     campo nasce trascinando un tipo dalla palette.
 *  2. **Il riuso**: se la domanda esiste già in libreria con lo stesso tipo, si
 *     RIUSA. Un campo nuovo per la stessa domanda vuol dire due colonne nei
 *     report che nessuno saprà sommare — la regola che la migrazione
 *     `20261005_1080` ha già dovuto sistemare a posteriori.
 *  3. **Il tipo di un campo riusato**: è quello della libreria, non quello che
 *     il modello immagina. Il tipo di un campo esistente non si cambia (ci sono
 *     appese le risposte già date).
 *
 * Questo file è PURO: nessuna sessione, nessuna rete. La chiamata al modello e
 * la lettura del catalogo stanno in `services/formDesignerService.ts`, e questa
 * separazione è quella che rende il filtro provabile caso per caso.
 */
import {
  FORM_CONDITION_OPS, FORM_CONDITION_OPS_WITHOUT_VALUE,
  FORM_FIELD_NAME_RE, FORM_FIELD_TYPES, FORM_FIELD_TYPES_AS_PROPERTY, FORM_FIELD_TYPES_WITH_VOCABULARY,
  canBeComputed, canBeConditionSubject, isFormFieldType, nomeDaEtichetta,
  type FormCondition, type FormConditionOp,
} from '@opengraphity/types'
import { validateScript } from '@opengraphity/scripting'

/**
 * I tipi che il modello può proporre: tutti tranne la TABELLA.
 *
 * Una tabella ripetibile non è un campo, è un documento a parte (le colonne,
 * con tipo e vocabolario per ognuna): proporla a metà darebbe un campo che il
 * renderer non sa disegnare. Resta fuori DICHIARATO — la proposta porta una
 * nota che lo dice, invece di far sparire la richiesta senza spiegazioni.
 */
export const TIPI_PROPONIBILI: readonly string[] = FORM_FIELD_TYPES.filter((t) => t !== 'table')

/** Il catalogo vero del tenant: quello che il modello può scegliere, e niente altro. */
export interface CatalogoPerProposta {
  /** I campi già in libreria: nome → tipo ed etichetta. */
  readonly campiLibreria: ReadonlyMap<string, { readonly fieldType: string; readonly label: string }>
  /** I vocabolari del Dizionario: nome → valori. */
  readonly vocabolari: ReadonlyMap<string, readonly string[]>
  /** I tipi di CI su cui un `ref_ci` può pescare. */
  readonly tipiCI: ReadonlySet<string>
  /** I valori del vocabolario `category`. */
  readonly categorie: readonly string[]
  /** I valori del vocabolario `priority`. */
  readonly priorita: readonly string[]
  /** Le definizioni di workflow delle service request: nome minuscolo → id. */
  readonly workflowPerNome: ReadonlyMap<string, { readonly id: string; readonly name: string }>
  /** Gli script del cliente sono accesi? Se no, formule e validazioni non si propongono. */
  readonly scriptingAcceso: boolean
  /**
   * Chi ha chiesto la proposta può creare campi e vocabolari nuovi
   * (`config.metamodel`)? Se no si propone solo il riuso: una proposta che il
   * richiedente non può applicare è una promessa che l'interfaccia non tiene.
   */
  readonly consentiNuovi: boolean
  /** Il tetto di campi per modulo, dalla configurazione del tenant. */
  readonly maxCampiPerModulo: number
  /** I campi già citati dal modulo, quando si AGGIUNGE a uno esistente. */
  readonly campiGiaNelModulo: readonly string[]
}

/** Uno scarto: cosa, e perché — con la chiave i18n che il designer sa rendere. */
export interface ScartoProposta {
  readonly cosa: string
  readonly key: string
  readonly params: Readonly<Record<string, string | number>>
}

export interface VoceProposta {
  readonly name: string
  readonly description: string | null
  readonly category: string | null
  readonly priority: string | null
  readonly requiresApproval: boolean
  readonly workflowDefinitionId: string | null
  readonly workflowDefinitionName: string | null
  readonly why: string
}

export interface VocabolarioProposto {
  readonly name: string
  readonly label: string
  readonly values: readonly string[]
  readonly why: string
}

export interface CampoProposto {
  readonly name: string
  readonly fieldType: string
  readonly labelIt: string
  readonly labelEn: string
  readonly helpIt: string | null
  readonly helpEn: string | null
  readonly vocabulary: string | null
  readonly refTypes: readonly string[]
  readonly formula: string | null
  readonly validationScript: string | null
  readonly why: string
}

export interface VoceDiSezioneProposta {
  readonly field: string
  /** `library` = campo che esisteva già, `new` = campo da creare accettando. */
  readonly source: 'library' | 'new'
  readonly required: boolean
  readonly width: 'full' | 'half'
  readonly endUser: boolean
  readonly readOnly: boolean
  /** La condizione di visibilità come JSON, o `null` se il campo si vede sempre. */
  readonly visibleWhen: string | null
  readonly why: string
}

export interface SezioneProposta {
  readonly id: string
  readonly titleIt: string
  readonly titleEn: string
  readonly columns: 1 | 2
  readonly items: readonly VoceDiSezioneProposta[]
}

export interface PropostaValidata {
  readonly voce: VoceProposta | null
  readonly vocabolariNuovi: readonly VocabolarioProposto[]
  readonly campiNuovi: readonly CampoProposto[]
  readonly sezioni: readonly SezioneProposta[]
  readonly scartati: readonly ScartoProposta[]
  readonly note: readonly string[]
}

// ── Lettura difensiva del documento del modello ─────────────────────────────
//
// Lo schema JSON obbliga la FORMA, non il contenuto: `tipo` è una stringa fra
// quelle elencate, ma niente impedisce al modello di scrivere un vocabolario
// che non esiste. Quindi si legge come si legge un input esterno.

function testo(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}
function booleano(raw: unknown, difetto: boolean): boolean {
  return typeof raw === 'boolean' ? raw : difetto
}
function lista(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : []
}
function oggetto(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

/** Etichette confrontabili: «Centro di costo» e «centro  di  costo» sono la stessa domanda. */
function chiaveEtichetta(etichetta: string): string {
  return etichetta.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * VALIDA LA PROPOSTA GREZZA contro il catalogo del tenant.
 *
 * Non lancia: una proposta sbagliata a metà resta utile per l'altra metà, e
 * quello che cade cade in `scartati`. L'unico caso senza ritorno è un documento
 * che non contiene nemmeno una sezione con un campo valido, e lo riconosce il
 * chiamante guardando `sezioni`.
 */
export function validaProposta(grezza: unknown, catalogo: CatalogoPerProposta): PropostaValidata {
  const doc = oggetto(grezza)
  const scartati: ScartoProposta[] = []
  const note: string[] = [...lista(doc['note']).map((n) => testo(n)).filter((n) => n !== '')]

  // ── I vocabolari nuovi ────────────────────────────────────────────────────
  //
  // Vengono per primi perché un campo a scelta li cita: un vocabolario
  // scartato porta con sé i campi che lo usavano.
  const vocabolariNuovi: VocabolarioProposto[] = []
  const vocabolariDisponibili = new Map<string, readonly string[]>(catalogo.vocabolari)
  for (const raw of lista(doc['vocabolari_nuovi'])) {
    const v = oggetto(raw)
    const nome = testo(v['nome']).toLowerCase()
    const etichetta = testo(v['etichetta'])
    const valori = lista(v['valori']).map((x) => testo(x)).filter((x) => x !== '')
    if (!catalogo.consentiNuovi) {
      scartati.push({ cosa: etichetta || nome, key: 'proposal.discard.newVocabularyNotAllowed', params: {} })
      continue
    }
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(nome)) {
      scartati.push({ cosa: etichetta || nome || '—', key: 'proposal.discard.vocabularyName', params: { name: nome } })
      continue
    }
    if (catalogo.vocabolari.has(nome)) {
      // Non è un errore: è un vocabolario che esiste già, e la cosa giusta è
      // usarlo. Lo dico, perché i suoi valori possono non essere quelli che il
      // modello immaginava.
      scartati.push({ cosa: nome, key: 'proposal.discard.vocabularyExists', params: { name: nome } })
      continue
    }
    if (valori.length < 2) {
      scartati.push({ cosa: etichetta || nome, key: 'proposal.discard.vocabularyValues', params: { name: nome } })
      continue
    }
    const unici = [...new Set(valori)]
    vocabolariNuovi.push({ name: nome, label: etichetta || nome, values: unici, why: testo(v['perche']) })
    vocabolariDisponibili.set(nome, unici)
  }

  // ── I campi, sezione per sezione ──────────────────────────────────────────
  const campiNuovi: CampoProposto[] = []
  /** Nome → tipo, per i campi che il modulo citerà: serve alle condizioni. */
  const tipoDelCampo = new Map<string, string>()
  for (const [nome, def] of catalogo.campiLibreria) tipoDelCampo.set(nome, def.fieldType)
  /** I nomi già presi: la libreria più quelli che sto inventando ora. */
  const nomiPresi = new Set<string>([...catalogo.campiLibreria.keys()])
  /** Etichetta normalizzata → nome, per riconoscere una domanda che esiste già. */
  const perEtichetta = new Map<string, string>()
  for (const [nome, def] of catalogo.campiLibreria) perEtichetta.set(chiaveEtichetta(def.label), nome)

  /** I campi citati dal modulo finito: i suoi più quelli che c'erano già. */
  const citati = new Set<string>(catalogo.campiGiaNelModulo)
  const restanti = () => catalogo.maxCampiPerModulo - citati.size

  interface VoceGrezza { voce: Omit<VoceDiSezioneProposta, 'visibleWhen'>; condizione: unknown }
  const sezioniGrezze: { id: string; titleIt: string; titleEn: string; columns: 1 | 2; items: VoceGrezza[] }[] = []

  let indiceSezione = 0
  for (const rawSez of lista(doc['sezioni'])) {
    const sez = oggetto(rawSez)
    indiceSezione += 1
    const items: VoceGrezza[] = []

    for (const rawCampo of lista(sez['campi'])) {
      const c = oggetto(rawCampo)
      const etichettaIt = testo(c['etichetta_it'])
      const etichettaEn = testo(c['etichetta_en'])
      const etichetta = etichettaIt || etichettaEn
      const perche = testo(c['perche'])
      const tipoChiesto = testo(c['tipo'])

      if (etichetta === '') {
        scartati.push({ cosa: tipoChiesto || '—', key: 'proposal.discard.noLabel', params: {} })
        continue
      }
      if (restanti() <= 0) {
        scartati.push({ cosa: etichetta, key: 'proposal.discard.formFull', params: { max: catalogo.maxCampiPerModulo } })
        continue
      }

      // RIUSO: chiesto dal modello (`riuso`) o riconosciuto dall'etichetta.
      const riusoChiesto = testo(c['riuso'])
      const riuso = catalogo.campiLibreria.has(riusoChiesto)
        ? riusoChiesto
        : (perEtichetta.get(chiaveEtichetta(etichetta)) ?? null)
      if (riusoChiesto !== '' && riuso === null) {
        scartati.push({ cosa: etichetta, key: 'proposal.discard.reuseUnknown', params: { name: riusoChiesto } })
        // Non si ferma: il campo si può ancora creare nuovo.
      }

      let nome: string
      let tipo: string
      let source: 'library' | 'new'
      if (riuso !== null) {
        const def = catalogo.campiLibreria.get(riuso)!
        nome = riuso
        tipo = def.fieldType
        source = 'library'
        if (tipoChiesto !== '' && tipoChiesto !== tipo) {
          // Il tipo di un campo esistente non si cambia: ci sono appese le
          // risposte già date. Vince la libreria, e lo dico.
          scartati.push({ cosa: etichetta, key: 'proposal.discard.reuseTypeKept', params: { name: riuso, kept: tipo, asked: tipoChiesto } })
        }
        if (citati.has(nome)) {
          scartati.push({ cosa: etichetta, key: 'proposal.discard.alreadyInForm', params: { name: nome } })
          continue
        }
      } else {
        if (!catalogo.consentiNuovi) {
          scartati.push({ cosa: etichetta, key: 'proposal.discard.newFieldNotAllowed', params: {} })
          continue
        }
        if (!isFormFieldType(tipoChiesto) || !TIPI_PROPONIBILI.includes(tipoChiesto)) {
          scartati.push({ cosa: etichetta, key: 'proposal.discard.unknownType', params: { fieldType: tipoChiesto } })
          continue
        }
        tipo = tipoChiesto
        source = 'new'
        nome = nomeDaEtichetta(etichettaIt || etichettaEn, [...nomiPresi])
        if (!FORM_FIELD_NAME_RE.test(nome)) {
          scartati.push({ cosa: etichetta, key: 'proposal.discard.fieldName', params: { name: nome } })
          continue
        }

        // Il vocabolario di una scelta: deve esistere o essere fra quelli nuovi.
        let vocabolario: string | null = testo(c['vocabolario']).toLowerCase() || null
        const vuoleVocabolario = (FORM_FIELD_TYPES_WITH_VOCABULARY as readonly string[]).includes(tipo)
        if (vocabolario !== null && !vocabolariDisponibili.has(vocabolario)) {
          scartati.push({ cosa: etichetta, key: 'proposal.discard.vocabularyUnknown', params: { name: vocabolario } })
          vocabolario = null
        }
        if (vuoleVocabolario && vocabolario === null) {
          // Una scelta senza elenco non offre niente: il campo non ha senso.
          scartati.push({ cosa: etichetta, key: 'proposal.discard.choiceWithoutVocabulary', params: { fieldType: tipo } })
          continue
        }
        if (!vuoleVocabolario && vocabolario !== null) {
          scartati.push({ cosa: etichetta, key: 'proposal.discard.vocabularyNotAllowed', params: { fieldType: tipo } })
          vocabolario = null
        }

        // I tipi di CI di un riferimento alla CMDB: quelli che esistono.
        const tipiCIChiesti = tipo === 'ref_ci' ? lista(c['tipi_ci']).map((x) => testo(x)).filter((x) => x !== '') : []
        const tipiCI = tipiCIChiesti.filter((x) => catalogo.tipiCI.has(x))
        for (const ignoto of tipiCIChiesti.filter((x) => !catalogo.tipiCI.has(x))) {
          scartati.push({ cosa: etichetta, key: 'proposal.discard.ciTypeUnknown', params: { name: ignoto } })
        }

        // Gli SCRIPT. Due cancelli: gli script del cliente devono essere
        // accesi, e il codice deve passare il validatore statico che usa il
        // prodotto (`packages/scripting`) — quello che rifiuta `process`,
        // `require`, `eval` e i cicli infiniti.
        const formula = scriptValido(testo(c['formula']) || null, catalogo, etichetta, 'formula', scartati)
        const formulaAmmessa = formula !== null && canBeComputed(tipo)
        if (formula !== null && !formulaAmmessa) {
          scartati.push({ cosa: etichetta, key: 'proposal.discard.formulaNotAllowed', params: { fieldType: tipo } })
        }
        const script = scriptValido(testo(c['script_validazione']) || null, catalogo, etichetta, 'validation', scartati)
        const scriptAmmesso = script !== null && (FORM_FIELD_TYPES_AS_PROPERTY as readonly string[]).includes(tipo)
        if (script !== null && !scriptAmmesso) {
          scartati.push({ cosa: etichetta, key: 'proposal.discard.scriptNotAllowed', params: { fieldType: tipo } })
        }

        campiNuovi.push({
          name: nome, fieldType: tipo,
          labelIt: etichettaIt || etichettaEn, labelEn: etichettaEn || etichettaIt,
          helpIt: testo(c['aiuto_it']) || null, helpEn: testo(c['aiuto_en']) || null,
          vocabulary: vocabolario, refTypes: tipiCI,
          formula: formulaAmmessa ? formula : null,
          validationScript: scriptAmmesso ? script : null,
          why: perche,
        })
        nomiPresi.add(nome)
        perEtichetta.set(chiaveEtichetta(etichetta), nome)
      }

      tipoDelCampo.set(nome, tipo)
      citati.add(nome)
      const calcolato = campiNuovi.find((x) => x.name === nome)?.formula != null
      items.push({
        voce: {
          field: nome, source,
          // Un campo calcolato non si compila: chiederlo obbligatorio sarebbe
          // una richiesta a chi non può rispondere (e il server la rifiuta).
          required: !calcolato && booleano(c['obbligatorio'], false),
          width: testo(c['larghezza']) === 'half' ? 'half' : 'full',
          endUser: booleano(c['visibile_nella_richiesta'], true),
          readOnly: !calcolato && booleano(c['solo_lettura'], false),
          why: perche,
        },
        condizione: c['visibile_quando'],
      })
    }

    if (items.length === 0) continue
    const titoloIt = testo(sez['titolo_it'])
    const titoloEn = testo(sez['titolo_en'])
    sezioniGrezze.push({
      id: `ai_${String(indiceSezione)}`,
      titleIt: titoloIt || titoloEn,
      titleEn: titoloEn || titoloIt,
      columns: Number(sez['colonne']) === 2 ? 2 : 1,
      items,
    })
  }

  // ── Le condizioni, alla fine ──────────────────────────────────────────────
  //
  // Una condizione guarda un ALTRO campo, quindi si può validare solo quando si
  // sa quali campi il modulo cita davvero: farlo prima vorrebbe dire accettare
  // una regola su un campo che poi è stato scartato — e una regola su un campo
  // che non c'è nasconde il campo per sempre.
  const sezioni: SezioneProposta[] = sezioniGrezze.map((s) => ({
    id: s.id, titleIt: s.titleIt, titleEn: s.titleEn, columns: s.columns,
    items: s.items.map((g) => ({
      ...g.voce,
      visibleWhen: condizioneValida(g.condizione, citati, tipoDelCampo, g.voce.field, scartati),
    })),
  }))

  // ── L'intestazione della voce ─────────────────────────────────────────────
  const voce = voceValidata(doc['voce'], catalogo, scartati)

  return { voce, vocabolariNuovi, campiNuovi, sezioni, scartati, note }
}

/** Uno script del cliente: acceso, e valido secondo il validatore del prodotto. */
function scriptValido(
  codice: string | null, catalogo: CatalogoPerProposta, cosa: string,
  genere: 'formula' | 'validation', scartati: ScartoProposta[],
): string | null {
  if (codice === null || codice === '') return null
  if (!catalogo.scriptingAcceso) {
    scartati.push({ cosa, key: 'proposal.discard.scriptingOff', params: { kind: genere } })
    return null
  }
  const esito = validateScript(codice)
  if (!esito.valid) {
    scartati.push({ cosa, key: 'proposal.discard.scriptInvalid', params: { kind: genere, message: esito.errors.join('; ') } })
    return null
  }
  return codice
}

/**
 * La condizione di visibilità. Si scarta INTERA se una sola regola non regge:
 * una condizione applicata a metà mostra il campo in casi in cui non deve
 * comparire, ed è peggio di nessuna condizione — perché sembra impostata.
 */
function condizioneValida(
  raw: unknown, citati: ReadonlySet<string>, tipoDelCampo: ReadonlyMap<string, string>,
  campo: string, scartati: ScartoProposta[],
): string | null {
  if (raw == null) return null
  const o = oggetto(raw)
  const regoleGrezze = lista(o['rules'])
  if (regoleGrezze.length === 0) return null

  const regole: { field: string; op: FormConditionOp; value?: string }[] = []
  for (const rawRegola of regoleGrezze) {
    const r = oggetto(rawRegola)
    const altro = testo(r['field'])
    const op = testo(r['op'])
    if (!citati.has(altro) || altro === campo) {
      scartati.push({ cosa: campo, key: 'proposal.discard.conditionField', params: { name: altro || '—' } })
      return null
    }
    if (!canBeConditionSubject(tipoDelCampo.get(altro) ?? '')) {
      scartati.push({ cosa: campo, key: 'proposal.discard.conditionSubject', params: { name: altro, fieldType: tipoDelCampo.get(altro) ?? '—' } })
      return null
    }
    if (!(FORM_CONDITION_OPS as readonly string[]).includes(op)) {
      scartati.push({ cosa: campo, key: 'proposal.discard.conditionOp', params: { op: op || '—' } })
      return null
    }
    const senzaValore = (FORM_CONDITION_OPS_WITHOUT_VALUE as readonly string[]).includes(op)
    const valore = testo(r['value'])
    if (!senzaValore && valore === '') {
      scartati.push({ cosa: campo, key: 'proposal.discard.conditionValue', params: { name: altro, op } })
      return null
    }
    regole.push(senzaValore ? { field: altro, op: op as FormConditionOp } : { field: altro, op: op as FormConditionOp, value: valore })
  }

  const condizione: FormCondition = { match: testo(o['match']) === 'any' ? 'any' : 'all', rules: regole }
  return JSON.stringify(condizione)
}

/** Nome, descrizione, categoria, priorità, approvazione e workflow: solo valori che esistono. */
function voceValidata(raw: unknown, catalogo: CatalogoPerProposta, scartati: ScartoProposta[]): VoceProposta | null {
  if (raw == null) return null
  const v = oggetto(raw)
  const nome = testo(v['nome'])
  if (nome === '') return null

  const categoriaChiesta = testo(v['categoria'])
  const categoria = catalogo.categorie.includes(categoriaChiesta) ? categoriaChiesta : null
  if (categoriaChiesta !== '' && categoria === null) {
    scartati.push({ cosa: nome, key: 'proposal.discard.categoryUnknown', params: { name: categoriaChiesta } })
  }

  const prioritaChiesta = testo(v['priorita'])
  const priorita = catalogo.priorita.includes(prioritaChiesta) ? prioritaChiesta : null
  if (prioritaChiesta !== '' && priorita === null) {
    scartati.push({ cosa: nome, key: 'proposal.discard.priorityUnknown', params: { name: prioritaChiesta } })
  }

  // Il workflow si cerca per NOME fra quelli che esistono: l'AI non ne crea.
  const workflowChiesto = testo(v['workflow'])
  const workflow = catalogo.workflowPerNome.get(workflowChiesto.toLowerCase()) ?? null
  if (workflowChiesto !== '' && workflow === null) {
    scartati.push({ cosa: nome, key: 'proposal.discard.workflowUnknown', params: { name: workflowChiesto } })
  }

  return {
    name: nome,
    description: testo(v['descrizione']) || null,
    category: categoria,
    priority: priorita,
    requiresApproval: booleano(v['richiede_approvazione'], false),
    workflowDefinitionId: workflow?.id ?? null,
    workflowDefinitionName: workflow?.name ?? null,
    why: testo(v['perche']),
  }
}
