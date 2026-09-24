/**
 * A PERSON KEPT AS AN ID, CHOSEN AMONG THOSE WHO CAN DO THE JOB (review of 23 Sep 2026).
 *
 * The automation editors keep a person as an id in the rule's parameters and
 * offered them from a plain select of the whole directory — end users and
 * deactivated people included, so a rule could assign tickets to someone who
 * cannot work them. This is `UserPicker` (a server search among the active
 * people whose role grants `permission`) for an id: the saved person is named
 * through `usersByIds`, and one no longer active is said.
 */
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { UserPicker } from './UserPicker'
import { useUserNames } from '@/hooks/useUserNames'

export interface UserIdPickerProps {
  /** The saved id; '' = nobody chosen. */
  value:      string
  onChange:   (id: string) => void
  /** Only the people whose role grants this permission are offered. */
  permission: string
  /** The line under the box: which people these are. */
  hint:       string
  label:      string
  inputId?:   string
  style?:     CSSProperties
}

export function UserIdPicker({ value, onChange, permission, hint, label, inputId, style }: UserIdPickerProps) {
  const { t } = useTranslation()
  const { byId } = useUserNames(value ? [value] : [])
  const named = value ? byId.get(value) : undefined
  const name = named ? (named.active ? named.name : t('pickers.users.inactive', { name: named.name })) : value
  return (
    <UserPicker
      permission={permission}
      hint={hint}
      value={value ? { id: value, name } : null}
      onChange={(u) => onChange(u?.id ?? '')}
      label={label}
      inputId={inputId}
      style={style}
    />
  )
}
