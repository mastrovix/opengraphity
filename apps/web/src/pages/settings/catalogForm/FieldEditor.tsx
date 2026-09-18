/**
 * L'EDITOR DI UN CAMPO DELLA LIBRERIA — UNO SOLO, DUE POSTI (18 set 2026).
 *
 * Era dentro `FieldLibraryPanel`. Poi il costruttore dei moduli ha avuto la
 * palette dei TIPI, e trascinando una «Data» serviva chiedere le stesse cose:
 * etichette, aiuto, obbligatorio, colonna nelle liste, il VOCABOLARIO di una
 * tendina, le colonne di una tabella, la formula e lo script di validazione.
 *
 * Scriverne un secondo, piu piccolo, voleva dire due editor che divergono: uno
 * dei due, prima o poi, non avrebbe avuto una casella — e chi costruisce il
 * modulo da li non avrebbe mai saputo che quella cosa si poteva impostare.
 * Quindi l'editor e questo, e i due posti gli passano lo stato e il salvataggio:
 *
 *  - la LIBRERIA lo apre nella pagina (crea o modifica un campo);
 *  - il COSTRUTTORE lo apre in un modale quando si lascia cadere un tipo, e
 *    gli chiede in piu di PROPORRE il nome dall'etichetta (`nomeDallEtichetta`),
 *    perche li si scrive un'etichetta, non un identificatore.
 *
 * Nome e tipo non si cambiano dopo: `inModifica` li blocca. E il nome proposto
 * smette di seguire l'etichetta appena qualcuno lo scrive a mano.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@apollo/client/react'
import {
  canBeComputed, emptyFormTable, FORM_FIELD_TYPES, FORM_FIELD_TYPES_AS_PROPERTY,
  FORM_FIELD_TYPES_WITH_VOCABULARY, isFormTableType, nomeDaEtichetta, type FormTableDefinition,
} from '@opengraphity/types'
import { ScriptFields } from './ScriptFields'
import { TableColumnsEditor } from './TableColumnsEditor'
import { colors, fontWeight } from '@/lib/tokens'
import { Input, Select, LabelledField } from '@/components/ui/FormControls'
import { GET_CI_TYPES } from '@/graphql/queries'

/** Il campo che si sta scrivendo. Le etichette sono due lingue fisse: it ed en. */
export interface Bozza {
  name: string
  fieldType: string
  labelIt: string
  labelEn: string
  helpIt: string
  helpEn: string
  required: boolean
  vocabulary: string
  inList: boolean
  /** I tipi di CI ammessi da un `ref_ci`: vuoto = tutta la CMDB. */
  refTypes: string[]
  formula: string
  validationScript: string
  /** Le colonne della tabella, gia lette: il JSON lo ricuce chi salva. */
  tabella: FormTableDefinition
}

export const BOZZA_VUOTA: Bozza = {
  name: '', fieldType: 'text', labelIt: '', labelEn: '', helpIt: '', helpEn: '',
  required: false, vocabulary: '', inList: false, refTypes: [], formula: '', validationScript: '',
  tabella: emptyFormTable(),
}

/** Il campo esistente che si sta modificando: nome e tipo restano quelli. */
export interface CampoInModifica {
  id:        string
  name:      string
  fieldType: string
  label:     string
}

/**
 * L'INPUT DELLA MUTATION, ricavato dalla bozza. Sta qui perche lo usano tutti
 * e due i posti: se la libreria e il costruttore lo componessero ognuno per
 * conto suo, un campo creato dal costruttore potrebbe nascere senza l'aiuto o
 * senza lo script — e nessuno se ne accorgerebbe fino a compilare il modulo.
 */
/**
 * UN VOCABOLARIO PER NOME, quello che il server userà davvero.
 *
 * Il Dizionario può avere due definizioni con lo stesso `name`: quella spedita
 * col prodotto e la copia del tenant. Chi legge i valori — `loadVocabularyEntries`
 * sul server — preferisce la copia del tenant e ripiega sulla spedita. Questa
 * funzione fa la stessa scelta, perché una tendina che offre due righe uguali
 * promette una scelta che non esiste: qualunque riga si prenda, nel campo
 * finisce lo stesso nome.
 *
 * Ordinate per etichetta: in una tendina di venticinque voci è l'unico ordine
 * che si può cercare a occhio.
 */
/**
 * UNA RIGA DELLA LIBRERIA DIVENTA UNA BOZZA DA MODIFICARE.
 *
 * Stava scritta dentro il pulsante «Modifica» della libreria. Da quando lo
 * stesso editor si apre anche dal designer — si clicca un campo del modulo e
 * si cambiano le sue proprietà, non solo come sta in QUEL modulo — la
 * conversione serve in due posti, e due copie avrebbero divergito sul primo
 * campo nuovo (il `refTypes` di un riferimento è già dovuto passare di qui).
 */
