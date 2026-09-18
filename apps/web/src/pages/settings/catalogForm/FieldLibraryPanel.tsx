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
import { emptyFormTable, type FormTableDefinition } from '@opengraphity/types'
import { GET_CATALOG_FORM_LIMITS, GET_ENUM_TYPES, GET_FORM_FIELDS } from '@/graphql/queries'
import { CREATE_FORM_FIELD, DELETE_FORM_FIELD, UPDATE_FORM_FIELD } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { LimitsCard } from './LimitsCard'
import { FieldEditor, inputDaBozza, BOZZA_VUOTA, type Bozza } from './FieldEditor'
import { colors, fontWeight } from '@/lib/tokens'
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
  /** I tipi di CI ammessi da un `ref_ci`: vuoto = tutta la CMDB. */
  refTypes?: string[]
  /** La formula di un campo calcolato, e lo script che rifiuta un valore (ondata 6). */
  formula: string | null
  validationScript: string | null
  /** Le colonne, se è una tabella: JSON come lo manda l'API (ondata 7). */
  tableDefinition: string | null
  usedBy: string[]
  options: Array<{ value: string; label: string }>
}


/** Un'etichetta o un aiuto come li manda l'API: un testo per lingua. */
interface TestoPerLinguaLetto { language: string; label: string }

/**
 * LE COLONNE DI UNA TABELLA da modificare, lette dal documento della libreria.
 *
 * Due difetti in una riga (revisione del 17 set 2026). Il primo: la query non
 * chiedeva `tableDefinition`, quindi l'editor si apriva VUOTO e salvando si
 * mandava «nessuna colonna» — l'API rifiutava accusando una tabella che le
 * aveva, e un campo tabella era di fatto non modificabile. Il secondo: un
 * `JSON.parse` senza guardia, cioè un documento malformato nel grafo che fa
 * cadere la pagina invece di dire cosa non si capisce. Qui un documento
 * illeggibile diventa una tabella vuota E un errore in console: chi modifica
 * vede l'editor, non una schermata bianca.
 */
function colonneDi(c: FormFieldRow): FormTableDefinition {
  if (!c.tableDefinition) return emptyFormTable()
  try {
    return JSON.parse(c.tableDefinition) as FormTableDefinition
  } catch (err) {
    console.error(`FormField ${c.name}: table_definition cannot be read`, err)
    return emptyFormTable()
  }
}

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

  const salva = async () => {
    if (!bozza) return
    const comune = inputDaBozza(bozza, inModifica?.fieldType ?? bozza.fieldType)
    if (comune.label === '') { toast.error(t('pages.catalogForms.library.labelNeeded')); return }
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

          <FieldEditor
            bozza={bozza}
            onBozza={setBozza}
            inModifica={inModifica}
            vocabolari={enumData?.enumTypes ?? []}
            onSalva={salva}
            onAnnulla={chiudi}
            etichettaSalva={t('common.save')}
            campiLeggibili={campi.map((c) => ({ name: c.name, label: c.label }))}
          />
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
                        refTypes: c.refTypes ?? [],
                        labelIt: perLingua(c.labels, 'it', c.label),
                        labelEn: perLingua(c.labels, 'en', c.label),
                        helpIt: perLingua(c.helps, 'it', c.help),
                        helpEn: perLingua(c.helps, 'en', c.help),
                        required: c.required, vocabulary: c.vocabulary ?? '', inList: c.inList,
                        formula: c.formula ?? '', validationScript: c.validationScript ?? '',
                        tabella: colonneDi(c),
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
