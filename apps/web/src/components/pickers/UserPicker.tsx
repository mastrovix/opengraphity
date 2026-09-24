/**
 * A PERSON, CHOSEN AMONG THOSE WHO CAN DO THE JOB (D21, tour of 23 Sep 2026).
 *
 * The «Change owner» of a new change offered all 3,001 people of the demo
 * tenant, 1,700 end users among them, in a plain select. The owner of a change
 * is someone who works on changes: the candidates here are the ACTIVE people
 * whose role grants the permission the caller names — `change.write`
 * («Changes: work») for the change owner. It is the role data the web already
 * reads for assignments (`GET_ASSIGNABLE_USERS` does the same with
 * `ticket.assignable`), not a list of role names.
 *
 * The API does not check the owner's permission; this is a choice of
 * candidates, and the line under the box says which ones.
 *
 * Searched on the SERVER (tour of 23 Sep 2026): the first version downloaded
 * every person of the organization, with their permissions, to keep the few
 * that qualify — 3,001 people on the demo each time the page opened. Now
 * `searchUsers(permission:)` answers with the matches as the user types, at
 * most a page of them.
 */
import { useState, type CSSProperties } from 'react'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { SEARCH_USERS } from '@/graphql/queries'
import { useDebounced } from '@/hooks/useDebounced'
import { SearchPicker, type PickerOption } from '@/components/ui/SearchPicker'

/** The permission of «Changes: work»: who can own a change. */
export const CHANGE_WORK_PERMISSION = 'change.write'

/** How many people one answer brings: the others are reached by typing. */
export const USER_PICKER_PAGE = 20

interface UserSuggestion { id: string; name: string; email: string }

export interface UserPickerProps {
  /** Only the people whose role grants this permission are offered; absent = every active person. */
  permission?: string
  /** The line under the box: which people these are. */
  hint:        string
  value:       { id: string; name: string } | null
  onChange:    (user: { id: string; name: string } | null) => void
  label:       string
  inputId?:    string
  clearLabel?: string
  style?:      CSSProperties
}

export function UserPicker({ permission, hint, value, onChange, label, inputId, clearLabel, style }: UserPickerProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const search = useDebounced(query.trim(), 250)
  const { data, loading, error } = useQuery<{ searchUsers: UserSuggestion[] }>(SEARCH_USERS, {
    variables: { search, limit: USER_PICKER_PAGE, permission },
  })
  const people = data?.searchUsers ?? []
  const options: PickerOption[] = people.map((u) => ({ id: u.id, label: u.name, detail: u.email }))
  // Nothing typed and nobody at all: no active person has a role that can do this.
  const nobody = data !== undefined && people.length === 0 && search === ''
  const fullPage = people.length === USER_PICKER_PAGE
  return (
    <SearchPicker
      label={label}
      inputId={inputId}
      options={options}
      value={value ? { id: value.id, label: value.name } : null}
      onChange={(o) => onChange(o ? { id: o.id, name: o.label } : null)}
      onQueryChange={setQuery}
      placeholder={t('pickers.users.placeholder')}
      clearLabel={clearLabel}
      loading={loading && !data}
      error={error ? error.message : null}
      hint={nobody ? t('pickers.users.nobody') : fullPage ? `${hint} ${t('pickers.users.typeToFind')}` : hint}
      maxResults={USER_PICKER_PAGE}
      style={style}
    />
  )
}
