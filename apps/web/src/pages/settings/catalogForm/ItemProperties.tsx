/**
 * LE PROPRIETÀ DI QUELLO CHE È SELEZIONATO SULLA TELA (18 set 2026).
 *
 * Nel costruttore nuovo la tela disegna il modulo e non lo configura: le
 * spunte — obbligatorio, mezza larghezza, visibile nel portale, la condizione —
 * stanno qui, nel modale che si apre selezionando un campo o una sezione.
 *
 * Il motivo è quello per cui il proprietario ha chiesto «qualcosa di più simile
 * a un designer»: con quattro controlli sotto ogni campo, dieci campi fanno
 * quaranta controlli, e la forma del modulo — l'ordine, le colonne, cosa è
 * obbligatorio — non si vede più. Le impostazioni non sparaiscono, si spostano
 * dove si guarda una cosa per volta.
 *
 * Questo file è solo il CONTENUTO: il riquadro, il velo e il centraggio li fa
 * `ModaleCentrato`, che porta le sue lezioni.
 */
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import {
  isFormReferenceType, larghezzaEffettiva, FORM_FIELD_TYPES_WITHOUT_ANSWER,
  type CatalogFormItem, type CatalogFormSection,
} from '@opengraphity/types'
import { Input, Select, LabelledField } from '@/components/ui/FormControls'
import { colors } from '@/lib/tokens'
import type { FormFieldRow } from './FieldLibraryPanel'

const bottone: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
  border: `1px solid ${colors.border}`, background: colors.white, cursor: 'pointer',
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
}

const spunta: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10,
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
}

/** Le proprietà di un CAMPO nel modulo. Il campo in sé (etichetta, tipo, script) sta in libreria. */
export function ProprietaVoce({
  item, campo, sezione, onItem, onRimuovi, editorCondizione,
}: {
  item: CatalogFormItem
  campo: FormFieldRow | undefined
  sezione: CatalogFormSection
  onItem: (v: CatalogFormItem) => void
  onRimuovi: () => void
  /** L'editor delle condizioni lo passa il pannello: conosce i soggetti possibili. */
  editorCondizione: React.ReactNode
}) {
  const { t } = useTranslation()
  const senzaRisposta = campo && (FORM_FIELD_TYPES_WITHOUT_ANSWER as readonly string[]).includes(campo.fieldType)

  return (
    <div>
      <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-table)', fontFamily: 'var(--font-mono)', color: 'var(--color-slate-light)' }}>
        {item.field} · {t(`pages.catalogForms.fieldType.${campo?.fieldType ?? 'text'}`)}
      </p>

      {/* Una nota non porta risposta: non può essere obbligatoria (l'API lo rifiuta). */}
      {!senzaRisposta && (
        <label style={spunta}>
          <input type="checkbox" checked={item.required ?? campo?.required ?? false}
            onChange={(e) => { onItem({ ...item, required: e.target.checked }) }} style={{ marginTop: 3 }} />
          <span>{t('pages.catalogForms.builder.required')}</span>
        </label>
      )}

      <label style={spunta}>
        {/* La spunta mostra la larghezza VERA: se la sezione è a due colonne,
            un campo che non dice niente è già a metà — e vederla spenta
            sarebbe una bugia. */}
        <input type="checkbox" checked={larghezzaEffettiva(sezione, item) === 'half'}
          onChange={(e) => { onItem({ ...item, width: e.target.checked ? 'half' : 'full' }) }} style={{ marginTop: 3 }} />
        <span>{t('pages.catalogForms.builder.halfWidth')}</span>
      </label>

      {campo && isFormReferenceType(campo.fieldType) ? (
        <p style={{ margin: '10px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
          {t('pages.catalogForms.builder.referenceStaffOnly')} — {t('pages.catalogForms.builder.referenceStaffOnlyWhy')}
        </p>
      ) : (
        <label style={spunta}>
          <input type="checkbox" checked={item.endUser !== false}
            onChange={(e) => { onItem({ ...item, endUser: e.target.checked }) }} style={{ marginTop: 3 }} />
          <span>{t('pages.catalogForms.builder.endUser')}</span>
        </label>
      )}

      <div style={{ marginTop: 14 }}>{editorCondizione}</div>

      <div style={{ marginTop: 18, borderTop: `1px solid ${colors.border}`, paddingTop: 12 }}>
        <button type="button" onClick={onRimuovi} style={{ ...bottone, color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}>
          <Trash2 size={13} /> {t('pages.catalogForms.builder.removeField')}
        </button>
        <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
          {t('pages.catalogForms.builder.removeFieldHelp')}
        </p>
      </div>
    </div>
  )
}

/** Le proprietà di una SEZIONE: titolo per lingua, colonne, e le larghezze in blocco. */
export function ProprietaSezione({
  sezione, lingue, onSezione, onRimuovi, onLarghezzaInBlocco,
}: {
  sezione: CatalogFormSection
  lingue: readonly string[]
  onSezione: (s: CatalogFormSection) => void
  onRimuovi: () => void
  onLarghezzaInBlocco: (l: 'full' | 'half') => void
}) {
  const { t } = useTranslation()

  return (
    <div>
      {/*
        IL TITOLO IN TUTTE LE LINGUE DEL PRODOTTO. Prima ce n'era una casella
        sola, in quella corrente, e l'altra lingua restava vuota senza che si
        vedesse: a schermo, per metà dei clienti, una sezione anonima. La
        pubblicazione ora le pretende entrambe.
      */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
        {lingue.map((codice) => (
          <LabelledField key={codice} label={t('pages.catalogForms.builder.sectionTitleIn', { language: codice.toUpperCase() })}>
            <Input
              value={(sezione.title as Record<string, string | undefined>)[codice] ?? ''}
              onChange={(e) => { onSezione({ ...sezione, title: { ...sezione.title, [codice]: e.target.value } }) }}
            />
          </LabelledField>
        ))}
      </div>

      <div style={{ marginTop: 12, maxWidth: 220 }}>
        <LabelledField label={t('pages.catalogForms.builder.columns')}>
          <Select
            value={String(sezione.columns ?? 1)}
            onChange={(e) => {
              const n = e.target.value === '2' ? 2 : 1
              onSezione(n === 1 ? { ...sezione, columns: undefined } : { ...sezione, columns: 2 })
            }}
          >
            <option value="1">{t('pages.catalogForms.builder.columnsOne')}</option>
            <option value="2">{t('pages.catalogForms.builder.columnsTwo')}</option>
          </Select>
        </LabelledField>
      </div>

      {/* La fatica vera erano dodici spunte, non la scelta. */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" style={bottone} onClick={() => { onLarghezzaInBlocco('half') }}>
          {t('pages.catalogForms.builder.allHalf')}
        </button>
        <button type="button" style={bottone} onClick={() => { onLarghezzaInBlocco('full') }}>
          {t('pages.catalogForms.builder.allFull')}
        </button>
      </div>

      <div style={{ marginTop: 18, borderTop: `1px solid ${colors.border}`, paddingTop: 12 }}>
        <button type="button" onClick={onRimuovi} style={{ ...bottone, color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}>
          <Trash2 size={13} /> {t('pages.catalogForms.builder.removeSection')}
        </button>
      </div>
    </div>
  )
}
