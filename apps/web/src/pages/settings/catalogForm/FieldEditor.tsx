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
import {
  canBeComputed, emptyFormTable, FORM_FIELD_TYPES, FORM_FIELD_TYPES_AS_PROPERTY,
  FORM_FIELD_TYPES_WITH_VOCABULARY, isFormTableType, nomeDaEtichetta, type FormTableDefinition,
} from '@opengraphity/types'
import { ScriptFields } from './ScriptFields'
import { TableColumnsEditor } from './TableColumnsEditor'
import { colors, fontWeight } from '@/lib/tokens'
import { Input, Select, LabelledField } from '@/components/ui/FormControls'

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
  formula: string
  validationScript: string
  /** Le colonne della tabella, gia lette: il JSON lo ricuce chi salva. */
  tabella: FormTableDefinition
}

export const BOZZA_VUOTA: Bozza = {
  name: '', fieldType: 'text', labelIt: '', labelEn: '', helpIt: '', helpEn: '',
  required: false, vocabulary: '', inList: false, formula: '', validationScript: '',
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
    help: b.helpIt.trim() || b.helpEn.trim() || null,
  }
}

export function FieldEditor({
  bozza, onBozza, inModifica, vocabolari, onSalva, onAnnulla, salvando, etichettaSalva,
  nomeDallEtichetta, nomiPresi,
}: {
  bozza: Bozza
  onBozza: (b: Bozza) => void
  inModifica?: CampoInModifica | null
  vocabolari: readonly { name: string; label: string }[]
  onSalva: () => void | Promise<void>
  onAnnulla: () => void
  salvando?: boolean
  etichettaSalva: string
  /** Propone il nome dall'etichetta finche nessuno lo scrive a mano. */
  nomeDallEtichetta?: boolean
  nomiPresi?: readonly string[]
}) {
  const { t } = useTranslation()
  const [nomeAMano, setNomeAMano] = useState(false)

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
                {vocabolari.map((v) => <option key={v.name} value={v.name}>{v.label || v.name}</option>)}
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