export function bozzaDaCampo(c: {
  name: string; fieldType: string; label: string; help: string | null
  labels: ReadonlyArray<{ language: string; label: string }>
  helps: ReadonlyArray<{ language: string; label: string }>
  required: boolean; vocabulary: string | null; inList: boolean
  formula: string | null; validationScript: string | null
  tableDefinition?: string | null; refTypes?: string[]
}): Bozza {
  /* Il ripiego sull'etichetta BASE non è un vezzo: un campo può avere
     l'etichetta in una lingua sola, e mostrare vuoto farebbe cancellare
     l'altra al primo salvataggio. */
  const perLingua = (testi: ReadonlyArray<{ language: string; label: string }>, lingua: string, base: string | null) =>
    testi.find((l) => l.language === lingua)?.label ?? (base ?? '')
  const tabella = (() => {
    if (c.tableDefinition == null || c.tableDefinition === '') return emptyFormTable()
    try { return JSON.parse(c.tableDefinition) as FormTableDefinition } catch (err) {
      console.error(`FormField ${c.name}: table_definition cannot be read`, err)
      return emptyFormTable()
    }
  })()
  return {
    name: c.name, fieldType: c.fieldType,
    refTypes: c.refTypes ?? [],
    labelIt: perLingua(c.labels, 'it', c.label),
    labelEn: perLingua(c.labels, 'en', c.label),
    helpIt: perLingua(c.helps, 'it', c.help),
    helpEn: perLingua(c.helps, 'en', c.help),
    required: c.required, vocabulary: c.vocabulary ?? '', inList: c.inList,
    formula: c.formula ?? '', validationScript: c.validationScript ?? '',
    tabella,
  }
}

export function vocabolariUnici<T extends { name: string; label: string; isShipped?: boolean }>(
  vocabolari: readonly T[],
): T[] {
  const perNome = new Map<string, T>()
  for (const v of vocabolari) {
    const gia = perNome.get(v.name)
    // La copia del tenant vince, come sul server.
    if (!gia || (gia.isShipped === true && v.isShipped !== true)) perNome.set(v.name, v)
  }
  return [...perNome.values()].sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name))
}

export function inputDaBozza(b: Bozza, tipoEffettivo: string) {
  const testi = (it: string, en: string) =>
    [{ language: 'it', text: it }, { language: 'en', text: en }].filter((x) => x.text.trim() !== '')
  return {
    label: b.labelIt.trim() || b.labelEn.trim(),
    labels: testi(b.labelIt, b.labelEn),
    helps:  testi(b.helpIt, b.helpEn),
    required: b.required,
    inList: b.inList,
    // Vuoto = «togli»: l'API accetta la stringa vuota come «nessuna formula».
    formula: b.formula.trim(),
    validationScript: b.validationScript.trim(),
    // Le colonne solo per una tabella: mandarle su un altro tipo e un rifiuto
    // dell'API, e ha ragione lei.
    tableDefinition: isFormTableType(tipoEffettivo) ? JSON.stringify(b.tabella) : null,
    vocabulary: b.vocabulary || null,
    // Solo un `ref_ci` li porta: mandarli su un altro tipo è un rifiuto
    // dell'API, e ha ragione lei (un filtro che non filtra inganna).
    refTypes: tipoEffettivo === 'ref_ci' ? b.refTypes : [],
    help: b.helpIt.trim() || b.helpEn.trim() || null,
  }
}

