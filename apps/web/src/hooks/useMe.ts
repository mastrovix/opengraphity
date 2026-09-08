/**
 * Current user as seen by the API (`me`): the role comes from the DB via
 * `me.role`, NOT from the Keycloak realm roles — this is the single source of
 * truth for every role-based UI decision (route guards, Sidebar, pages).
 *
 * One query document (GET_ME) + `cache-first`: Apollo deduplicates in-flight
 * requests and serves every later caller from the cache, so mounting the hook
 * in N components costs one network round-trip.
 */
import { useQuery } from '@apollo/client/react'
import { GET_ME } from '@/graphql/queries'

export type UserRole = 'admin' | 'operator' | 'viewer' | 'end_user'

export const ALL_ROLES: readonly UserRole[] = ['admin', 'operator', 'viewer', 'end_user']

export interface Me {
  id:      string
  name:    string
  email:   string
  /** Role stored in the DB (`admin | operator | viewer | end_user`). */
  role:    string
  slackId: string | null
  teams:   { id: string; name: string }[]
}

export function useMe() {
  const { data, loading, error, refetch } = useQuery<{ me: Me | null }>(GET_ME, { fetchPolicy: 'cache-first' })
  const me = data?.me ?? null
  return {
    me,
    role:    me?.role ?? null,
    isAdmin: me?.role === 'admin',
    loading,
    error:   error ?? null,
    refetch,
  }
}
