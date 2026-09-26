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
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { GET_SERVICE_CATALOG_ADMIN } from '@/graphql/queries'
import { CREATE_SERVICE_CATALOG_ITEM, UPDATE_SERVICE_CATALOG_ITEM } from '@/graphql/mutations'
import { useCrudModal } from '@/hooks/useCrudModal'
import { palette } from '@/lib/tokens'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { SeverityBadge } from '@/components/ui/badges'
import { showError } from '@/lib/showError'
import { TeamPicker } from '@/components/pickers/TeamPicker'
import { TEAM_TYPE } from '@/lib/teamVocabularies'
import { reloadQueries } from '@/lib/reloadQueries'

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
  /** The fulfilment group (D56): the requests of this item are born assigned to it; null = born without a team. */
  fulfillmentTeam: { id: string; name: string } | null
}

type FormState = { name: string; description: string; category: string; requiresApproval: boolean; priority: string; fulfillmentTeam: { id: string; name: string } | null }
// Nessuna priorità preselezionata: la sceglie l'amministratore per ogni voce (verifica «Cosa resta cablato», ondata 1).
const EMPTY_FORM: FormState = { name: '', description: '', category: '', requiresApproval: false, priority: '', fulfillmentTeam: null }
const itemToForm = (item: CatalogItem): FormState => ({
  name: item.name, description: item.description ?? '', category: item.category ?? '', requiresApproval: item.requiresApproval, priority: item.priority ?? '',
  fulfillmentTeam: item.fulfillmentTeam,
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
  const ids = { name: `${uid}-name`, description: `${uid}-description`, category: `${uid}-category`, approval: `${uid}-approval`, priority: `${uid}-priority`, team: `${uid}-team` }
  const { entriesOf } = useDomainVocabularies()
  const priorities = entriesOf('priority') ?? []
  const categories = entriesOf('category') ?? []
  const { labelOf } = useDomainVocabularies()

  const [createItem, { loading: creating }] = useMutation(CREATE_SERVICE_CATALOG_ITEM, {
    onCompleted: () => { modal.close(); toast.success(t('toast.catalog.created')); reloadQueries(refetch) },
    onError: (e) => showError(e),
  })
  const [updateItem, { loading: updating }] = useMutation(UPDATE_SERVICE_CATALOG_ITEM, {
    onCompleted: () => { modal.close(); reloadQueries(refetch) },
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
      // D56: null on an edit removes the group the item had.
      fulfillmentTeamId: form.fulfillmentTeam?.id ?? null,
    }
    if (!modal.open) return
    if (modal.editing) void updateItem({ variables: { id: modal.editing.id, input } })
    else void createItem({ variables: { input } })
  }

  const toggleActive = (item: CatalogItem) =>
    void updateItem({ variables: { id: item.id, input: { active: !item.active } } })

  const items = data?.serviceCatalogItems ?? []
  // The app's table (26 Sep 2026: it was hand-made). The row opens the item to edit.
  // `data-tone` keeps the red of what is missing: the table greys the rest.
  const columns: ColumnDef<CatalogItem>[] = [
    { key: 'name', label: t('common.name'), sortable: true, render: (_v, it) => (
      <>
        <div style={{ fontWeight: 600 }}>{it.name}</div>
        {it.description && <div style={{ marginTop: 2 }}>{it.description}</div>}
      </>
    ) },
    { key: 'category', label: t('pages.serviceCatalogAdmin.category'), sortable: true, sortValue: (it) => (it.category ? (labelOf('category', it.category) ?? it.category) : it.legacyCategory), render: (_v, it) => it.category
      ? (labelOf('category', it.category) ?? it.category)
      : it.legacyCategory
        ? <span data-tone="danger" title={t('pages.serviceCatalogAdmin.legacyCategoryHint')} style={{ color: 'var(--color-danger)' }}>{t('pages.serviceCatalogAdmin.legacyCategory', { text: it.legacyCategory })}</span>
        : '—' },
    { key: 'priority', label: t('pages.serviceCatalogAdmin.priority'), sortable: true, render: (_v, it) => it.priority
      ? <SeverityBadge value={it.priority} vocabulary="priority" />
      : <span data-tone="danger" style={{ color: 'var(--color-danger)' }}>{t('pages.serviceCatalogAdmin.priorityMissing')}</span> },
    { key: 'fulfillmentTeam', label: t('pages.serviceCatalogAdmin.fulfillmentTeam'), sortable: true, render: (_v, it) => it.fulfillmentTeam?.name ?? '—' },
    { key: 'requiresApproval', label: t('pages.changeDetail.approval'), render: (_v, it) => it.requiresApproval
      ? <Pill bg={palette.warning.tint} color={palette.warning.strong}>{t('pages.serviceCatalogAdmin.required')}</Pill>
      : t('common.no') },
    { key: 'active', label: t('common.status'), render: (_v, it) => it.active
      ? <Pill bg={palette.success.tint} color={palette.success.strong}>{t('pages.serviceCatalogAdmin.active')}</Pill>
      : <Pill bg="var(--color-border-light)" color="var(--color-slate)">{t('pages.serviceCatalogAdmin.inactive')}</Pill> },
    { key: 'id', label: t('common.actions'), sortable: false, render: (_v, it) => (
      <span style={{ whiteSpace: 'nowrap' }}>
        <Button variant="ghost" onClick={() => modal.openEdit(it)} style={{ marginRight: 6 }}>{t('common.edit')}</Button>
        <Button variant="secondary" size="xs" onClick={() => toggleActive(it)} disabled={saving}>
          {t(it.active ? 'pages.serviceCatalogAdmin.deactivate' : 'pages.serviceCatalogAdmin.activate')}
        </Button>
      </span>
    ) },
  ]
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
        <SortableFilterTable<CatalogItem>
          label={t('sidebar.serviceCatalog')}
          columns={columns}
          data={items}
          onRowClick={(it) => modal.openEdit(it)}
       />
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
        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor={ids.team}>{t('pages.serviceCatalogAdmin.fulfillmentTeam')}</FieldLabel>
          {/* D56: the support team that fulfils the requests of this item (searchable; emptied with the first choice). */}
          <TeamPicker
            role={TEAM_TYPE.SUPPORT}
            inputId={ids.team}
            label={t('pages.serviceCatalogAdmin.fulfillmentTeam')}
            clearLabel={t('pages.serviceCatalogAdmin.noFulfillmentTeam')}
            value={form.fulfillmentTeam}
            onChange={(team) => patch({ fulfillmentTeam: team })}
          />
          <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', lineHeight: 1.5 }}>
            {t('pages.serviceCatalogAdmin.fulfillmentTeamHint')}
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
