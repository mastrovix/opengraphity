import { useId } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { ShoppingCart, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { QueryError } from '@/components/QueryError'
import { EmptyState } from '@/components/EmptyState'
import { Skeleton } from '@/components/ui/skeleton'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Input, Textarea, Select, FieldLabel } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import { GET_SERVICE_CATALOG_ADMIN } from '@/graphql/queries'
import { CREATE_SERVICE_CATALOG_ITEM, UPDATE_SERVICE_CATALOG_ITEM } from '@/graphql/mutations'
import { useCrudModal } from '@/hooks/useCrudModal'
import { palette } from '@/lib/tokens'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { SeverityBadge } from '@/components/ui/badges'
import { showError } from '@/lib/showError'

interface CatalogItem {
  id: string
  name: string
  description: string | null
  /** Un valore del vocabolario `category`, o null. */
  category: string | null
  /** La categoria scritta a mano prima del Dizionario, non convertita: da sostituire. */
  legacyCategory: string | null
  requiresApproval: boolean
  /** La priorità con cui nascono le richieste da questa voce (vocabolario `priority`); null = voce vecchia da sistemare. */
  priority: string | null
  active: boolean
  createdAt: string
}

type FormState = { name: string; description: string; category: string; requiresApproval: boolean; priority: string }
// Nessuna priorità preselezionata: la sceglie l'amministratore per ogni voce (verifica «Cosa resta cablato», ondata 1).
const EMPTY_FORM: FormState = { name: '', description: '', category: '', requiresApproval: false, priority: '' }
const itemToForm = (item: CatalogItem): FormState => ({
  name: item.name, description: item.description ?? '', category: item.category ?? '', requiresApproval: item.requiresApproval, priority: item.priority ?? '',
})

