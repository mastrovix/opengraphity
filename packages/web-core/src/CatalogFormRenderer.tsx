/**
 * IL RENDERER DEI MODULI DEL CATALOGO, uno per due applicazioni.
 *
 * Perché sta qui e non in `apps/web`: il modulo di una voce di catalogo si
 * compila da DUE posti — l'area di lavoro e il portale — e oggi i due hanno
 * renderer diversi, con quello del portale più povero (solo `select` e
 * `input`: nessuna area di testo, nessuna sezione, nessun condizionale). Con
 * moduli ricchi due renderer divergono in una settimana, e la divergenza si
 * vede dove fa più male: l'utente finale compila un modulo diverso da quello
 * che l'amministratore ha disegnato.
 *
 * COSA È CONDIVISO E COSA NO. Qui stanno la struttura e il comportamento:
 * l'ordine delle sezioni, i tipi di campo, le condizioni di visibilità, gli
 * errori, cosa viene riportato al chiamante. L'ASPETTO no: questo componente
 * non scrive un colore né una dimensione, emette solo classi `og-form-*` e
 * ogni applicazione le veste con la sua scala — il web è una console fitta
 * (corpo a 12px), il portale è per persone che ci passano due minuti l'anno.
 * Per la stessa ragione qui non si importa nessun token: il portale non ha
 * quelli del web.
 *
 * LE CONDIZIONI le valuta `evaluateFormCondition` di @opengraphity/types, cioè
 * ESATTAMENTE la funzione che il server usa per decidere cosa accettare. Se
 * qui ne vivesse una copia, un campo nascosto diventerebbe un varco: il
 * browser lo nasconderebbe, il server lo accetterebbe, o viceversa un
 * obbligatorio invisibile bloccherebbe l'invio senza che si capisca perché.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  FORM_FIELD_TYPES_WITHOUT_ANSWER, evaluateFormCondition, isFormAttachmentType, isFormReferenceType,
  isFormTableType, localizedText,
  type CatalogFormDefinition, type CatalogFormItem, type FormAnswerValue, type FormAnswers,
} from '@opengraphity/types'

/** Un campo della libreria come lo restituisce `catalogFormToFill`. */
export interface CatalogFormFieldView {
  name: string
  fieldType: string
  label: string
  labels?: ReadonlyArray<{ language: string; label: string }>
  help?: string | null
  helps?: ReadonlyArray<{ language: string; label: string }>
  required: boolean
  vocabulary?: string | null
  options?: ReadonlyArray<{ value: string; label: string }>
  /** Le colonne, se il campo è una tabella (ondata 7). */
  tableColumns?: readonly CatalogFormTableColumnView[]
  /**
   * La FORMULA di un campo calcolato (ondata 6). Presente = il campo è in sola
   * lettura: il valore lo calcola il renderer mentre si compila, per mostrarlo,
   * e lo ricalcola l'API al salvataggio, che è quello che conta.
   */
  formula?: string | null
}

/** Un file caricato su una bozza: lo stato è del chiamante, il renderer lo mostra. */
export interface CatalogFormFile {
  id: string
  filename: string
  sizeBytes: number
}

/** Un nodo scelto da un campo di riferimento. */
export interface CatalogFormReference {
  id: string
  label: string
}

/** Una riga di tabella mentre si compila: valore per nome di colonna (ondata 7). */
export type CatalogFormTableRow = Record<string, string>

/**
 * Una colonna come la manda `FormField.tableColumns`: etichetta già nella
 * lingua di chi compila e scelte già risolte. Il renderer non legge vocabolari.
 */
export interface CatalogFormTableColumnView {
  name: string
  label: string
  fieldType: string
  required: boolean
  options?: ReadonlyArray<{ value: string; label: string }>
}

