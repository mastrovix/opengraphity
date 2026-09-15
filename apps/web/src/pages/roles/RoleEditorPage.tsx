/**
 * UN RUOLO: il nome e i permessi, spuntati area per area (ondata 7 di «Nulla
 * cablato»). La stessa pagina crea (`/roles/new`, anche come copia di un altro
 * ruolo con `?from=`) e modifica (`/roles/:key`).
 *
 * Il catalogo dei permessi è del prodotto (`PERMISSION_CATALOG`): qui si sceglie
 * quali dare, con il nome e la spiegazione di ognuno. La chiave del ruolo nasce
 * dal nome alla creazione e poi non cambia.
 */
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Info, KeyRound, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { PERMISSION_AREAS, PERMISSION_CATALOG, PERMISSIONS, type Permission, type PermissionArea } from '@opengraphity/types'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { Button } from '@/components/Button'
import { Input, FieldLabel } from '@/components/ui/FormControls'
import { SectionCard } from '@/components/ui/SectionCard'
import { CREATE_ROLE, DELETE_ROLE, UPDATE_ROLE } from '@/graphql/mutations'
import { useConfirm } from '@/hooks/useConfirm'
import { GET_ROLES } from '@/graphql/queries'
import { useRoles, useRoleLabel, type RoleRow } from '@/hooks/useRoles'
import { colors } from '@/lib/tokens'
import { showError } from '@/lib/showError'

const permissionsOfArea = (area: PermissionArea): readonly Permission[] =>
  PERMISSION_CATALOG.filter((p) => p.area === area).map((p) => p.key)

function AreaCard({ area, selected, onChange }: { area: PermissionArea; selected: ReadonlySet<Permission>; onChange: (next: Set<Permission>) => void }) {
  const { t } = useTranslation()
  const perms = permissionsOfArea(area)
  const count = perms.filter((p) => selected.has(p)).length
  const all = count === perms.length
  const toggleAll = () => {
    const next = new Set(selected)
    for (const p of perms) { if (all) next.delete(p); else next.add(p) }
    onChange(next)
  }
  return (
    <SectionCard
      title={t(`permissions.areas.${area}`)}
      collapsible={false}
      headerRight={(
        <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 'var(--font-size-label)', color: colors.slate, fontVariantNumeric: 'tabular-nums' }}>
            {t('pages.roles.areaCount', { selected: count, total: perms.length })}
          </span>
          <Button variant="secondary" size="xs" onClick={toggleAll}>{all ? t('pages.roles.clearArea') : t('pages.roles.selectArea')}</Button>
        </span>
      )}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 4 }}>
        {perms.map((p) => {
          const id = `perm-${p}`
          const on = selected.has(p)
          const toggle = () => { const next = new Set(selected); if (on) next.delete(p); else next.add(p); onChange(next) }
          return (
            <div
              key={p}
              style={{
                display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8,
                background: on ? 'var(--color-brand-light)' : 'transparent', border: `1px solid ${on ? 'var(--color-brand)' : 'transparent'}`,
              }}
            >
              <input id={id} type="checkbox" checked={on} onChange={toggle} aria-describedby={`${id}-desc`}
                style={{ marginTop: 3, accentColor: 'var(--color-brand)', cursor: 'pointer' }} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <label htmlFor={id} style={{ fontWeight: 600, color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                  {t(`permissions.items.${p.replace('.', '_')}.label`)}
                </label>
                <span id={`${id}-desc`} style={{ color: colors.slate, fontSize: 'var(--font-size-label)', lineHeight: 1.45 }}>
                  {t(`permissions.items.${p.replace('.', '_')}.description`)}
                </span>
              </span>
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}

function Editor({ role, template }: { role: RoleRow | null; template: RoleRow | null }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const label = useRoleLabel()
  const source = role ?? template
  const [name, setName] = useState(role ? (role.name ?? '') : template ? t('pages.roles.copyOf', { name: label(template) }) : '')
  const [selected, setSelected] = useState<Set<Permission>>(() => new Set((source?.permissions ?? []).filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p))))
  const [createRole, { loading: creating }] = useMutation<{ createRole: RoleRow }>(CREATE_ROLE, { refetchQueries: [GET_ROLES] })
  const [updateRole, { loading: updating }] = useMutation<{ updateRole: RoleRow }>(UPDATE_ROLE, { refetchQueries: [GET_ROLES] })
  const [deleteRole, { loading: deleting }] = useMutation(DELETE_ROLE, { refetchQueries: [GET_ROLES] })
  const confirm = useConfirm()
  const busy = creating || updating || deleting
  // Giro UI del 15 set 2026: nel dettaglio di un ruolo personalizzato non c'era
  // modo di eliminarlo, solo un'icona nell'elenco. Stesse regole dell'elenco.
  const deleteBlocked = !role ? null : role.isFactory ? t('pages.roles.cannotDeleteFactory') : role.userCount > 0 ? t('pages.roles.cannotDeleteInUse') : null
  const remove = async () => {
    if (!role) return
    const ok = await confirm({ title: t('pages.roles.deleteTitle', { name: label(role) }), body: t('pages.roles.deleteBody'), danger: true, confirmLabel: t('pages.roles.delete') })
    if (!ok) return
    try {
      await deleteRole({ variables: { key: role.key } })
      toast.success(t('pages.roles.deleted'))
      navigate('/roles')
    } catch (e) { showError(e) }
  }
  const nameRequired = !role?.isFactory
  const nameMissing = nameRequired && name.trim() === ''
  const hadUsersAdmin = role?.permissions.includes('admin.users') ?? false

  const save = async () => {
    const input = { name: name.trim() === '' ? null : name.trim(), permissions: PERMISSIONS.filter((p) => selected.has(p)) }
    try {
      if (role) {
        await updateRole({ variables: { key: role.key, input } })
        toast.success(t('pages.roles.saved'))
      } else {
        await createRole({ variables: { input } })
        toast.success(t('pages.roles.created'))
      }
      navigate('/roles')
    } catch (e) { showError(e) }
  }

  return (
    <>
      <div style={{ background: 'var(--surface)', border: `1px solid ${colors.border}`, borderRadius: 10, padding: 20, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 280, flex: '1 1 320px', maxWidth: 480 }}>
          <FieldLabel htmlFor="role-name">{t('pages.roles.name')}</FieldLabel>
          <Input id="role-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)}
            placeholder={role?.isFactory ? t(`roles.${role.key}`, { defaultValue: role.key }) : undefined} />
          {role?.isFactory && (
            <span style={{ fontSize: 'var(--font-size-label)', color: colors.slate }}>{t('pages.roles.nameFactoryHint', { name: t(`roles.${role.key}`, { defaultValue: role.key }) })}</span>
          )}
        </div>
        {role && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <FieldLabel>{t('pages.roles.key')}</FieldLabel>
            <code style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', background: 'var(--color-slate-bg)', padding: '6px 10px', borderRadius: 6 }}>{role.key}</code>
            <span style={{ fontSize: 'var(--font-size-label)', color: colors.slate }}>{t('pages.roles.keyHint')}</span>
          </div>
        )}
        {role && (
          <span style={{ fontSize: 'var(--font-size-body)', color: colors.slate, marginLeft: 'auto' }}>
            {t('pages.roles.peopleWithRole', { count: role.userCount })}
          </span>
        )}
      </div>

      {!selected.has('workspace.use') && (
        <p role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, padding: '10px 14px', borderRadius: 8, background: 'var(--color-info-bg)', color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-body)' }}>
          <Info size={16} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--color-brand)' }} />
          {selected.size === 0 ? t('pages.roles.noPermissions') : t('pages.roles.portalOnlyHint')}
        </p>
      )}
      {hadUsersAdmin && !selected.has('admin.users') && (
        <p role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, padding: '10px 14px', borderRadius: 8, background: 'var(--color-warning-bg)', color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-body)' }}>
          <Info size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
          {t('pages.roles.usersAdminHint')}
        </p>
      )}

      <div>
        {PERMISSION_AREAS.map((area) => <AreaCard key={area} area={area} selected={selected} onChange={setSelected} />)}
      </div>

      <div style={{
        position: 'sticky', bottom: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
        background: 'var(--surface)', border: `1px solid ${colors.border}`, borderRadius: 10, boxShadow: 'var(--shadow-sm, none)',
      }}>
        <Button icon={<Save size={14} aria-hidden="true" />} disabled={busy || nameMissing} onClick={() => void save()}>{t('common.save')}</Button>
        <Button variant="secondary" onClick={() => navigate('/roles')}>{t('common.cancel')}</Button>
        {role && !role.isFactory && (
          <Button variant="danger" icon={<Trash2 size={14} aria-hidden="true" />} disabled={busy || deleteBlocked !== null} title={deleteBlocked ?? undefined} onClick={() => void remove()}>{t('pages.roles.delete')}</Button>
        )}
        <span style={{ fontSize: 'var(--font-size-body)', color: colors.slate, fontVariantNumeric: 'tabular-nums' }}>
          {t('pages.roles.permissionsCount', { selected: selected.size, total: PERMISSIONS.length })}
        </span>
      </div>
    </>
  )
}