export function FieldEditor({
  bozza, onBozza, inModifica, vocabolari, onSalva, onAnnulla, salvando, etichettaSalva,
  nomeDallEtichetta, nomiPresi, campiLeggibili,
}: {
  bozza: Bozza
  onBozza: (b: Bozza) => void
  inModifica?: CampoInModifica | null
  /** I vocabolari del Dizionario: `isShipped` distingue quelli di fabbrica dalle copie del tenant. */
  vocabolari: readonly { name: string; label: string; isShipped?: boolean }[]
  onSalva: () => void | Promise<void>
  onAnnulla: () => void
  salvando?: boolean
  etichettaSalva: string
  /** Propone il nome dall'etichetta finche nessuno lo scrive a mano. */
  nomeDallEtichetta?: boolean
  nomiPresi?: readonly string[]
  /** I campi che uno script può leggere: l'aiuto li elenca come `input.nome`. */
  campiLeggibili?: readonly { name: string; label: string }[]
}) {
  const { t } = useTranslation()
  const [nomeAMano, setNomeAMano] = useState(false)
  /* I tipi di CI servono solo a un `ref_ci`: la query si salta per tutti gli
     altri campi, che sono la maggioranza. */
  const { data: tipiData } = useQuery<{ ciTypes: Array<{ name: string; label: string; active: boolean }> }>(GET_CI_TYPES, {
    fetchPolicy: 'cache-first',
    skip: (inModifica?.fieldType ?? bozza.fieldType) !== 'ref_ci',
  })
  const tipiDiCI = (tipiData?.ciTypes ?? []).filter((x) => x.active)

  /**
   * Scrivere l'etichetta propone il nome. Solo nel costruttore, solo su un
   * campo nuovo, e solo finche il nome non e stato toccato: riscrivere sotto
   * le mani un identificatore che qualcuno ha appena deciso sarebbe peggio di
   * non proporlo affatto.
   */
  const scriviEtichetta = (quale: 'labelIt' | 'labelEn', valore: string) => {
    const b = { ...bozza, [quale]: valore }
    if (nomeDallEtichetta === true && !nomeAMano && !inModifica) {
      const primaria = (quale === 'labelIt' ? valore : b.labelIt).trim() || b.labelEn.trim() || valore.trim()
      b.name = primaria === '' ? '' : nomeDaEtichetta(primaria, nomiPresi ?? [])
    }
    onBozza(b)
  }

  /** I tipi che possono avere una FORMULA: valore singolo e proprieta del ticket. */
  function calcolabile(tipo: string): boolean { return canBeComputed(tipo) }
  /** I tipi che finiscono in una proprieta del ticket: gli unici che possono essere una colonna. */
  function comeProprieta(tipo: string): boolean {
    const proprieta: readonly string[] = FORM_FIELD_TYPES_AS_PROPERTY
    return proprieta.includes(tipo)
  }
  function conVocabolario(tipo: string): boolean {
    const conScelte: readonly string[] = FORM_FIELD_TYPES_WITH_VOCABULARY
    return conScelte.includes(tipo)
  }

  return (
    <>
        <div className="og-pair">
          <LabelledField label={t('pages.catalogForms.library.name')}>
            <Input
              value={inModifica ? inModifica.name : bozza.name}
              disabled={!!inModifica}
              placeholder="cost_centre"
              onChange={(e) => { setNomeAMano(true); onBozza({ ...bozza, name: e.target.value }) }}
            />
            <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
              {inModifica ? t('pages.catalogForms.library.nameFixed') : t('pages.catalogForms.library.nameHelp')}
            </p>
          </LabelledField>
          <LabelledField label={t('pages.catalogForms.library.type')}>
            <Select
              value={inModifica ? inModifica.fieldType : bozza.fieldType}
              disabled={!!inModifica}
              onChange={(e) => onBozza({ ...bozza, fieldType: e.target.value, vocabulary: conVocabolario(e.target.value) ? bozza.vocabulary : '' })}
            >
              {FORM_FIELD_TYPES.map((tipo) => (
                <option key={tipo} value={tipo}>{t(`pages.catalogForms.fieldType.${tipo}`)}</option>
              ))}
            </Select>
            {inModifica && (
              <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                {t('pages.catalogForms.library.typeFixed')}
              </p>
            )}
          </LabelledField>
        </div>

        <div className="og-pair" style={{ marginTop: 12 }}>
          <LabelledField label={t('pages.catalogForms.library.labelIt')}>
            <Input value={bozza.labelIt} onChange={(e) => { scriviEtichetta('labelIt', e.target.value) }} />
          </LabelledField>
          <LabelledField label={t('pages.catalogForms.library.labelEn')}>
            <Input value={bozza.labelEn} onChange={(e) => { scriviEtichetta('labelEn', e.target.value) }} />
          </LabelledField>
        </div>

        <div className="og-pair" style={{ marginTop: 12 }}>
          <LabelledField label={t('pages.catalogForms.library.helpIt')}>
            <Input value={bozza.helpIt} onChange={(e) => onBozza({ ...bozza, helpIt: e.target.value })} />
          </LabelledField>
          <LabelledField label={t('pages.catalogForms.library.helpEn')}>
            <Input value={bozza.helpEn} onChange={(e) => onBozza({ ...bozza, helpEn: e.target.value })} />
          </LabelledField>
        </div>

        {conVocabolario(inModifica?.fieldType ?? bozza.fieldType) && (
          <div style={{ marginTop: 12 }}>
            <LabelledField label={t('pages.catalogForms.library.vocabulary')}>
              <Select value={bozza.vocabulary} onChange={(e) => onBozza({ ...bozza, vocabulary: e.target.value })}>
                <option value="">{t('common.select')}</option>
                {/*
                  UNA RIGA PER VOCABOLARIO, NON DUE (18 set 2026).

                  La tendina mostrava «CI Status» due volte — quello di fabbrica
                  e la copia del tenant — e sembrava una scelta. Non lo è: il
                  campo salva il NOME (`ci_status`), e al momento di leggere i
                  valori il server prende comunque la copia del tenant, se c'è
                  (`loadVocabularyEntries`). Due righe con lo stesso nome sono
                  la stessa scelta scritta due volte.

                  Quindi si dedùplica per nome tenendo quella che il server
                  userà, e «di fabbrica» resta solo dove è VERO — cioè dove il
                  cliente non ha una sua copia: lì dice «questo non l'hai
                  personalizzato», che è un'informazione, non un doppione.
                */}
                {vocabolariUnici(vocabolari).map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.label || v.name} · {v.name}
                    {v.isShipped === true ? ` · ${t('pages.catalogForms.library.vocabularyShipped')}` : ''}
                  </option>
                ))}
              </Select>
              <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                {t('pages.catalogForms.library.vocabularyHelp')}
              </p>
            </LabelledField>
          </div>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
          <input type="checkbox" checked={bozza.required} onChange={(e) => onBozza({ ...bozza, required: e.target.checked })} />
          {t('pages.catalogForms.library.requiredByDefault')}
        </label>

        {/* Colonna nelle liste (ondata 4): la offriamo solo ai tipi che diventano
            una proprietà del ticket — l'API rifiuta gli altri, e una spunta che
            si può accendere per poi sentirsi dire no è una trappola. */}
        {comeProprieta(bozza.fieldType) && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
            <input type="checkbox" checked={bozza.inList} onChange={(e) => onBozza({ ...bozza, inList: e.target.checked })} style={{ marginTop: 3 }} />
            <span>
              {t('pages.catalogForms.library.inList')}
              <span style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                {t('pages.catalogForms.library.inListHelp')}
              </span>
            </span>
          </label>
        )}

        {/*
          I TIPI DI CI di un riferimento alla CMDB (18 set 2026). Senza, la
          ricerca offriva OGNI CI del tenant: «quale stampante?» proponeva
          anche i firewall. Nessuna spunta = tutta la CMDB, che è quello che
          facevano tutti i campi finora — quindi non cambia niente per chi non
          entra qui.
        */}
        {(inModifica?.fieldType ?? bozza.fieldType) === 'ref_ci' && (
          <div style={{ marginTop: 14 }}>
            <LabelledField label={t('pages.catalogForms.library.refTypes')}>
              <div style={{
                display: 'flex', flexWrap: 'wrap', gap: '6px 16px', maxHeight: 160, overflowY: 'auto',
                border: `1px solid ${colors.border}`, borderRadius: 8, padding: 10,
              }}>
                {tipiDiCI.length === 0 && (
                  <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                    {t('pages.catalogForms.library.refTypesNone')}
                  </span>
                )}
                {tipiDiCI.map((tipo) => (
                  <label key={tipo.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
                    <input
                      type="checkbox"
                      checked={bozza.refTypes.includes(tipo.name)}
                      onChange={(e) => {
                        onBozza({
                          ...bozza,
                          refTypes: e.target.checked
                            ? [...bozza.refTypes, tipo.name]
                            : bozza.refTypes.filter((x) => x !== tipo.name),
                        })
                      }}
                    />
                    {tipo.label || tipo.name}
                  </label>
                ))}
              </div>
              <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                {t('pages.catalogForms.library.refTypesHelp')}
              </p>
            </LabelledField>
          </div>
        )}

        {/* Le colonne, solo per una tabella (ondata 7). */}
        {isFormTableType(inModifica?.fieldType ?? bozza.fieldType) && (
          <TableColumnsEditor
            definizione={bozza.tabella}
            onChange={(d) => onBozza({ ...bozza, tabella: d })}
            vocabolari={vocabolari}
          />
        )}

        {/* La formula e la validazione (ondata 6): due caselle di codice, con
            i loro contratti e la prova. */}
        <ScriptFields
          formula={bozza.formula}
          onFormula={(v) => onBozza({ ...bozza, formula: v })}
          canCompute={calcolabile(inModifica?.fieldType ?? bozza.fieldType)}
          validationScript={bozza.validationScript}
          onValidationScript={(v) => onBozza({ ...bozza, validationScript: v })}
          campiLeggibili={campiLeggibili}
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={() => { void onSalva() }}
            style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: 'var(--color-brand)', color: colors.white, fontSize: 'var(--font-size-body)', fontWeight: fontWeight.medium, cursor: 'pointer' }}>
            {salvando ? t('common.saving') : etichettaSalva}
          </button>
          <button type="button" onClick={onAnnulla}
            style={{ padding: '7px 14px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.white, fontSize: 'var(--font-size-body)', cursor: 'pointer', color: 'var(--color-slate-dark)' }}>
            {t('common.cancel')}
          </button>
        </div>

    </>
  )
}
