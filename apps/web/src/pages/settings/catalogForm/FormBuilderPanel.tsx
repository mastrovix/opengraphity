/**
 * IL COSTRUTTORE del modulo di una voce di catalogo (ondata 1).
 *
 * Si scelgono la voce e poi le sezioni; dentro ogni sezione si pescano i campi
 * dalla LIBRERIA (non si creano qui: un campo è una proprietà dei ticket, e
 * nasce in libreria). Per ogni campo il modulo può sovrascrivere
 * obbligatorietà, larghezza, aiuto e la condizione che lo mostra.
 *
 * L'ANTEPRIMA usa lo STESSO componente che compilano l'area di lavoro e il
 * portale (`CatalogFormRenderer`), non una finta: quello che si vede qui è
 * quello che vedrà chi compila, condizioni comprese — si può rispondere
 * nell'anteprima e guardare i campi comparire. Il disegnatore dei tipi ITIL ha
 * un'anteprima che azzera gli script e rende un modulo piatto; questa no.
 *
 * SALVARE PUBBLICA. Non ci sono bozze nell'ondata 1: si salva e la revisione
 * sale. I ticket già compilati non cambiano, perché portano la loro revisione.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  CATALOG_FORM_VERSION, FORM_CONDITION_OPS, FORM_CONDITION_OPS_WITHOUT_VALUE, FORM_FIELD_TYPES_WITHOUT_ANSWER,
  emptyCatalogForm, localizedText,
  type CatalogFormDefinition, type CatalogFormItem, type CatalogFormSection,
  type FormAnswerValue, type FormAnswers, type FormCondition, type FormConditionOp,
} from '@opengraphity/types'
import { CatalogFormRenderer } from '@opengraphity/web-core'
import { GET_CATALOG_FORM, GET_FORM_FIELDS, GET_SERVICE_CATALOG_ADMIN } from '@/graphql/queries'
import { SAVE_CATALOG_FORM } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { colors, fontWeight } from '@/lib/tokens'
import { Input, Select } from '@/components/ui/FormControls'
import type { FormFieldRow } from './FieldLibraryPanel'

interface CatalogItem { id: string; name: string; active: boolean; category: string | null }

const bottone: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
  border: `1px solid ${colors.border}`, background: colors.white, cursor: 'pointer',
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
}
const iconaAzione: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 3 }

/** Un identificativo di sezione stabile e valido (minuscole, cifre, trattino basso). */
function idSezione(esistenti: readonly string[]): string {
  for (let i = 1; i < 999; i++) {
    const candidato = `section_${i}`
    if (!esistenti.includes(candidato)) return candidato
  }
  return `section_${Date.now()}`
}