export function RoleEditorPage() {
  const { t } = useTranslation()
  const { key } = useParams<{ key: string }>()
  const [params] = useSearchParams()
  const label = useRoleLabel()
  const { roles, loading, error } = useRoles()
  const isNew = key === undefined
  const role = useMemo(() => (isNew ? null : roles.find((r) => r.key === key) ?? null), [isNew, roles, key])
  const template = useMemo(() => {
    const from = params.get('from')
    return isNew && from ? roles.find((r) => r.key === from) ?? null : null
  }, [isNew, params, roles])
  const waitingTemplate = isNew && params.get('from') !== null && loading

  return (
    <PageContainer style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <Link to="/roles" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-label)', color: colors.brand, textDecoration: 'none', marginBottom: 8 }}>
          <ArrowLeft size={13} aria-hidden="true" /> {t('pages.roles.backToRoles')}
        </Link>
        <PageTitle icon={<KeyRound size={22} color="var(--color-icon-accent)" />}>
          {isNew ? t('pages.roles.newTitle') : role ? label(role) : t('pages.roles.editTitle')}
        </PageTitle>
      </div>
      {error && <p role="alert" style={{ color: 'var(--color-danger-text)', margin: 0 }}>{t('pages.roles.loadError', { error: error.message })}</p>}
      {(loading && !isNew) || waitingTemplate ? <p style={{ margin: 0 }}>{t('common.loading')}</p> : null}
      {!loading && !isNew && !role && !error && <p role="alert" style={{ margin: 0 }}>{t('errors.notFound', { entity: 'Role', id: key })}</p>}
      {(isNew ? !waitingTemplate : role !== null) && <Editor key={role?.key ?? `new-${template?.key ?? ''}`} role={role} template={template} />}
    </PageContainer>
  )
}