export interface CatalogFormRendererProps {
  definition: CatalogFormDefinition
  fields: readonly CatalogFormFieldView[]
  answers: FormAnswers
  onChange: (name: string, value: FormAnswerValue) => void
  /** La lingua di chi compila; decide etichette e aiuti. */
  language?: string | null
  /** true dal portale: i campi non offerti agli utenti finali non compaiono. */
  endUser?: boolean
  /** Errori per campo, come li restituisce il server. */
  errors?: Readonly<Record<string, string>>
  disabled?: boolean
  /** La parola «obbligatorio» per il lettore di schermo, nella lingua dell'app. */
  requiredLabel?: string
  /** Il testo della scelta vuota di una tendina, nella lingua dell'app. */
  emptyChoiceLabel?: string
  /** Le due voci di un campo sì/no, nella lingua dell'app: qui non si scrive testo. */
  yesLabel?: string
  noLabel?: string
  /** La parola «calcolato», per il segno accanto a un campo con formula (ondata 6). */
  computedLabel?: string

  // ── Ondata 7: le tabelle ripetibili ───────────────────────────────────────
  //
  // Le righe stanno FUORI dalle risposte, come i file e i riferimenti: una
  // risposta è un valore, una riga è un record. Lo stato è del chiamante, il
  // renderer mostra e chiede — così il portale e l'area di lavoro compilano la
  // stessa tabella con lo stesso comportamento.
  /** Le righe per nome di campo tabella. */
  tables?: Readonly<Record<string, readonly CatalogFormTableRow[]>>
  /** Cambia le righe di un campo. Assente = la tabella si mostra in sola lettura. */
  onTablesChange?: (fieldName: string, rows: readonly CatalogFormTableRow[]) => void
  /** «Aggiungi una riga» e «Togli la riga», nella lingua dell'app. */
  tableAddRowLabel?: string
  tableRemoveRowLabel?: string

  // ── Ondata 2: allegati e riferimenti ──────────────────────────────────────
  //
  // Il renderer non fa rete: mostra e chiede. Il caricamento e la ricerca li
  // fa il chiamante, perché le due applicazioni hanno strumenti diversi — e
  // perché nel portale la ricerca nella CMDB non deve esistere affatto.

  /** I file già caricati, per campo. Lo stato è del chiamante: gli serve per sapere se un obbligatorio è soddisfatto. */
  files?: Readonly<Record<string, readonly CatalogFormFile[]>>
  /** Caricare un file su un campo allegato. Assente = il campo si mostra in sola lettura. */
  onUploadFile?: (fieldName: string, file: File) => void | Promise<void>
  /** Togliere un file già caricato. */
  onRemoveFile?: (fieldName: string, fileId: string) => void | Promise<void>
  /** Il campo su cui un caricamento è in corso (per disabilitare il controllo). */
  uploadingField?: string | null

  /** I nodi scelti dai campi di riferimento, per campo. */
  references?: Readonly<Record<string, readonly CatalogFormReference[]>>
  /** Cerca i candidati di un campo di riferimento. Assente = il campo dice che non si può scegliere qui. */
  onSearchReference?: (fieldName: string, fieldType: string, query: string) => Promise<readonly CatalogFormReference[]>
  /** Scegliere (o togliere, con `null`) il nodo puntato. */
  onPickReference?: (fieldName: string, chosen: CatalogFormReference | null) => void
  /** Testi dei due controlli nuovi, nella lingua dell'app. */
  fileAddLabel?: string
  fileRemoveLabel?: string
  referenceSearchLabel?: string
  referenceNoResultsLabel?: string
  referenceClearLabel?: string
  referenceUnavailableLabel?: string
}

/** L'etichetta di un campo nella lingua chiesta, con ripiego su quella di base. */
function etichetta(f: CatalogFormFieldView, language: string | null | undefined): string {
  return (language && f.labels?.find((l) => l.language === language)?.label) || f.label
}

function aiuto(f: CatalogFormFieldView, item: CatalogFormItem, language: string | null | undefined): string | null {
  // L'aiuto del MODULO vince su quello della libreria: lo stesso campo può
  // avere bisogno di una spiegazione diversa in due richieste diverse.
  if (item.help) return localizedText(item.help, language, '')
  return (language && f.helps?.find((l) => l.language === language)?.label) || f.help || null
}

/**
 * Le voci da mostrare, date le risposte di adesso. È la stessa funzione che il
 * server richiama prima di scrivere (`visibleFormItems`): qui però serve anche
 * a sapere quali campi NON inviare, quindi il chiamante la può usare per
 * ripulire le risposte quando una condizione si spegne.
 */
