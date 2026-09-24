/**
 * THE NAMES OF PEOPLE ALREADY CHOSEN (review of 23 Sep 2026).
 *
 * The automation editors and their preview downloaded every person of the
 * organization — 3,001 on the demo tenant, at every opening of a rule — only
 * to show the name of the one or two a rule names. This asks for those ids
 * and nothing else.
 */
import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_USERS_BY_IDS } from '@/graphql/queries'

export interface NamedUser { id: string; name: string; email: string; active: boolean }

export function useUserNames(ids: readonly string[]): { byId: ReadonlyMap<string, NamedUser>; error: Error | null } {
  const wanted = useMemo(() => [...new Set(ids.filter((id) => id !== ''))].sort(), [ids])
  const { data, error } = useQuery<{ usersByIds: NamedUser[] }>(GET_USERS_BY_IDS, {
    variables: { ids: wanted },
    skip: wanted.length === 0,
  })
  const byId = useMemo(() => new Map((data?.usersByIds ?? []).map((u) => [u.id, u])), [data])
  return { byId, error: error ?? null }
}
