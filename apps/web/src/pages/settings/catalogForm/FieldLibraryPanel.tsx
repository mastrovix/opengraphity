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
import { Button } from '@/components/Button'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@apollo/client/react'
import { Plus, Trash2, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { GET_CATALOG_FORM_LIMITS, GET_ENUM_TYPES, GET_FORM_FIELDS } from '@/graphql/queries'
import { CREATE_FORM_FIELD, DELETE_FORM_FIELD, UPDATE_FORM_FIELD } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { LimitsCard } from './LimitsCard'
import { FieldEditor, bozzaDaCampo, inputDaBozza, BOZZA_VUOTA, type Bozza } from './FieldEditor'
import { colors } from '@/lib/tokens'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'

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
  /** Condiviso nella libreria: compare fra i campi da riusare. */
  shared?: boolean
  /** La formula di un campo calcolato, e lo script che rifiuta un valore (ondata 6). */
  formula: string | null
  validationScript: string | null
  /** Le colonne, se è una tabella: JSON come lo manda l'API (ondata 7). */
  tableDefinition: string | null
  usedBy: string[]
  options: Array<{ value: string; label: string }>
}






export function FieldLibraryPanel() {
  const { t, i18n } = useTranslation()
  const { data, loading, refetch } = useQuery<{ formFields: FormFieldRow[] }>(GET_FORM_FIELDS, {
    variables: { language: i18n.language }, fetchPolicy: 'cache-and-network',
  })
  const { data: enumData } = useQuery<{ enumTypes: Array<{ name: string; label: string }> }>(GET_ENUM_TYPES, { fetchPolicy: 'cache-first' })
  const campi = data?.formFields ?? []
  const apri = (c: FormFieldRow) => { setInModifica(c); setBozza(bozzaDaCampo(c)) }
  const columns: ColumnDef<FormFieldRow>[] = [
    { key: 'label', label: t('pages.catalogForms.library.label'), sortable: true, render: (_v, c) => (
      <>
        {c.label}
        {c.required && <span data-tone="danger" style={{ color: 'var(--color-danger)', marginLeft: 3 }}>*</span>}
        {c.help && <div>{c.help}</div>}
      </>
    ) },
    { key: 'name', label: t('pages.catalogForms.library.name'), sortable: true, render: (_v, c) => <span style={{ fontFamily: 'var(--font-mono)' }}>{c.name}</span> },
    { key: 'fieldType', label: t('pages.catalogForms.library.type'), sortable: true, render: (_v, c) => (
      <>
        {t(`pages.catalogForms.fieldType.${c.fieldType}`)}
        {c.vocabulary && <div>{c.vocabulary}</div>}
      </>
    ) },
    { key: 'inList', label: t('pages.catalogForms.library.inListShort'), render: (_v, c) => (c.inList ? t('common.yes') : t('common.no')) },
    { key: 'usedBy', label: t('pages.catalogForms.library.usedBy'), render: (_v, c) => (c.usedBy.length === 0 ? t('pages.catalogForms.library.usedByNone') : c.usedBy.join(', ')) },
    { key: 'id', label: t('common.actions'), sortable: false, render: (_v, c) => (
      <span style={{ whiteSpace: 'nowrap' }}>
        <button type="button" onClick={() => apri(c)} aria-label={t('common.edit')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 4 }}>
          <Pencil size={14} />
        </button>
        <button type="button" onClick={() => setDaCancellare(c)} aria-label={t('common.delete')}
          style={{ background: 'none', border: 'none', cursor: c.usedBy.length > 0 ? 'not-allowed' : 'pointer', color: c.usedBy.length > 0 ? 'var(--color-slate-light)' : 'var(--color-danger)', padding: 4 }}
          disabled={c.usedBy.length > 0}
          title={c.usedBy.length > 0 ? t('pages.catalogForms.library.cannotDelete', { forms: c.usedBy.join(', ') }) : undefined}
        >
          <Trash2 size={14} />
        </button>
      </span>
    ) },
  ]

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
    try {
      if (inModifica) await aggiorna({ variables: { id: inModifica.id, input: comune } })
      else await crea({ variables: { input: { ...comune, name: bozza.name.trim(), fieldType: bozza.fieldType } } })
    } catch {
      // The mutation's onError has already told the user; the editor stays open with what was typed.
      return
    }
    toast.success(inModifica ? t('pages.catalogForms.library.saved') : t('pages.catalogForms.library.created'))
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
        <Button variant="primary"
          onClick={() => { setInModifica(null); setBozza(BOZZA_VUOTA) }}
        >
          <Plus size={14} /> {t('pages.catalogForms.library.add')}
        </Button>
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

      {/* The app's table (26 Sep 2026: it was hand-made). The row opens the field to edit. */}
      <SortableFilterTable<FormFieldRow>
        label={t('pages.catalogForms.tabs.library')}
        columns={columns}
        data={campi}
        loading={loading && !data}
        emptyMessage={t('pages.catalogForms.library.empty')}
        onRowClick={apri}
     />

      {daCancellare && (
        <ConfirmModal
          open
          danger
          title={t('pages.catalogForms.library.deleteTitle')}
          body={t('pages.catalogForms.library.deleteMessage', { name: daCancellare.label })}
          confirmLabel={t('common.delete')}
          onConfirm={async () => {
            try {
              await cancella({ variables: { id: daCancellare.id } })
            } catch {
              // The mutation's onError has already told the user; the question closes all the same.
              setDaCancellare(null)
              return
            }
            setDaCancellare(null)
            toast.success(t('pages.catalogForms.library.deleted'))
            void refetch()
          }}
          onCancel={() => setDaCancellare(null)}
        />
      )}
    </div>
  )
}
