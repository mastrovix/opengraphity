/**
 * THE TEAM OF A TICKET OR OF A CI, CHOSEN AMONG THE TEAMS THAT DO THAT JOB
 * (D10 / D34, tour of 23 Sep 2026).
 *
 * The incident «Team» offered all 501 teams — owner teams (`OWN_…`) and the
 * Change Management Office included — and the CI groups offered every team for
 * both roles, cut to the width of a select. Here the candidates are the teams
 * of the right type (`teamsFor`, lib/teamVocabularies.ts): support teams
 * resolve incidents and run CIs, owner teams own them.
 *
 * The filter is never silent: the line under the box says which teams are
 * offered, and «Show all teams» widens the list — a tenant whose teams have
 * no type would otherwise have nothing to choose.
 */
import { useState, type CSSProperties } from 'react'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { GET_TEAM_CHOICES } from '@/graphql/queries'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { TEAM_TYPE_VOCABULARY, teamsFor, type TeamChoice, type TeamRole } from '@/lib/teamVocabularies'
import { SearchPicker, type PickerOption } from '@/components/ui/SearchPicker'

export interface TeamPickerProps {
  /** Which job the team does: the candidates are the teams of this type. */
  role:        TeamRole
  value:       { id: string; name: string } | null
  onChange:    (team: { id: string; name: string } | null) => void
  label:       string
  inputId?:    string
  clearLabel?: string
  placeholder?: string
  invalid?:    boolean
  disabled?:   boolean
  style?:      CSSProperties
}

const linkButton: CSSProperties = {
  background: 'none', border: 'none', padding: 0, marginLeft: 6, cursor: 'pointer',
  color: 'var(--color-brand)', textDecoration: 'underline', font: 'inherit',
}

export function TeamPicker({ role, value, onChange, label, inputId, clearLabel, placeholder, invalid, disabled, style }: TeamPickerProps) {
  const { t } = useTranslation()
  const { labelOf } = useDomainVocabularies()
  const { data, loading, error } = useQuery<{ teams: TeamChoice[] }>(GET_TEAM_CHOICES, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const [showAll, setShowAll] = useState(false)
  const all = data?.teams ?? []
  const fit = teamsFor(role, all)
  const typeLabel = (type: string | null) => (type ? (labelOf(TEAM_TYPE_VOCABULARY, type) ?? type) : t('pickers.teams.noType'))
  const options: PickerOption[] = (showAll ? all : fit).map((tm) => ({
    id: tm.id, label: tm.name, detail: showAll ? typeLabel(tm.type) : null,
  }))
  const changeManagerOut = !showAll && all.some((tm) => tm.type === role && tm.isChangeManager === true)
  const hint = (
    <>
      {showAll ? t('pickers.teams.allShown') : t('pickers.teams.onlyType', { type: typeLabel(role) })}
      {!showAll && data && fit.length === 0 && ` ${t('pickers.teams.noneOfType', { type: typeLabel(role) })}`}
      {changeManagerOut && ` ${t('pickers.teams.changeManagerOut')}`}
      <button type="button" style={linkButton} onMouseDown={(e) => e.preventDefault()} onClick={() => setShowAll((v) => !v)}>
        {showAll ? t('pickers.teams.showOnly', { type: typeLabel(role) }) : t('pickers.teams.showAll', { total: all.length })}
      </button>
    </>
  )
  return (
    <SearchPicker
      label={label}
      inputId={inputId}
      options={options}
      value={value ? { id: value.id, label: value.name } : null}
      onChange={(o) => onChange(o ? { id: o.id, name: o.label } : null)}
      placeholder={placeholder ?? t('pages.createTicket.searchTeam')}
      clearLabel={clearLabel}
      loading={loading && !data}
      error={error ? error.message : null}
      hint={hint}
      invalid={invalid}
      disabled={disabled}
      style={style}
    />
  )
}
