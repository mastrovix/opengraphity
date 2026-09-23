/**
 * THE NEW SERVICE REQUEST, created without leaving the designer (see «LA VOCE
 * DI CATALOGO SI CREA DA QUI» in `FormBuilderPanel`).
 *
 * It asks the minimum the catalog requires — name and priority — plus the two
 * things decided at the start and not later: the category (the workflow the
 * request follows depends on it) and whether it needs an approval.
 *
 * The draft is the panel's, because the AI designer fills it in too; creating
 * the item is this modal's. Once the item exists the panel takes over: it
 * closes this modal, reads the list again and opens the new item.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@apollo/client/react'
import { CREATE_SERVICE_CATALOG_ITEM } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { colors, fontWeight } from '@/lib/tokens'
import { Input, LabelledField, Select } from '@/components/ui/FormControls'
import { ModaleCentrato } from './ModaleCentrato'

/** A catalog item as the builder lists it — and as this modal hands a new one over. */
export interface CatalogItem { id: string; name: string; active: boolean; category: string | null }

/** What is being written for the new item, before it exists. */
export interface NewItemDraft { name: string; description: string; category: string; priority: string; requiresApproval: boolean }

const bottone: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
  border: `1px solid ${colors.border}`, background: colors.white, cursor: 'pointer',
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
}

export function NewItemModal({ draft, onDraft, onClose, onCreated }: {
  draft: NewItemDraft
  onDraft: (d: NewItemDraft) => void
  /** Leaving without creating anything. */
  onClose: () => void
  /** The item exists: the panel closes this modal and opens it. */
  onCreated: (item: CatalogItem) => Promise<void>
}) {
  const { t } = useTranslation()
  const { entriesOf } = useDomainVocabularies()
  const [creating, setCreating] = useState(false)
  const [createItem] = useMutation(CREATE_SERVICE_CATALOG_ITEM, { onError: (e) => showError(e) })
  const ready = draft.name.trim() !== '' && draft.priority !== ''

  const create = async () => {
    setCreating(true)
    let r: Awaited<ReturnType<typeof createItem>>
    try {
      r = await createItem({ variables: { input: {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        category: draft.category || null,
        priority: draft.priority,
        requiresApproval: draft.requiresApproval,
      } } })
    } catch {
      // The mutation's onError has already told the user; the modal stays open with what they wrote.
      setCreating(false)
      return
    }
    setCreating(false)
    await onCreated((r.data as { createServiceCatalogItem: CatalogItem }).createServiceCatalogItem)
  }

  return (
    <ModaleCentrato
      titolo={t('pages.catalogForms.builder.newItemTitle')}
      sottotitolo={t('pages.catalogForms.builder.newItemHelp')}
      largo={560}
      onChiudi={onClose}
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <LabelledField label={t('pages.catalogForms.builder.newItemName')}>
          <Input value={draft.name} onChange={(e) => { onDraft({ ...draft, name: e.target.value }) }} />
        </LabelledField>
        <LabelledField label={t('pages.catalogForms.builder.newItemDescription')}>
          <Input value={draft.description} onChange={(e) => { onDraft({ ...draft, description: e.target.value }) }} />
        </LabelledField>
        <div className="og-pair">
          {/* La CATEGORIA non e un'etichetta: da lei dipende quale workflow
              segue la richiesta, se questa voce non ne fissa uno suo. */}
          <LabelledField label={t('pages.catalogForms.builder.newItemCategory')}>
            <Select value={draft.category} onChange={(e) => { onDraft({ ...draft, category: e.target.value }) }}>
              <option value="">{t('common.select')}</option>
              {(entriesOf('category') ?? []).map((v) => <option key={v.value} value={v.value}>{v.label || v.value}</option>)}
            </Select>
          </LabelledField>
          <LabelledField label={t('pages.catalogForms.builder.newItemPriority')}>
            <Select value={draft.priority} onChange={(e) => { onDraft({ ...draft, priority: e.target.value }) }}>
              <option value="">{t('common.select')}</option>
              {(entriesOf('priority') ?? []).map((v) => <option key={v.value} value={v.value}>{v.label || v.value}</option>)}
            </Select>
          </LabelledField>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
          <input type="checkbox" checked={draft.requiresApproval}
            onChange={(e) => { onDraft({ ...draft, requiresApproval: e.target.checked }) }} />
          {t('pages.catalogForms.builder.newItemApproval')}
        </label>

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            disabled={!ready || creating}
            onClick={() => { void create() }}
            style={{
              padding: '7px 14px', borderRadius: 8, border: 'none',
              background: ready ? 'var(--color-brand)' : 'var(--color-surface-alt)',
              color: ready ? colors.white : 'var(--color-slate-light)',
              fontSize: 'var(--font-size-body)', fontWeight: fontWeight.medium,
              cursor: ready && !creating ? 'pointer' : 'not-allowed',
            }}
          >
            {creating ? t('common.saving') : t('pages.catalogForms.builder.newItemCreate')}
          </button>
          <button type="button" onClick={onClose} style={bottone}>{t('common.cancel')}</button>
        </div>
      </div>
    </ModaleCentrato>
  )
}
