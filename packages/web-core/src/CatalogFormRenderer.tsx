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
import { useMemo } from 'react'
import {
  FORM_FIELD_TYPES_WITHOUT_ANSWER, evaluateFormCondition, localizedText,
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
  return visibleCatalogFormItems(definition, answers, endUser)
    .filter((item) => !senzaRisposta.includes(tipoDi.get(item.field) ?? ''))
    .map((item) => {
      const v = answers[item.field]
      return Array.isArray(v)
        ? { name: item.field, values: v.map(String) }
        : { name: item.field, value: v == null ? null : String(v) }
    })
}

export function CatalogFormRenderer({
  definition, fields, answers, onChange, language, endUser, errors, disabled,
  requiredLabel, emptyChoiceLabel, yesLabel, noLabel,
}: CatalogFormRendererProps) {
  const perNome = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields])

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
                    onChange={onChange}
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
  language?: string | null
  disabled?: boolean
  requiredLabel?: string
  emptyChoiceLabel?: string
  yesLabel?: string
  noLabel?: string
  onChange: (name: string, value: FormAnswerValue) => void
}

function CampoDelModulo({ campo, item, valore, errore, language, disabled, requiredLabel, emptyChoiceLabel, yesLabel, noLabel, onChange }: CampoProps) {
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