export function visibleCatalogFormItems(
  definition: CatalogFormDefinition, answers: FormAnswers, endUser?: boolean,
): CatalogFormItem[] {
  const out: CatalogFormItem[] = []
  for (const s of definition.sections) {
    if (!evaluateFormCondition(s.visibleWhen, answers)) continue
    for (const i of s.items) {
      if (endUser && i.endUser === false) continue
      if (!evaluateFormCondition(i.visibleWhen, answers)) continue
      out.push(i)
    }
  }
  return out
}

/** Una risposta nella forma che l'API accetta (`FormAnswerInput`). */
export interface CatalogFormAnswerToSend {
  name: string
  value?: string | null
  values?: string[]
}

/**
 * Le risposte da INVIARE, date le risposte in corso. Sta qui, accanto al
 * renderer, perché la regola deve essere identica nell'area di lavoro e nel
 * portale: due copie divergono, e la divergenza si scopre con un errore del
 * server in faccia a chi compila.
 *
 * Due regole, entrambe imparate dal server:
 *  - si inviano SOLO i campi visibili adesso. Un campo nascosto da una
 *    condizione che arriva comunque viene rifiutato (è un varco), quindi
 *    mandarlo sarebbe un errore garantito.
 *  - le NOTE non si inviano mai: non portano una risposta. Il primo giro nel
 *    browser è finito esattamente così — «il campo istruzioni_hw è una nota:
 *    non porta una risposta» — perché la pagina mandava tutto ciò che vedeva.
 */
export function catalogFormAnswersToSend(
  definition: CatalogFormDefinition,
  fields: readonly CatalogFormFieldView[],
  answers: FormAnswers,
  endUser?: boolean,
): CatalogFormAnswerToSend[] {
  const tipoDi = new Map(fields.map((f) => [f.name, f.fieldType]))
  const senzaRisposta: readonly string[] = FORM_FIELD_TYPES_WITHOUT_ANSWER
  // I CALCOLATI non si mandano (ondata 6): il valore è della formula, e l'API
  // rifiuta chi lo manda. Nelle `answers` c'è per far vedere il totale e per
  // farci passare le condizioni, non per essere spedito.
  const calcolato = new Set(fields.filter((f) => f.formula && f.formula.trim() !== '').map((f) => f.name))
  return visibleCatalogFormItems(definition, answers, endUser)
    .filter((item) => !senzaRisposta.includes(tipoDi.get(item.field) ?? ''))
    .filter((item) => !calcolato.has(item.field))
    // Le TABELLE non stanno nelle risposte: le righe viaggiano a parte
    // (`catalogFormTableAnswers`), perché una riga non è un valore.
    .filter((item) => !isFormTableType(tipoDi.get(item.field) ?? ''))
    .map((item) => {
      const v = answers[item.field]
      return Array.isArray(v)
        ? { name: item.field, values: v.map(String) }
        : { name: item.field, value: v == null ? null : String(v) }
    })
}

/**
 * Le RIGHE da mandare, nella forma che l'API vuole: `{name, rows}` con le celle
 * per nome di colonna (ondata 7). Solo le tabelle VISIBILI — una nascosta da
 * una condizione non è stata chiesta — e solo le righe con qualcosa dentro: le
 * vuote le scarta comunque il server, mandarle sarebbe rumore.
 */
export function catalogFormTableAnswers(
  definition: CatalogFormDefinition,
  fields: readonly CatalogFormFieldView[],
  answers: FormAnswers,
  tables: Readonly<Record<string, readonly CatalogFormTableRow[]>>,
  endUser?: boolean,
): Array<{ name: string; rows: CatalogFormTableRow[] }> {
  const tipoDi = new Map(fields.map((f) => [f.name, f.fieldType]))
  const out: Array<{ name: string; rows: CatalogFormTableRow[] }> = []
  for (const item of visibleCatalogFormItems(definition, answers, endUser)) {
    if (!isFormTableType(tipoDi.get(item.field) ?? '')) continue
    const righe = (tables[item.field] ?? []).filter((r) => Object.values(r).some((v) => v != null && String(v).trim() !== ''))
    if (righe.length > 0) out.push({ name: item.field, rows: righe.map((r) => ({ ...r })) })
  }
  return out
}

