/**
 * I ruoli dell'organizzazione (ondata 7 di «Nulla cablato») e come si chiamano.
 * Un ruolo di fabbrica mai rinominato ha `name: null` e si traduce dalla chiave
 * (`roles.<chiave>`); un ruolo creato dall'admin ha il suo nome.
 */
import { useCallback } from 'react'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { GET_ROLES } from '@/graphql/queries'
import { useMe } from '@/hooks/useMe'

export interface RoleRow {
  key:         string
  name:        string | null
  permissions: string[]
  isFactory:   boolean
  userCount:   number
}

/** Il nome da mostrare di un ruolo. */
export function useRoleLabel() {
  const { t } = useTranslation()
  return useCallback((role: { key: string; name: string | null; isFactory?: boolean } | null | undefined): string => {
    if (!role) return '—'
    if (role.name) return role.name
    return t(`roles.${role.key}`, { defaultValue: role.key })
  }, [t])
}

export function useRoles() {
  const { can } = useMe()
  // Chi assegna ruoli e chi indirizza notifiche «per ruolo»: gli stessi permessi dell'API.
  const mayRead = can('admin.users', 'config.notifications', 'config.workflow', 'config.automation')
  const { data, loading, error, refetch } = useQuery<{ roles: RoleRow[] }>(GET_ROLES, { skip: !mayRead, fetchPolicy: 'cache-and-network' })
  const label = useRoleLabel()
  const roles = data?.roles ?? []
  return {
    roles,
    loading: loading && !data,
    error: error ?? null,
    refetch,
    /** Il nome di un ruolo per chiave; la chiave stessa se il ruolo non è fra quelli caricati. */
    labelOf: (key: string | null | undefined) => {
      if (!key) return '—'
      const role = roles.find((r) => r.key === key)
      return role ? label(role) : label({ key, name: null })
    },
  }
}