export function FormBuilderPanel() {
  const { t, i18n } = useTranslation()
  const lingua = i18n.language

  const { data: catalogData } = useQuery<{ serviceCatalogItems: CatalogItem[] }>(GET_SERVICE_CATALOG_ADMIN, { fetchPolicy: 'cache-and-network' })
  const voci = (catalogData?.serviceCatalogItems ?? []).filter((v) => v.active)
  const [voceId, setVoceId] = useState('')
  useEffect(() => { if (!voceId && voci[0]) setVoceId(voci[0].id) }, [voci, voceId])

  const { data: libreriaData } = useQuery<{ formFields: FormFieldRow[] }>(GET_FORM_FIELDS, {
    variables: { language: lingua }, fetchPolicy: 'cache-and-network',
  })
  // `?? []` crea un array nuovo a ogni render: dentro le dipendenze di un
  // useMemo lo farebbe ricalcolare sempre (avviso react-hooks).
  const libreria = useMemo(() => libreriaData?.formFields ?? [], [libreriaData])
  const perNome = useMemo(() => {
    const m = new Map<string, FormFieldRow>()
    for (const f of libreria) m.set(f.name, f)
    return m
  }, [libreria])

  const { data: formData, refetch } = useQuery<{ catalogForm: { itemId: string; itemName: string; revision: number; definition: string } }>(
    GET_CATALOG_FORM, { variables: { itemId: voceId }, skip: !voceId, fetchPolicy: 'network-only' },
  )

  const [bozza, setBozza] = useState<CatalogFormDefinition>(emptyCatalogForm())
  const [toccato, setToccato] = useState(false)
  useEffect(() => {
    if (!formData?.catalogForm) return
    try { setBozza(JSON.parse(formData.catalogForm.definition) as CatalogFormDefinition) }
    catch { setBozza(emptyCatalogForm()) }
    setToccato(false)
  }, [formData])

  const [risposteAnteprima, setRisposteAnteprima] = useState<Record<string, FormAnswerValue>>({})
  const [salva, { loading: salvando }] = useMutation(SAVE_CATALOG_FORM, { onError: (e) => showError(e) })

  const cambia = (f: (d: CatalogFormDefinition) => CatalogFormDefinition) => {
    setBozza((d) => f(d))
    setToccato(true)
  }

  const sostituisciSezione = (indice: number, s: CatalogFormSection) =>
    cambia((d) => ({ ...d, sections: d.sections.map((x, i) => (i === indice ? s : x)) }))

  const sostituisciVoce = (iSez: number, iVoce: number, v: CatalogFormItem) =>
    cambia((d) => ({
      ...d,
      sections: d.sections.map((s, i) => (i !== iSez ? s : { ...s, items: s.items.map((x, j) => (j === iVoce ? v : x)) })),
    }))

  const usati = new Set(bozza.sections.flatMap((s) => s.items.map((i) => i.field)))
  const disponibili = libreria.filter((f) => !usati.has(f.name))
  /** I campi che una condizione può guardare: quelli già nel modulo, escluse le note (non hanno valore). */
  const soggettiCondizione = [...usati].filter((n) => {
    const f = perNome.get(n)
    return f && !(FORM_FIELD_TYPES_WITHOUT_ANSWER as readonly string[]).includes(f.fieldType)
  })

  const salvaModulo = async () => {
    const r = await salva({ variables: { itemId: voceId, definition: JSON.stringify({ ...bozza, version: CATALOG_FORM_VERSION }) } })
    if (!r.data) return
    toast.success(t('pages.catalogForms.builder.published', { revision: (r.data as { saveCatalogForm: { revision: number } }).saveCatalogForm.revision }))
    setToccato(false)
    void refetch()
  }

  if (voci.length === 0) {
    return <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('pages.catalogForms.builder.noItems')}</p>
  }

  return (
    <div className="og-split">
      {/* ── Il disegno ─────────────────────────────────────────────────── */}
      <div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
          <label style={{ flex: '1 1 220px', minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
              {t('pages.catalogForms.builder.item')}
            </span>
            <Select value={voceId} onChange={(e) => setVoceId(e.target.value)}>
              {voci.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
          </label>
          <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', paddingBottom: 8 }}>
            {formData?.catalogForm?.revision
              ? t('pages.catalogForms.builder.revision', { revision: formData.catalogForm.revision })
              : t('pages.catalogForms.builder.neverPublished')}
          </span>
          <button type="button" onClick={() => void salvaModulo()} disabled={salvando || !toccato}
            style={{ ...bottone, border: 'none', background: 'var(--color-brand)', color: colors.white, fontWeight: fontWeight.medium, padding: '7px 14px', opacity: salvando || !toccato ? 0.55 : 1, cursor: salvando || !toccato ? 'not-allowed' : 'pointer' }}>
            {salvando ? t('common.saving') : t('pages.catalogForms.builder.publish')}
          </button>
        </div>

        {bozza.sections.map((sezione, iSez) => (
          <div key={sezione.id} style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 14, marginBottom: 12, background: colors.white }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <Input
                value={localizedText(sezione.title, lingua, '')}
                placeholder={t('pages.catalogForms.builder.sectionTitle')}
                onChange={(e) => sostituisciSezione(iSez, { ...sezione, title: { ...sezione.title, [lingua]: e.target.value } })}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button type="button" aria-label={t('pages.catalogForms.builder.removeSection')}
                onClick={() => cambia((d) => ({ ...d, sections: d.sections.filter((_, i) => i !== iSez) }))}
                style={{ ...iconaAzione, color: 'var(--color-danger)' }}>
                <Trash2 size={14} />
              </button>
            </div>

            {sezione.items.length === 0 && (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 10px' }}>
                {t('pages.catalogForms.builder.sectionEmpty')}
              </p>
            )}

            {sezione.items.map((item, iVoce) => {
              const campo = perNome.get(item.field)
              const senzaRisposta = campo && (FORM_FIELD_TYPES_WITHOUT_ANSWER as readonly string[]).includes(campo.fieldType)
              return (
                <div key={item.field} style={{ borderTop: `1px solid ${colors.slateBg}`, padding: '10px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
                      {campo?.label ?? item.field}
                    </strong>
                    <span style={{ fontSize: 'var(--font-size-table)', fontFamily: 'var(--font-mono)', color: 'var(--color-slate-light)' }}>
                      {item.field} · {t(`pages.catalogForms.fieldType.${campo?.fieldType ?? 'text'}`)}
                    </span>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                      <button type="button" aria-label={t('pages.catalogForms.builder.moveUp')} disabled={iVoce === 0}
                        onClick={() => sostituisciSezione(iSez, { ...sezione, items: scambia(sezione.items, iVoce, iVoce - 1) })}
                        style={{ ...iconaAzione, opacity: iVoce === 0 ? 0.35 : 1 }}>
                        <ChevronUp size={14} />
                      </button>
                      <button type="button" aria-label={t('pages.catalogForms.builder.moveDown')} disabled={iVoce === sezione.items.length - 1}
                        onClick={() => sostituisciSezione(iSez, { ...sezione, items: scambia(sezione.items, iVoce, iVoce + 1) })}
                        style={{ ...iconaAzione, opacity: iVoce === sezione.items.length - 1 ? 0.35 : 1 }}>
                        <ChevronDown size={14} />
                      </button>
                      <button type="button" aria-label={t('pages.catalogForms.builder.removeField')}
                        onClick={() => sostituisciSezione(iSez, { ...sezione, items: sezione.items.filter((_, j) => j !== iVoce) })}
                        style={{ ...iconaAzione, color: 'var(--color-danger)' }}>
                        <Trash2 size={14} />
                      </button>
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
                    {/* Una nota non porta risposta: non può essere obbligatoria (l'API lo rifiuta). */}
                    {!senzaRisposta && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <input type="checkbox" checked={item.required ?? campo?.required ?? false}
                          onChange={(e) => sostituisciVoce(iSez, iVoce, { ...item, required: e.target.checked })} />
                        {t('pages.catalogForms.builder.required')}
                      </label>
                    )}
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <input type="checkbox" checked={item.width === 'half'}
                        onChange={(e) => sostituisciVoce(iSez, iVoce, { ...item, width: e.target.checked ? 'half' : 'full' })} />
                      {t('pages.catalogForms.builder.halfWidth')}
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <input type="checkbox" checked={item.endUser !== false}
                        onChange={(e) => sostituisciVoce(iSez, iVoce, { ...item, endUser: e.target.checked })} />
                      {t('pages.catalogForms.builder.endUser')}
                    </label>
                  </div>

                  <EditorCondizione
                    condizione={item.visibleWhen}
                    soggetti={soggettiCondizione.filter((n) => n !== item.field)}
                    etichettaDi={(n) => perNome.get(n)?.label ?? n}
                    onChange={(c) => sostituisciVoce(iSez, iVoce, c ? { ...item, visibleWhen: c } : omettiCondizione(item))}
                  />
                </div>
              )
            })}

            {disponibili.length > 0 && (
              <div style={{ borderTop: `1px solid ${colors.slateBg}`, paddingTop: 10, marginTop: 4 }}>
                <Select value="" aria-label={t('pages.catalogForms.builder.addField')}
                  onChange={(e) => {
                    if (!e.target.value) return
                    sostituisciSezione(iSez, { ...sezione, items: [...sezione.items, { field: e.target.value }] })
                  }}>
                  <option value="">{t('pages.catalogForms.builder.addField')}</option>
                  {disponibili.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
                </Select>
              </div>
            )}
          </div>
        ))}

        <button type="button" style={bottone}
          onClick={() => cambia((d) => ({ ...d, sections: [...d.sections, { id: idSezione(d.sections.map((s) => s.id)), title: {}, items: [] }] }))}>
          <Plus size={14} /> {t('pages.catalogForms.builder.addSection')}
        </button>

        {libreria.length === 0 && (
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 12 }}>
            {t('pages.catalogForms.builder.libraryEmpty')}
          </p>
        )}
      </div>

      {/* ── L'anteprima, col renderer vero ─────────────────────────────── */}
      <div>
        <h3 style={{ fontSize: 'var(--font-size-section-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 4px' }}>
          {t('pages.catalogForms.builder.preview')}
        </h3>
        <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', margin: '0 0 12px' }}>
          {t('pages.catalogForms.builder.previewHelp')}
        </p>
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 16, background: colors.white }}>
          <CatalogFormRenderer
            definition={bozza}
            fields={libreria}
            answers={risposteAnteprima as FormAnswers}
            onChange={(nome, valore) => setRisposteAnteprima((p) => ({ ...p, [nome]: valore }))}
            language={lingua}
            requiredLabel={t('forms.fieldRequired')}
            emptyChoiceLabel={t('common.select')}
            yesLabel={t('common.yes')}
            noLabel={t('common.no')}
          />
        </div>
      </div>
    </div>
  )
}

