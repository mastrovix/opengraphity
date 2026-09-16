/**
 * LA LIBRERIA DEI CAMPI dei moduli del catalogo (ondata 1).
 *
 * Perché una libreria e non campi propri di ogni voce: se ogni modulo
 * definisse i suoi, dieci moduli che chiedono il centro di costo darebbero
 * dieci proprietà diverse sui ticket e nessun report saprebbe sommarle. Qui il
 * campo si definisce UNA volta — tipo, etichette per lingua, aiuto,
 * vocabolario — e i moduli lo pescano.
 *
 * Due cose che la pagina DICE invece di lasciare scoprire:
 *  - il nome non si cambia, perché è il nome della proprietà sul ticket:
 *    rinominarlo perderebbe le risposte già raccolte;
 *  - un campo usato da un modulo non si cancella, e il rifiuto elenca i moduli
 *    (la colonna «usato da» lo mostra prima di provarci).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@apollo/client/react'
import { Plus, Trash2, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { FORM_FIELD_TYPES, FORM_FIELD_TYPES_WITH_VOCABULARY } from '@opengraphity/types'
import { GET_ENUM_TYPES, GET_FORM_FIELDS } from '@/graphql/queries'
import { CREATE_FORM_FIELD, DELETE_FORM_FIELD, UPDATE_FORM_FIELD } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { colors, fontWeight } from '@/lib/tokens'
import { Input, Select, LabelledField } from '@/components/ui/FormControls'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

export interface FormFieldRow {
  id: string
  name: string
  fieldType: string
  label: string
  labels: Array<{ language: string; label: string }>
  help: string | null
  helps: Array<{ language: string; label: string }>
  required: boolean
  vocabulary: string | null
  usedBy: string[]
  options: Array<{ value: string; label: string }>
}

interface Bozza {
  name: string
  fieldType: string
  labelIt: string
  labelEn: string
  helpIt: string
  helpEn: string
  required: boolean
  vocabulary: string
}

const BOZZA_VUOTA: Bozza = { name: '', fieldType: 'text', labelIt: '', labelEn: '', helpIt: '', helpEn: '', required: false, vocabulary: '' }

const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: `1px solid ${colors.border}` }
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', borderBottom: `1px solid ${colors.slateBg}`, verticalAlign: 'top' }

export function FieldLibraryPanel() {
  const { t, i18n } = useTranslation()
  const { data, loading, refetch } = useQuery<{ formFields: FormFieldRow[] }>(GET_FORM_FIELDS, {
    variables: { language: i18n.language }, fetchPolicy: 'cache-and-network',
  })
  const { data: enumData } = useQuery<{ enumTypes: Array<{ name: string; label: string }> }>(GET_ENUM_TYPES, { fetchPolicy: 'cache-first' })
  const campi = data?.formFields ?? []

  const [bozza, setBozza] = useState<Bozza | null>(null)
  const [inModifica, setInModifica] = useState<FormFieldRow | null>(null)
  const [daCancellare, setDaCancellare] = useState<FormFieldRow | null>(null)

  const [crea] = useMutation(CREATE_FORM_FIELD, { onError: (e) => showError(e) })
  const [aggiorna] = useMutation(UPDATE_FORM_FIELD, { onError: (e) => showError(e) })
  const [cancella] = useMutation(DELETE_FORM_FIELD, { onError: (e) => showError(e) })

  const chiudi = () => { setBozza(null); setInModifica(null) }

  const testiDa = (b: Bozza) => ({
    labels: [{ language: 'it', text: b.labelIt }, { language: 'en', text: b.labelEn }].filter((x) => x.text.trim() !== ''),
    helps: [{ language: 'it', text: b.helpIt }, { language: 'en', text: b.helpEn }].filter((x) => x.text.trim() !== ''),
  })

  const salva = async () => {
    if (!bozza) return
    const etichetta = bozza.labelIt.trim() || bozza.labelEn.trim()
    if (!etichetta) { toast.error(t('pages.catalogForms.library.labelNeeded')); return }
    const { labels, helps } = testiDa(bozza)
    const comune = {
      label: etichetta,
      labels, helps,
      required: bozza.required,
      vocabulary: bozza.vocabulary || null,
      help: bozza.helpIt.trim() || bozza.helpEn.trim() || null,
    }
    if (inModifica) {
      const r = await aggiorna({ variables: { id: inModifica.id, input: comune } })
      if (!r.data) return
      toast.success(t('pages.catalogForms.library.saved'))
    } else {
      const r = await crea({ variables: { input: { ...comune, name: bozza.name.trim(), fieldType: bozza.fieldType } } })
      if (!r.data) return
      toast.success(t('pages.catalogForms.library.created'))
    }
    chiudi()
    void refetch()
  }

  function conVocabolario(tipo: string): boolean {
    const conScelte: readonly string[] = FORM_FIELD_TYPES_WITH_VOCABULARY
    return conScelte.includes(tipo)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, gap: 16, flexWrap: 'wrap' }}>
        <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', maxWidth: '60ch' }}>
          {t('pages.catalogForms.library.intro')}
        </p>
        <button type="button"
          onClick={() => { setInModifica(null); setBozza(BOZZA_VUOTA) }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: 'none', background: 'var(--color-brand)', color: colors.white, fontSize: 'var(--font-size-body)', fontWeight: fontWeight.medium, cursor: 'pointer' }}
        >
          <Plus size={14} /> {t('pages.catalogForms.library.add')}
        </button>
      </div>

      {bozza && (
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 16, marginBottom: 16, background: colors.white }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <strong style={{ fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>
              {inModifica ? t('pages.catalogForms.library.editing', { name: inModifica.label }) : t('pages.catalogForms.library.newField')}
            </strong>
            <button type="button" onClick={chiudi} aria-label={t('common.cancel')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)' }}>
              <X size={16} />
            </button>
          </div>

          <div className="og-pair">
            <LabelledField label={t('pages.catalogForms.library.name')}>
              <Input
                value={inModifica ? inModifica.name : bozza.name}
                disabled={!!inModifica}
                placeholder="cost_centre"
                onChange={(e) => setBozza({ ...bozza, name: e.target.value })}
              />
              <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                {inModifica ? t('pages.catalogForms.library.nameFixed') : t('pages.catalogForms.library.nameHelp')}
              </p>
            </LabelledField>
            <LabelledField label={t('pages.catalogForms.library.type')}>
              <Select
                value={inModifica ? inModifica.fieldType : bozza.fieldType}
                disabled={!!inModifica}
                onChange={(e) => setBozza({ ...bozza, fieldType: e.target.value, vocabulary: conVocabolario(e.target.value) ? bozza.vocabulary : '' })}
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
              <Input value={bozza.labelIt} onChange={(e) => setBozza({ ...bozza, labelIt: e.target.value })} />
            </LabelledField>
            <LabelledField label={t('pages.catalogForms.library.labelEn')}>
              <Input value={bozza.labelEn} onChange={(e) => setBozza({ ...bozza, labelEn: e.target.value })} />
            </LabelledField>
          </div>

          <div className="og-pair" style={{ marginTop: 12 }}>
            <LabelledField label={t('pages.catalogForms.library.helpIt')}>
              <Input value={bozza.helpIt} onChange={(e) => setBozza({ ...bozza, helpIt: e.target.value })} />
            </LabelledField>
            <LabelledField label={t('pages.catalogForms.library.helpEn')}>
              <Input value={bozza.helpEn} onChange={(e) => setBozza({ ...bozza, helpEn: e.target.value })} />
            </LabelledField>
          </div>

          {conVocabolario(inModifica?.fieldType ?? bozza.fieldType) && (
            <div style={{ marginTop: 12 }}>
              <LabelledField label={t('pages.catalogForms.library.vocabulary')}>
                <Select value={bozza.vocabulary} onChange={(e) => setBozza({ ...bozza, vocabulary: e.target.value })}>
                  <option value="">{t('common.select')}</option>
                  {(enumData?.enumTypes ?? []).map((v) => <option key={v.name} value={v.name}>{v.label || v.name}</option>)}
                </Select>
                <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                  {t('pages.catalogForms.library.vocabularyHelp')}
                </p>
              </LabelledField>
            </div>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
            <input type="checkbox" checked={bozza.required} onChange={(e) => setBozza({ ...bozza, required: e.target.checked })} />
            {t('pages.catalogForms.library.requiredByDefault')}
          </label>

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" onClick={() => void salva()}
              style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: 'var(--color-brand)', color: colors.white, fontSize: 'var(--font-size-body)', fontWeight: fontWeight.medium, cursor: 'pointer' }}>
              {t('common.save')}
            </button>
            <button type="button" onClick={chiudi}
              style={{ padding: '7px 14px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.white, fontSize: 'var(--font-size-body)', cursor: 'pointer', color: 'var(--color-slate-dark)' }}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="og-scroll-x">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>{t('pages.catalogForms.library.label')}</th>
              <th style={th}>{t('pages.catalogForms.library.name')}</th>
              <th style={th}>{t('pages.catalogForms.library.type')}</th>
              <th style={th}>{t('pages.catalogForms.library.usedBy')}</th>
              <th style={th} aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {campi.map((c) => (
              <tr key={c.id}>
                <td style={td}>
                  {c.label}
                  {c.required && <span style={{ color: 'var(--color-danger)', marginLeft: 3 }}>*</span>}
                  {c.help && <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{c.help}</div>}
                </td>
                <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--color-slate)' }}>{c.name}</td>
                <td style={td}>
                  {t(`pages.catalogForms.fieldType.${c.fieldType}`)}
                  {c.vocabulary && <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{c.vocabulary}</div>}
                </td>
                <td style={td}>
                  {c.usedBy.length === 0
                    ? <span style={{ color: 'var(--color-slate-light)' }}>{t('pages.catalogForms.library.usedByNone')}</span>
                    : c.usedBy.join(', ')}
                </td>
                <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                  <button type="button"
                    onClick={() => {
                      setInModifica(c)
                      setBozza({
                        name: c.name, fieldType: c.fieldType,
                        labelIt: c.labels.find((l) => l.language === 'it')?.label ?? '',
                        labelEn: c.labels.find((l) => l.language === 'en')?.label ?? '',
                        helpIt: c.helps.find((l) => l.language === 'it')?.label ?? '',
                        helpEn: c.helps.find((l) => l.language === 'en')?.label ?? '',
                        required: c.required, vocabulary: c.vocabulary ?? '',
                      })
                    }}
                    aria-label={t('common.edit')}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 4 }}
                  >
                    <Pencil size={14} />
                  </button>
                  <button type="button" onClick={() => setDaCancellare(c)} aria-label={t('common.delete')}
                    style={{ background: 'none', border: 'none', cursor: c.usedBy.length > 0 ? 'not-allowed' : 'pointer', color: c.usedBy.length > 0 ? 'var(--color-slate-light)' : 'var(--color-danger)', padding: 4, opacity: c.usedBy.length > 0 ? 0.5 : 1 }}
                    disabled={c.usedBy.length > 0}
                    title={c.usedBy.length > 0 ? t('pages.catalogForms.library.cannotDelete', { forms: c.usedBy.join(', ') }) : undefined}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {!loading && campi.length === 0 && (
              <tr><td style={{ ...td, color: 'var(--color-slate-light)', textAlign: 'center', padding: 28 }} colSpan={5}>{t('pages.catalogForms.library.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {daCancellare && (
        <ConfirmModal
          open
          danger
          title={t('pages.catalogForms.library.deleteTitle')}
          body={t('pages.catalogForms.library.deleteMessage', { name: daCancellare.label })}
          confirmLabel={t('common.delete')}
          onConfirm={async () => {
            const r = await cancella({ variables: { id: daCancellare.id } })
            setDaCancellare(null)
            if (r.data) { toast.success(t('pages.catalogForms.library.deleted')); void refetch() }
          }}
          onCancel={() => setDaCancellare(null)}
        />
      )}
    </div>
  )
}
