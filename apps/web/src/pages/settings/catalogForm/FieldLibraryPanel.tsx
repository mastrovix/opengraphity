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
import {
  canBeComputed, emptyFormTable, FORM_FIELD_TYPES, FORM_FIELD_TYPES_AS_PROPERTY,
  FORM_FIELD_TYPES_WITH_VOCABULARY, isFormTableType, type FormTableDefinition,
} from '@opengraphity/types'
import { GET_CATALOG_FORM_LIMITS, GET_ENUM_TYPES, GET_FORM_FIELDS } from '@/graphql/queries'
import { CREATE_FORM_FIELD, DELETE_FORM_FIELD, UPDATE_FORM_FIELD } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { LimitsCard } from './LimitsCard'
import { ScriptFields } from './ScriptFields'
import { TableColumnsEditor } from './TableColumnsEditor'
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
  inList: boolean
  /** La formula di un campo calcolato, e lo script che rifiuta un valore (ondata 6). */
  formula: string | null
  validationScript: string | null
  /** Le colonne, se è una tabella: JSON come lo manda l'API (ondata 7). */
  tableDefinition: string | null
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
  inList: boolean
  formula: string
  validationScript: string
  /** Le colonne della tabella, già lette: il JSON lo ricuce chi salva. */
  tabella: FormTableDefinition
}

const BOZZA_VUOTA: Bozza = { name: '', fieldType: 'text', labelIt: '', labelEn: '', helpIt: '', helpEn: '', required: false, vocabulary: '', inList: false, formula: '', validationScript: '', tabella: emptyFormTable() }

/** Un'etichetta o un aiuto come li manda l'API: un testo per lingua. */
interface TestoPerLinguaLetto { language: string; label: string }

/**
 * IL TESTO DI UNA LINGUA quando si apre un campo per modificarlo, col ripiego
 * sull'etichetta BASE.
 *
 * Il difetto che ha reso necessario questo ripiego (visto dal vivo, e
 * causato da me): un campo può avere l'etichetta base in una lingua e
 * `labels` in un'altra — `costo_stimato` aveva base «Costo stimato (EUR)» e
 * `labels: {en: "Estimated cost (EUR)"}`. La casella italiana si apriva VUOTA,
 * e al salvataggio l'etichetta base veniva riscritta da quello che c'era nelle
 * caselle: l'italiano SPARIVA. Un modulo di modifica non deve perdere quello
 * che non ha saputo caricare.
 *
 * Con il ripiego la casella mostra quello che quella lingua MOSTRA DAVVERO —
 * il renderer fa lo stesso: se `labels` non ha la lingua, usa la base.
 */
function perLingua(
  // Il tipo ha un NOME perché il guardiano i18n legge `ReadonlyArray<{ … }>`
  // come un tag JSX e da lì prende per testo a schermo quello che segue.
  testi: readonly TestoPerLinguaLetto[],
  lingua: string,
  base: string | null,
): string {
  return testi.find((l) => l.language === lingua)?.label ?? (base ?? '')
}

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

  // `refetchQueries`: creare e cancellare cambiano il CONTEGGIO dei campi, che
  // la card dei tetti mostra con la sua query — senza questo direbbe «8 su 120»
  // con nove campi nella tabella sotto.
  const [crea] = useMutation(CREATE_FORM_FIELD, { onError: (e) => showError(e), refetchQueries: [GET_CATALOG_FORM_LIMITS] })
  const [aggiorna] = useMutation(UPDATE_FORM_FIELD, { onError: (e) => showError(e) })
  const [cancella] = useMutation(DELETE_FORM_FIELD, { onError: (e) => showError(e), refetchQueries: [GET_CATALOG_FORM_LIMITS] })

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
      inList: bozza.inList,
      // Vuoto = «togli»: l'API accetta la stringa vuota come «nessuna formula».
      formula: bozza.formula.trim(),
      validationScript: bozza.validationScript.trim(),
      // Le colonne solo per una tabella: mandarle su un altro tipo è un rifiuto
      // dell'API, e ha ragione lei.
      tableDefinition: isFormTableType(inModifica?.fieldType ?? bozza.fieldType) ? JSON.stringify(bozza.tabella) : null,
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

  /** I tipi che possono avere una FORMULA: valore singolo e proprietà del ticket. */
  function calcolabile(tipo: string): boolean {
    return canBeComputed(tipo)
  }

  /** I tipi che finiscono in una proprietà del ticket: gli unici che possono essere una colonna. */
  function comeProprieta(tipo: string): boolean {
    const proprieta: readonly string[] = FORM_FIELD_TYPES_AS_PROPERTY
    return proprieta.includes(tipo)
  }

  function conVocabolario(tipo: string): boolean {
    const conScelte: readonly string[] = FORM_FIELD_TYPES_WITH_VOCABULARY
    return conScelte.includes(tipo)
  }

  return (
    <div>
      <LimitsCard />

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

          {/* Colonna nelle liste (ondata 4): la offriamo solo ai tipi che diventano
              una proprietà del ticket — l'API rifiuta gli altri, e una spunta che
              si può accendere per poi sentirsi dire no è una trappola. */}
          {comeProprieta(bozza.fieldType) && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
              <input type="checkbox" checked={bozza.inList} onChange={(e) => setBozza({ ...bozza, inList: e.target.checked })} style={{ marginTop: 3 }} />
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
              onChange={(d) => setBozza({ ...bozza, tabella: d })}
              vocabolari={enumData?.enumTypes ?? []}
            />
          )}

          {/* La formula e la validazione (ondata 6): due caselle di codice, con
              i loro contratti e la prova. */}
          <ScriptFields
            formula={bozza.formula}
            onFormula={(v) => setBozza({ ...bozza, formula: v })}
            canCompute={calcolabile(inModifica?.fieldType ?? bozza.fieldType)}
            validationScript={bozza.validationScript}
            onValidationScript={(v) => setBozza({ ...bozza, validationScript: v })}
          />

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
              <th style={th}>{t('pages.catalogForms.library.inListShort')}</th>
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
                <td style={{ ...td, color: c.inList ? 'var(--color-slate-dark)' : 'var(--color-slate-light)' }}>
                  {c.inList ? t('common.yes') : t('common.no')}
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
                        // Il ripiego sull'etichetta BASE non è un vezzo: vedi `perLingua`.
                        labelIt: perLingua(c.labels, 'it', c.label),
                        labelEn: perLingua(c.labels, 'en', c.label),
                        helpIt: perLingua(c.helps, 'it', c.help),
                        helpEn: perLingua(c.helps, 'en', c.help),
                        required: c.required, vocabulary: c.vocabulary ?? '', inList: c.inList,
                        formula: c.formula ?? '', validationScript: c.validationScript ?? '',
                        tabella: c.tableDefinition ? (JSON.parse(c.tableDefinition) as FormTableDefinition) : emptyFormTable(),
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
              <tr><td style={{ ...td, color: 'var(--color-slate-light)', textAlign: 'center', padding: 28 }} colSpan={6}>{t('pages.catalogForms.library.empty')}</td></tr>
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
