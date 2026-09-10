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

interface CatalogItem {
  id: string
  name: string
  description: string | null
  category: string | null
  requiresApproval: boolean
  active: boolean
  createdAt: string
}

type FormState = { name: string; description: string; category: string; requiresApproval: boolean }
const EMPTY_FORM: FormState = { name: '', description: '', category: '', requiresApproval: false }
const itemToForm = (item: CatalogItem): FormState => ({
  name: item.name, description: item.description ?? '', category: item.category ?? '', requiresApproval: item.requiresApproval,
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
  const ids = { name: `${uid}-name`, description: `${uid}-description`, category: `${uid}-category`, approval: `${uid}-approval` }

  const [createItem, { loading: creating }] = useMutation(CREATE_SERVICE_CATALOG_ITEM, {
    onCompleted: async () => { modal.close(); await refetch(); toast.success(t('toast.catalog.created')) },
    onError: (e) => toast.error(e.message),
  })
  const [updateItem, { loading: updating }] = useMutation(UPDATE_SERVICE_CATALOG_ITEM, {
    onCompleted: async () => { modal.close(); await refetch() },
    onError: (e) => toast.error(e.message),
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const input = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      category: form.category.trim() || null,
      requiresApproval: form.requiresApproval,
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
        <PageTitle icon={<ShoppingCart size={20} />}>Catalogo servizi</PageTitle>
        <Button icon={<Plus size={15} aria-hidden="true" />} onClick={modal.openCreate}>Nuova voce</Button>
      </div>

      {loading && !data && <Skeleton style={{ height: 240 }} />}
      {error && !data && <QueryError message={error.message} onRetry={() => void refetch()} />}

      {data && items.length === 0 && (
        <EmptyState icon={<ShoppingCart size={28} />} title="Nessuna voce di catalogo" description="Crea la prima voce che gli utenti potranno richiedere dal portale self-service." />
      )}

      {items.length > 0 && (
        <div style={{ border: '1px solid var(--color-border-light)', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
            <thead>
              <tr style={{ background: 'var(--surface-1)', textAlign: 'left', color: 'var(--color-slate-light)' }}>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>Nome</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>Categoria</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>Approvazione</th>
                <th style={{ padding: '10px 14px', fontWeight: 600 }}>Stato</th>
                <th style={{ padding: '10px 14px', fontWeight: 600, textAlign: 'right' }}>Azioni</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ fontWeight: 600, color: 'var(--color-slate-dark)' }}>{it.name}</div>
                    {it.description && <div style={{ color: 'var(--color-slate-light)', fontSize: 12, marginTop: 2 }}>{it.description}</div>}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--color-slate)' }}>{it.category ?? '—'}</td>
                  <td style={{ padding: '10px 14px' }}>
                    {it.requiresApproval
                      ? <Pill bg={palette.warning.tint} color={palette.warning.strong}>Richiesta</Pill>
                      : <span style={{ color: 'var(--color-slate-light)' }}>No</span>}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {it.active
                      ? <Pill bg={palette.success.tint} color={palette.success.strong}>Attiva</Pill>
                      : <Pill bg="var(--color-border-light)" color="var(--color-slate)">Disattivata</Pill>}
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Button variant="ghost" onClick={() => modal.openEdit(it)} style={{ marginRight: 6 }}>{t('common.edit')}</Button>
                    <Button variant="secondary" size="xs" onClick={() => toggleActive(it)} disabled={saving}>
                      {it.active ? 'Disattiva' : 'Attiva'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={modal.open}
        onClose={modal.close}
        title={modal.editing ? 'Modifica voce di catalogo' : 'Nuova voce di catalogo'}
        as="form"
        onSubmit={submit}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={modal.close}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={saving || form.name.trim().length === 0}>
              {saving ? 'Salvataggio…' : t('common.save')}
            </Button>
          </>
        }
      >
        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor={ids.name}>Nome *</FieldLabel>
          <Input
            id={ids.name}
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            required
            // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management del dialogo aperto dall'utente (Modal)
            autoFocus
            placeholder="Es. Nuovo laptop"
          />
        </div>
        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor={ids.description}>Descrizione</FieldLabel>
          <Textarea id={ids.description} value={form.description} onChange={(e) => patch({ description: e.target.value })} rows={3} placeholder="Cosa include il servizio…" />
        </div>
        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor={ids.category}>Categoria</FieldLabel>
          <Input id={ids.category} value={form.category} onChange={(e) => patch({ category: e.target.value })} placeholder="Es. Hardware, Accessi, Software" />
        </div>
        <div>
          <FieldLabel htmlFor={ids.approval}>Approvazione</FieldLabel>
          <Select id={ids.approval} value={form.requiresApproval ? 'yes' : 'no'} onChange={(e) => patch({ requiresApproval: e.target.value === 'yes' })}>
            <option value="no">Non richiede approvazione</option>
            <option value="yes">Richiede approvazione</option>
          </Select>
        </div>
      </Modal>
    </PageContainer>
  )
}
