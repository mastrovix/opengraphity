/**
 * Current user as seen by the API (`me`): the role and its permissions come
 * from the DB via `me.role` / `me.permissions`, NOT from the Keycloak realm
 * roles — the single source of truth for every UI decision (route guards,
 * Sidebar, pages).
 *
 * Wave 7 of «Nulla cablato»: what a person may see and do is decided by the
 * PERMISSIONS of their role, which the organization chooses. Pages ask
 * `can('config.monitoring')`, never `role === 'admin'`.
 *
 * One query document (GET_ME) + `cache-first`: Apollo deduplicates in-flight
 * requests and serves every later caller from the cache, so mounting the hook
 * in N components costs one network round-trip.
 */
import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { isPermission, type Permission } from '@opengraphity/types'
import { GET_ME } from '@/graphql/queries'

export interface Me {
  id:      string
  name:    string
  email:   string
  /** Key of the person's role (a factory role or one the organization created). */
  role:    string
  /** The name the organization gave the role (null: a factory role never renamed). */
  roleName: string | null
  /** Permissions of that role. */
  permissions: string[]
  slackId: string | null
  /** Riceve le e-mail di notifica (null = nessun utente nel grafo per questa identità). */
  emailNotifications: boolean | null
  teams:   { id: string; name: string }[]
}

const NONE: ReadonlySet<Permission> = new Set()

export function useMe() {
  const { data, loading, error, refetch } = useQuery<{ me: Me | null }>(GET_ME, { fetchPolicy: 'cache-first' })
  const me = data?.me ?? null
  const permissions = useMemo<ReadonlySet<Permission>>(
    () => (me ? new Set(me.permissions.filter(isPermission)) : NONE),
    [me],
  )
  return {
    me,
    role:    me?.role ?? null,
    permissions,
    /** True when the role has AT LEAST ONE of these permissions (false while `me` loads). */
    can:     (...anyOf: Permission[]) => anyOf.some((p) => permissions.has(p)),
    loading,
    error:   error ?? null,
    refetch,
  }
}