export function CatalogFormRenderer(props: CatalogFormRendererProps) {
  const {
    definition, fields, answers, onChange, language, endUser, errors, disabled,
    requiredLabel, emptyChoiceLabel, yesLabel, noLabel, computedLabel,
  } = props
  const perNome = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields])

  /**
   * I CAMPI CALCOLATI, mentre si compila (ondata 6).
   *
   * Sta nel renderer e non nelle due pagine perché è comportamento, non
   * aspetto: il portale e l'area di lavoro devono vedere lo stesso totale. Il
   * valore finisce nelle `answers` — così le condizioni lo vedono — ma NON
   * viene spedito (`catalogFormAnswersToSend` lo esclude): a scriverlo sul
   * ticket pensa l'API, ricalcolandolo.
   *
   * L'attesa di 250 ms evita di eseguire una formula a ogni tasto premuto; il
   * confronto con il valore attuale evita il giro infinito (scrivo, ricalcolo,
   * scrivo). QuickJS si carica solo se un campo ha davvero una formula.
   */
  const conFormula = useMemo(() => fields.filter((f) => f.formula && f.formula.trim() !== ''), [fields])
  const [erroriFormula, setErroriFormula] = useState<Record<string, string>>({})
  useEffect(() => {
    if (conFormula.length === 0) return
    let annullato = false
    const attesa = setTimeout(() => {
      void (async () => {
        const { computeFormulas } = await import('./formulaRunner.js')
        const { values, errors: erroriNuovi } = await computeFormulas(conFormula, answers)
        if (annullato) return
        setErroriFormula(erroriNuovi)
        for (const [nome, calcolato] of Object.entries(values)) {
          const valore: FormAnswerValue = calcolato == null ? null
            : typeof calcolato === 'boolean' || typeof calcolato === 'number' ? calcolato
            : String(calcolato)
          const attuale = answers[nome]
          // `==` volutamente no: il confronto è fra due valori già normalizzati.
          if ((attuale ?? null) !== (valore ?? null)) onChange(nome, valore)
        }
      })()
    }, 250)
    return () => { annullato = true; clearTimeout(attesa) }
  }, [conFormula, answers, onChange])

  return (
    <div className="og-form">
      {definition.sections.map((sezione) => {
        if (!evaluateFormCondition(sezione.visibleWhen, answers)) return null
        const voci = sezione.items.filter((i) => {
          if (endUser && i.endUser === false) return false
          return evaluateFormCondition(i.visibleWhen, answers)
        })
        // Una sezione che non ha più niente da mostrare non lascia un titolo
        // sospeso: sparisce del tutto.
        if (voci.length === 0) return null
        const titolo = localizedText(sezione.title, language, '')
        const descrizione = sezione.description ? localizedText(sezione.description, language, '') : ''
        return (
          <section key={sezione.id} className="og-form-section" aria-labelledby={titolo ? `og-form-${sezione.id}` : undefined}>
            {titolo && <h3 id={`og-form-${sezione.id}`} className="og-form-section-title">{titolo}</h3>}
            {descrizione && <p className="og-form-section-desc">{descrizione}</p>}
            <div className="og-form-grid">
              {voci.map((item) => {
                const campo = perNome.get(item.field)
                // Un campo citato dal modulo e assente fra quelli risolti: non
                // si finge che non esista, si dice quale manca — l'API lo
                // impedisce, ma se accadesse il silenzio sarebbe peggio.
                if (!campo) {
                  return (
                    <p key={item.field} className="og-form-missing" role="alert">
                      {item.field}
                    </p>
                  )
                }
                return (
                  <CampoDelModulo
                    key={item.field}
                    campo={campo}
                    item={item}
                    valore={answers[item.field]}
                    errore={errors?.[item.field]}
                    language={language}
                    disabled={disabled}
                    requiredLabel={requiredLabel}
                    emptyChoiceLabel={emptyChoiceLabel}
                    yesLabel={yesLabel}
                    noLabel={noLabel}
                    computedLabel={computedLabel}
                    erroreFormula={erroriFormula[item.field]}
                    onChange={onChange}
                    extra={props}
                  />
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

interface CampoProps {
  campo: CatalogFormFieldView
  item: CatalogFormItem
  valore: FormAnswerValue
  errore?: string
  /** L'errore della FORMULA di questo campo, se ne ha una e non ha prodotto un valore. */
  erroreFormula?: string
  computedLabel?: string
  language?: string | null
  disabled?: boolean
  requiredLabel?: string
  emptyChoiceLabel?: string
  yesLabel?: string
  noLabel?: string
  onChange: (name: string, value: FormAnswerValue) => void
  /** Il resto delle props del renderer: allegati e riferimenti (ondata 2). */
  extra: CatalogFormRendererProps
}

function CampoDelModulo({ campo, item, valore, errore, erroreFormula, computedLabel, language, disabled, requiredLabel, emptyChoiceLabel, yesLabel, noLabel, onChange, extra }: CampoProps) {
  const obbligatorio = item.required ?? campo.required
  const testo = etichetta(campo, language)
  const spiegazione = aiuto(campo, item, language)
  const id = `og-form-f-${campo.name}`
  const idAiuto = spiegazione ? `${id}-help` : undefined
  const idErrore = errore ? `${id}-err` : undefined
  const descritto = [idAiuto, idErrore].filter(Boolean).join(' ') || undefined
  const larghezza = item.width === 'half' ? 'og-form-cell og-form-cell-half' : 'og-form-cell'

  // Una nota non è un campo: non ha etichetta, non ha valore, non si compila.
  if (campo.fieldType === 'note') {
    return (
      <div className="og-form-cell og-form-note">
        <p>{testo}</p>
        {spiegazione && <p className="og-form-help">{spiegazione}</p>}
      </div>
    )
  }

  /**
   * UNA TABELLA non è un controllo: è una tabella (ondata 7). Le righe stanno
   * fuori dalle risposte, quindi arrivano dal chiamante come i file e i
   * riferimenti.
   */
  if (isFormTableType(campo.fieldType)) {
    return (
      <div className="og-form-cell">
        <span className="og-form-label" id={`${id}-lbl`}>
          {testo}
          {obbligatorio && <span className="og-form-required" aria-label={requiredLabel}> *</span>}
        </span>
        {spiegazione && <p className="og-form-help" id={idAiuto}>{spiegazione}</p>}
        <CampoTabella
          campo={campo}
          righe={extra.tables?.[campo.name] ?? []}
          onChange={extra.onTablesChange ? (rows) => { extra.onTablesChange?.(campo.name, rows) } : undefined}
          disabled={disabled}
          addLabel={extra.tableAddRowLabel}
          removeLabel={extra.tableRemoveRowLabel}
          emptyChoiceLabel={emptyChoiceLabel}
          yesLabel={yesLabel}
          noLabel={noLabel}
        />
        {errore && <p className="og-form-error" id={idErrore} role="alert">{errore}</p>}
      </div>
    )
  }

  /**
   * UN CAMPO CALCOLATO non si compila: si legge (ondata 6). Niente controllo
   * spento e niente campo di testo in sola lettura — sarebbero due modi di
   * dire «qui potresti scrivere, ma no». Si mostra il valore, con il segno che
   * dice da dove viene; se la formula è fallita, si dice quello invece del
   * valore, perché un campo vuoto senza spiegazione sembrerebbe un dato che
   * manca.
   */
  if (campo.formula && campo.formula.trim() !== '') {
    const mostrato = valore == null || valore === '' ? '—'
      : typeof valore === 'boolean' ? (valore ? (yesLabel ?? 'yes') : (noLabel ?? 'no'))
      : Array.isArray(valore) ? valore.join(', ')
      : String(valore)
    return (
      <div className={larghezza}>
        <span className="og-form-label" id={`${id}-lbl`}>
          {testo}
          {computedLabel && <span className="og-form-computed-badge">{computedLabel}</span>}
        </span>
        {erroreFormula
          ? <p className="og-form-error" role="alert">{erroreFormula}</p>
          : <p className="og-form-computed" aria-labelledby={`${id}-lbl`}>{mostrato}</p>}
        {spiegazione && <p className="og-form-help" id={idAiuto}>{spiegazione}</p>}
        {errore && <p className="og-form-error" id={idErrore} role="alert">{errore}</p>}
      </div>
    )
  }

  const comune = {
    id,
    disabled,
    'aria-describedby': descritto,
    'aria-invalid': errore ? true : undefined,
    className: errore ? 'og-form-input og-form-input-error' : 'og-form-input',
  }
  const testoDi = (v: FormAnswerValue): string => (v == null || Array.isArray(v) ? '' : String(v))

  return (
    <div className={larghezza}>
      <label className="og-form-label" htmlFor={id}>
        {testo}
        {obbligatorio && <span className="og-form-required" aria-label={requiredLabel}>*</span>}
      </label>

      {isFormAttachmentType(campo.fieldType) && (
        <CampoAllegato campo={campo} disabled={disabled} extra={extra} />
      )}

      {isFormReferenceType(campo.fieldType) && (
        <CampoRiferimento campo={campo} disabled={disabled} extra={extra} />
      )}

      {campo.fieldType === 'textarea' && (
        <textarea {...comune} rows={4} value={testoDi(valore)} required={obbligatorio}
          onChange={(e) => onChange(campo.name, e.target.value)} />
      )}

      {campo.fieldType === 'boolean' && (
        <select {...comune} value={valore === true ? 'true' : valore === false ? 'false' : ''} required={obbligatorio}
          onChange={(e) => onChange(campo.name, e.target.value === '' ? null : e.target.value === 'true')}>
          <option value="">{emptyChoiceLabel ?? '—'}</option>
          <option value="true">{yesLabel ?? 'true'}</option>
          <option value="false">{noLabel ?? 'false'}</option>
        </select>
      )}

      {campo.fieldType === 'enum' && (
        <select {...comune} value={testoDi(valore)} required={obbligatorio}
          onChange={(e) => onChange(campo.name, e.target.value === '' ? null : e.target.value)}>
          <option value="">{emptyChoiceLabel ?? '—'}</option>
          {(campo.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}

      {campo.fieldType === 'multi_enum' && (
        <div className="og-form-multi" role="group" aria-labelledby={id} aria-describedby={descritto}>
          {(campo.options ?? []).map((o) => {
            const scelti = Array.isArray(valore) ? valore.map(String) : []
            const dentro = scelti.includes(o.value)
            return (
              <label key={o.value} className="og-form-check">
                <input
                  type="checkbox" checked={dentro} disabled={disabled}
                  onChange={() => onChange(campo.name, dentro ? scelti.filter((v) => v !== o.value) : [...scelti, o.value])}
                />
                <span>{o.label}</span>
              </label>
            )
          })}
        </div>
      )}

      {(campo.fieldType === 'text' || campo.fieldType === 'number' || campo.fieldType === 'date' || campo.fieldType === 'datetime') && (
        <input
          {...comune}
          type={campo.fieldType === 'number' ? 'number' : campo.fieldType === 'date' ? 'date' : campo.fieldType === 'datetime' ? 'datetime-local' : 'text'}
          value={testoDi(valore)}
          required={obbligatorio}
          onChange={(e) => onChange(campo.name, e.target.value === '' ? null : e.target.value)}
        />
      )}

      {spiegazione && <p id={idAiuto} className="og-form-help">{spiegazione}</p>}
      {errore && <p id={idErrore} className="og-form-error" role="alert">{errore}</p>}
    </div>
  )
}

/**
 * UN CAMPO ALLEGATO. Il file si carica SUBITO, su una bozza, perché la
 * richiesta non esiste ancora — nel portale prima si poteva allegare solo
 * dopo la creazione. Lo stato dei file è del chiamante: gli serve per sapere
 * se un campo obbligatorio è soddisfatto prima di inviare.
 */
function CampoAllegato({ campo, disabled, extra }: { campo: CatalogFormFieldView; disabled?: boolean; extra: CatalogFormRendererProps }) {
  const caricati = extra.files?.[campo.name] ?? []
  const inCorso = extra.uploadingField === campo.name
  return (
    <div className="og-form-files">
      {caricati.length > 0 && (
        <ul className="og-form-file-list">
          {caricati.map((f) => (
            <li key={f.id}>
              <span className="og-form-file-name">{f.filename}</span>
              <span className="og-form-file-size">{formatKb(f.sizeBytes)}</span>
              {extra.onRemoveFile && !disabled && (
                <button type="button" className="og-form-file-remove"
                  aria-label={`${extra.fileRemoveLabel ?? 'remove'} ${f.filename}`}
                  onClick={() => void extra.onRemoveFile?.(campo.name, f.id)}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {extra.onUploadFile && (
        <label className="og-form-file-add">
          <input
            type="file"
            disabled={disabled || inCorso}
            onChange={(e) => {
              const file = e.target.files?.[0]
              // Il controllo si svuota SEMPRE: altrimenti ricaricare lo stesso
              // file non emette un evento e sembra che non sia successo niente.
              e.target.value = ''
              if (file) void extra.onUploadFile?.(campo.name, file)
            }}
          />
          <span>{inCorso ? '…' : (extra.fileAddLabel ?? '+')}</span>
        </label>
      )}
    </div>
  )
}

function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * UN CAMPO DI RIFERIMENTO (CI, persona, squadra). La ricerca la fa il
 * chiamante: nel portale non c'è, e il campo lo DICE invece di mostrare una
 * casella che non trova niente — un utente finale non naviga la CMDB.
 */
function CampoRiferimento({ campo, disabled, extra }: { campo: CatalogFormFieldView; disabled?: boolean; extra: CatalogFormRendererProps }) {
  const scelti = extra.references?.[campo.name] ?? []
  const [query, setQuery] = useState('')
  const [risultati, setRisultati] = useState<readonly CatalogFormReference[] | null>(null)
  const [cercando, setCercando] = useState(false)

  if (!extra.onSearchReference || !extra.onPickReference) {
    return <p className="og-form-help">{extra.referenceUnavailableLabel ?? ''}</p>
  }

  if (scelti.length > 0) {
    return (
      <div className="og-form-ref-chosen">
        <span>{scelti[0]!.label}</span>
        {!disabled && (
          <button type="button" className="og-form-file-remove"
            aria-label={extra.referenceClearLabel}
            onClick={() => { extra.onPickReference?.(campo.name, null); setQuery(''); setRisultati(null) }}>
            ×
          </button>
        )}
      </div>
    )
  }

  const cerca = async (testo: string) => {
    setQuery(testo)
    if (testo.trim().length < 2) { setRisultati(null); return }
    setCercando(true)
    try {
      setRisultati(await extra.onSearchReference!(campo.name, campo.fieldType, testo.trim()))
    } finally {
      setCercando(false)
    }
  }

  return (
    <div className="og-form-ref">
      <input
        className="og-form-input"
        type="search"
        value={query}
        disabled={disabled}
        placeholder={extra.referenceSearchLabel}
        onChange={(e) => void cerca(e.target.value)}
      />
      {risultati && (
        <ul className="og-form-ref-results">
          {risultati.length === 0 && !cercando && (
            <li className="og-form-ref-empty">{extra.referenceNoResultsLabel}</li>
          )}
          {risultati.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => { extra.onPickReference?.(campo.name, r); setRisultati(null); setQuery('') }}>
                {r.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface CampoTabellaProps {
  campo: CatalogFormFieldView
  righe: readonly CatalogFormTableRow[]
  onChange?: (rows: readonly CatalogFormTableRow[]) => void
  disabled?: boolean
  addLabel?: string
  removeLabel?: string
  emptyChoiceLabel?: string
  yesLabel?: string
  noLabel?: string
}

interface CellaProps {
  colonna: CatalogFormTableColumnView
  valore: string
  onChange: (v: string) => void
  disabled?: boolean
  emptyChoiceLabel?: string
  yesLabel?: string
  noLabel?: string
}

/**
 * UNA TABELLA RIPETIBILE mentre si compila (ondata 7).
 *
 * Una riga per record, una colonna per cella, «+ Aggiungi una riga» sotto. Le
 * righe sono del chiamante, come i file e i riferimenti: qui si mostrano e si
 * chiedono. Senza `onTablesChange` la tabella si legge e non si compila, che è
 * quello che serve all'anteprima del costruttore.
 *
 * Non si aggiunge una riga vuota da sé all'apertura: una tabella che nasce con
 * una riga dentro sembra chiedere qualcosa, e se chi compila non la tocca il
 * server la scarta comunque. Meglio un invito esplicito.
 */
function CampoTabella({ campo, righe, onChange, disabled, addLabel, removeLabel, emptyChoiceLabel, yesLabel, noLabel }: CampoTabellaProps) {
  const colonne = campo.tableColumns ?? []
  const soloLettura = !onChange || disabled === true

  const setCell = (indice: number, colonna: string, valore: string) => {
    onChange?.(righe.map((r, i) => (i === indice ? { ...r, [colonna]: valore } : r)))
  }
  const addRow = () => {
    onChange?.([...righe, Object.fromEntries(colonne.map((c) => [c.name, '']))])
  }
  const removeRow = (indice: number) => {
    onChange?.(righe.filter((_, i) => i !== indice))
  }

  return (
    <div className="og-form-table-wrap">
      <table className="og-form-table">
        <thead>
          <tr>
            {colonne.map((c) => (
              <th key={c.name} scope="col">{c.label}{c.required ? ' *' : ''}</th>
            ))}
            {!soloLettura && <th scope="col" className="og-form-table-actions" />}
          </tr>
        </thead>
        <tbody>
          {righe.map((riga, i) => (
            <tr key={i}>
              {colonne.map((c) => (
                <td key={c.name}>
                  <CellaDellaTabella
                    colonna={c}
                    valore={riga[c.name] ?? ''}
                    disabled={soloLettura}
                    emptyChoiceLabel={emptyChoiceLabel}
                    yesLabel={yesLabel}
                    noLabel={noLabel}
                    onChange={(v) => { setCell(i, c.name, v) }}
                  />
                </td>
              ))}
              {!soloLettura && (
                <td className="og-form-table-actions">
                  <button type="button" className="og-form-table-remove" onClick={() => { removeRow(i) }} aria-label={removeLabel ?? '×'}>
                    ×
                  </button>
                </td>
              )}
            </tr>
          ))}
          {righe.length === 0 && (
            <tr>
              <td colSpan={colonne.length + (soloLettura ? 0 : 1)} className="og-form-table-empty">—</td>
            </tr>
          )}
        </tbody>
      </table>
      {!soloLettura && (
        <button type="button" className="og-form-table-add" onClick={addRow}>
          {addLabel ?? '+'}
        </button>
      )}
    </div>
  )
}

/** Una cella: il controllo del tipo della sua colonna, niente di più. */
function CellaDellaTabella({ colonna, valore, onChange, disabled, emptyChoiceLabel, yesLabel, noLabel }: CellaProps) {
  const comune = { disabled, className: 'og-form-input og-form-table-input' }
  switch (colonna.fieldType) {
    case 'number':
      return <input {...comune} type="number" value={valore} onChange={(e) => { onChange(e.target.value) }} />
    case 'date':
      return <input {...comune} type="date" value={valore} onChange={(e) => { onChange(e.target.value) }} />
    case 'boolean':
      return (
        <select {...comune} value={valore} onChange={(e) => { onChange(e.target.value) }}>
          <option value="">{emptyChoiceLabel ?? '—'}</option>
          <option value="true">{yesLabel ?? 'yes'}</option>
          <option value="false">{noLabel ?? 'no'}</option>
        </select>
      )
    case 'enum':
      return (
        <select {...comune} value={valore} onChange={(e) => { onChange(e.target.value) }}>
          <option value="">{emptyChoiceLabel ?? '—'}</option>
          {(colonna.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )
    default:
      // Un tipo di colonna che questo renderer non conosce: si mostra il valore
      // come testo invece di non mostrare niente.
      return <input {...comune} type="text" value={valore} onChange={(e) => { onChange(e.target.value) }} />
  }
}
