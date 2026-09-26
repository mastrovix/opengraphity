/**
 * RUOLI (ondata 7 di «Nulla cablato»): l'elenco dei ruoli dell'organizzazione
 * con quanti permessi e quante persone ha ciascuno. Da qui si crea, si duplica,
 * si modifica e si elimina un ruolo. Le regole (nomi unici, ruoli di fabbrica
 * non eliminabili, almeno una persona che gestisce persone e ruoli) le applica
 * l'API; la pagina le rende visibili prima del clic.
 */
import { Loading } from '@/components/ui/Loading'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Copy, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { PERMISSIONS } from '@opengraphity/types'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { Button } from '@/components/Button'
import { Pill } from '@/components/ui/Pill'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { DELETE_ROLE } from '@/graphql/mutations'
import { useRoles, useRoleLabel, type RoleRow } from '@/hooks/useRoles'
import { useConfirm } from '@/hooks/useConfirm'
import { colors } from '@/lib/tokens'
import { showError } from '@/lib/showError'

/** A role as the list shows it: its key is the row id, its label the name shown. */
type RoleView = RoleRow & { id: string; label: string }

function IconAction({ label, onClick, to, disabled, title, children }: {
  label: string; onClick?: () => void; to?: string; disabled?: boolean; title?: string; children: React.ReactNode
}) {
  const style: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 6,
    border: `1px solid ${colors.border}`, background: 'var(--surface)', color: disabled ? colors.slateLight : colors.slate,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, textDecoration: 'none',
  }
  if (to && !disabled) return <Link to={to} aria-label={label} title={title ?? label} style={style}>{children}</Link>
  return <button type="button" aria-label={label} title={title ?? label} disabled={disabled} onClick={onClick} style={style}>{children}</button>
}

export function RolesPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const label = useRoleLabel()
  const { roles, loading, error, refetch } = useRoles()
  const [deleteRole] = useMutation(DELETE_ROLE)

  const onDelete = async (role: RoleRow) => {
    const ok = await confirm({ title: t('pages.roles.deleteTitle', { name: label(role) }), body: t('pages.roles.deleteBody'), danger: true, confirmLabel: t('pages.roles.delete') })
    if (!ok) return
    try {
      await deleteRole({ variables: { key: role.key } })
      toast.success(t('pages.roles.deleted'))
      void refetch()
    } catch (e) { showError(e) }
  }

  // The list is the app's table (26 Sep 2026: it was hand-made, with its own hover and a link on the name).
  const columns: ColumnDef<RoleView>[] = [
    { key: 'label', label: t('pages.roles.colRole'), sortable: true },
    { key: 'isFactory', label: t('pages.roles.colType'), sortable: true, render: (_v, role) => (
      <Pill bg={role.isFactory ? 'var(--color-slate-bg)' : 'var(--color-brand-light)'} color={role.isFactory ? colors.slate : colors.brandHover} radius={4} style={{ fontSize: 'var(--font-size-label)' }}>
        {role.isFactory ? t('pages.roles.factory') : t('pages.roles.custom')}
      </Pill>
    ) },
    { key: 'permissions', label: t('pages.roles.colPermissions'), render: (_v, role) => (
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{t('pages.roles.permissionsCount', { selected: role.permissions.length, total: PERMISSIONS.length })}</span>
    ) },
    { key: 'userCount', label: t('pages.roles.colPeople'), sortable: true, render: (_v, role) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{role.userCount}</span> },
    { key: 'id', label: t('common.actions'), sortable: false, render: (_v, role) => {
      const deleteBlocked = role.isFactory ? t('pages.roles.cannotDeleteFactory') : role.userCount > 0 ? t('pages.roles.cannotDeleteInUse') : null
      return (
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <IconAction label={t('pages.roles.edit')} to={`/roles/${role.key}`}><Pencil size={14} aria-hidden="true" /></IconAction>
          <IconAction label={t('pages.roles.duplicate')} to={`/roles/new?from=${encodeURIComponent(role.key)}`}><Copy size={14} aria-hidden="true" /></IconAction>
          <IconAction label={t('pages.roles.delete')} title={deleteBlocked ?? undefined} disabled={deleteBlocked !== null} onClick={() => void onDelete(role)}>
            <Trash2 size={14} aria-hidden="true" />
          </IconAction>
        </span>
      )
    } },
  ]

  return (
    <PageContainer style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <PageTitle icon={<KeyRound size={22} color="var(--color-icon-accent)" />}>{t('pages.roles.title')}</PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', margin: '4px 0 0', maxWidth: '80ch' }}>
            {t('pages.roles.subtitle')}
          </p>
        </div>
        <Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => navigate('/roles/new')}>{t('pages.roles.newRole')}</Button>
      </div>

      {error && <p role="alert" style={{ color: 'var(--color-danger-text)', margin: 0 }}>{t('pages.roles.loadError', { error: error.message })}</p>}
      {loading && <Loading />}

      {roles.length > 0 && (
        <SortableFilterTable<RoleView>
          label={t('pages.roles.title')}
          columns={columns}
          data={roles.map((r) => ({ ...r, id: r.key, label: label(r) }))}
          onRowClick={(r) => navigate(`/roles/${r.key}`)}
       />
      )}
    </PageContainer>
  )
}