export function ServiceCatalogAdminPage() {
  const { t } = useTranslation()
  const { data, loading, error, refetch } = useQuery<{ serviceCatalogItems: CatalogItem[] }>(
    GET_SERVICE_CATALOG_ADMIN,
    { fetchPolicy: 'cache-and-network' },
  )
  const modal = useCrudModal<CatalogItem, FormState>(EMPTY_FORM, itemToForm)
  const { draft: form, patch } = modal
  const uid = useId()
  const ids = { name: `${uid}-name`, description: `${uid}-description`, category: `${uid}-category`, approval: `${uid}-approval`, priority: `${uid}-priority` }
  const { entriesOf } = useDomainVocabularies()
  const priorities = entriesOf('priority') ?? []
  const categories = entriesOf('category') ?? []
  const { labelOf } = useDomainVocabularies()

  const [createItem, { loading: creating }] = useMutation(CREATE_SERVICE_CATALOG_ITEM, {
    onCompleted: async () => { modal.close(); await refetch(); toast.success(t('toast.catalog.created')) },
    onError: (e) => showError(e),
  })
  const [updateItem, { loading: updating }] = useMutation(UPDATE_SERVICE_CATALOG_ITEM, {
    onCompleted: async () => { modal.close(); await refetch() },
    onError: (e) => showError(e),
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const input = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      category: form.category || null,
      requiresApproval: form.requiresApproval,
      priority: form.priority,
    }
    if (!modal.open) return
    if (modal.editing) void updateItem({ variables: { id: modal.editing.id, input } })
    else void createItem({ variables: { input } })
  }

  const toggleActive = (item: CatalogItem) =>
    void updateItem({ variables: { id: item.id, input: { active: !item.active } } })

  const items = data?.serviceCatalogItems ?? []
  const saving = creating || updating

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <PageTitle icon={<ShoppingCart size={22} color="var(--color-icon-accent)" />}>{t('sidebar.serviceCatalog')}</PageTitle>
        <Button icon={<Plus size={15} aria-hidden="true" />} onClick={modal.openCreate}>{t('pages.serviceCatalogAdmin.newItem')}</Button>
      </div>

      {loading && !data && <Skeleton style={{ height: 240 }} />}
      {error && !data && <QueryError message={error.message} onRetry={() => void refetch()} />}

      {data && items.length === 0 && (
        <EmptyState icon={<ShoppingCart size={28} />} title={t('pages.serviceCatalogAdmin.emptyTitle')} description={t('pages.serviceCatalogAdmin.emptyDescription')} />
      )}

      {items.length > 0 && (
        <div style={{ border: '1px solid var(--color-border-light)', overflow: 'hidden' }}>
          <div className="og-scroll-x">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th style={{ padding: '10px 14px' }}>{t('common.name')}</th>
                <th style={{ padding: '10px 14px' }}>{t('pages.serviceCatalogAdmin.category')}</th>
                <th style={{ padding: '10px 14px' }}>{t('pages.serviceCatalogAdmin.priority')}</th>
                <th style={{ padding: '10px 14px' }}>{t('pages.changeDetail.approval')}</th>
                <th style={{ padding: '10px 14px' }}>{t('common.status')}</th>
                <th style={{ padding: '10px 14px', textAlign: 'right' }}>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ fontWeight: 600, color: 'var(--color-slate-dark)' }}>{it.name}</div>
                    {it.description && <div style={{ color: 'var(--color-slate-light)', fontSize: 12, marginTop: 2 }}>{it.description}</div>}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--color-slate)' }}>
                    {it.category
                      ? (labelOf('category', it.category) ?? it.category)
                      : it.legacyCategory
                        ? <span title={t('pages.serviceCatalogAdmin.legacyCategoryHint')} style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-label)' }}>{t('pages.serviceCatalogAdmin.legacyCategory', { text: it.legacyCategory })}</span>
                        : '—'}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {it.priority
                      ? <SeverityBadge value={it.priority} vocabulary="priority" />
                      : <span style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-label)' }}>{t('pages.serviceCatalogAdmin.priorityMissing')}</span>}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {it.requiresApproval
                      ? <Pill bg={palette.warning.tint} color={palette.warning.strong}>{t('pages.serviceCatalogAdmin.required')}</Pill>
                      : <span style={{ color: 'var(--color-slate-light)' }}>No</span>}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {it.active
                      ? <Pill bg={palette.success.tint} color={palette.success.strong}>{t('pages.serviceCatalogAdmin.active')}</Pill>
                      : <Pill bg="var(--color-border-light)" color="var(--color-slate)">{t('pages.serviceCatalogAdmin.inactive')}</Pill>}
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Button variant="ghost" onClick={() => modal.openEdit(it)} style={{ marginRight: 6 }}>{t('common.edit')}</Button>
                    <Button variant="secondary" size="xs" onClick={() => toggleActive(it)} disabled={saving}>
                      {t(it.active ? 'pages.serviceCatalogAdmin.deactivate' : 'pages.serviceCatalogAdmin.activate')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </div>
      )}

      <Modal
        open={modal.open}
        onClose={modal.close}
        title={t(modal.editing ? 'pages.serviceCatalogAdmin.editTitle' : 'pages.serviceCatalogAdmin.createTitle')}
        as="form"
        onSubmit={submit}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={modal.close}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={saving || form.name.trim().length === 0 || form.priority === ''}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          </>
        }
      >
        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor={ids.name}>{t('pages.slaReport.nameRequired')}</FieldLabel>
          <Input
            id={ids.name}
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            required
            // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management del dialogo aperto dall'utente (Modal)
            autoFocus
            placeholder={t('pages.serviceCatalogAdmin.namePlaceholder')}
          />
        </div>
        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor={ids.description}>{t('common.description')}</FieldLabel>
          <Textarea id={ids.description} value={form.description} onChange={(e) => patch({ description: e.target.value })} rows={3} placeholder={t('pages.serviceCatalogAdmin.descriptionPlaceholder')} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor={ids.category}>{t('pages.serviceCatalogAdmin.category')}</FieldLabel>
          <Select id={ids.category} value={form.category} onChange={(e) => patch({ category: e.target.value })}>
            <option value="">{t('pages.serviceCatalogAdmin.noCategory')}</option>
            {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
          <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-label)', color: modal.editing?.legacyCategory ? 'var(--color-danger)' : 'var(--color-slate-light)', lineHeight: 1.5 }}>
            {modal.editing?.legacyCategory
              ? t('pages.serviceCatalogAdmin.legacyCategoryEdit', { text: modal.editing.legacyCategory })
              : t('pages.serviceCatalogAdmin.categoryHint')}
          </p>
        </div>
        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor={ids.priority}>{t('pages.serviceCatalogAdmin.priorityRequired')}</FieldLabel>
          <Select id={ids.priority} value={form.priority} onChange={(e) => patch({ priority: e.target.value })} required>
            <option value="" disabled>{t('pages.serviceCatalogAdmin.priorityPlaceholder')}</option>
            {priorities.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
          <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', lineHeight: 1.5 }}>
            {t('pages.serviceCatalogAdmin.priorityHint')}
          </p>
        </div>
        <div>
          <FieldLabel htmlFor={ids.approval}>{t('pages.changeDetail.approval')}</FieldLabel>
          <Select id={ids.approval} value={form.requiresApproval ? 'yes' : 'no'} onChange={(e) => patch({ requiresApproval: e.target.value === 'yes' })}>
            <option value="no">{t('pages.serviceCatalogAdmin.noApproval')}</option>
            <option value="yes">{t('pages.serviceCatalogAdmin.needsApproval')}</option>
          </Select>
        </div>
      </Modal>
    </PageContainer>
  )
}