function scambia<T>(list: readonly T[], a: number, b: number): T[] {
  const out = [...list]
  const x = out[a]!, y = out[b]!
  out[a] = y; out[b] = x
  return out
}

/** Togliere la condizione vuol dire togliere la chiave: `undefined` non è JSON. */
function omettiCondizione(item: CatalogFormItem): CatalogFormItem {
  const { visibleWhen: _, ...resto } = item
  return resto
}

/**
 * L'editor di una condizione. Dichiarativa, non uno script: così si può
 * mostrare, spiegare e verificare — e il server la rivaluta con la stessa
 * funzione, senza eseguire codice del cliente.
 */
function EditorCondizione({ condizione, soggetti, etichettaDi, onChange }: {
  condizione?: FormCondition
  soggetti: readonly string[]
  etichettaDi: (name: string) => string
  onChange: (c: FormCondition | undefined) => void
}) {
  const { t } = useTranslation()
  const regole = condizione?.rules ?? []

  if (soggetti.length === 0 && regole.length === 0) return null

  return (
    <div style={{ marginTop: 8, paddingLeft: 10, borderLeft: `2px solid ${colors.slateBg}` }}>
      {regole.length === 0 ? (
        <button type="button" style={{ ...bottone, padding: '3px 8px', fontSize: 'var(--font-size-table)' }}
          onClick={() => onChange({ match: 'all', rules: [{ field: soggetti[0]!, op: 'eq', value: '' }] })}>
          <Plus size={12} /> {t('pages.catalogForms.builder.addCondition')}
        </button>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>
            <span>{t('pages.catalogForms.builder.showWhen')}</span>
            <Select value={condizione!.match} style={{ width: 'auto', padding: '2px 22px 2px 6px', fontSize: 'var(--font-size-table)' }}
              onChange={(e) => onChange({ ...condizione!, match: e.target.value as 'all' | 'any' })}>
              <option value="all">{t('pages.catalogForms.builder.matchAll')}</option>
              <option value="any">{t('pages.catalogForms.builder.matchAny')}</option>
            </Select>
          </div>
          {regole.map((regola, i) => (
            <div key={i} style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: 5, flexWrap: 'wrap' }}>
              <Select value={regola.field} style={{ width: 'auto', padding: '2px 22px 2px 6px', fontSize: 'var(--font-size-table)' }}
                onChange={(e) => onChange({ ...condizione!, rules: condizione!.rules.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)) })}>
                {soggetti.map((n) => <option key={n} value={n}>{etichettaDi(n)}</option>)}
              </Select>
              <Select value={regola.op} style={{ width: 'auto', padding: '2px 22px 2px 6px', fontSize: 'var(--font-size-table)' }}
                onChange={(e) => {
                  const op = e.target.value as FormConditionOp
                  const senzaValore = (FORM_CONDITION_OPS_WITHOUT_VALUE as readonly string[]).includes(op)
                  onChange({
                    ...condizione!,
                    rules: condizione!.rules.map((r, j) => (j === i ? (senzaValore ? { field: r.field, op } : { field: r.field, op, value: r.value ?? '' }) : r)),
                  })
                }}>
                {FORM_CONDITION_OPS.map((op) => <option key={op} value={op}>{t(`pages.catalogForms.conditionOp.${op}`)}</option>)}
              </Select>
              {!(FORM_CONDITION_OPS_WITHOUT_VALUE as readonly string[]).includes(regola.op) && (
                <Input value={regola.value ?? ''} style={{ width: 120, padding: '2px 6px', fontSize: 'var(--font-size-table)' }}
                  onChange={(e) => onChange({ ...condizione!, rules: condizione!.rules.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)) })} />
              )}
              <button type="button" aria-label={t('pages.catalogForms.builder.removeCondition')}
                onClick={() => {
                  const restanti = condizione!.rules.filter((_, j) => j !== i)
                  onChange(restanti.length === 0 ? undefined : { ...condizione!, rules: restanti })
                }}
                style={iconaAzione}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <button type="button" style={{ ...bottone, padding: '3px 8px', fontSize: 'var(--font-size-table)' }}
            onClick={() => onChange({ ...condizione!, rules: [...condizione!.rules, { field: soggetti[0]!, op: 'eq', value: '' }] })}>
            <Plus size={12} /> {t('pages.catalogForms.builder.addRule')}
          </button>
        </>
      )}
    </div>
  )
}
